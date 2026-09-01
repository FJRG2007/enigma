/**
 * Keyboard shortcuts as data: parsed from a string, matched against an event, and written
 * back out the way the platform writes them.
 *
 * Two components need the same three things and would otherwise each get their own half of
 * them - the context menu prints a shortcut beside an action, and the selection list matches
 * one against a key press. A menu whose label says `Ctrl+A` while the list listens for
 * `Meta+A` is the defect that shape produces, so both read this file.
 *
 * `Mod` is the whole point of the spec being a string. It means Command on an Apple keyboard
 * and Control everywhere else, which is what every one of these shortcuts actually means -
 * hardcoding either one is wrong on half the machines.
 */

/** One shortcut, normalized. `mod` and `ctrl`/`meta` are exclusive: `Mod` sets only `mod`. */
export interface Shortcut {
    /** The `KeyboardEvent.key` to match, lowercased for letters (`a`, `f2`, `delete`, ` `). */
    key: string;
    /** Command on an Apple platform, Control elsewhere. */
    mod?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    alt?: boolean;
}

/** The parts of a key press a shortcut reads. A real KeyboardEvent satisfies it. */
export interface ShortcutEvent {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
}

/**
 * A shortcut as written: `"Mod+A"`, `"Shift+F10"`, `"Delete"`, `"Ctrl+Shift+N"`. A list means
 * several presses do the same thing, and `false` means the command has no binding at all.
 */
export type ShortcutSpec = string | Shortcut | readonly (string | Shortcut)[] | false;

const MODIFIERS = new Set(["mod", "ctrl", "control", "meta", "cmd", "command", "super", "win", "shift", "alt", "option", "opt"]);

/** Names that are not one character but are one key. Written the way `KeyboardEvent.key` spells them. */
const NAMED: Record<string, string> = {
    esc: "escape",
    escape: "escape",
    del: "delete",
    delete: "delete",
    back: "backspace",
    backspace: "backspace",
    enter: "enter",
    return: "enter",
    space: " ",
    spacebar: " ",
    tab: "tab",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    arrowup: "arrowup",
    arrowdown: "arrowdown",
    arrowleft: "arrowleft",
    arrowright: "arrowright",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
    plus: "+"
};

/**
 * Whether this is an Apple keyboard, and so whether `Mod` is Command.
 *
 * `navigator.platform` is deprecated and still the only reliable answer where it exists, so
 * it is tried first and the user agent is the fallback. A server has neither and gets `false`,
 * which is the right guess: a label rendered on the server is corrected on hydration, and a
 * key press cannot happen there at all.
 */
export function isApplePlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const source = navigator.platform || navigator.userAgent || "";
    return /mac|iphone|ipad|ipod/i.test(source);
}

/** `"Mod+Shift+A"` -> the shortcut it stands for. Unknown words are treated as the key. */
export function parseShortcut(spec: string | Shortcut): Shortcut {
    if (typeof spec !== "string") return { ...spec, key: normalizeKey(spec.key) };

    const shortcut: Shortcut = { key: "" };
    // Split on + and - so `Ctrl-A` reads the same as `Ctrl+A`, but never on a LONE separator:
    // `Ctrl++` and `Ctrl+-` are real shortcuts whose key is the separator itself.
    const parts = spec.split(/[+-](?!$)/).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return { key: normalizeKey(spec.trim()) };

    parts.forEach((part, index) => {
        const word = part.toLowerCase();
        const last = index === parts.length - 1;
        // The last word is the KEY even when it names a modifier: `Shift` alone is a
        // shortcut, and so is the `Alt` in `Ctrl+Alt`.
        if (!last && MODIFIERS.has(word)) {
            applyModifier(shortcut, word);
            return;
        }
        if (last && MODIFIERS.has(word) && parts.length > 1) {
            applyModifier(shortcut, word);
            return;
        }
        shortcut.key = normalizeKey(part);
    });

    // `Ctrl+Alt` with no key left: the trailing modifier IS the key.
    if (!shortcut.key) shortcut.key = normalizeKey(parts[parts.length - 1]);
    return shortcut;
}

function applyModifier(shortcut: Shortcut, word: string): void {
    if (word === "mod") shortcut.mod = true;
    else if (word === "ctrl" || word === "control") shortcut.ctrl = true;
    else if (word === "meta" || word === "cmd" || word === "command" || word === "super" || word === "win") shortcut.meta = true;
    else if (word === "shift") shortcut.shift = true;
    else shortcut.alt = true;
}

/**
 * `KeyboardEvent.key` as this file compares it: lowercase, with the aliases resolved.
 *
 * NOT trimmed, and that is the whole comment: the space bar reports its key as `" "`, so
 * trimming here turns Ctrl+Space into Ctrl+nothing and the binding silently never matches.
 * The spec's own words are trimmed where they are split instead.
 */
function normalizeKey(key: string): string {
    const lower = key.toLowerCase();
    return NAMED[lower] ?? lower;
}

/** A spec as a list, so one binding and several read the same downstream. */
export function shortcutList(spec: ShortcutSpec): Shortcut[] {
    if (spec === false || spec == null) return [];
    const entries = Array.isArray(spec) ? spec : [spec as string | Shortcut];
    return entries.map(parseShortcut);
}

/**
 * Whether a key press is this shortcut.
 *
 * Every modifier is checked, including the ones the shortcut does NOT ask for: `Delete` must
 * not fire on `Ctrl+Delete`, which means something else in every file manager there is. Shift
 * is the one exception the caller can waive, because a shifted letter arrives as a different
 * `key` on some layouts.
 */
export function matchesShortcut(event: ShortcutEvent, spec: ShortcutSpec, apple = isApplePlatform()): boolean {
    return shortcutList(spec).some((shortcut) => matchesOne(event, shortcut, apple));
}

function matchesOne(event: ShortcutEvent, shortcut: Shortcut, apple: boolean): boolean {
    const key = normalizeKey(event.key);
    // `Mod` resolves to exactly one physical modifier, so Ctrl+A on a Mac is NOT Cmd+A: it
    // is the terminal's start-of-line, and a list that stole it would be the thing at fault.
    const wantCtrl = Boolean(shortcut.ctrl || (shortcut.mod && !apple));
    const wantMeta = Boolean(shortcut.meta || (shortcut.mod && apple));
    return key === shortcut.key
        && Boolean(event.ctrlKey) === wantCtrl
        && Boolean(event.metaKey) === wantMeta
        && Boolean(event.shiftKey) === Boolean(shortcut.shift)
        && Boolean(event.altKey) === Boolean(shortcut.alt);
}

/**
 * The shortcut written the way this platform writes it, as tokens.
 *
 * Tokens rather than a string because that is what a menu renders: one `<kbd>` per key, so
 * `Ctrl` and `A` can be spaced and styled apart. `shortcutText` joins them for anything that
 * only has room for a string.
 */
export function shortcutTokens(spec: string | Shortcut, apple = isApplePlatform()): string[] {
    const shortcut = parseShortcut(spec);
    const tokens: string[] = [];
    // Apple's own order, which is also the order Windows uses for the modifiers it has:
    // Control, Option/Alt, Shift, Command.
    if (shortcut.ctrl || (shortcut.mod && !apple)) tokens.push(apple ? "⌃" : "Ctrl");
    if (shortcut.alt) tokens.push(apple ? "⌥" : "Alt");
    if (shortcut.shift) tokens.push(apple ? "⇧" : "Shift");
    if (shortcut.meta || (shortcut.mod && apple)) tokens.push(apple ? "⌘" : "Win");
    tokens.push(keyLabel(shortcut.key, apple));
    return tokens;
}

/** One string, for a `title`, an `aria-keyshortcuts` neighbour, or a menu with no room. */
export function shortcutText(spec: string | Shortcut, apple = isApplePlatform()): string {
    return shortcutTokens(spec, apple).join(apple ? "" : "+");
}

const KEY_LABELS: Record<string, string> = {
    " ": "Space",
    escape: "Esc",
    enter: "Enter",
    backspace: "Backspace",
    delete: "Del",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    pageup: "PgUp",
    pagedown: "PgDn"
};

/** The glyphs an Apple keyboard prints on its own keys, which is what its menus show. */
const APPLE_KEY_LABELS: Record<string, string> = {
    delete: "⌦",
    backspace: "⌫",
    enter: "↩",
    escape: "esc"
};

function keyLabel(key: string, apple: boolean): string {
    if (apple && APPLE_KEY_LABELS[key]) return APPLE_KEY_LABELS[key];
    const named = KEY_LABELS[key];
    if (named) return named;
    // A function key is upper case whole (`F2`); a letter is one capital.
    return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * How long a typeahead buffer survives. Long enough to type a word, short enough to reset
 * before the next thing you meant.
 */
export const TYPEAHEAD_MS = 600;

/** The buffer between two presses: what has been typed, and when. */
export interface TypeaheadState {
    typed: string;
    at: number;
}

export interface TypeaheadStep extends TypeaheadState {
    /** What to look for. The buffer, or its one repeated character - see below. */
    needle: string;
    /**
     * Whether this press CYCLES through the rows starting with the letter rather than refining
     * what the last one found. True for a single letter and for the same letter pressed again,
     * which is the rule every desktop list follows: "rrr" is not a word anybody is typing, it
     * is someone walking through the Rs.
     */
    cycle: boolean;
}

/**
 * Advance a typeahead buffer.
 *
 * Shared because two lists in this package do the same thing with it - a select with no filter
 * and a menu - and a buffer that timed out differently in the two would be felt as one of them
 * being broken.
 */
export function typeaheadStep(state: TypeaheadState, character: string, now = Date.now(), windowMs = TYPEAHEAD_MS): TypeaheadStep {
    const typed = now - state.at > windowMs ? character : state.typed + character;
    const repeated = typed.length > 1 && [...typed].every((letter) => letter === typed[0]);
    return {
        typed,
        at: now,
        needle: repeated ? typed[0] : typed,
        cycle: typed.length === 1 || repeated
    };
}
