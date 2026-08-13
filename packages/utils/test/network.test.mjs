import test from "node:test";
import assert from "node:assert/strict";
import { createNetworkMonitor, SERVER_NETWORK_STATE } from "../dist/index.js";

test("a server render reports online without inventing a connection", () => {
    // There is no window here, so this is the branch a server actually takes.
    const monitor = createNetworkMonitor();
    assert.deepEqual(monitor.state, SERVER_NETWORK_STATE);
    assert.equal(monitor.state.online, true, "assuming offline would flash a warning on every page");
    assert.equal(monitor.state.recovered, false);
    monitor.destroy();
});

test("subscribing on the server is inert but still returns an unsubscribe", () => {
    const monitor = createNetworkMonitor();
    const off = monitor.subscribe(() => assert.fail("nothing can change without a window"));
    assert.equal(typeof off, "function");
    off();
    monitor.destroy();
});
