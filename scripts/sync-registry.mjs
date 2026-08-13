/**
 * Copy each component package's registry.json into the CLI's assets.
 *
 * The bundled copy is a DISCOVERY fallback only: `enigma add` still prefers the
 * registry inside the package installed in the project, so the catalogue an agent
 * reads matches the API that project compiles against. This copy exists so the
 * catalogue can be listed before anything is installed.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["primitives", "utils"];

let copied = 0;
for (const name of packages) {
    const source = join(root, "packages", name, "registry.json");
    if (!existsSync(source)) {
        console.error(`sync-registry: missing ${source}`);
        process.exitCode = 1;
        continue;
    }
    const target = join(root, "packages", "enigma-cli", "assets", "registry", name, "registry.json");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied++;
}

console.log(`sync-registry: ${copied}/${packages.length} registries copied into the CLI assets.`);
