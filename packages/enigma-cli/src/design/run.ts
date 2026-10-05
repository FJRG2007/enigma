/**
 * One `enigma design` run end to end: extract a profile from the source, optionally run
 * the browser passes (homepage capture, ultra extraction), write DESIGN.md / SKILL.md /
 * references / tokens / fonts / screenshots into `<out>/<name>-design/`, package the
 * `.skill` archive, and install the skill folder into the chosen agents.
 */

import { finish } from "./write/md";
import { bundleFonts } from "./fonts";
import { join, resolve } from "node:path";
import { zipDirectory } from "./write/zip";
import * as ultraMd from "./write/ultra-md";
import { capturePages } from "./ultra/pages";
import { findBrowser } from "./browser/chrome";
import { extractLayouts } from "./ultra/layout";
import { AGENTS, discoverAgents } from "@/agents";
import { Browser, type Page } from "./browser/page";
import { generateDesignMd } from "./write/design-md";
import { writeTokensJson } from "./write/tokens-json";
import { captureAnimations } from "./ultra/animations";
import { captureInteractions } from "./ultra/interactions";
import { detectDomComponents } from "./ultra/components-dom";
import { generateAnimationsMd } from "./write/animations-md";
import { runDirMode, runRepoMode, runUrlMode } from "./modes";
import type { DesignProfile, FullAnimationResult } from "./types";
import { embedReferences, generateSkillMd, skillName } from "./write/skill-md";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Written into every generated folder: how a later run recognizes a folder it may replace. */
export const MARKER_FILE = ".enigma-design.json";

export type SourceKind = "url" | "dir" | "repo";
export type OutputFormat = "design-md" | "skill" | "both";
export type InstallScope = "global" | "local" | "none";

export interface DesignOptions {
    source: SourceKind;
    target: string;
    out: string;
    name?: string;
    format: OutputFormat;
    ultra: boolean;
    screens: number;
    browser?: string | null;
    /** False skips the browser entirely (HTTP crawl only). */
    useBrowser?: boolean;
    install: InstallScope;
    /** Agents to install into; empty means every detected one. */
    agents: string[];
    fonts: boolean;
    siteFonts: boolean;
    force: boolean;
}

export interface Reporter {
    step: (label: string) => void;
    done: (label: string, detail: string) => void;
    warn: (message: string) => void;
}

export interface InstallResult { agent: string; path: string; status: "installed" | "skipped"; reason?: string; }

export interface DesignResult {
    profile: DesignProfile;
    designDir: string;
    designMdPath: string | null;
    skillFile: string | null;
    animations: FullAnimationResult | null;
    installs: InstallResult[];
    browserUsed: boolean;
}

/** A folder is ours when absent, empty, or carrying the marker; anything else is the user's. */
function ownsFolder(dir: string): boolean {
    return !existsSync(dir) || readdirSync(dir).length === 0 || existsSync(join(dir, MARKER_FILE));
}

function prepareFolder(dir: string, force: boolean, what: string): void {
    if (!ownsFolder(dir) && !force) throw new Error(`${what} ${dir} exists and was not created by enigma design; pass --force to replace it`);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    mkdirSync(dir, { recursive: true });
}

function contextFile(projectName: string): string {
    return finish(`# ${projectName} Design System

This folder holds the **${projectName}** design system, extracted by enigma design.

Read \`SKILL.md\` before writing any UI code. It is the master reference; the rest:

- \`references/DESIGN.md\`: extended tokens and component specs
- \`references/ANIMATIONS.md\`: motion and keyframe specs (browser extraction)
- \`references/LAYOUT.md\`: grid and layout containers (browser extraction)
- \`references/COMPONENTS.md\`: repeated DOM component patterns (browser extraction)
- \`screens/\`: screenshots; study them before implementing

Match colors, fonts, spacing and motion exactly.
`);
}

async function withPage<T>(browser: Browser, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await browser.newPage();
    try { return await fn(page); } finally { await page.close(); }
}

async function homepageScreenshot(browser: Browser, url: string, designDir: string): Promise<string | null> {
    try {
        return await withPage(browser, async (page) => {
            await page.goto(url);
            await page.wait(2000);
            mkdirSync(join(designDir, "screenshots"), { recursive: true });
            writeFileSync(join(designDir, "screenshots", "homepage.png"), await page.screenshot());
            return "screenshots/homepage.png";
        });
    } catch { return null; }
}

async function runUltra(browser: Browser, url: string, profile: DesignProfile, designDir: string, screens: number, reporter: Reporter): Promise<FullAnimationResult> {
    for (const sub of ["screens/pages", "screens/sections", "screens/states", "screens/scroll", "references"]) mkdirSync(join(designDir, sub), { recursive: true });

    reporter.step("Capturing motion, layout and components");
    const { animations, layouts, components } = await withPage(browser, async (page) => {
        await page.goto(url);
        await page.wait(3000);
        // Layout and components read the page at rest; the scroll journey runs last.
        const layouts = await extractLayouts(page);
        const components = await detectDomComponents(page);
        return { animations: await captureAnimations(page, designDir), layouts, components };
    });
    reporter.done("Motion, layout, components", `${animations.scrollFrames.length} scroll frames - ${animations.keyframes.length} keyframes - ${components.length} components`);

    reporter.step(`Capturing up to ${screens} pages`);
    const { pages, sections } = await capturePages(browser, url, designDir, screens);
    reporter.done("Pages", `${pages.length} pages - ${sections.length} sections`);

    reporter.step("Capturing hover and focus states");
    const interactions = await withPage(browser, async (page) => {
        await page.goto(url);
        await page.wait(3000);
        return captureInteractions(page, designDir);
    });
    reporter.done("Interactions", `${interactions.length} elements`);

    const refs = join(designDir, "references");
    writeFileSync(join(refs, "ANIMATIONS.md"), finish(generateAnimationsMd(animations)), "utf8");
    writeFileSync(join(refs, "LAYOUT.md"), finish(ultraMd.generateLayoutMd(layouts, profile)), "utf8");
    writeFileSync(join(refs, "INTERACTIONS.md"), finish(ultraMd.generateInteractionsMd(interactions, profile)), "utf8");
    writeFileSync(join(refs, "COMPONENTS.md"), finish(ultraMd.generateComponentsMd(components, profile)), "utf8");
    writeFileSync(join(refs, "VISUAL_GUIDE.md"), finish(ultraMd.generateVisualGuideMd(profile, pages, sections, animations)), "utf8");
    writeFileSync(join(designDir, "screens", "INDEX.md"), finish(ultraMd.generateScreensIndex(pages, sections, animations)), "utf8");
    return animations;
}

/** Copy the skill folder into each agent's skills directory. */
export function installSkill(designDir: string, name: string, scope: Exclude<InstallScope, "none">, agents: string[], force: boolean): InstallResult[] {
    const targets = agents.length > 0 ? agents : discoverAgents().filter((a) => a.installed).map((a) => a.name);
    const results: InstallResult[] = [];
    const seen = new Set<string>();
    for (const agent of targets) {
        const def = AGENTS[agent];
        if (!def) { results.push({ agent, path: "", status: "skipped", reason: "unknown agent" }); continue; }
        const dest = join(def.targets[scope].skills, name);
        // Codex and another agent may share one skills directory; copy once.
        if (seen.has(dest)) continue;
        seen.add(dest);
        if (!ownsFolder(dest) && !force) {
            results.push({ agent, path: dest, status: "skipped", reason: "a skill with this name exists and was not created by enigma design (use --force)" });
            continue;
        }
        rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        mkdirSync(dest, { recursive: true });
        cpSync(designDir, dest, { recursive: true, filter: (src) => !/\.skill$|[\\/](CLAUDE|AGENTS)\.md$/.test(src) });
        results.push({ agent, path: dest, status: "installed" });
    }
    return results;
}

export async function runDesign(options: DesignOptions, reporter: Reporter): Promise<DesignResult> {
    const out = resolve(options.out);
    const executable = options.source === "url" && options.useBrowser !== false ? findBrowser(options.browser) : null;
    if (options.source === "url" && options.browser && !executable) throw new Error(`browser not found at ${options.browser}`);
    if (options.source === "url" && options.useBrowser !== false && !executable) {
        reporter.warn("No Chrome, Edge, Chromium or Brave found: rendered styles, screenshots and ultra capture are skipped.");
        reporter.warn("Install one, or point --browser (or ENIGMA_BROWSER) at its executable.");
    }

    let browser: Browser | null = null;
    try {
        if (executable) {
            reporter.step("Starting the browser");
            browser = await Browser.launch(executable);
            reporter.done("Browser", executable);
        }

        let profile: DesignProfile;
        if (options.source === "dir") {
            reporter.step("Scanning the project");
            profile = runDirMode(resolve(options.target), options.name);
            reporter.done("Project scan", `${profile.colors.length} colors - ${profile.components.length} components`);
        } else if (options.source === "repo") {
            reporter.step("Cloning and scanning the repository");
            profile = await runRepoMode(options.target, options.name);
            reporter.done("Repository scan", `${profile.colors.length} colors - ${profile.components.length} components`);
        } else {
            reporter.step("Crawling HTML and CSS");
            const res = await runUrlMode(options.target, browser, options.name);
            profile = res.profile;
            reporter.done("CSS + token extraction", browser
                ? `${res.cssColors} CSS colors - ${res.computedColors} rendered - ${res.cssFonts} fonts`
                : `${res.cssColors} colors - ${res.cssFonts} fonts`);
        }

        const name = skillName(profile.projectName);
        const designDir = join(out, name);
        prepareFolder(designDir, options.force, "Output folder");
        writeFileSync(join(designDir, MARKER_FILE), `${JSON.stringify({ generator: "enigma design", source: options.source, target: options.target, created: new Date().toISOString() }, null, 2)}\n`, "utf8");

        let screenshotPath: string | null = null;
        let animations: FullAnimationResult | null = null;
        if (browser && options.source === "url") {
            reporter.step("Capturing the homepage");
            screenshotPath = await homepageScreenshot(browser, options.target, designDir);
            reporter.done("Homepage", screenshotPath ?? "capture failed");
            if (options.ultra) animations = await runUltra(browser, options.target, profile, designDir, options.screens, reporter);
        } else if (options.ultra) {
            reporter.warn(options.source === "url" ? "Ultra capture needs a browser; skipped." : "Ultra capture applies to --url only; skipped.");
        }

        const writeSkill = options.format !== "design-md";
        if (writeSkill && options.fonts) {
            reporter.step("Bundling fonts");
            const families = [...new Set(profile.typography.map((t) => t.fontFamily))].filter(Boolean);
            const fonts = await bundleFonts(profile.fontSources, families, designDir, { siteFonts: options.siteFonts });
            profile = { ...profile, fontSources: fonts.sources };
            reporter.done("Fonts", `${fonts.bundled} files`);
        }

        writeTokensJson(profile, designDir, new Date().toISOString().slice(0, 10));
        const designMd = generateDesignMd(profile, screenshotPath);
        let designMdPath: string | null = null;
        if (options.format !== "skill") {
            designMdPath = join(designDir, "DESIGN.md");
            writeFileSync(designMdPath, designMd, "utf8");
        }

        let skillFile: string | null = null;
        let installs: InstallResult[] = [];
        if (writeSkill) {
            mkdirSync(join(designDir, "references"), { recursive: true });
            writeFileSync(join(designDir, "references", "DESIGN.md"), designMd, "utf8");
            const skillMd = generateSkillMd(profile, screenshotPath, animations) + embedReferences(designDir);
            writeFileSync(join(designDir, "SKILL.md"), finish(skillMd), "utf8");
            writeFileSync(join(designDir, "CLAUDE.md"), contextFile(profile.projectName), "utf8");
            writeFileSync(join(designDir, "AGENTS.md"), contextFile(profile.projectName), "utf8");

            skillFile = join(designDir, `${name}.skill`);
            const archive = join(out, `.${name}.skill.tmp`);
            zipDirectory(designDir, archive, name, (p) => /[\\/](CLAUDE|AGENTS)\.md$/.test(p) || p.endsWith(MARKER_FILE));
            renameSync(archive, skillFile);
            reporter.done(".skill package", skillFile);

            if (options.install !== "none") installs = installSkill(designDir, name, options.install, options.agents, options.force);
        }
        return { profile, designDir, designMdPath, skillFile, animations, installs, browserUsed: !!browser };
    } finally {
        await browser?.close();
    }
}
