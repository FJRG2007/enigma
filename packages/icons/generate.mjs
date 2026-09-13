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
//   node generate.mjs --set <path/to/icons.json> [--weight <name>] [--out src]
//
// WEIGHT IS A BUILD DIMENSION, NOT A PROP. A `weight` prop would have to reach
// every body at runtime, which puts all of them in the bundle for any icon the
// app imports and destroys the one thing this package is for. So each weight is
// generated into its own directory and addressed by its own subpath, and an app
// pays only for the weights it actually imports.
//
// The DEFAULT weight (declared in icon-map.json) is written to the root of
// `--out` so the package's main entry keeps working unchanged; every other
// weight is written to `<out>/<weight>/`.
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

const SET = arg("--set", null);
if (!SET || !existsSync(SET)) {
    console.error("usage: node generate.mjs --set <path/to/icons.json> [--weight <name>] [--out src]");
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
     * disappears. Kept in the signature so a stroked weight can be swapped in
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
 * rather than a hole. Every path carries fill="currentColor", so colour comes
 * from the surrounding text colour and nothing else.
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

const { icons, brands, weights } = JSON.parse(readFileSync(MAP, "utf8"));
const defaultWeight = weights?.default ?? "bold-duotone";
const available = weights?.available ?? [defaultWeight];

const WEIGHT = arg("--weight", defaultWeight);
if (!available.includes(WEIGHT)) {
    console.error(`Unknown weight '${WEIGHT}'. icon-map.json declares: ${available.join(", ")}.`);
    console.error("Add it to `weights.available` and give each icon its name under `glyphs` first.");
    process.exit(1);
}

const isDefault = WEIGHT === defaultWeight;
// The default weight owns the root of the output so the package's main entry is
// unchanged by this ever growing; another weight gets a directory of its own.
const OUT = resolve(HERE, arg("--out", "src"), isDefault ? "" : WEIGHT);
const FACTORY_IMPORT = isDefault ? "../icon" : "../../icon";

/**
 * What this icon is called in the requested weight.
 *
 * `glyph` is the default weight's name and every icon has one; another weight
 * reads `glyphs[weight]`, which is written out per icon rather than derived by
 * swapping a suffix - a set is free to name a weight's glyph anything at all,
 * and guessing it produces an icon that silently renders nothing.
 */
const glyphFor = (spec) => (isDefault ? spec.glyph : spec.glyphs?.[WEIGHT]);

const drawings = JSON.parse(readFileSync(SET, "utf8")).icons;

// A name that is missing, or not in the set, does not throw at runtime - it
// renders an empty square forever - so it has to fail here instead.
const unnamed = Object.entries(icons).filter(([, spec]) => !glyphFor(spec));
if (unnamed.length > 0) {
    console.error(`${unnamed.length} icon(s) have no name for weight '${WEIGHT}':`);
    for (const [name] of unnamed.slice(0, 10)) console.error(`    ${name}`);
    process.exit(1);
}
const missing = Object.entries(icons).filter(([, spec]) => !drawings[glyphFor(spec)]);
if (missing.length > 0) {
    console.error("Names not present in the icon set:");
    for (const [name, spec] of missing.slice(0, 10)) console.error(`    ${name} -> ${glyphFor(spec)}`);
    process.exit(1);
}

rmSync(resolve(OUT, "icons"), { recursive: true, force: true });
rmSync(resolve(OUT, "categories"), { recursive: true, force: true });
mkdirSync(resolve(OUT, "icons"), { recursive: true });
mkdirSync(resolve(OUT, "categories"), { recursive: true });

// One factory for every weight: it is the same component either way, so a second
// weight must not ship a second copy of it.
if (isDefault) writeFileSync(resolve(OUT, "icon.tsx"), FACTORY, "utf8");

const names = Object.keys(icons).sort();
const byCategory = new Map();
let bytes = 0;

for (const name of names) {
    const { category } = icons[name];
    const glyph = glyphFor(icons[name]);
    const body = drawings[glyph].body;
    bytes += body.length;
    const file = `// ${name} - ${glyph}. GENERATED, do not hand-edit.
import { icon } from "${FACTORY_IMPORT}";

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
    `// GENERATED, do not hand-edit. Run: node generate.mjs --set <set.json> --weight ${WEIGHT}`,
    "//",
    "// Import from the root for a single icon (the bundler keeps only that module),",
    "// or from a category when you want the group:",
    "//   import { IconMapPin } from \"@<scope>/icons\";",
    "//   import { IconMapPin } from \"@<scope>/icons/categories/map\";",
    "",
];
if (isDefault) index.push("export type { Icon, IconProps } from \"./icon\";", "");
for (const name of names) index.push(`export { ${name} } from "./icons/${name}";`);
if (isDefault) {
    index.push("", "// Brand marks keep their real logo: this set has none, and drawing one by hand");
    index.push("// is worse than shipping the real mark.", "export {");
    // No comma after the last entry: a trailing one in a named export list is a style
    // violation here, and the generator is the only thing that writes this file.
    const sortedBrands = [...brands].sort();
    for (const [position, brand] of sortedBrands.entries()) {
        index.push(`    ${brand}${position === sortedBrands.length - 1 ? "" : ","}`);
    }
    index.push("} from \"@tabler/icons-react\";");
}
index.push("");
writeFileSync(resolve(OUT, "index.ts"), index.join("\n"), "utf8");

// A namespace export needs an identifier, so the category's display name becomes
// one: "Arrows Action" -> arrowsAction. The display name stays in the comment.
const catIndex = ["// GENERATED, do not hand-edit.", ""];
for (const category of categories) {
    catIndex.push(`// ${category}`);
    catIndex.push(`export * as ${camel(category)} from "./${slug(category)}";`);
}
writeFileSync(resolve(OUT, "categories", "index.ts"), `${catIndex.join("\n")}\n`, "utf8");

const brandNote = isDefault ? `, ${brands.length} brand re-exports` : "";
process.stdout.write(
    `${WEIGHT}: ${names.length} icons in ${categories.length} categories${brandNote}, ${(bytes / 1024).toFixed(0)} KB of bodies\n`,
);
