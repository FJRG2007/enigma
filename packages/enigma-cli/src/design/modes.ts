/**
 * The three ways to obtain a DesignProfile: a local project directory, a git repository
 * (shallow-cloned to a temp dir, then read as a directory), or a live URL (HTTP crawl,
 * plus the rendered styles when a browser is available).
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalize } from "./normalize";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Browser } from "./browser/page";
import { extractHttpTokens } from "./extract/http";
import { addColor, mergeRawTokens } from "./raw-tokens";
import { extractComponents } from "./extract/components";
import { extractTokenFiles } from "./extract/tokens-file";
import { extractTailwindTokens } from "./extract/tailwind";
import { extractComputedTokens } from "./extract/computed";
import { extractStylesheetTokens } from "./extract/stylesheets";
import type { ComponentInfo, DesignProfile, RawTokens } from "./types";
import { detectFrameworks, detectLibraries, projectName } from "./extract/project";

const HTTP_PAGES = 5;
const COMPUTED_PAGES = 3;
const CLONE_TIMEOUT_MS = 180_000;

/** Hex colors written inline in component markup count toward the palette. */
function addComponentColors(components: ComponentInfo[], tokens: RawTokens): void {
    for (const comp of components) {
        for (const m of comp.jsxSnippet.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
            const h = m[1]!.toLowerCase();
            addColor(tokens, h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`, "component");
        }
    }
}

/** Motion declared in components (Framer Motion, springs, Tailwind animate-*) as animation tokens. */
function addComponentAnimations(components: ComponentInfo[], tokens: RawTokens): void {
    for (const comp of components) {
        for (const detail of comp.animationDetails) {
            if (detail.startsWith("framer-motion")) tokens.animations.push({ name: "framer-motion", type: "framer-motion", value: detail, source: comp.filePath });
            else if (detail.startsWith("spring:")) tokens.animations.push({ name: "spring-config", type: "spring", value: detail.replace("spring: ", ""), source: comp.filePath });
            else if (detail.startsWith("tw-animate-")) tokens.animations.push({ name: detail.replace("tw-", ""), type: "css-keyframe", value: detail, source: comp.filePath });
        }
    }
}

export function runDirMode(projectDir: string, nameOverride?: string): DesignProfile {
    const merged = mergeRawTokens([extractTailwindTokens(projectDir), extractTokenFiles(projectDir), extractStylesheetTokens(projectDir)]);
    const components = extractComponents(projectDir);
    addComponentColors(components, merged);
    addComponentAnimations(components, merged);
    return normalize(projectName(projectDir, nameOverride), detectFrameworks(projectDir), merged, components, detectLibraries(projectDir));
}

/**
 * A repository location git can clone: an http(s), ssh or git URL, or scp-style
 * `user@host:path`. Anything else - in particular a value starting with `-`, which git
 * would read as an option - is refused.
 */
export function isCloneableUrl(url: string): boolean {
    if (url.startsWith("-")) return false;
    if (/^(https?|ssh|git):\/\/[^\s]+$/i.test(url)) return true;
    return /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url);
}

/** `https://github.com/org/repo.git` -> `repo`. */
export function repoName(url: string): string {
    return url.replace(/\/+$/, "").match(/[/:]([^/:]+?)(?:\.git)?$/)?.[1] ?? "project";
}

function gitClone(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Never prompt for credentials: a private repo fails fast instead of hanging the run.
        const child = spawn("git", ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, dest], {
            stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`git clone timed out after ${CLONE_TIMEOUT_MS / 1000}s`)); }, CLONE_TIMEOUT_MS);
        child.once("error", (err) => { clearTimeout(timer); reject(new Error(`cannot run git: ${err.message}`)); });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`git clone failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`));
        });
    });
}

export async function runRepoMode(url: string, nameOverride?: string): Promise<DesignProfile> {
    if (!isCloneableUrl(url)) throw new Error(`not a git URL: ${url}`);
    const dir = mkdtempSync(join(tmpdir(), "enigma-design-repo-"));
    try {
        await gitClone(url, join(dir, "repo"));
        return runDirMode(join(dir, "repo"), nameOverride ?? repoName(url));
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

/** `https://www.stripe.com/x` -> `stripe`. */
export function urlName(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0] || "website"; } catch { return "website"; }
}

export interface UrlModeResult {
    profile: DesignProfile;
    cssColors: number;
    cssFonts: number;
    computedColors: number;
}

export async function runUrlMode(url: string, browser: Browser | null, nameOverride?: string): Promise<UrlModeResult> {
    const http = await extractHttpTokens(url, HTTP_PAGES);
    let computed: RawTokens | null = null;
    if (browser) {
        try { computed = await extractComputedTokens(browser, url, COMPUTED_PAGES); } catch { /* the HTTP pass stands alone */ }
    }
    const merged = computed ? mergeRawTokens([http.tokens, computed]) : http.tokens;
    const profile = normalize(nameOverride ?? urlName(url), [], merged, http.components, { iconLibrary: null, stateLibrary: null, animationLibrary: null });
    profile.siteUrl = url;
    profile.favicon = merged.favicon ?? null;
    return { profile, cssColors: http.tokens.colors.length, cssFonts: http.tokens.fonts.length, computedColors: computed?.colors.length ?? 0 };
}
