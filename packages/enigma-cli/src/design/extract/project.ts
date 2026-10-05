/**
 * What a local project declares about itself: its name, its UI frameworks (from
 * package.json), whether it uses CSS Modules, and which icon, state and animation
 * libraries it depends on.
 */

import { join, basename, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Framework, FrameworkId, ProjectLibraries } from "../types";

const DEP_MAP: Array<{ pkg: string; id: FrameworkId; name: string; }> = [
    { pkg: "tailwindcss", id: "tailwind", name: "Tailwind CSS" },
    { pkg: "react", id: "react", name: "React" },
    { pkg: "vue", id: "vue", name: "Vue" },
    { pkg: "next", id: "next", name: "Next.js" },
    { pkg: "nuxt", id: "nuxt", name: "Nuxt" },
    { pkg: "svelte", id: "svelte", name: "Svelte" },
    { pkg: "@angular/core", id: "angular", name: "Angular" },
    { pkg: "styled-components", id: "css-in-js", name: "CSS-in-JS (styled-components)" },
    { pkg: "@emotion/react", id: "css-in-js", name: "CSS-in-JS (Emotion)" },
    { pkg: "@emotion/styled", id: "css-in-js", name: "CSS-in-JS (Emotion)" },
];

interface PackageJson {
    name?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
}

function readPackageJson(projectDir: string): PackageJson | null {
    const path = join(projectDir, "package.json");
    if (!existsSync(path)) return null;
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" ? parsed as PackageJson : null;
    } catch { return null; }
}

/** Every dependency name -> version range, dev dependencies included. */
function allDeps(pkg: PackageJson | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const deps of [pkg?.dependencies, pkg?.devDependencies]) {
        if (!deps || typeof deps !== "object") continue;
        for (const [name, range] of Object.entries(deps)) out[name] = String(range);
    }
    return out;
}

function hasCssModules(dir: string, depth = 0): boolean {
    if (depth > 4) return false;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            if (entry.isFile() && /\.module\.(css|scss|less)$/.test(entry.name)) return true;
            if (entry.isDirectory() && hasCssModules(join(dir, entry.name), depth + 1)) return true;
        }
    } catch { /* unreadable directory */ }
    return false;
}

export function detectFrameworks(projectDir: string): Framework[] {
    const deps = allDeps(readPackageJson(projectDir));
    const seen = new Set<FrameworkId>();
    const frameworks: Framework[] = [];
    for (const mapping of DEP_MAP) {
        if (deps[mapping.pkg] && !seen.has(mapping.id)) {
            seen.add(mapping.id);
            frameworks.push({ id: mapping.id, name: mapping.name, version: deps[mapping.pkg]!.replace(/[\^~>=<]/g, "") });
        }
    }
    if (hasCssModules(projectDir)) frameworks.push({ id: "css-modules", name: "CSS Modules" });
    return frameworks;
}

/** The project's display name: the override, else package.json `name`, else the folder name. */
export function projectName(projectDir: string, override?: string): string {
    if (override) return override;
    const name = readPackageJson(projectDir)?.name;
    return typeof name === "string" && name ? name : basename(resolve(projectDir));
}

export function detectLibraries(projectDir: string): ProjectLibraries {
    const deps = allDeps(readPackageJson(projectDir));
    const first = (pairs: Array<[string[], string]>): string | null => pairs.find(([pkgs]) => pkgs.some((p) => deps[p]))?.[1] ?? null;
    return {
        iconLibrary: first([
            [["lucide-react", "lucide-vue-next"], "Lucide"], [["@heroicons/react", "heroicons"], "Heroicons"],
            [["react-icons"], "React Icons"], [["@phosphor-icons/react"], "Phosphor"],
            [["@tabler/icons-react"], "Tabler Icons"], [["@radix-ui/react-icons"], "Radix Icons"],
        ]),
        stateLibrary: first([
            [["zustand"], "Zustand"], [["@reduxjs/toolkit", "redux"], "Redux"], [["jotai"], "Jotai"],
            [["recoil"], "Recoil"], [["valtio"], "Valtio"], [["pinia"], "Pinia"], [["mobx"], "MobX"],
        ]),
        animationLibrary: first([
            [["framer-motion", "motion"], "Framer Motion"], [["@react-spring/web", "react-spring"], "React Spring"],
            [["gsap"], "GSAP"], [["animejs", "anime.js"], "Anime.js"], [["@formkit/auto-animate"], "AutoAnimate"],
        ]),
    };
}
