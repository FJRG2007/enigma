/**
 * tokens/colors.json, spacing.json and typography.json: the profile as structured data,
 * for tooling and for agents that prefer JSON over prose.
 */

import { join } from "node:path";
import type { DesignProfile } from "../types";
import { mkdirSync, writeFileSync } from "node:fs";

const CORE_ROLES = new Set(["background", "surface", "text-primary", "text-muted", "accent", "border"]);
const STATUS_ROLES = new Set(["danger", "success", "warning"]);
const SIZE_LABELS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"];

function write(dir: string, name: string, data: unknown): void {
    writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function writeTokensJson(profile: DesignProfile, skillDir: string, extractedOn: string): void {
    const dir = join(skillDir, "tokens");
    mkdirSync(dir, { recursive: true });

    const core: Record<string, unknown> = {}, status: Record<string, unknown> = {}, extended: Record<string, unknown> = {};
    for (const color of profile.colors) {
        const token = { value: color.hex, role: color.role, ...(color.name ? { name: color.name } : {}) };
        if (CORE_ROLES.has(color.role)) core[color.role] = token;
        else if (STATUS_ROLES.has(color.role)) status[color.role] = token;
        else extended[color.name ? color.name.replace(/\s+/g, "-").toLowerCase() : color.hex.replace("#", "color-")] = token;
    }
    write(dir, "colors.json", { core, status, extended, meta: { theme: profile.designTraits.isDark ? "dark" : "light", extracted: extractedOn } });

    const { base, values, unit } = profile.spacing;
    const sorted = [...values].sort((a, b) => a - b);
    write(dir, "spacing.json", {
        base: { value: `${base}px`, description: "Grid unit: every spacing value is a multiple of this" },
        unit,
        scale: Object.fromEntries(sorted.slice(0, SIZE_LABELS.length).map((v, i) => [SIZE_LABELS[i], { value: `${v}${unit}`, px: v }])),
        multipliers: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${i + 1}x`, { value: `${base * (i + 1)}px`, raw: base * (i + 1) }])),
        meta: { totalValues: values.length, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 },
    });

    write(dir, "typography.json", {
        families: [...new Set(profile.typography.map((t) => t.fontFamily).filter(Boolean))],
        scale: Object.fromEntries(profile.typography.map((t) => [t.role, {
            fontFamily: t.fontFamily, fontSize: t.fontSize ?? null, fontWeight: t.fontWeight ?? null, lineHeight: t.lineHeight ?? null, source: t.source,
        }])),
        fontFaces: profile.fontSources.map((s) => ({ family: s.family, src: s.src, format: s.format ?? "truetype", weight: s.weight ?? "400" })),
        rules: { maxSizesPerScreen: 4, headingWeightRange: "600-700", bodyWeight: 400, lineHeightBody: 1.5, lineHeightHeading: 1.2 },
    });
}
