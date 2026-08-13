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

export interface RegistryFile {
    /** Path inside the published package. */
    path: string;
    /** File name written into the project in copy mode. */
    dest: string;
    targets: ComponentTarget[];
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

    if (manifest.dependencies?.[item.pkg]) {
        return { ok: true, written: [], installed: [], message: `${item.pkg} is already a dependency.` };
    }
    if (!install) {
        return { ok: true, written: [], installed: [], message: `Run: npm install ${item.pkg}` };
    }

    const result = spawnSync("npm", ["install", item.pkg], { cwd: projectDir, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) return { ok: false, written: [], installed: [], message: `npm install ${item.pkg} failed.` };
    return { ok: true, written: [], installed: [item.pkg], message: `Installed ${item.pkg}.` };
}

/**
 * Copy the item's source into the project, shadcn style, so it can be edited.
 *
 * Requires the package on disk: the CLI never invents source it cannot read.
 */
export function addAsCopy(item: ResolvedItem, projectDir: string, target: ComponentTarget, destination: string): AddResult {
    if (!item.root) {
        return {
            ok: false,
            written: [],
            installed: [],
            message: `Copy mode needs the package source on disk. Run: npm install ${item.pkg}`
        };
    }

    const files = item.files.filter((file) => file.targets.includes(target));
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

    return { ok: true, written, installed: [], message: `Copied ${written.length} file(s) into ${destination}.` };
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
