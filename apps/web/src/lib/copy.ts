/**
 * The one copy-to-clipboard button on this site.
 *
 * There were two: the one the docs script bolts onto every code block, and the one inside
 * `<Command>`. They looked alike and behaved differently - one swapped its icon for a tick
 * and only on a confirmed write, the other kept its icon, went green for a different length
 * of time, and reported success even when the fallback had failed. Two implementations of
 * one affordance always drift; this is the shared one.
 */

export const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
export const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

/** How long the tick stays before the button goes back to offering a copy. */
const CONFIRM_MS = 1600;

/**
 * Write to the clipboard, and say whether it worked.
 *
 * The async API is blocked outright by some clipboard-guard extensions and unavailable
 * outside a secure context, so `execCommand` stands in - and its return value is checked,
 * because the fallback silently doing nothing while the button flashes a tick is worse than
 * no button at all.
 */
export async function writeClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const scratch = document.createElement("textarea");
            scratch.value = text;
            // Fixed and invisible: appending it inline scrolls the page to the bottom.
            scratch.style.position = "fixed";
            scratch.style.opacity = "0";
            document.body.append(scratch);
            scratch.focus();
            scratch.select();
            const ok = document.execCommand("copy");
            scratch.remove();
            return ok;
        } catch {
            return false;
        }
    }
}

/** Wire a button to copy whatever `read` returns, with the tick as the confirmation. */
export function bindCopy(button: HTMLButtonElement, read: () => string): void {
    let timer: ReturnType<typeof setTimeout> | null = null;

    button.addEventListener("click", async () => {
        // Nothing is shown until the write is CONFIRMED: a tick over a clipboard that did
        // not change is a lie the reader only finds out about on paste.
        if (!(await writeClipboard(read()))) return;

        button.innerHTML = CHECK_ICON;
        button.classList.add("done");
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            button.innerHTML = COPY_ICON;
            button.classList.remove("done");
        }, CONFIRM_MS);
    });
}
