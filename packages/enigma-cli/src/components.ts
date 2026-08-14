/**
 * The component registry: headless primitives and utilities an agent or a dev can
 * pull into a project, either as a dependency or copied in as source.
 *
 * The registry is read from the INSTALLED package whenever the project has one,
 * so the catalogue an agent is shown is the API the project actually compiles
 * against. A registry frozen into a skill would drift the first time the package
 * is upgraded, and nothing would report the mismatch.
 */

import { ASSETS_DIR } from "@/assets-dir";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { readJson, findGitRoot } from "@/util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const REGISTRY_PACKAGES = ["@enigmax/primitives", "@enigmax/utils"] as const;

export type ComponentTarget = "vanilla" | "react" | "astro" | "vue" | "svelte";

/**
 * Which styling layer a copied component arrives with. The PRIMITIVE never has one -
 * this only picks the recipe written alongside it.
 */
export type ComponentStyle = "tailwind" | "css" | "none";

export interface RegistryFile {
    /** Path inside the published package. */
    path: string;
    /** File name written into the project in copy mode. */
    dest: string;
    targets: ComponentTarget[];
    /**
     * Only written for this styling layer. Absent means the file is the headless part
     * and is always written, whatever the style.
     */
    style?: ComponentStyle;
    /** Import specifiers to rewrite when the file is copied out of the package. */
    rewrite?: Record<string, string>;
    /**
     * The file a consumer imports from after a copy. Without it the last code file wins,
     * which is only right while an item ships one adapter - a styled recipe alongside it
     * would be reported as the entry purely for arriving last.
     */
    main?: boolean;
}

export interface RegistryItem {
    name: string;
    title: string;
    description: string;
    targets: ComponentTarget[];
    entry: Partial<Record<ComponentTarget, string>>;
    exports: Partial<Record<ComponentTarget, string[]>>;
    files: RegistryFile[];
    /** Packages this item needs beyond its own, installed with it. */
    dependencies?: Record<string, string>;
    styles: boolean;
    themeHooks?: string[];
    docs?: string;
}

export interface Registry {
    registry: string;
    version: number;
    kind: string;
    items: RegistryItem[];
}

export interface ResolvedItem extends RegistryItem {
    /** The package the item belongs to. */
    pkg: string;
    /** Directory the registry was read from, or null when only the bundled copy exists. */
    root: string | null;
}

/**
 * Where a registry can be found, best first: the project's installed copy, then a
 * monorepo checkout, then the copy bundled with the CLI.
 */
function registryRoots(pkg: string, projectDir: string): string[] {
    const roots: string[] = [join(projectDir, "node_modules", pkg)];
    const git = findGitRoot(projectDir);
    if (git) {
        roots.push(join(git, "node_modules", pkg));
        roots.push(join(git, "packages", pkg.replace("@enigmax/", "")));
    }
    roots.push(join(ASSETS_DIR, "registry", pkg.replace("@enigmax/", "")));
    return roots;
}

function loadRegistry(pkg: string, projectDir: string): { registry: Registry; root: string | null; } | null {
    for (const root of registryRoots(pkg, projectDir)) {
        const file = join(root, "registry.json");
        if (!existsSync(file)) continue;
        const registry = readJson<Registry>(file);
        if (registry?.items?.length) return { registry, root: existsSync(join(root, "src")) ? root : null };
    }
    return null;
}

/** Every item across every registry, with the package it came from. */
export function listComponents(projectDir: string = process.cwd()): ResolvedItem[] {
    const items: ResolvedItem[] = [];
    for (const pkg of REGISTRY_PACKAGES) {
        const found = loadRegistry(pkg, projectDir);
        if (!found) continue;
        for (const item of found.registry.items) items.push({ ...item, pkg, root: found.root });
    }
    return items;
}

export function findComponent(name: string, projectDir: string = process.cwd()): ResolvedItem | null {
    const wanted = name.trim().toLowerCase();
    return listComponents(projectDir).find((item) => item.name === wanted) ?? null;
}

/** The project's framework, from its manifest. Falls back to vanilla, which every item supports. */
export function detectTarget(projectDir: string): ComponentTarget {
    const preference = readPreferences(projectDir).target;
    if (preference) return preference;
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }>(join(projectDir, "package.json"));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if (deps["astro"]) return "astro";
    if (deps["vue"]) return "vue";
    if (deps["svelte"]) return "svelte";
    if (deps["react"]) return "react";
    return "vanilla";
}

/**
 * The styling layer to write, from the project itself.
 *
 * Tailwind is the default WHERE THE PROJECT HAS IT - writing utility classes into a
 * project without Tailwind produces a component styled by nothing at all, which is worse
 * than plain CSS. Pass --style to override.
 */
export function detectStyle(projectDir: string): ComponentStyle {
    const preference = readPreferences(projectDir).style;
    if (preference) return preference;
    // A shadcn project has already answered this question in its own config.
    const shadcn = readShadcnConfig(projectDir)?.tailwind;
    if (shadcn?.css || shadcn?.config !== undefined) return "tailwind";

    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }>(join(projectDir, "package.json"));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if (deps["tailwindcss"]) return "tailwind";
    // Tailwind 4 can be wired through the Vite/PostCSS plugin without the meta package.
    if (deps["@tailwindcss/vite"] || deps["@tailwindcss/postcss"]) return "tailwind";
    return "css";
}

/** Package managers `enigma add` knows how to drive. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** How each one is told to add a dependency. `install` is not universal - pnpm/yarn/bun use `add`. */
const ADD_COMMAND: Record<PackageManager, string[]> = {
    npm: ["install"],
    pnpm: ["add"],
    yarn: ["add"],
    bun: ["add"]
};

/**
 * The package manager the PROJECT uses, not the one that happens to be on PATH.
 *
 * Running `npm install` inside a pnpm or bun project writes a second lockfile and leaves
 * the tree in a state the project's own tooling disagrees with, so this is worth reading
 * properly: the corepack `packageManager` field first, because it is a declaration rather
 * than a trace, then the lockfile, searching upwards so a workspace package finds the one
 * at the monorepo root.
 */
export function detectPackageManager(projectDir: string): PackageManager {
    const manifest = readJson<{ packageManager?: string; }>(join(projectDir, "package.json"));
    const declared = manifest?.packageManager?.split("@")[0];
    if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;

    const lockfiles: [string, PackageManager][] = [
        ["pnpm-lock.yaml", "pnpm"],
        ["bun.lockb", "bun"],
        ["bun.lock", "bun"],
        ["yarn.lock", "yarn"],
        ["package-lock.json", "npm"]
    ];

    let dir = projectDir;
    for (let depth = 0; depth < 6; depth++) {
        for (const [file, manager] of lockfiles) {
            if (existsSync(join(dir, file))) return manager;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return "npm";
}

/** Run the project's own package manager to add packages. */
function runInstall(projectDir: string, packages: string[]): { ok: boolean; manager: PackageManager; } {
    const manager = detectPackageManager(projectDir);
    const result = spawnSync(manager, [...ADD_COMMAND[manager], ...packages], {
        cwd: projectDir,
        stdio: "inherit",
        shell: process.platform === "win32"
    });
    return { ok: result.status === 0, manager };
}

/**
 * shadcn/ui's own `components.json`, when the project has one.
 *
 * Read, never written. A project that uses shadcn has already decided where components go
 * and whether it styles with Tailwind, and a second tool inventing its own answers to both
 * is how a codebase ends up with two component folders. Writing to the file instead would
 * mean editing a document another tool owns.
 */
interface ShadcnConfig {
    tailwind?: { config?: string; css?: string; };
    aliases?: { ui?: string; components?: string; lib?: string; };
}

function readShadcnConfig(projectDir: string): ShadcnConfig | null {
    return readJson<ShadcnConfig>(join(projectDir, "components.json"));
}

/** Preferences enigma stores for itself, under `components` in `.enigma.json`. */
interface ComponentPreferences {
    target?: ComponentTarget;
    style?: ComponentStyle;
    /** Project-relative directory copied source lands in. */
    dest?: string;
}

function readPreferences(projectDir: string): ComponentPreferences {
    const config = readJson<{ components?: ComponentPreferences; }>(join(projectDir, ".enigma.json"));
    return config?.components ?? {};
}

/**
 * Resolve a path alias the way shadcn's own conventions do: `@/x` is `src/x` in a project
 * with a `src` directory and `./x` otherwise. Reading tsconfig `paths` properly would be
 * more correct, and is worth doing the day someone reports an alias this misses.
 */
function resolveAlias(projectDir: string, alias: string): string | null {
    if (!alias.startsWith("@/")) return null;
    const rest = alias.slice(2).split("/");
    const base = existsSync(join(projectDir, "src")) ? [projectDir, "src"] : [projectDir];
    return join(...base, ...rest);
}

/**
 * Where a project already keeps its components, in the order the answers are trustworthy.
 *
 * Every one of these is a directory the project MADE, so landing beside them is landing
 * where a reader would look. `lib/enigma` is the fallback for a project that has none.
 */
const COMPONENT_DIRS = [
    ["src", "components"],
    ["app", "components"],
    ["components"],
    ["src", "app", "components"],
    ["resources", "js", "components"]
];

/** Where copied source lands, unless the caller names a directory. */
export function defaultDestination(projectDir: string): string {
    const preference = readPreferences(projectDir).dest;
    if (preference) return join(projectDir, preference);

    // In a shadcn project, next to the components shadcn writes - one folder, not two.
    const aliases = readShadcnConfig(projectDir)?.aliases;
    const alias = aliases?.ui ?? aliases?.components;
    const resolved = alias ? resolveAlias(projectDir, alias) : null;
    if (resolved) return resolved;

    // A components directory the project already has, with an `enigma` folder inside it:
    // grouped, so a component that came from here is obvious at a glance and updating one
    // never has to guess which files were yours.
    for (const parts of COMPONENT_DIRS) {
        const dir = join(projectDir, ...parts);
        if (existsSync(dir)) return join(dir, "enigma");
    }

    return existsSync(join(projectDir, "src")) ? join(projectDir, "src", "lib", "enigma") : join(projectDir, "lib", "enigma");
}

export interface AddResult {
    ok: boolean;
    /** Files written in copy mode. */
    written: string[];
    /** Files left alone because they already existed and `overwrite` was not set. */
    skipped: string[];
    /** Packages added in dependency mode. */
    installed: string[];
    message: string;
}

/** Add the item as a dependency and report the import to use. */
export function addAsDependency(item: ResolvedItem, projectDir: string, install: boolean, withDependencies = true): AddResult {
    const manifestPath = join(projectDir, "package.json");
    const manifest = readJson<{ dependencies?: Record<string, string>; }>(manifestPath);
    if (!manifest) return { ok: false, written: [], skipped: [], installed: [], message: `No package.json in ${projectDir}.` };

    // An item's own package plus whatever it declares it needs - the search primitive is
    // useless without its engine, so asking for it and then hitting a missing module is
    // a worse experience than installing the pair.
    const wanted = [item.pkg, ...(withDependencies ? Object.keys(item.dependencies ?? {}) : [])];
    const missing = wanted.filter((name) => !manifest.dependencies?.[name]);
    if (!missing.length) {
        return { ok: true, written: [], skipped: [], installed: [], message: `${wanted.join(" and ")} already installed.` };
    }
    const manager = detectPackageManager(projectDir);
    if (!install) {
        return { ok: true, written: [], skipped: [], installed: [], message: `Run: ${installCommand(manager, missing)}` };
    }

    const result = runInstall(projectDir, missing);
    if (!result.ok) return { ok: false, written: [], skipped: [], installed: [], message: `${installCommand(manager, missing)} failed.` };
    return { ok: true, written: [], skipped: [], installed: missing, message: `Installed ${missing.join(", ")} with ${manager}.` };
}

export interface CopyOptions {
    style?: ComponentStyle;
    withDependencies?: boolean;
    /**
     * Replace files that are already there. Off by default, because the entire point of
     * copy mode is that the source becomes yours to edit - and a second `enigma add` that
     * silently threw those edits away would be indistinguishable from one that worked.
     */
    overwrite?: boolean;
}

/**
 * Copy the item's source into the project, shadcn style, so it can be edited.
 *
 * Requires the package on disk: the CLI never invents source it cannot read.
 */
export function addAsCopy(item: ResolvedItem, projectDir: string, target: ComponentTarget, destination: string, options: CopyOptions = {}): AddResult {
    const { style = "none", withDependencies = true, overwrite = false } = options;
    if (!item.root) {
        return {
            ok: false,
            written: [],
            skipped: [],
            installed: [],
            message: `Copy mode needs the package source on disk. Run: npm install ${item.pkg}`
        };
    }

    // A file with no `style` is the headless part and always travels; one that names a
    // style travels only when it is the style asked for.
    const files = item.files.filter((file) => file.targets.includes(target) && (!file.style || file.style === style));
    if (!files.length) {
        return { ok: false, written: [], skipped: [], installed: [], message: `'${item.name}' has no files for target '${target}'.` };
    }

    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
        const source = join(item.root, file.path);
        if (!existsSync(source)) {
            return { ok: false, written, skipped, installed: [], message: `Missing ${file.path} in ${item.pkg}. Reinstall the package.` };
        }
        const outPath = join(destination, file.dest);
        if (!overwrite && existsSync(outPath)) {
            skipped.push(outPath);
            continue;
        }
        let contents = readFileSync(source, "utf8");
        for (const [from, to] of Object.entries(file.rewrite ?? {})) {
            contents = contents.split(`"${from}"`).join(`"${to}"`);
        }
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, contents);
        written.push(outPath);
    }

    // The copied recipe imports its engine, so the dependency travels with the source.
    const extra = withDependencies ? Object.keys(item.dependencies ?? {}) : [];
    const installed: string[] = [];
    let manager: PackageManager = "npm";
    if (extra.length) {
        const manifest = readJson<{ dependencies?: Record<string, string>; }>(join(projectDir, "package.json"));
        const missing = extra.filter((name) => !manifest?.dependencies?.[name]);
        if (missing.length) {
            const result = runInstall(projectDir, missing);
            manager = result.manager;
            if (result.ok) installed.push(...missing);
        }
    }

    const note = installed.length ? ` Installed ${installed.join(", ")} with ${manager}.` : "";
    const kept = skipped.length ? ` Left ${skipped.length} existing file(s) alone; --overwrite replaces them.` : "";
    return { ok: true, written, skipped, installed, message: `Copied ${written.length} file(s) into ${destination}.${kept}${note}` };
}

/** The exact line a reader can paste, in the project's own package manager. */
export function installCommand(manager: PackageManager, packages: string[]): string {
    return [manager, ...ADD_COMMAND[manager], ...packages].join(" ");
}

/** The import line a consumer should write for this item on this target. */
export function usageSnippet(item: ResolvedItem, target: ComponentTarget, copiedInto: string | null): string {
    const names = item.exports[target] ?? item.exports.vanilla ?? [];
    if (!copiedInto) return `import { ${names.join(", ")} } from "${item.entry[target] ?? item.pkg}";`;

    // The entry is whichever file says it is; failing that, the last CODE file, because
    // the core comes first and a stylesheet is not something anyone imports symbols from.
    const files = item.files.filter((file) => file.targets.includes(target) && /\.[cm]?[jt]sx?$/.test(file.dest));
    const entry = (files.find((file) => file.main)?.dest ?? files[files.length - 1]?.dest ?? item.name)
        .replace(/\.[cm]?[jt]sx?$/, "")
        // A folder's index is addressed by the folder.
        .replace(/\/index$/, "");
    return `import { ${names.join(", ")} } from "./${entry}";`;
}
