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
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }>(join(projectDir, "package.json"));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if (deps["tailwindcss"]) return "tailwind";
    // Tailwind 4 can be wired through the Vite/PostCSS plugin without the meta package.
    if (deps["@tailwindcss/vite"] || deps["@tailwindcss/postcss"]) return "tailwind";
    return "css";
}

/** Where copied source lands, unless the caller names a directory. */
export function defaultDestination(projectDir: string): string {
    return existsSync(join(projectDir, "src")) ? join(projectDir, "src", "lib", "enigma") : join(projectDir, "lib", "enigma");
}

export interface AddResult {
    ok: boolean;
    /** Files written in copy mode. */
    written: string[];
    /** Packages added in dependency mode. */
    installed: string[];
    message: string;
}

/** Add the item as a dependency and report the import to use. */
export function addAsDependency(item: ResolvedItem, projectDir: string, install: boolean): AddResult {
    const manifestPath = join(projectDir, "package.json");
    const manifest = readJson<{ dependencies?: Record<string, string>; }>(manifestPath);
    if (!manifest) return { ok: false, written: [], installed: [], message: `No package.json in ${projectDir}.` };

    // An item's own package plus whatever it declares it needs - the search primitive is
    // useless without its engine, so asking for it and then hitting a missing module is
    // a worse experience than installing the pair.
    const wanted = [item.pkg, ...Object.keys(item.dependencies ?? {})];
    const missing = wanted.filter((name) => !manifest.dependencies?.[name]);
    if (!missing.length) {
        return { ok: true, written: [], installed: [], message: `${wanted.join(" and ")} already installed.` };
    }
    if (!install) {
        return { ok: true, written: [], installed: [], message: `Run: npm install ${missing.join(" ")}` };
    }

    const result = spawnSync("npm", ["install", ...missing], { cwd: projectDir, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) return { ok: false, written: [], installed: [], message: `npm install ${missing.join(" ")} failed.` };
    return { ok: true, written: [], installed: missing, message: `Installed ${missing.join(", ")}.` };
}

/**
 * Copy the item's source into the project, shadcn style, so it can be edited.
 *
 * Requires the package on disk: the CLI never invents source it cannot read.
 */
export function addAsCopy(item: ResolvedItem, projectDir: string, target: ComponentTarget, destination: string, style: ComponentStyle = "none"): AddResult {
    if (!item.root) {
        return {
            ok: false,
            written: [],
            installed: [],
            message: `Copy mode needs the package source on disk. Run: npm install ${item.pkg}`
        };
    }

    // A file with no `style` is the headless part and always travels; one that names a
    // style travels only when it is the style asked for.
    const files = item.files.filter((file) => file.targets.includes(target) && (!file.style || file.style === style));
    if (!files.length) {
        return { ok: false, written: [], installed: [], message: `'${item.name}' has no files for target '${target}'.` };
    }

    const written: string[] = [];
    for (const file of files) {
        const source = join(item.root, file.path);
        if (!existsSync(source)) {
            return { ok: false, written, installed: [], message: `Missing ${file.path} in ${item.pkg}. Reinstall the package.` };
        }
        let contents = readFileSync(source, "utf8");
        for (const [from, to] of Object.entries(file.rewrite ?? {})) {
            contents = contents.split(`"${from}"`).join(`"${to}"`);
        }
        const outPath = join(destination, file.dest);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, contents);
        written.push(outPath);
    }

    // The copied recipe imports its engine, so the dependency travels with the source.
    const extra = Object.keys(item.dependencies ?? {});
    const installed: string[] = [];
    if (extra.length) {
        const manifest = readJson<{ dependencies?: Record<string, string>; }>(join(projectDir, "package.json"));
        const missing = extra.filter((name) => !manifest?.dependencies?.[name]);
        if (missing.length) {
            const result = spawnSync("npm", ["install", ...missing], { cwd: projectDir, stdio: "inherit", shell: process.platform === "win32" });
            if (result.status === 0) installed.push(...missing);
        }
    }

    const note = installed.length ? ` Installed ${installed.join(", ")}.` : "";
    return { ok: true, written, installed, message: `Copied ${written.length} file(s) into ${destination}.${note}` };
}

/** The import line a consumer should write for this item on this target. */
export function usageSnippet(item: ResolvedItem, target: ComponentTarget, copiedInto: string | null): string {
    const names = item.exports[target] ?? item.exports.vanilla ?? [];
    if (!copiedInto) return `import { ${names.join(", ")} } from "${item.entry[target] ?? item.pkg}";`;

    // The adapter is the last file that matches the target; the core comes first.
    const files = item.files.filter((file) => file.targets.includes(target));
    const entry = files[files.length - 1]?.dest.replace(/\.[cm]?tsx?$/, "") ?? item.name;
    return `import { ${names.join(", ")} } from "./${entry}";`;
}
