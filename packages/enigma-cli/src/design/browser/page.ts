/**
 * One headless browser per run, and the page operations the extractors use: open a tab
 * at a desktop viewport, navigate and wait for the DOM, evaluate a script, screenshot
 * (viewport, full page or a clip), and move the mouse for hover states.
 *
 * Every step of a run shares the one browser (a tab each), so a full ultra extraction
 * costs one browser start rather than one per step.
 */

import { CdpConnection } from "./cdp";
import { launchBrowser, type LaunchedBrowser } from "./chrome";

export const VIEWPORT = { width: 1440, height: 900 };
/** Chrome cannot rasterize past this many pixels in one capture. */
const MAX_CAPTURE_HEIGHT = 16_000;

export interface Clip { x: number; y: number; width: number; height: number; }

export class Browser {
    private userAgent: string | null = null;

    private constructor(private readonly launched: LaunchedBrowser, readonly cdp: CdpConnection) {}

    static async launch(executable: string): Promise<Browser> {
        const launched = await launchBrowser(executable);
        try {
            const cdp = await CdpConnection.connect(launched.wsEndpoint);
            return new Browser(launched, cdp);
        } catch (err) {
            await launched.dispose();
            throw err;
        }
    }

    /**
     * The browser's own user agent minus the `Headless` marker: sites that block
     * headless browsers would otherwise serve a challenge page instead of their design.
     */
    private async desktopUserAgent(): Promise<string> {
        if (this.userAgent) return this.userAgent;
        const version = await this.cdp.send("Browser.getVersion");
        this.userAgent = String(version.userAgent ?? "").replace(/HeadlessChrome/g, "Chrome");
        return this.userAgent;
    }

    async newPage(): Promise<Page> {
        const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const page = new Page(this.cdp, String(targetId), String(sessionId));
        await page.init(await this.desktopUserAgent());
        return page;
    }

    async close(): Promise<void> {
        try { await this.cdp.send("Browser.close", {}, undefined, 5_000); } catch { /* the kill below covers it */ }
        this.cdp.close();
        await this.launched.dispose();
    }
}

export class Page {
    constructor(private readonly cdp: CdpConnection, private readonly targetId: string, private readonly sessionId: string) {}

    private send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
        return this.cdp.send(method, params, this.sessionId, timeoutMs);
    }

    async init(userAgent: string): Promise<void> {
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        await this.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
        if (userAgent) await this.send("Emulation.setUserAgentOverride", { userAgent });
        // A page that opens alert()/confirm() would otherwise stall every later command.
        this.cdp.on(this.sessionId, "Page.javascriptDialogOpening", () => {
            this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        });
    }

    /** Navigate and resolve once the DOM is parsed; rejects on a network error or timeout. */
    async goto(url: string, timeoutMs = 60_000): Promise<void> {
        const loaded = this.cdp.waitFor(this.sessionId, "Page.domContentEventFired", timeoutMs);
        loaded.catch(() => {});
        const res = await this.send("Page.navigate", { url }, timeoutMs);
        if (res.errorText) throw new Error(`cannot load ${url}: ${String(res.errorText)}`);
        await loaded;
    }

    wait(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Run `script` - the source of a browser-side function - with `arg`, returning its
     * JSON-serializable result. Scripts are plain JS strings because they run in the page,
     * not in this process.
     */
    async evaluate<T>(script: string, arg?: unknown): Promise<T> {
        const expression = `(${script})(${arg === undefined ? "" : JSON.stringify(arg)})`;
        const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        const details = res.exceptionDetails as { exception?: { description?: string; }; text?: string; } | undefined;
        if (details) throw new Error(details.exception?.description ?? details.text ?? "script failed");
        return (res.result as { value?: T; } | undefined)?.value as T;
    }

    async title(): Promise<string> {
        return this.evaluate<string>("() => document.title");
    }

    /** PNG of the viewport, or of `clip` in document coordinates. */
    async screenshot(clip?: Clip): Promise<Buffer> {
        const params: Record<string, unknown> = { format: "png" };
        if (clip) {
            params.clip = { ...clip, scale: 1 };
            params.captureBeyondViewport = true;
        }
        const res = await this.send("Page.captureScreenshot", params);
        return Buffer.from(String(res.data ?? ""), "base64");
    }

    /** PNG of the whole document (capped at MAX_CAPTURE_HEIGHT). */
    async fullPageScreenshot(): Promise<Buffer> {
        const metrics = await this.send("Page.getLayoutMetrics");
        const size = (metrics.cssContentSize ?? metrics.contentSize) as { width: number; height: number; };
        const width = Math.max(1, Math.ceil(Math.min(size.width, VIEWPORT.width * 2)));
        const height = Math.max(1, Math.ceil(Math.min(size.height, MAX_CAPTURE_HEIGHT)));
        return this.screenshot({ x: 0, y: 0, width, height });
    }

    /**
     * The text of every stylesheet the page loaded, cross-origin ones included. Script in
     * the page cannot read a cross-origin sheet's rules, but the DevTools CSS domain can,
     * and CDN-hosted CSS is where most production sites keep their keyframes.
     */
    async styleSheetTexts(limit = 200): Promise<string[]> {
        const ids: string[] = [];
        const off = this.cdp.on(this.sessionId, "CSS.styleSheetAdded", (params) => {
            const id = (params.header as { styleSheetId?: string; } | undefined)?.styleSheetId;
            if (id) ids.push(id);
        });
        try {
            await this.send("DOM.enable");
            // Enabling replays a styleSheetAdded event for every sheet already loaded.
            await this.send("CSS.enable");
            await this.wait(250);
        } finally { off(); }
        const texts: string[] = [];
        for (const styleSheetId of ids.slice(0, limit)) {
            try { texts.push(String((await this.send("CSS.getStyleSheetText", { styleSheetId })).text ?? "")); } catch { /* sheet went away */ }
        }
        await this.send("CSS.disable").catch(() => {});
        return texts;
    }

    async mouseMove(x: number, y: number): Promise<void> {
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    }

    async close(): Promise<void> {
        try { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* browser already gone */ }
    }
}
