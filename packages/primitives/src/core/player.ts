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

/* -------- what a source IS -------- */

/**
 * The MIME types worth naming from a file extension, and nothing else.
 *
 * Deliberately short. A `<source>` with no `type` makes the browser fetch and sniff, which
 * costs a request and always works; a `<source>` with the WRONG type is skipped outright, and
 * the video then does not play at all. So a guess is more expensive than silence, and only
 * extensions that mean one thing are in here.
 */
const SOURCE_TYPES: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    m3u8: "application/vnd.apple.mpegurl",
    mpd: "application/dash+xml"
};

/**
 * The type a URL's extension implies, or undefined.
 *
 * Read from the PATH, so a query string or a fragment cannot be mistaken for one -
 * `/clip.mp4?token=...` is still an mp4, and `/download?file=x.webm` is not a webm, because
 * the extension has to be on the path's last segment. A `blob:` or `data:` URL has no
 * extension to read and gets nothing, which is the right answer: the browser sniffs.
 */
export function sourceType(url: string): string | undefined {
    let path = url;
    try {
        path = new URL(url, typeof location === "undefined" ? "https://localhost" : location.href).pathname;
    } catch {
        path = url.split("?")[0]!.split("#")[0]!;
    }
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return undefined;
    return SOURCE_TYPES[name.slice(dot + 1).toLowerCase()];
}

/* -------- captions -------- */

/** One subtitle track, as the menu lists it. */
export interface CaptionTrack {
    /** Where it sits in the element's own `textTracks`, which is what turns it on. */
    index: number;
    label: string;
    language: string;
}

/** Which of the element's text tracks are subtitles a viewer would choose between. */
export function captionTracks(list: TextTrackList | null | undefined): CaptionTrack[] {
    if (!list) return [];
    const found: CaptionTrack[] = [];
    for (let at = 0; at < list.length; at += 1) {
        const track = list[at];
        // Chapters and metadata are for the page, not for the viewer: listing them offers a
        // language picker entry that draws nothing over the picture.
        if (!track || (track.kind !== "subtitles" && track.kind !== "captions")) continue;
        found.push({ index: at, label: track.label || track.language || `Track ${found.length + 1}`, language: track.language });
    }
    return found;
}

/**
 * The track the element is SHOWING, or -1.
 *
 * Read rather than remembered: a `default` track is showing before any button was pressed, and
 * a player that assumed "off" would need two presses to turn something off.
 */
export function activeCaption(list: TextTrackList | null | undefined): number {
    if (!list) return -1;
    for (let at = 0; at < list.length; at += 1) if (list[at]?.mode === "showing") return at;
    return -1;
}

/**
 * Show one track and disable the rest. -1 turns them all off.
 *
 * "disabled" rather than "hidden": a hidden track still fires its cues, so a page listening to
 * `cuechange` for its own transcript would keep receiving a language nobody asked for.
 */
export function showCaption(list: TextTrackList | null | undefined, index: number): void {
    if (!list) return;
    for (let at = 0; at < list.length; at += 1) {
        const track = list[at];
        if (track) track.mode = at === index ? "showing" : "disabled";
    }
}

/* -------- casting: the remote screen this is played on -------- */

/** What the cast control knows about the world. */
export interface RemoteState {
    /** There is somewhere to cast TO. Before the browser has looked, this is optimistic. */
    available: boolean;
    /** Playing on that screen right now. */
    connected: boolean;
}

interface RemotePlaybackLike {
    state: "connected" | "connecting" | "disconnected";
    watchAvailability: (callback: (available: boolean) => void) => Promise<number>;
    cancelWatchAvailability: (id: number) => Promise<void>;
    prompt: () => Promise<void>;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
}

/** The element, with the two spellings of "play this somewhere else" on it. */
type CastableVideo = HTMLVideoElement & {
    remote?: RemotePlaybackLike;
    /** Safari's AirPlay picker, which predates the standard and is still the only one it has on iOS. */
    webkitShowPlaybackTargetPicker?: () => void;
    webkitCurrentPlaybackTargetIsWireless?: boolean;
};

/**
 * Whether this element can be cast at all.
 *
 * `disableRemotePlayback` is honoured: a page that asked for the button to be gone does not
 * get one drawn over its video by a component.
 */
export function supportsRemote(video: HTMLVideoElement | null): boolean {
    const element = video as CastableVideo | null;
    if (!element || element.disableRemotePlayback) return false;
    return Boolean(element.remote?.prompt ?? element.webkitShowPlaybackTargetPicker);
}

/**
 * Watch for a screen to cast to, and for the connection to it.
 *
 * WHY AVAILABILITY IS OPTIMISTIC WHEN THE WATCH FAILS. `watchAvailability` rejects with
 * NotSupportedError on the platforms that can still `prompt()` - Safari, and Chromium for some
 * sources - so treating a rejection as "no devices" hides a control that works. A button that
 * opens an empty picker is a smaller loss than a missing one.
 */
export function watchRemote(video: HTMLVideoElement, onChange: (state: RemoteState) => void): () => void {
    const element = video as CastableVideo;
    const state: RemoteState = { available: false, connected: false };
    const publish = (next: Partial<RemoteState>): void => {
        Object.assign(state, next);
        onChange({ ...state });
    };

    if (element.remote) {
        const remote = element.remote;
        const onState = (): void => publish({ connected: remote.state === "connected" });
        let watch: number | null = null;
        let cancelled = false;

        remote.watchAvailability((available) => { if (!cancelled) publish({ available }); })
            .then((id) => {
                if (cancelled) void remote.cancelWatchAvailability(id).catch(() => { /* already gone */ });
                else watch = id;
            })
            .catch(() => { if (!cancelled) publish({ available: true }); });

        for (const name of ["connect", "connecting", "disconnect"]) remote.addEventListener(name, onState);
        onState();

        return () => {
            cancelled = true;
            for (const name of ["connect", "connecting", "disconnect"]) remote.removeEventListener(name, onState);
            if (watch !== null) void remote.cancelWatchAvailability(watch).catch(() => { /* already gone */ });
        };
    }

    const onAvailability = (event: Event): void => publish({ available: (event as Event & { availability?: string; }).availability === "available" });
    const onWireless = (): void => publish({ connected: Boolean(element.webkitCurrentPlaybackTargetIsWireless) });
    element.addEventListener("webkitplaybacktargetavailabilitychanged", onAvailability);
    element.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
    onWireless();

    return () => {
        element.removeEventListener("webkitplaybacktargetavailabilitychanged", onAvailability);
        element.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
    };
}

/**
 * Open the browser's own device picker.
 *
 * There is no list to draw ourselves: both APIs hand the choice to the platform, which is the
 * only thing that can enumerate the screens on the network.
 */
export async function promptRemote(video: HTMLVideoElement): Promise<void> {
    const element = video as CastableVideo;
    if (element.remote?.prompt) return void await element.remote.prompt();
    element.webkitShowPlaybackTargetPicker?.();
}
