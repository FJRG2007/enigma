/**
 * `enigma memory render`: the operating contract an install writes into CLAUDE.md / AGENTS.md, as
 * plain text for a host that is not a CLI agent - a chat backend that injects it as a system
 * prompt.
 *
 * The text is the deployed memory under the current config, minus what only a coding harness can
 * act on (session-memory tools, the quality gate, parallel sub-agents, "load the matching skill"
 * when no skill is shipped alongside), optionally followed by the policy skills themselves. The
 * output is a pure function of the enigma version and the settings, so a host can cache it by
 * (version, sha256).
 */

import { createHash } from "node:crypto";
import { renderDeployedMemory, renderDeployedSkills, stripMemoryBlock } from "./skills";

export const RENDER_TARGETS = ["generic"] as const;
export type RenderTarget = typeof RENDER_TARGETS[number];

export interface RenderOptions {
    target: RenderTarget;
    /** Keep the rules, drop examples and code samples. */
    compact: boolean;
    /** Skills appended after the contract: none, every deployable one, or these names. */
    skills: "none" | "all" | string[];
}

export interface RenderResult {
    text: string;
    sha256: string;
    /** Skills included, in output order. */
    skills: string[];
}

/** Blocks of the memory file that drive harness tools a chat does not have. */
const HARNESS_BLOCKS = ["recall", "gate", "parallel-subagents"];

/** Remove a markdown section (its heading line through the line before the next heading of the same or higher level). */
function dropSection(text: string, heading: string): string {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start < 0) return text;
    const level = heading.match(/^#+/)![0].length;
    let end = start + 1;
    while (end < lines.length && !(/^#+\s/.test(lines[end]!) && lines[end]!.match(/^#+/)![0].length <= level)) end++;
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** Drop the list items of one section that mention skills (instructions to load files a chat does not have). */
function dropSkillBullets(text: string, heading: string): string {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start < 0) return text;
    const out = lines.slice(0, start + 1);
    let i = start + 1;
    for (; i < lines.length && !/^#+\s/.test(lines[i]!); i++) {
        if (/^- /.test(lines[i]!) && /\bskills?\b|SKILL\.md/i.test(lines[i]!)) continue;
        out.push(lines[i]!);
    }
    return [...out, ...lines.slice(i)].join("\n");
}

/** Strip the YAML frontmatter a SKILL.md opens with. */
function stripFrontmatter(text: string): string {
    return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** A paragraph that is an illustration rather than a rule. */
const SAMPLE_OPENER = /^(\*\*)?(Examples?|Bad|Good|Wrong|Right|Before|After)\b[^:\n]{0,40}:/;

/**
 * Keep the rules, drop the illustrations: sections titled as examples, fenced code samples,
 * paragraphs and list items that open as a sample ("Example:", "Bad:", "Good:", "Not:"), inline
 * "Yes: ..." samples and "e.g." asides. Rule text itself is never rewritten.
 */
export function compactText(text: string): string {
    let out = text.replace(/^```[\s\S]*?^```\n?/gm, "");
    for (const heading of out.split("\n").filter((l) => /^#+\s.*\bexamples?\b/i.test(l))) out = dropSection(out, heading.trim());
    return out
        .split(/\n{2,}/)
        .filter((para) => !SAMPLE_OPENER.test(para.trimStart()))
        .join("\n\n")
        .split("\n")
        .filter((l) => !/^\s*- (Not|Bad|Good|Wrong|Right|Example)\b[^:]*:/.test(l))
        .map((l) => l
            .replace(/\s*Yes: "[^"]*"\.?/g, "")
            .replace(/\s*\((e\.g\.|for example)[^)]*\)/g, "")
            .replace(/\s+-\s+e\.g\.[^.]*\./g, ".")
            .replace(/,?\s+e\.g\.\s[^.;]*([.;])/g, "$1"))
        .join("\n");
}

/** Normalize spacing so equal content always renders to equal bytes. */
function tidy(text: string): string {
    return `${text
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()}\n`;
}

/** Render the contract (and optionally the skills) for a non-agent host. */
export function renderHostMemory(opts: RenderOptions): RenderResult {
    let text = renderDeployedMemory();
    for (const id of HARNESS_BLOCKS) text = stripMemoryBlock(text, id);
    text = text.replace(/^<!-- enigma:[^>]*-->\n?/gm, "");

    const all = renderDeployedSkills();
    let picked = opts.skills === "none" ? [] : opts.skills === "all" ? all : all.filter((s) => (opts.skills as string[]).includes(s.name));
    if (Array.isArray(opts.skills)) {
        const unknown = opts.skills.filter((n) => !all.some((s) => s.name === n));
        if (unknown.length) throw new Error(`unknown or disabled skill(s): ${unknown.join(", ")}`);
        picked = opts.skills.map((n) => all.find((s) => s.name === n)!);
    }

    if (!picked.length) {
        text = dropSection(text, "### Policy Skills (load the matching one)");
        text = dropSkillBullets(text, "## Operating Contract (Mandatory - Do Not Skip)");
    }
    const parts = [text];
    for (const s of picked) {
        parts.push(`# Policy: ${s.name}\n\n${stripFrontmatter(s.text).replace(/^<!-- enigma:[^>]*-->\n?/gm, "")}`);
    }
    let out = parts.join("\n\n");
    if (opts.compact) out = compactText(out);
    out = tidy(out);
    return { text: out, sha256: createHash("sha256").update(out).digest("hex"), skills: picked.map((s) => s.name) };
}
