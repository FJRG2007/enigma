#!/usr/bin/env node
// Generate the icon package's source from icon-map.json and a set of drawings.
//
// One module per icon, one barrel per category, and a root index that re-exports
// everything. That shape is what lets a bundler drop what an app never renders:
// the package declares no side effects, so an unused export is unreachable code
// and never reaches the output. Nothing resolves at runtime and no icon data is
// fetched at install time - the bodies are written here as plain strings.
//
// Usage:
//   node generate.mjs --set <path/to/icons.json> [--out src]
//
// The set is a build-time input, not a dependency of the published package: it
// is read here and the ~400 bodies the map names are copied out. The full set
// is several thousand icons, of which this keeps about five percent.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = resolve(HERE, "icon-map.json");

const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = resolve(HERE, arg("--out", "src"));
const SET = arg("--set", null);
if (!SET || !existsSync(SET)) {
    console.error("usage: node generate.mjs --set <path/to/icons.json> [--out src]");
    process.exit(1);
}

/** A category name to its module slug: "Text Formatting" -> "text-formatting". */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The same name as a JS identifier: "Text Formatting" -> textFormatting. */
const camel = (name) => slug(name).replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());

const FACTORY = `import { forwardRef } from "react";
import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

export type IconProps = {
    className?: string;
    size?: number | string;
    /**
     * Accepted and ignored. These icons are filled, not stroked, so there is no
     * line to widen - and forwarding a number into the SVG \`stroke\` attribute,
     * which takes a COLOUR, paints the icon with an invalid value until it
     * disappears. Kept in the signature so a stroked set can be swapped out
     * without touching the call sites that pass it.
     */
    stroke?: number | string;
} & Omit<SVGProps<SVGSVGElement>, "stroke" | "size">;

/**
 * The shape of one icon component: a forwardRef so a parent can measure or
 * focus it, and so \`typeof SomeIcon\` types a parameter the way call sites expect.
 */
export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/**
 * Build one icon component around its vendored body.
 *
 * The body is a constant written by the generator, never anything a caller
 * supplies, which is what makes dangerouslySetInnerHTML the right tool here
 * rather than a hole. Both paths of a duotone glyph carry fill="currentColor",
 * so colour comes from the surrounding text colour and nothing else.
 */
export function icon(name: string, body: string): Icon {
    const Component = forwardRef<SVGSVGElement, IconProps>(
        ({ className, size = 24, stroke: _stroke, ...rest }, ref) => (
            <svg
                ref={ref}
                className={className}
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden
                {...rest}
                dangerouslySetInnerHTML={{ __html: body }}
            />
        ),
    );
    Component.displayName = name;
    return Component;
}
`;

const { icons, brands } = JSON.parse(readFileSync(MAP, "utf8"));
const drawings = JSON.parse(readFileSync(SET, "utf8")).icons;

// A name that is not in the set does not throw at runtime - it renders an empty
// square forever - so it has to fail here instead.
const missing = Object.entries(icons).filter(([, spec]) => !drawings[spec.glyph]);
if (missing.length > 0) {
    console.error("Names not present in the icon set:");
    for (const [name, spec] of missing.slice(0, 10)) console.error(`    ${name} -> ${spec.glyph}`);
    process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(resolve(OUT, "icons"), { recursive: true });
mkdirSync(resolve(OUT, "categories"), { recursive: true });

writeFileSync(resolve(OUT, "icon.tsx"), FACTORY, "utf8");

const names = Object.keys(icons).sort();
const byCategory = new Map();
let bytes = 0;

for (const name of names) {
    const { glyph, category } = icons[name];
    const body = drawings[glyph].body;
    bytes += body.length;
    const file = `// ${name} - ${glyph}. GENERATED, do not hand-edit.
import { icon } from "../icon";

export const ${name} = icon(${JSON.stringify(name)}, ${JSON.stringify(body)});
`;
    writeFileSync(resolve(OUT, "icons", `${name}.tsx`), file, "utf8");
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(name);
}

const categories = [...byCategory.keys()].sort();
for (const category of categories) {
    const members = byCategory.get(category).sort();
    const lines = [`// ${category}. GENERATED, do not hand-edit.`];
    for (const name of members) lines.push(`export { ${name} } from "../icons/${name}";`);
    writeFileSync(resolve(OUT, "categories", `${slug(category)}.ts`), `${lines.join("\n")}\n`, "utf8");
}

const index = [
    "// GENERATED, do not hand-edit. Run: node generate.mjs --set <set.json>",
    "//",
    "// Import from the root for a single icon (the bundler keeps only that module),",
    "// or from a category when you want the group:",
    "//   import { IconMapPin } from \"@<scope>/icons\";",
    "//   import { IconMapPin } from \"@<scope>/icons/categories/map\";",
    "",
    "export type { Icon, IconProps } from \"./icon\";",
    "",
];
for (const name of names) index.push(`export { ${name} } from "./icons/${name}";`);
index.push("", "// Brand marks keep their real logo: this set has none, and drawing one by hand");
index.push("// is worse than shipping the real mark.", "export {");
// No comma after the last entry: a trailing one in a named export list is a style
// violation here, and the generator is the only thing that writes this file.
const sortedBrands = [...brands].sort();
for (const [position, brand] of sortedBrands.entries()) {
    index.push(`    ${brand}${position === sortedBrands.length - 1 ? "" : ","}`);
}
index.push("} from \"@tabler/icons-react\";", "");
writeFileSync(resolve(OUT, "index.ts"), index.join("\n"), "utf8");

// A namespace export needs an identifier, so the category's display name becomes
// one: "Arrows Action" -> arrowsAction. The display name stays in the comment.
const catIndex = ["// GENERATED, do not hand-edit.", ""];
for (const category of categories) {
    catIndex.push(`// ${category}`);
    catIndex.push(`export * as ${camel(category)} from "./${slug(category)}";`);
}
writeFileSync(resolve(OUT, "categories", "index.ts"), `${catIndex.join("\n")}\n`, "utf8");

process.stdout.write(
    `${names.length} icons in ${categories.length} categories, ${brands.length} brand re-exports, ${(bytes / 1024).toFixed(0)} KB of bodies\n`,
);
