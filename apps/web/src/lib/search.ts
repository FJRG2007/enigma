import { getCollection, render } from "astro:content";

// One searchable record per doc heading (plus one per doc for its title/description).
// Built entirely at build time and serialized into the page; the client just runs Fuse.
export interface SearchRecord {
    page: string;   // route slug (collection entry id)
    id: string;     // heading anchor, "" for the doc itself
    title: string;  // heading text (or doc title)
    group: string;  // sidebar group / doc title, for context in results
    text: string;   // plain-text snippet of the section
}

// Reduce raw Markdown/MDX to plain text for fuzzy matching. Strips MDX component syntax
// (imports, JSX expressions, tag attributes, tags) so result snippets read as prose.
const strip = (md: string): string =>
    md
        .replace(/```[\s\S]*?```/g, " ")            // fenced code
        .replace(/`[^`]*`/g, " ")                   // inline code
        .replace(/import[\s\S]*?from\s+["'][^"']+["'];?/g, " ") // mdx imports
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")      // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")    // links -> text
        .replace(/\{[\s\S]*?\}/g, " ")              // jsx expressions, e.g. ex={[...]}
        .replace(/\b[\w-]+="[^"]*"/g, " ")          // tag attributes, e.g. name="..."
        .replace(/<\/?[A-Za-z][^>]*>/g, " ")        // component / html tags
        .replace(/[#>*_~|`-]+/g, " ")               // md punctuation
        .replace(/\s+/g, " ")
        .trim();

export async function buildSearchIndex(): Promise<SearchRecord[]> {
    const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
    const records: SearchRecord[] = [];
    for (const entry of docs) {
        const { headings } = await render(entry);
        const page = entry.id;
        records.push({ page, id: "", title: entry.data.title, group: entry.data.title, text: strip(entry.data.description) });
        // Pair each "## heading" with the body text up to the next "## ".
        const sections = (entry.body ?? "").split(/^##\s+/m).slice(1);
        const h2s = headings.filter((h) => h.depth === 2);
        h2s.forEach((h, i) => {
            const section = sections[i] ? sections[i].replace(/^.*(\r?\n|$)/, "") : "";
            records.push({ page, id: h.slug, title: h.text, group: entry.data.title, text: strip(section).slice(0, 220) });
        });
    }
    return records;
}
