import { resolve } from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

/** The two packages a component page can be documenting. */
const PACKAGES = ["primitives", "utils"] as const;

interface RegistryItem {
    name: string;
    /** The file a reader should be sent to, relative to the package. */
    source?: string;
}

/**
 * A package's catalogue, from the checkout first and the installed copy second.
 *
 * The same order `recipe()` reads in, and for the same reason: this site lives inside the
 * monorepo, so building it from a clone should describe what that clone contains rather than
 * whatever was published when the site was last installed.
 */
function read(pkg: string): RegistryItem[] {
    const local = resolve(process.cwd(), "..", "..", "packages", pkg, "registry.json");
    const path = existsSync(local) ? local : require.resolve(`@enigmax/${pkg}/registry.json`);
    return (JSON.parse(readFileSync(path, "utf8")) as { items: RegistryItem[]; }).items;
}

const catalogue = new Map(PACKAGES.flatMap((pkg) => read(pkg).map((item) => [item.name, { pkg, item }] as const)));

/**
 * Where a component's own code lives, as a path from the root of the repository.
 *
 * Read from the registry rather than built from the page's slug. The slug is not the file
 * name and never was: the player's core is `player.ts`, the viewer's is `image-viewer.ts`,
 * the toast's is a renderer over `notifications.ts`, and `notifications` itself moved from
 * one package to the other. A guessed path is a "source" link that 404s, which is worse than
 * no link at all - and it fails silently, because nobody clicks their own footer.
 */
export function sourcePath(name: string): string | null {
    const found = catalogue.get(name);
    return found?.item.source ? `packages/${found.pkg}/${found.item.source}` : null;
}
