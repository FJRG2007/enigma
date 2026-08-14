import { useRef, useMemo, useSyncExternalStore } from "react";
import { createNetworkMonitor, SERVER_NETWORK_STATE, type NetworkState } from "@/core/network";

/**
 * Connection state, kept in sync through useSyncExternalStore.
 *
 * ```tsx
 * const { online, recovered, slow } = useNetworkState();
 *
 * useEffect(() => {
 *     if (!online) notify({ key: "net", title: "No connection", tone: "error" });
 *     else if (recovered) notify({ key: "net", title: "Back online", tone: "success" });
 * }, [online, recovered]);
 * ```
 *
 * `recovered` is false on a first load, so a page that opens online never announces a
 * recovery that did not happen - the bug every hand-rolled `wasOffline` flag starts with.
 */
export function useNetworkState(): NetworkState {
    // One monitor per component, torn down with it. The listeners are shared browser
    // events, so a handful of these costs nothing.
    const monitor = useMemo(() => createNetworkMonitor(), []);
    const snapshot = useRef(monitor.state);

    return useSyncExternalStore(
        (listener) => monitor.subscribe((next) => {
            snapshot.current = next;
            listener();
        }),
        () => snapshot.current,
        () => SERVER_NETWORK_STATE
    );
}
