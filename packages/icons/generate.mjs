#!/usr/bin/env node
// Generate the icon package's source from icon-map.json and a set of drawings.
//
// One module per icon, one barrel per category, and a barrel per weight. That shape is what
// lets a bundler drop what an app never renders: the package declares no side effects, so an
// unused export is unreachable code and never reaches the output. Nothing resolves at
// runtime and no icon data is fetched at install time - the bodies are written here as
// plain strings.
//
// Usage:
//   node generate.mjs --set <path/to/icons.json> --weight <name> [--out src]
//
// THERE IS NO DEFAULT WEIGHT. Every weight is a directory of its own and an icon is always
// asked for by the weight it is drawn in, so no weight is privileged by living at the root
// and adding the hundredth one changes nothing about the first.
//
// WEIGHT IS A BUILD DIMENSION, NOT A PROP. A `weight` prop would have to reach every body at
// runtime, which puts all of them in the bundle for any icon the app imports and destroys
// the one thing this package is for.
//
// The root of `--out` holds only what the weights SHARE: the component factory and the brand
// re-exports, which are real logos and have no visual weight to pick.
//
// The set is a build-time input, not a dependency of the published package: it is read here
// and the bodies the map names are copied out.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = resolve(HERE, "icon-map.json");

const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const { icons, brands, weights } = JSON.parse(readFileSync(MAP, "utf8"));
const available = weights?.available ?? [];

const SET = arg("--set", null);
const WEIGHT = arg("--weight", null);
if (!SET || !existsSync(SET) || !WEIGHT) {
    console.error("usage: node generate.mjs --set <path/to/icons.json> --weight <name> [--out src]");
    console.error(`weights declared in icon-map.json: ${available.join(", ") || "(none)"}`);
    process.exit(1);
}
if (!available.includes(WEIGHT)) {
    console.error(`Unknown weight '${WEIGHT}'. icon-map.json declares: ${available.join(", ") || "(none)"}.`);
    console.error("Add it to `weights.available` and give each icon its name under `glyphs` first.");
    process.exit(1);
}

const ROOT = resolve(HERE, arg("--out", "src"));
const OUT = resolve(ROOT, WEIGHT);

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
     * disappears. Kept in the signature so a stroked weight can be imported in
     * place of a filled one without touching the call sites that pass it.
     */
    stroke?: number | string;
} & Omit<SVGProps<SVGSVGElement>, "stroke" | "size">;

/**
 * The shape of one icon component: a forwardRef so a parent can measure or
 * focus it, and so \`typeof SomeIcon\` types a parameter the way call sites expect.
 * Every weight produces this same type, so a component that takes an icon as a
 * prop accepts any of them.
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

/**
 * What this icon is called in the requested weight.
 *
 * Written out per weight in the map rather than derived by swapping a suffix: a set is free
 * to name a weight's glyph anything at all, and guessing it produces an icon that silently
 * renders nothing.
 */
const glyphFor = (spec) => spec.glyphs?.[WEIGHT];

const drawings = JSON.parse(readFileSync(SET, "utf8")).icons;

// A name that is missing, or not in the set, does not throw at runtime - it renders an empty
// square forever - so it has to fail here instead.
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

rmSync(OUT, { recursive: true, force: true });
mkdirSync(resolve(OUT, "icons"), { recursive: true });
mkdirSync(resolve(OUT, "categories"), { recursive: true });

// Shared by every weight, so it is written once at the root rather than copied into each.
writeFileSync(resolve(ROOT, "icon.tsx"), FACTORY, "utf8");

const names = Object.keys(icons).sort();
const byCategory = new Map();
let bytes = 0;

for (const name of names) {
    const { category } = icons[name];
    const glyph = glyphFor(icons[name]);
    const body = drawings[glyph].body;
    bytes += body.length;
    const file = `// ${name} - ${glyph}. GENERATED, do not hand-edit.
import { icon } from "../../icon";

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
    "// Every icon in this weight. There is no default weight: an icon is always asked",
    "// for by the weight it is drawn in.",
    "",
];
for (const name of names) index.push(`export { ${name} } from "./icons/${name}";`);
index.push("");
writeFileSync(resolve(OUT, "index.ts"), index.join("\n"), "utf8");

// A namespace export needs an identifier, so the category's display name becomes one:
// "Arrows Action" -> arrowsAction. The display name stays in the comment.
const catIndex = ["// GENERATED, do not hand-edit.", ""];
for (const category of categories) {
    catIndex.push(`// ${category}`);
    catIndex.push(`export * as ${camel(category)} from "./${slug(category)}";`);
}
writeFileSync(resolve(OUT, "categories", "index.ts"), `${catIndex.join("\n")}\n`, "utf8");

// The root barrel is the same for every weight, so it is rewritten on each run rather than
// owned by one of them: the types the factory exports, and the brand marks, which are real
// logos and have no weight to choose.
const root = [
    "// GENERATED, do not hand-edit. Run: node generate.mjs --set <set.json> --weight <name>",
    "//",
    "// The root carries what every weight shares. Icons are NOT here: there is no default",
    "// weight, so each one is imported from the weight it is drawn in:",
    "//   import { IconMapPin } from \"@<scope>/icons/bold-duotone\";",
    "//   import { IconMapPin } from \"@<scope>/icons/bold-duotone/icons/IconMapPin\";",
    "",
    "export type { Icon, IconProps } from \"./icon\";",
    "",
    "// Brand marks keep their real logo: this set has none, and drawing one by hand is worse",
    "// than shipping the real mark. A logo has no visual weight, so they live at the root.",
    "export {",
];
// No comma after the last entry: a trailing one in a named export list is a style violation
// here, and the generator is the only thing that writes this file.
const sortedBrands = [...brands].sort();
for (const [position, brand] of sortedBrands.entries()) {
    root.push(`    ${brand}${position === sortedBrands.length - 1 ? "" : ","}`);
}
root.push("} from \"@tabler/icons-react\";", "");
writeFileSync(resolve(ROOT, "index.ts"), root.join("\n"), "utf8");

process.stdout.write(
    `${WEIGHT}: ${names.length} icons in ${categories.length} categories, ${(bytes / 1024).toFixed(0)} KB of bodies\n`,
);
