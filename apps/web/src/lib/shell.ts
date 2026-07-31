// Shared client helpers for the install command: a dependency-free shell highlighter and a
// clipboard copy with a synchronous fallback. Imported by the landing page and /start so the
// logic lives in one place.

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/**
 * Color a shell command: program names (start, and after a pipe/&&/;), flags, URLs and
 * operators. Returns HTML; the plain command is recoverable from the element's textContent.
 */
export function highlightShell(cmd: string): string {
    let cmdPos = true;
    return cmd.split(/(\s+)/).map((tok) => {
        if (/^\s+$/.test(tok) || tok === "") return tok;
        if (/^[|&;]+$/.test(tok)) { cmdPos = true; return `<span class="t-op">${esc(tok)}</span>`; }
        if (/:\/\//.test(tok)) { cmdPos = false; return `<span class="t-url">${esc(tok)}</span>`; }
        if (tok.startsWith("-")) { cmdPos = false; return `<span class="t-flag">${esc(tok)}</span>`; }
        if (cmdPos) { cmdPos = false; return `<span class="t-cmd">${esc(tok)}</span>`; }
        return esc(tok);
    }).join("");
}

function fallbackCopy(text: string): boolean {
    try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch { return false; }
}

/** Copy text to the clipboard, falling back to execCommand when the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { return fallbackCopy(text); }
}

// ── Install command (shared by the landing hero and /start) ──────────────────────────

// curl is the recommended script; npm is the preferred package manager, with pnpm/yarn/bun
// for those who use them; npx is one-shot. Single source of truth for both pages.
export const INSTALL_METHODS: Record<string, string> = {
    curl: "curl -fsSL https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.sh | sh",
    powershell: "irm https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.ps1 | iex",
    npm: "npm install -g enigma-cli@latest && enigma install",
    pnpm: "pnpm add -g enigma-cli@latest && enigma install",
    yarn: "yarn global add enigma-cli@latest && enigma install",
    bun: "bun add -g enigma-cli@latest && enigma install",
    npx: "npx enigma-cli@latest install --all --yes",
};
// The visitor's last-chosen method, so /start shows the same one they picked on the landing.
export const INSTALL_STORE_KEY = "enigma-install-method";

export function isWindows(): boolean {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string; }; };
    return /win/i.test(nav.userAgentData?.platform || navigator.platform || navigator.userAgent || "");
}

/**
 * Resolve a method id to its command and a short label. The `curl` script has no `sh` on
 * Windows, so it defaults to the PowerShell one-liner there; package-manager methods are OS-agnostic.
 */
export function resolveInstall(method?: string | null): { id: string; command: string; label: string; } {
    let id = method && method in INSTALL_METHODS ? method : "curl";
    if (id === "curl" && isWindows()) id = "powershell";
    const labels: Record<string, string> = { curl: "macOS / Linux", powershell: "Windows (PowerShell)" };
    return { id, command: INSTALL_METHODS[id], label: labels[id] ?? id };
}

export function savedInstallMethod(): string | null {
    try { return localStorage.getItem(INSTALL_STORE_KEY); } catch { return null; }
}
export function saveInstallMethod(id: string): void {
    try { localStorage.setItem(INSTALL_STORE_KEY, id); } catch { /* storage may be blocked */ }
}
