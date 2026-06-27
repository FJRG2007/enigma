/**
 * At-rest encryption for the few secrets enigma must persist in .enigma.json (today: the
 * recall provider API key). The goal is modest and explicit: keep credentials out of plain
 * text on disk. It is NOT a defense against an attacker who already has read access to the
 * user's home dir - the key sits beside the data, like an SSH key's own file permissions.
 *
 * Scheme: AES-256-GCM with a per-machine 32-byte key auto-generated at ~/.enigma.key (0600).
 * Encrypted values carry an "enc:v1:" prefix; decryptSecret returns any unprefixed value
 * unchanged, so older plain-text keys keep working and re-save encrypted on the next write.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function keyPath(): string {
    return join(enigmaHome(), ".enigma.key");
}

/** Load the machine key, generating and persisting it (0600) on first use. */
function loadKey(): Buffer {
    const path = keyPath();
    if (existsSync(path)) {
        const hex = readFileSync(path, "utf8").trim();
        const key = Buffer.from(hex, "hex");
        if (key.length === KEY_BYTES) return key;
    }
    const key = randomBytes(KEY_BYTES);
    // mode 0600 protects the key on POSIX; on Windows it is a no-op but harmless.
    writeFileSync(path, key.toString("hex"), { mode: 0o600 });
    return key;
}

/** Whether a stored value is one of our encrypted blobs (vs. legacy plain text). */
export function isEncryptedSecret(value: string): boolean {
    return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. An empty string stays empty (it means "no secret"), and an
 * already-encrypted value is returned as-is so re-saving an unchanged key is idempotent.
 */
export function encryptSecret(plain: string): string {
    if (!plain) return "";
    if (isEncryptedSecret(plain)) return plain;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored secret. Unprefixed values are returned unchanged (legacy plain text), and
 * any malformed/undecryptable blob returns "" - a lost key degrades to "no secret" rather
 * than throwing, so a corrupt file never breaks a sync.
 */
export function decryptSecret(stored: string): string {
    if (!stored) return "";
    if (!isEncryptedSecret(stored)) return stored;
    try {
        const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
        if (!ivB64 || !tagB64 || !ctB64) return "";
        const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(ivB64, "base64"));
        decipher.setAuthTag(Buffer.from(tagB64, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
    } catch { return ""; }
}
