/**
 * Install-time hook: fetch the host's enigma binary from its GitHub Release.
 *
 * This is best-effort and NEVER fails the install. If the download fails (offline,
 * proxy, unsupported platform) or scripts are skipped entirely (`npm i
 * --ignore-scripts`), the launcher (bin/enigma.mjs) downloads on first run instead.
 * That keeps `npm install` robust while still verifying the binary before use.
 */

import { loadChecksums } from "./platform.mjs";
import { downloadBinary, installedBinary } from "./download.mjs";

async function main() {
    // An explicit binary (dev/CI) or one already installed: nothing to do.
    if (process.env.ENIGMA_BIN_PATH || installedBinary()) return;
    // No checksums.json means this is a source checkout / workspace install, not a
    // published tarball - there is no release to fetch from, so stay silent.
    if (Object.keys(loadChecksums()).length === 0) return;

    try {
        await downloadBinary({ log: (message) => process.stdout.write(`enigma: ${message}\n`) });
        // Next-step hint: the binary is ready, but skills only deploy when the user
        // asks (explicit consent for writes to agent config dirs). After that first
        // install, launching a tool via enigma keeps the deployment auto-synced.
        process.stdout.write(
            "enigma: ready. Next step: run `enigma` to set up your agents " +
            "(non-interactive: `enigma install --all --yes`).\n",
        );
    } catch (error) {
        process.stdout.write(
            `enigma: could not download the binary now (${error.message}). ` +
            `It will be fetched automatically the first time you run \`enigma\`.\n`,
        );
        // Intentionally exit 0: a failed postinstall must not break `npm install`.
    }
}

await main();