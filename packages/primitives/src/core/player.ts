/**
 * The arithmetic behind the video player: times, seeking, buffering, volume and the keys.
 *
 * None of it is rendering, so it is testable without a browser and reusable by a page that
 * draws its own controls - the same split the colour maths and the image viewer's are in.
 */

/** The playback rates the settings menu offers, in the order it lists them. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** How far the arrows seek, in seconds, and what a bigger jump moves by. */
export const SEEK_STEP = 5;
export const SEEK_JUMP = 10;
export const VOLUME_STEP = 0.05;

/**
 * Seconds as a clock, sized by the LONGEST time it will have to show.
 *
 * `duration` is what stops the label changing width mid-playback: a 1h04m video passing 10:00
 * would otherwise go from `9:59` to `10:00` to `1:00:00`, and every control after it moves.
 */
export function formatTime(seconds: number, duration = seconds): string {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const withHours = Number.isFinite(duration) && duration >= 3600;

    const pad = (value: number): string => String(value).padStart(2, "0");
    if (withHours || hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
    return `${minutes}:${pad(rest)}`;
}

/** A time as a fraction of the duration, safe before the metadata says what that is. */
export function progress(time: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(Math.max(time / duration, 0), 1);
}

/** Where a press on a horizontal rail lands, as a fraction of it. */
export function fractionAt(box: { left: number; width: number; }, clientX: number): number {
    if (!box.width) return 0;
    return Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
}

/**
 * How much is buffered AHEAD of where playback is.
 *
 * The range under the playhead, not the largest one: a viewer who seeks past the buffer is
 * looking at a bar that says nothing is loaded, which is true of the part they are watching.
 */
export function bufferedAhead(ranges: TimeRanges | null, time: number, duration: number): number {
    if (!ranges || !Number.isFinite(duration) || duration <= 0) return 0;
    for (let at = 0; at < ranges.length; at += 1) {
        if (ranges.start(at) <= time && ranges.end(at) >= time) return Math.min(ranges.end(at) / duration, 1);
    }
    return 0;
}

/** The next rate in the list, wrapping - what a repeated press on the speed row does. */
export function nextSpeed(current: number, step = 1): number {
    const at = SPEEDS.indexOf(current as typeof SPEEDS[number]);
    const from = at === -1 ? SPEEDS.indexOf(1) : at;
    return SPEEDS[(from + step + SPEEDS.length) % SPEEDS.length] as number;
}

/** What a key press means, or null when the player should leave it to the page. */
export type PlayerCommand =
    | { type: "toggle"; }
    | { type: "seek"; by: number; }
    | { type: "seekTo"; fraction: number; }
    | { type: "volume"; by: number; }
    | { type: "mute"; }
    | { type: "fullscreen"; }
    | { type: "captions"; }
    | { type: "pip"; };

/**
 * The shortcuts, as the platform's video players define them.
 *
 * Space and K play, J and L jump ten, the arrows nudge five and the volume, M mutes, F is
 * fullscreen, C captions, and a digit seeks to that tenth of the video.
 */
export function commandFor(key: string): PlayerCommand | null {
    if (key === " " || key === "k" || key === "K") return { type: "toggle" };
    if (key === "ArrowRight") return { type: "seek", by: SEEK_STEP };
    if (key === "ArrowLeft") return { type: "seek", by: -SEEK_STEP };
    if (key === "l" || key === "L") return { type: "seek", by: SEEK_JUMP };
    if (key === "j" || key === "J") return { type: "seek", by: -SEEK_JUMP };
    if (key === "ArrowUp") return { type: "volume", by: VOLUME_STEP };
    if (key === "ArrowDown") return { type: "volume", by: -VOLUME_STEP };
    if (key === "m" || key === "M") return { type: "mute" };
    if (key === "f" || key === "F") return { type: "fullscreen" };
    if (key === "c" || key === "C") return { type: "captions" };
    if (key === "p" || key === "P") return { type: "pip" };
    if (key >= "0" && key <= "9") return { type: "seekTo", fraction: Number(key) / 10 };
    return null;
}

/**
 * Whether a key press belongs to the page rather than to the player.
 *
 * A shortcut that fires while somebody is typing turns their space bar into a pause, so the
 * player stands down inside anything that takes text.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== "string") return false;
    if (element.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/** Whether the document is showing something fullscreen, across the two spellings of it. */
export function fullscreenElement(): Element | null {
    if (typeof document === "undefined") return null;
    const legacy = document as Document & { webkitFullscreenElement?: Element | null; };
    return document.fullscreenElement ?? legacy.webkitFullscreenElement ?? null;
}

/**
 * Fullscreen, including the one platform that will not give it to a container.
 *
 * iOS Safari has no Fullscreen API on an arbitrary element: the only thing that can fill the
 * screen is the video itself, through `webkitEnterFullscreen`. Without that branch the button
 * does nothing at all on an iPhone, which is where most video is watched.
 */
export async function toggleFullscreen(container: HTMLElement, video: HTMLVideoElement | null): Promise<void> {
    const legacyDocument = document as Document & { webkitExitFullscreen?: () => Promise<void>; };
    if (fullscreenElement()) {
        await (document.exitFullscreen?.() ?? legacyDocument.webkitExitFullscreen?.());
        return;
    }

    const legacyElement = container as HTMLElement & { webkitRequestFullscreen?: () => Promise<void>; };
    if (container.requestFullscreen) return void await container.requestFullscreen();
    if (legacyElement.webkitRequestFullscreen) return void await legacyElement.webkitRequestFullscreen();

    const iosVideo = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void; }) | null;
    iosVideo?.webkitEnterFullscreen?.();
}

/** Picture in picture, where the browser has it. Firefox has its own button and no API. */
export function supportsPip(): boolean {
    return typeof document !== "undefined" && Boolean(document.pictureInPictureEnabled);
}

export async function togglePip(video: HTMLVideoElement): Promise<void> {
    if (document.pictureInPictureElement) return void await document.exitPictureInPicture();
    await video.requestPictureInPicture();
}
