import { type Page } from "@playwright/test";

export interface Sample {
    /** performance.now() at the frame, in ms. */
    time: number;
    /** The translated axis of the track's computed transform, in px. */
    value: number;
}

/**
 * Sample the track's real transform on every animation frame.
 *
 * Reads `new DOMMatrixReadOnly(getComputedStyle(track).transform)` rather than
 * the engine's own state, so the test cannot pass on a number the engine merely
 * believes. Everything else in this file derives from these samples.
 */
export async function sampleTransform(page: Page, ms: number, axis: "x" | "y" = "x"): Promise<Sample[]> {
    return page.evaluate(async ({ ms, axis }) => {
        const track = document.querySelector("[data-testid=track]") as HTMLElement;
        const samples: { time: number; value: number; }[] = [];
        await new Promise<void>(resolve => {
            const start = performance.now();
            const tick = (now: number) => {
                const matrix = new DOMMatrixReadOnly(getComputedStyle(track).transform);
                samples.push({ time: now, value: axis === "x" ? matrix.m41 : matrix.m42 });
                if (now - start >= ms) resolve();
                else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        return samples;
    }, { ms, axis });
}

/** The measured lap, straight off the running instance. */
export async function period(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __marquee: { period: number; }; }).__marquee.period);
}

/**
 * Per-frame speed in px/s, positive when the row scrolls forward.
 *
 * The transform is the negated offset, so a forward lap makes it fall. A delta
 * past half a period is the loop wrapping, not a jump: add the period back.
 * The first samples are discarded - the first rAF delta after installing the
 * sampler is near zero and produces a meaningless spike.
 */
export function toSpeeds(samples: Sample[], lap: number, discard = 3): number[] {
    const speeds: number[] = [];
    for (let index = discard; index < samples.length - 1; index++) {
        const dt = (samples[index + 1].time - samples[index].time) / 1000;
        if (dt <= 0) continue;
        let delta = samples[index + 1].value - samples[index].value;
        if (delta > lap / 2) delta -= lap;
        if (delta < -lap / 2) delta += lap;
        speeds.push(-delta / dt);
    }
    return speeds;
}

export function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Largest single-frame movement in px. A resize must not produce one bigger than a cruise frame. */
export function largestFrameStep(samples: Sample[], lap: number, discard = 3): number {
    let largest = 0;
    for (let index = discard; index < samples.length - 1; index++) {
        let delta = samples[index + 1].value - samples[index].value;
        if (delta > lap / 2) delta -= lap;
        if (delta < -lap / 2) delta += lap;
        largest = Math.max(largest, Math.abs(delta));
    }
    return largest;
}
