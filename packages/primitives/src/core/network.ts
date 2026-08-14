/**
 * Connection state: online/offline plus whatever the Network Information API will say.
 *
 * The part worth not rewriting is the TRANSITION. "You are back online" needs to know the
 * connection had dropped, and every implementation of that ends up as a stray `wasOffline`
 * boolean next to the effect, re-derived per screen and wrong the first time the page
 * loads offline. It is tracked here instead.
 */

export interface NetworkState {
    online: boolean;
    /** Estimated downlink in Mbps. Null where the browser does not report it. */
    downlink: number | null;
    downlinkMax: number | null;
    /** "slow-2g" | "2g" | "3g" | "4g", or null. */
    effectiveType: string | null;
    /** Estimated round-trip time in ms. */
    rtt: number | null;
    /** The visitor asked for reduced data use. */
    saveData: boolean | null;
    /** "wifi" | "cellular" | "ethernet" | ..., or null. */
    type: string | null;
    /**
     * The connection dropped earlier and is back. False on a first load, so a page that
     * opens online never announces a recovery that did not happen.
     */
    recovered: boolean;
    /** On a connection worth degrading for: 2g or slower, or data saver on. */
    slow: boolean;
}

export interface NetworkMonitor {
    readonly state: NetworkState;
    subscribe(listener: (state: NetworkState) => void): () => void;
    destroy(): void;
}

/** What a server render sees. Assuming offline would flash a warning on every page. */
export const SERVER_NETWORK_STATE: NetworkState = {
    online: true,
    downlink: null,
    downlinkMax: null,
    effectiveType: null,
    rtt: null,
    saveData: null,
    type: null,
    recovered: false,
    slow: false
};

interface ConnectionLike extends EventTarget {
    downlink?: number;
    downlinkMax?: number;
    effectiveType?: string;
    rtt?: number;
    saveData?: boolean;
    type?: string;
}

/** Still prefixed in some browsers, and absent entirely in Safari. */
function connection(): ConnectionLike | null {
    if (typeof navigator === "undefined") return null;
    const nav = navigator as Navigator & {
        connection?: ConnectionLike;
        mozConnection?: ConnectionLike;
        webkitConnection?: ConnectionLike;
    };
    return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

function shallowEqual(left: NetworkState, right: NetworkState): boolean {
    for (const key of Object.keys(left) as (keyof NetworkState)[]) {
        if (left[key] !== right[key]) return false;
    }
    return true;
}

export function createNetworkMonitor(): NetworkMonitor {
    // Nothing to observe during a server render; the snapshot stands in.
    if (typeof window === "undefined") {
        return {
            get state() { return SERVER_NETWORK_STATE; },
            subscribe() { return () => { /* nothing changes */ }; },
            destroy() { /* nothing to release */ }
        };
    }

    const listeners = new Set<(state: NetworkState) => void>();
    let hasBeenOffline = false;
    let state = read();

    function read(): NetworkState {
        const link = connection();
        const online = navigator.onLine;
        const effectiveType = link?.effectiveType ?? null;
        const saveData = link?.saveData ?? null;
        return {
            online,
            downlink: link?.downlink ?? null,
            downlinkMax: link?.downlinkMax ?? null,
            effectiveType,
            rtt: link?.rtt ?? null,
            saveData,
            type: link?.type ?? null,
            recovered: online && hasBeenOffline,
            slow: saveData === true || effectiveType === "2g" || effectiveType === "slow-2g"
        };
    }

    function update(): void {
        if (!navigator.onLine) hasBeenOffline = true;
        const next = read();
        // The connection object fires `change` for readings that did not change; an
        // identical object would re-render every subscriber for nothing.
        if (shallowEqual(state, next)) return;
        state = next;
        for (const listener of listeners) listener(state);
    }

    const link = connection();
    window.addEventListener("online", update, { passive: true });
    window.addEventListener("offline", update, { passive: true });
    link?.addEventListener("change", update, { passive: true });

    return {
        get state() { return state; },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        destroy() {
            listeners.clear();
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
            link?.removeEventListener("change", update);
        }
    };
}
