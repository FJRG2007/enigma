/**
 * The one-page repo report: what a new session reads instead of exploring.
 *
 * WHY. Every fresh session (and every one after a `/clear`) spent its first calls orienting -
 * listing directories, opening READMEs, grepping for the entry point - and each of those calls
 * re-read the whole context. Graphify's GRAPH_REPORT.md answers that with one plain-language page;
 * this is the same idea built from enigma's graph, sized to be injected at session start:
 *
 *  - AREAS, not directories: files grouped by how densely they depend on each other
 *    (codegraph-cluster.ts), each labelled by where most of its files live, with its most-used
 *    definitions, the docs that belong to it, and the areas it leans on.
 *  - DOCS: the project's own notes and READMEs with their titles, so "is there a note about X" is
 *    answered without a search.
 *  - Somebody else's code is left out (vendored SDKs, references, examples, fixtures): its hubs
 *    are real in-degree, but naming them as this project's hotspots misdirects (a vendored Ruby SDK
 *    used to own the top of this repo's map).
 */

import * as cg from "./codegraph";
import * as rank from "./codegraph-rank";
import { isCodeLang, isForeignPath } from "./codegraph-extract";
import { clusterFiles, type FileLink } from "./codegraph-cluster";

export interface ReportSymbol { name: string; kind: string; path: string; line: number; inDegree: number; }

export interface ReportArea {
    label: string;
    files: number;
    languages: string[];
    keySymbols: ReportSymbol[];
    docs: string[];
    dependsOn: string[];
}

export interface GraphReport {
    name: string;
    totals: { files: number; symbols: number; edges: number; inferred: number; docs: number; };
    areas: ReportArea[];
    /** Areas past the cap, and files in no area (no dependency edge at all). */
    moreAreas: number;
    docs: { path: string; title: string; }[];
    moreDocs: number;
    /** Files left out as somebody else's material. */
    foreign: number;
    truncated: boolean;
}

export interface ReportOptions { project?: string; refresh?: boolean; maxAreas?: number; maxDocs?: number; }

const DEFAULT_MAX_AREAS = 8;
const DEFAULT_MAX_DOCS = 12;
const KEY_SYMBOLS = 3;
const AREA_DOCS = 2;
const DEPENDS_ON = 2;

/** Share of an area's files a directory must hold to name the area. */
const LABEL_SHARE = 0.6;

/** The deepest directory holding at least LABEL_SHARE of the files, or the most common top directory. */
function areaLabel(paths: string[]): string {
    const dirs = paths.map((p) => p.split("/").slice(0, -1));
    let label: string[] = [];
    for (let depth = 1; ; depth++) {
        const counts = new Map<string, number>();
        for (const d of dirs) if (d.length >= depth) { const k = d.slice(0, depth).join("/"); counts.set(k, (counts.get(k) ?? 0) + 1); }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        if (!top || top[1] / paths.length < LABEL_SHARE) break;
        label = top[0].split("/");
    }
    if (label.length) return `${label.join("/")}/`;
    if (paths.length === 1) return paths[0];
    const first = new Map<string, number>();
    for (const d of dirs) { const k = d[0] ?? "(root)"; first.set(k, (first.get(k) ?? 0) + 1); }
    const [top] = [...first.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return `${top}/ (mixed)`;
}

/** Build the report from the stored graph. Null when the project has never been indexed. */
export function codeGraphReport(opts: ReportOptions = {}): GraphReport | null {
    const graph = cg.loadFreshGraph(opts.project, opts.refresh ?? true);
    if (!graph) return null;
    const nodes = cg.graphNodes(graph);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const langByPath = new Map(graph.files.map((f) => [f.path, f.lang]));
    const own = graph.files.filter((f) => !isForeignPath(f.path));
    // Areas are made of CODE: notes and config cluster with whatever they happen to link, which
    // labelled areas after a docs folder and mixed a vendored skill's pages into the codebase's.
    const codePaths = new Set(own.filter((f) => isCodeLang(f.lang)).map((f) => f.path));
    const docPaths = new Set(own.filter((f) => f.lang === "markdown").map((f) => f.path));

    // File-level dependency weights, both directions summed: clustering asks "how tied are these".
    const weights = new Map<string, number>();
    const directed = new Map<string, number>();
    const docRefs = new Map<string, Map<string, number>>();
    for (const e of graph.edges) {
        if (e[2] === "contains") continue;
        const a = byId.get(e[0])?.path;
        const b = byId.get(e[1])?.path;
        if (!a || !b || a === b) continue;
        if (docPaths.has(a) && codePaths.has(b)) {
            const refs = docRefs.get(a) ?? new Map<string, number>();
            refs.set(b, (refs.get(b) ?? 0) + 1);
            docRefs.set(a, refs);
            continue;
        }
        if (!codePaths.has(a) || !codePaths.has(b)) continue;
        const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
        directed.set(`${a}\n${b}`, (directed.get(`${a}\n${b}`) ?? 0) + 1);
    }
    const links: FileLink[] = [...weights.entries()].map(([k, w]) => { const [a, b] = k.split("\n"); return [a, b, w]; });
    const areaOf = clusterFiles([...codePaths], links);

    const members = new Map<number, string[]>();
    for (const [path, area] of areaOf) { const list = members.get(area); if (list) list.push(path); else members.set(area, [path]); }
    const deg = rank.inDegree(graph.edges, true);
    const maxAreas = opts.maxAreas ?? DEFAULT_MAX_AREAS;
    const ranked = [...members.entries()].filter(([, paths]) => paths.length >= 2).sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);

    const keyOf = (paths: string[]): ReportSymbol[] => {
        const inArea = new Set(paths);
        return nodes
            .filter((n) => n.kind !== "file" && inArea.has(n.path) && !rank.isTestPath(n.path))
            .map((n) => ({ name: n.name, kind: n.kind, path: n.path, line: n.line, inDegree: deg.get(n.id) ?? 0 }))
            .filter((sym) => sym.inDegree > 0)
            .sort((a, b) => b.inDegree - a.inDegree || a.name.localeCompare(b.name))
            .slice(0, KEY_SYMBOLS);
    };
    const keys = new Map(ranked.map(([area, paths]) => [area, keyOf(paths)]));
    // Two areas under one directory get told apart by what they are built around.
    const base = new Map(ranked.map(([area, paths]) => [area, areaLabel(paths)]));
    const seenLabel = new Map<string, number>();
    for (const label of base.values()) seenLabel.set(label, (seenLabel.get(label) ?? 0) + 1);
    const labels = new Map([...base.entries()].map(([area, label]) => {
        const around = keys.get(area)?.[0]?.name;
        return [area, (seenLabel.get(label) ?? 0) > 1 && around ? `${label} ~ ${around}` : label];
    }));

    // Each doc belongs to the area whose code it links or names most.
    const docsOf = new Map<number, string[]>();
    for (const [doc, refs] of docRefs) {
        const byArea = new Map<number, number>();
        for (const [code, w] of refs) { const area = areaOf.get(code); if (area !== undefined) byArea.set(area, (byArea.get(area) ?? 0) + w); }
        const best = [...byArea.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (!best) continue;
        const list = docsOf.get(best[0]) ?? [];
        list.push(doc);
        docsOf.set(best[0], list);
    }

    const areas: ReportArea[] = ranked.slice(0, maxAreas).map(([area, paths]) => {
        const inArea = new Set(paths);
        const out = new Map<number, number>();
        for (const [key, w] of directed) {
            const [a, b] = key.split("\n");
            if (!inArea.has(a) || inArea.has(b)) continue;
            const target = areaOf.get(b);
            if (target !== undefined && target !== area && labels.has(target)) out.set(target, (out.get(target) ?? 0) + w);
        }
        return {
            label: labels.get(area)!,
            files: paths.length,
            languages: [...new Set(paths.map((p) => langByPath.get(p)).filter((l): l is string => !!l))].sort(),
            keySymbols: keys.get(area) ?? [],
            docs: (docsOf.get(area) ?? []).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, AREA_DOCS),
            dependsOn: [...out.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, DEPENDS_ON).map(([t]) => labels.get(t)!),
        };
    });

    // The project's own docs, shallowest first: READMEs and docs/ before anything nested deep.
    const titleOf = new Map<string, string>();
    for (const n of nodes) if (n.kind === "section" && !titleOf.has(n.path)) titleOf.set(n.path, n.name);
    const docFiles = own.filter((f) => f.lang === "markdown")
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;

    return {
        name: graph.name,
        totals: {
            files: graph.files.length,
            symbols: nodes.length - graph.files.length,
            edges: graph.edges.length,
            inferred: graph.edges.filter((e) => e[3] === 1).length,
            docs: docFiles.length,
        },
        areas,
        moreAreas: Math.max(0, ranked.length - areas.length),
        docs: docFiles.slice(0, maxDocs).map((f) => ({ path: f.path, title: titleOf.get(f.path) ?? "" })),
        moreDocs: Math.max(0, docFiles.length - maxDocs),
        foreign: graph.files.length - own.length,
        truncated: graph.truncated,
    };
}

/** The report as the agent reads it: plain lines, one area per block, no decoration. */
export function formatReport(r: GraphReport): string {
    const t = r.totals;
    const lines = [`repo report - ${r.name} - ${t.files} files (${t.docs} docs) - ${t.symbols} symbols - ${t.edges} edges (${t.inferred} inferred by name)`];
    if (r.foreign) lines.push(`${r.foreign} file(s) of vendored, reference or example material are left out of the areas below.`);
    lines.push("", "areas (files that depend on each other, largest first):");
    for (const a of r.areas) {
        lines.push(`- ${a.label} - ${a.files} files${a.languages.length ? ` - ${a.languages.join(", ")}` : ""}`);
        if (a.keySymbols.length) lines.push(`    key: ${a.keySymbols.map((s) => `${s.name} (${s.path}:${s.line}, ${s.inDegree} in)`).join(", ")}`);
        if (a.dependsOn.length) lines.push(`    uses: ${a.dependsOn.join(", ")}`);
        if (a.docs.length) lines.push(`    docs: ${a.docs.join(", ")}`);
    }
    if (r.moreAreas) lines.push(`  +${r.moreAreas} smaller area(s)`);
    if (r.docs.length) {
        lines.push("", "docs:");
        for (const d of r.docs) lines.push(`- ${d.path}${d.title ? ` - ${d.title}` : ""}`);
        if (r.moreDocs) lines.push(`  +${r.moreDocs} more (enigma_codegraph_ask finds them by topic)`);
    }
    if (r.truncated) lines.push("", "The index hit its size cap; some files are not covered.");
    return `${lines.join("\n")}\n`;
}
