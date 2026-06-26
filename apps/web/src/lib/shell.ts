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
