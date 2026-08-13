/**
 * Button behaviour: what makes it unavailable, and everything that follows from that.
 *
 * Disabled, loading and a cooldown are three reasons for the same state, so they collapse
 * into one `available` the renderer reads, instead of three flags every call site has to
 * combine correctly. The element to render is reported rather than chosen, because a
 * framework-agnostic package cannot import next/link.
 */

/** Which tag the consumer should render. An href makes it a link, and a link is not a button. */
export type ButtonElement = "button" | "a";

export interface ButtonCooldown {
    /** How long the button stays unavailable after a press, in ms. */
    ms: number;
    /**
     * Survive a reload under this key. Without it the cooldown is in memory only, and a
     * refresh is a free retry - which is the whole thing a cooldown exists to prevent.
     */
    key?: string;
    storage?: "local" | "session";
}

export interface ButtonOptions {
    /** Turns into an `a`, and a link cannot be `disabled` - only `aria-disabled`. */
    href?: string;
    disabled?: boolean;
    /** Unavailable and busy. Set it yourself, or let an async `onPress` manage it. */
    loading?: boolean;
    /** ms, or the full shape for a cooldown that outlives a reload. */
    cooldown?: number | ButtonCooldown;
    /**
     * A single key that presses the button. Ignored while the visitor is typing, and
     * while any modifier is held, so it never steals a real shortcut.
     */
    shortcut?: string;
    /** Async work flips `loading` for its duration and only then starts the cooldown. */
    onPress?: (event?: Event) => void | Promise<void>;
    /** Called whenever anything below changes. */
    onChange?: (state: ButtonState) => void;
}

export interface ButtonState {
    /** The tag to render. */
    element: ButtonElement;
    /** Pressable: not disabled, not loading, not cooling down. */
    available: boolean;
    loading: boolean;
    disabled: boolean;
    /** ms left on the cooldown, 0 when there is none. */
    cooldown: number;
    /** The accessible name for the shortcut, when there is one. */
    shortcut: string | null;
}

export interface ButtonInstance {
    readonly state: ButtonState;
    /** Run the press as if it had been clicked. Ignored while unavailable. */
    press(event?: Event): Promise<void>;
    update(options: Partial<ButtonOptions>): void;
    /** Clear a cooldown early, including its stored entry. */
    reset(): void;
    subscribe(listener: (state: ButtonState) => void): () => void;
    destroy(): void;
}

const TICK_MS = 100;

function store(cooldown: ButtonCooldown): Storage | null {
    if (!cooldown.key || typeof window === "undefined") return null;
    try {
        const target = cooldown.storage === "local" ? window.localStorage : window.sessionStorage;
        const probe = "__enigma_probe__";
        target.setItem(probe, "1");
        target.removeItem(probe);
        return target;
    } catch {
        // Private-mode Safari exposes the object and throws on write.
        return null;
    }
}

function normalize(cooldown: ButtonOptions["cooldown"]): ButtonCooldown | null {
    if (cooldown == null) return null;
    return typeof cooldown === "number" ? { ms: cooldown } : cooldown;
}

/** A shortcut must not fire while the visitor is writing, or it types into the page. */
function isTyping(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    const tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}

export function createButton(options: ButtonOptions = {}): ButtonInstance {
    let opts: ButtonOptions = { ...options };
    let loading = Boolean(opts.loading);
    let readyAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let destroyed = false;
    const listeners = new Set<(state: ButtonState) => void>();

    const storageKey = () => {
        const cooldown = normalize(opts.cooldown);
        return cooldown?.key ? `enigma:cooldown:${cooldown.key}` : null;
    };

    function restore(): void {
        const cooldown = normalize(opts.cooldown);
        if (!cooldown) return;
        const target = store(cooldown);
        const key = storageKey();
        if (!target || !key) return;
        const saved = Number(target.getItem(key));
        // A stored time in the past is finished, not pending.
        if (Number.isFinite(saved) && saved > Date.now()) readyAt = saved;
    }

    function remaining(): number {
        return Math.max(0, readyAt - Date.now());
    }

    function snapshot(): ButtonState {
        const disabled = Boolean(opts.disabled);
        const cooldown = remaining();
        return {
            element: opts.href ? "a" : "button",
            available: !disabled && !loading && cooldown === 0,
            loading,
            disabled,
            cooldown,
            shortcut: opts.shortcut ?? null
        };
    }

    function emit(): void {
        const state = snapshot();
        opts.onChange?.(state);
        for (const listener of listeners) listener(state);
    }

    function stopTicking(): void {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
    }

    function startTicking(): void {
        if (timer !== null || remaining() === 0) return;
        timer = setInterval(() => {
            if (remaining() > 0) { emit(); return; }
            stopTicking();
            emit();
        }, TICK_MS);
    }

    function beginCooldown(): void {
        const cooldown = normalize(opts.cooldown);
        if (!cooldown || cooldown.ms <= 0) return;
        readyAt = Date.now() + cooldown.ms;
        const target = store(cooldown);
        const key = storageKey();
        if (target && key) {
            try { target.setItem(key, String(readyAt)); } catch { /* quota */ }
        }
        startTicking();
    }

    async function press(event?: Event): Promise<void> {
        if (destroyed || !snapshot().available) return;
        const result = opts.onPress?.(event);

        if (result instanceof Promise) {
            loading = true;
            emit();
            try {
                await result;
            } finally {
                loading = false;
                // The cooldown starts when the work FINISHES, not when it was asked for -
                // otherwise a slow request eats its own cooldown and the button is free
                // again the moment it returns.
                beginCooldown();
                emit();
            }
            return;
        }

        beginCooldown();
        emit();
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (!opts.shortcut || isTyping(event.target)) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key.toLowerCase() !== opts.shortcut.toLowerCase()) return;
        if (!snapshot().available) return;
        event.preventDefault();
        void press(event);
    }

    if (typeof window !== "undefined") {
        restore();
        startTicking();
        window.addEventListener("keydown", onKeyDown);
    }

    return {
        get state() { return snapshot(); },
        press,
        update(next: Partial<ButtonOptions>) {
            const hadCooldown = JSON.stringify(normalize(opts.cooldown));
            opts = { ...opts, ...next };
            if (next.loading !== undefined) loading = Boolean(next.loading);
            if (JSON.stringify(normalize(opts.cooldown)) !== hadCooldown) restore();
            emit();
        },
        reset() {
            readyAt = 0;
            stopTicking();
            const cooldown = normalize(opts.cooldown);
            const key = storageKey();
            if (cooldown && key) store(cooldown)?.removeItem(key);
            emit();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        destroy() {
            destroyed = true;
            stopTicking();
            listeners.clear();
            if (typeof window !== "undefined") window.removeEventListener("keydown", onKeyDown);
        }
    };
}
