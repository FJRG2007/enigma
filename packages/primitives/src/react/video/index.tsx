"use client";

import * as player from "@/core/player";
import { Rail } from "@/react/video/rail";
import * as icons from "@/react/video/icons";
import { VIDEO_STYLES } from "@/react/video/styles";
import { CONTROL_DEFAULTS } from "@/react/video/types";
import type { OpenVideoMenu } from "@/react/video/menu";
import type { ContextMenuItem, ContextMenuNode } from "@/react/context-menu/context";
import type { VideoContextMenuOptions, VideoLabels, VideoProps, VideoSource } from "@/react/video/types";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

/**
 * `<Video>` - a video with the controls a video is expected to have.
 *
 * ```tsx
 * <Video src="/demo.mp4" poster="/demo.jpg" />
 * <Video src={[{ src: "/a.webm", type: "video/webm" }, { src: "/a.mp4" }]} tracks={subtitles} />
 * ```
 *
 * Shaped after Plyr, which is the player this is measured against: the same control set, the
 * same shortcuts, the same bar that fades while playing. The difference is what it is made of
 * - React markup with `data-*` attributes rather than a template string it parses - so the
 * look is styled the way every other primitive here is, and the state a stylesheet needs is
 * on the elements.
 *
 * The `<video>` element stays the source of truth. Everything below reads it back through its
 * own events rather than keeping a second copy of what is playing: a player that believes its
 * own state is one that says "playing" after the browser refused to autoplay. The subtitle
 * list and the cast target are read the same way, from `textTracks` and from the browser's
 * own remote-playback watch.
 */

/**
 * The menu is a chunk of its own, and it is mounted the first time a pointer reaches the
 * player rather than on render - see the note in `menu.tsx`.
 */
const VideoMenu = lazy(() => import("@/react/video/menu").then((module) => ({ default: module.VideoMenu })));

let injected = false;

function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-video-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-video-styles", "");
    element.textContent = VIDEO_STYLES;
    document.head.prepend(element);
}

/** Whether two subtitle lists are the same one, so a render can be skipped. */
function same(a: readonly player.CaptionTrack[], b: readonly player.CaptionTrack[]): boolean {
    return a.length === b.length && a.every((track, at) => track.index === b[at]?.index && track.label === b[at]?.label);
}

/** The room the settings panel is left when the player is too short to hold all of it. */
const PANEL_GAP = 12;
const PANEL_MIN = 48;

export function Video(props: VideoProps): ReactNode {
    const {
        src,
        poster,
        tracks,
        controls = true,
        speeds = player.SPEEDS,
        keyboard = true,
        clickToPlay = true,
        autoHide = true,
        autoHideDelay = 2600,
        contextMenu = true,
        styles = true,
        labels = {},
        download,
        children,
        wrapperProps,
        ...rest
    } = props;

    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const settingsRef = useRef<HTMLButtonElement | null>(null);

    const [playing, setPlaying] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [looping, setLooping] = useState(false);
    const [captionList, setCaptionList] = useState<readonly player.CaptionTrack[]>([]);
    const [caption, setCaption] = useState(-1);
    /** null while the browser has no way to cast this element at all. */
    const [remote, setRemote] = useState<player.RemoteState | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [menu, setMenu] = useState(false);
    const [panelMax, setPanelMax] = useState<number | null>(null);
    const [idle, setIdle] = useState(false);
    /** The pointer is resting on the control bar, which is never a moment to take it away. */
    const [overBar, setOverBar] = useState(false);
    /** The context menu's chunk is mounted once a pointer has arrived - never on first render. */
    const [armed, setArmed] = useState(false);

    const show = useMemo(() => (controls === false ? null : { ...CONTROL_DEFAULTS, ...(controls === true ? {} : controls) }), [controls]);
    /** What the `tracks` prop SAYS, as a string - see the effect that reads the element back. */
    const trackKey = (tracks ?? []).map((track) => `${track.src}|${track.srcLang}|${track.label}`).join("\u0000");
    const sources: readonly VideoSource[] = useMemo(() => (typeof src === "string" ? [{ src }] : src ?? []), [src]);
    const pip = show?.pip && player.supportsPip();
    const cast = Boolean(show?.cast && remote?.available);

    const menuOptions = useMemo<VideoContextMenuOptions | null>(() => (
        contextMenu === false ? null : contextMenu === true ? {} : contextMenu
    ), [contextMenu]);

    /* -------- reading the element back -------- */

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const sync = (): void => {
            setPlaying(!video.paused && !video.ended);
            setVolume(video.volume);
            setMuted(video.muted);
            setSpeed(video.playbackRate);
            setLooping(video.loop);
        };
        const onTime = (): void => {
            setTime(video.currentTime);
            setBuffered(player.bufferedAhead(video.buffered, video.currentTime, video.duration));
        };
        const onDuration = (): void => setDuration(Number.isFinite(video.duration) ? video.duration : 0);

        const events: [string, () => void][] = [
            ["play", sync], ["pause", sync], ["ended", sync], ["volumechange", sync], ["ratechange", sync],
            ["timeupdate", onTime], ["progress", onTime], ["seeked", onTime],
            ["durationchange", onDuration], ["loadedmetadata", onDuration],
            ["waiting", () => setWaiting(true)], ["playing", () => { setWaiting(false); sync(); }],
            ["canplay", () => setWaiting(false)]
        ];
        for (const [name, handler] of events) video.addEventListener(name, handler);

        // The element may already be past these by the time React mounts - a cached video with
        // `autoPlay` fires `loadedmetadata` before the listeners exist.
        sync();
        onTime();
        onDuration();

        return () => { for (const [name, handler] of events) video.removeEventListener(name, handler); };
    }, [sources]);

    /**
     * The subtitle list, read from the element rather than from the `tracks` prop.
     *
     * They are not the same list. A `<track default>` is SHOWING before anything was pressed,
     * so a player that assumed "off" needed two presses to turn one off; and a page that adds
     * a track of its own, or renders `<track>` children, has subtitles this component was
     * never told about. `textTracks` is what the browser is actually drawing.
     */
    useEffect(() => {
        const list = videoRef.current?.textTracks;
        if (!list) return;

        const sync = (): void => {
            const found = player.captionTracks(list);
            // Only when it is a DIFFERENT list. `captionTracks` builds a new array every call,
            // and setting one unconditionally is a render, which re-runs this effect, which
            // sets another - a loop, and `tracks={[...]}` written inline is how everyone
            // writes it.
            setCaptionList((current) => (same(current, found) ? current : found));
            setCaption(player.activeCaption(list));
        };
        sync();
        for (const name of ["addtrack", "removetrack", "change"]) list.addEventListener(name, sync);
        return () => { for (const name of ["addtrack", "removetrack", "change"]) list.removeEventListener(name, sync); };
        // Keyed by what the tracks ARE rather than by the array they arrived in, for the same
        // reason: a fresh literal on every render would resubscribe on every render.
    }, [trackKey, sources]);

    /** Whether there is a screen to cast to, and whether it is playing there now. */
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !player.supportsRemote(video)) return;
        setRemote({ available: false, connected: false });
        return player.watchRemote(video, setRemote);
    }, [sources]);

    useEffect(() => {
        const onChange = (): void => setFullscreen(player.fullscreenElement() === wrapperRef.current);
        document.addEventListener("fullscreenchange", onChange);
        document.addEventListener("webkitfullscreenchange", onChange);
        return () => {
            document.removeEventListener("fullscreenchange", onChange);
            document.removeEventListener("webkitfullscreenchange", onChange);
        };
    }, []);

    /* -------- what the controls do -------- */

    const toggle = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        // `play()` rejects on its own - no gesture yet, no source, a policy - and an unhandled
        // rejection in a console is not a state change.
        if (video.paused) void video.play().catch(() => setPlaying(false));
        else video.pause();
    }, []);

    const seekTo = useCallback((fraction: number) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
        video.currentTime = fraction * video.duration;
        setTime(video.currentTime);
    }, []);

    const seekBy = useCallback((seconds: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration || 0);
        setTime(video.currentTime);
    }, []);

    const setVolumeTo = useCallback((fraction: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = Math.min(Math.max(fraction, 0), 1);
        // Moving the slider off zero is how somebody unmutes without hunting for the button.
        video.muted = video.volume === 0;
    }, []);

    const toggleMute = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        // Unmuting a video whose volume was dragged to zero would still be silent.
        if (!video.muted && video.volume === 0) video.volume = 0.5;
    }, []);

    /**
     * Which subtitle track was on before it was turned off.
     *
     * Without it, C after choosing Spanish brings back English: the toggle has to come back to
     * the language that was chosen, not to the first one in the list.
     */
    const preferred = useRef<number | null>(null);

    const chooseCaption = useCallback((index: number) => {
        const list = videoRef.current?.textTracks;
        if (!list) return;
        if (index !== -1) preferred.current = index;
        player.showCaption(list, index);
        setCaption(index);
    }, []);

    const toggleCaptions = useCallback(() => {
        const list = videoRef.current?.textTracks;
        const available = player.captionTracks(list);
        if (available.length === 0) return;
        const active = player.activeCaption(list);
        if (active !== -1) return chooseCaption(-1);
        const back = preferred.current;
        chooseCaption(back !== null && available.some((track) => track.index === back) ? back : available[0]!.index);
    }, [chooseCaption]);

    const setRate = useCallback((rate: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.playbackRate = rate;
        setSpeed(rate);
    }, []);

    const setLoop = useCallback((on: boolean) => {
        const video = videoRef.current;
        if (!video) return;
        // The element has no event for this one, so the state is set beside it rather than
        // read back from a `loopchange` that does not exist.
        video.loop = on;
        setLooping(on);
    }, []);

    const goFullscreen = useCallback(() => {
        const wrapper = wrapperRef.current;
        if (wrapper) void player.toggleFullscreen(wrapper, videoRef.current);
    }, []);

    const goPip = useCallback(() => {
        const video = videoRef.current;
        if (video) void player.togglePip(video).catch(() => { /* refused, or already gone */ });
    }, []);

    const goCast = useCallback(() => {
        const video = videoRef.current;
        // The picker is the platform's: nothing here can enumerate the screens on a network.
        if (video) void player.promptRemote(video).catch(() => { /* dismissed, or nothing found */ });
    }, []);

    /** What the two "copy the link" rows put on the clipboard. */
    const linkTo = useCallback((atTime: boolean): string | null => {
        const video = videoRef.current;
        const raw = video?.currentSrc || (typeof src === "string" ? src : sources[0]?.src);
        if (!raw) return null;
        try {
            const url = new URL(raw, typeof location === "undefined" ? undefined : location.href);
            // A media fragment, which is what a plain file understands - the platforms that
            // spell it `?t=` are answering their own player, not the video.
            if (atTime) url.hash = `t=${Math.floor(video?.currentTime ?? 0)}`;
            return url.href;
        } catch {
            return raw;
        }
    }, [src, sources]);

    /* -------- the keyboard, and the bar that gets out of the way -------- */

    const wake = useCallback(() => {
        setIdle(false);
        setArmed(true);
    }, []);

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (!keyboard || event.defaultPrevented || player.isTypingTarget(event.target)) return;
        const command = player.commandFor(event.key);
        if (!command) return;
        event.preventDefault();
        // The bar comes back for a key as well as for the pointer. Without it, seeking or
        // changing the volume from the keyboard in fullscreen shows nothing at all.
        wake();

        if (command.type === "toggle") return toggle();
        if (command.type === "seek") return seekBy(command.by);
        if (command.type === "seekTo") return seekTo(command.fraction);
        if (command.type === "volume") return setVolumeTo((videoRef.current?.volume ?? 0) + command.by);
        if (command.type === "mute") return toggleMute();
        if (command.type === "fullscreen") return goFullscreen();
        if (command.type === "captions") return toggleCaptions();
        if (command.type === "pip" && pip) return goPip();
    }, [keyboard, wake, toggle, seekBy, seekTo, setVolumeTo, toggleMute, goFullscreen, toggleCaptions, goPip, pip]);

    useEffect(() => {
        /**
         * Only while playing, never with a menu open, and never while the pointer is ON the
         * bar.
         *
         * The last one is the fullscreen complaint: the controls used to go away under the
         * cursor that was travelling towards them, which reads as the buttons disappearing
         * rather than as a bar getting out of the way. It is worst fullscreen, where the
         * distance to the button is the width of a screen.
         */
        if (!autoHide || !playing || menu || idle || overBar) return;
        const timer = window.setTimeout(() => setIdle(true), autoHideDelay);
        return () => window.clearTimeout(timer);
    }, [autoHide, playing, menu, idle, overBar, autoHideDelay, time]);

    useEffect(() => { if (!playing) setIdle(false); }, [playing]);

    // The settings panel closes on a press anywhere else, the way every menu does.
    useEffect(() => {
        if (!menu) return;
        const onPointerDown = (event: globalThis.PointerEvent): void => {
            if (!wrapperRef.current?.querySelector("[data-enigma-video-menu]")?.contains(event.target as Node)) setMenu(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [menu]);

    /**
     * How tall the settings panel is allowed to be.
     *
     * The player clips its own overflow - it has to, or a rounded corner is not rounded - and
     * the panel opens UPWARD from a button sitting on the bottom edge. So a panel taller than
     * the picture is a panel with its top cut off, which is what a speed list plus a language
     * list is on any player under about 300px. Measured rather than guessed: the room is the
     * distance from the top of the player to the top of the button that opened it, and what
     * does not fit scrolls.
     */
    useLayoutEffect(() => {
        if (!menu) {
            setPanelMax(null);
            return;
        }
        const wrapper = wrapperRef.current;
        const button = settingsRef.current;
        if (!wrapper || !button) return;
        const room = button.getBoundingClientRect().top - wrapper.getBoundingClientRect().top;
        setPanelMax(Math.max(PANEL_MIN, room - PANEL_GAP));
    }, [menu, fullscreen]);

    /* -------- the menu a right-click opens -------- */

    /**
     * The opener, once the menu's chunk has landed and mounted.
     *
     * State rather than a ref, because the player has to RENDER differently for it: the
     * wrapper carries `data-menu` while a right-click will be answered, and until then the
     * press is left to the browser's own menu.
     */
    const [opener, setOpener] = useState<OpenVideoMenu | null>(null);
    const onMenuReady = useCallback((open: OpenVideoMenu | null) => setOpener(() => open), []);

    const text: Required<Pick<VideoLabels, "play" | "pause">> & VideoLabels = {
        play: labels.play ?? "Play",
        pause: labels.pause ?? "Pause",
        ...labels
    };
    const captionsLabel = labels.captions ?? "Captions";
    const subtitlesLabel = labels.subtitles ?? "Subtitles";
    const offLabel = labels.captionsOff ?? "Off";
    const speedLabel = labels.speed ?? "Speed";
    const normalLabel = labels.normal ?? "Normal";
    const fullscreenLabel = fullscreen ? labels.exitFullscreen ?? "Exit fullscreen" : labels.enterFullscreen ?? "Fullscreen";

    const menuRows = useMemo<ContextMenuNode[]>(() => {
        if (!menuOptions) return [];
        // No source, no link: the two rows would sit there copying nothing, which is what a
        // player showing only its poster does before anybody has given it a file.
        const link = menuOptions.copyUrl !== false && sources.length > 0;

        /** Blocks, so a section that turned out empty does not leave two rules against each other. */
        const blocks: ContextMenuNode[][] = [
            [
                { id: "toggle", label: playing ? text.pause : text.play, icon: playing ? <icons.Pause /> : <icons.Play />, shortcut: "K" },
                { id: "loop", label: labels.loop ?? "Loop", icon: <icons.Loop />, checked: looping },
                {
                    id: "speed",
                    label: speedLabel,
                    icon: <icons.Speed />,
                    items: speeds.map((rate) => ({
                        id: `speed:${rate}`,
                        label: rate === 1 ? normalLabel : `${rate}x`,
                        group: "speed",
                        checked: speed === rate
                    }))
                },
                ...(captionList.length > 0 ? [{
                    id: "captions",
                    label: subtitlesLabel,
                    icon: caption === -1 ? <icons.CaptionsOff /> : <icons.Captions />,
                    items: [
                        { id: "caption:off", label: offLabel, group: "caption", checked: caption === -1 },
                        ...captionList.map((track) => ({
                            id: `caption:${track.index}`,
                            label: track.label,
                            group: "caption",
                            checked: caption === track.index
                        }))
                    ]
                } satisfies ContextMenuNode] : [])
            ],
            link ? [
                { id: "copy-url", label: labels.copyUrl ?? "Copy video URL", icon: <icons.Link /> },
                { id: "copy-url-time", label: labels.copyUrlAtTime ?? "Copy video URL at current time", icon: <icons.Clock /> }
            ] : [],
            [
                ...(pip ? [{ id: "pip", label: labels.pip ?? "Picture in picture", icon: <icons.Pip />, shortcut: "P" } satisfies ContextMenuNode] : []),
                ...(cast ? [{
                    id: "cast",
                    label: remote?.connected ? labels.stopCast ?? "Stop casting" : labels.cast ?? "Play on a TV",
                    icon: <icons.Cast />,
                    checked: remote?.connected
                } satisfies ContextMenuNode] : []),
                { id: "fullscreen", label: fullscreenLabel, icon: fullscreen ? <icons.Collapse /> : <icons.Expand />, shortcut: "F" }
            ],
            [...(menuOptions.items ?? [])]
        ];

        return blocks.filter((block) => block.length > 0).flatMap((block, at) => (at === 0 ? block : [{ type: "separator" } as ContextMenuNode, ...block]));
    }, [
        menuOptions, sources, playing, text.play, text.pause, looping, labels.loop, labels.copyUrl, labels.copyUrlAtTime, labels.pip, labels.cast, labels.stopCast,
        speedLabel, normalLabel, speeds, speed, captionList, caption, subtitlesLabel, offLabel, pip, cast, remote?.connected, fullscreen, fullscreenLabel
    ]);

    const onMenuSelect = useCallback((item: ContextMenuItem) => {
        const id = item.id;
        if (id === "toggle") toggle();
        else if (id === "loop") setLoop(!looping);
        else if (id.startsWith("speed:")) setRate(Number(id.slice("speed:".length)));
        else if (id === "caption:off") chooseCaption(-1);
        else if (id.startsWith("caption:")) chooseCaption(Number(id.slice("caption:".length)));
        else if (id === "copy-url" || id === "copy-url-time") {
            const url = linkTo(id === "copy-url-time");
            // Refused, or no clipboard at all: nothing is thrown at a console over a menu row.
            if (url) void navigator.clipboard?.writeText(url).catch(() => { /* denied */ });
        }
        else if (id === "pip") goPip();
        else if (id === "cast") goCast();
        else if (id === "fullscreen") goFullscreen();
        menuOptions?.onSelect?.(item);
    }, [toggle, setLoop, looping, setRate, chooseCaption, linkTo, goPip, goCast, goFullscreen, menuOptions]);

    const onContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
        // No chunk yet: the browser's own menu is a better answer than a press that does
        // nothing, so the event is left alone rather than swallowed.
        if (!menuOptions || !opener) return;
        event.preventDefault();
        opener({ x: event.clientX, y: event.clientY });
    }, [menuOptions, opener]);

    const played = player.progress(time, duration);

    return (
        <div
            {...wrapperProps}
            ref={wrapperRef}
            data-enigma-video=""
            data-playing={playing ? "" : undefined}
            data-hidden={idle ? "" : undefined}
            data-fullscreen={fullscreen ? "" : undefined}
            data-casting={remote?.connected ? "" : undefined}
            data-menu={opener ? "" : undefined}
            role="region"
            aria-label={labels.player ?? "Video player"}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onPointerMove={wake}
            onPointerEnter={() => setArmed(true)}
            onPointerDown={() => setArmed(true)}
            onPointerLeave={() => { if (playing && autoHide) setIdle(true); }}
            onFocus={wake}
            onContextMenu={onContextMenu}
        >
            <video
                {...rest}
                ref={videoRef}
                poster={poster}
                src={typeof src === "string" ? src : undefined}
                playsInline={rest.playsInline ?? true}
                onClick={() => { if (clickToPlay) toggle(); }}
            >
                {typeof src !== "string" && sources.map((source) => <source key={source.src} src={source.src} type={source.type} />)}
                {tracks?.map((track) => (
                    <track
                        key={track.src}
                        src={track.src}
                        kind={track.kind ?? "subtitles"}
                        srcLang={track.srcLang}
                        label={track.label}
                        default={track.default}
                    />
                ))}
            </video>

            <div data-enigma-video-overlay="">
                {waiting && <span data-enigma-video-spinner="" role="progressbar" aria-label={labels.player ?? "Video player"} />}
                {show?.play && !playing && !waiting && (
                    <button type="button" data-enigma-video-big="" aria-label={text.play} title={text.play} onClick={toggle}>
                        <icons.Play />
                    </button>
                )}
                {children}
            </div>

            {show && (
                <div
                    data-enigma-video-controls=""
                    onPointerEnter={() => setOverBar(true)}
                    onPointerLeave={() => setOverBar(false)}
                >
                    {show.play && (
                        <button type="button" data-enigma-video-button="" aria-label={playing ? text.pause : text.play} title={playing ? text.pause : text.play} onClick={toggle}>
                            {playing ? <icons.Pause /> : <icons.Play />}
                        </button>
                    )}

                    {show.currentTime && <span data-enigma-video-time="">{player.formatTime(time, duration)}</span>}

                    {show.progress && (
                        <Rail
                            value={played}
                            secondary={buffered}
                            label={labels.seek ?? "Seek"}
                            valueText={`${player.formatTime(time, duration)} of ${player.formatTime(duration, duration)}`}
                            onChange={seekTo}
                        />
                    )}

                    {show.duration && <span data-enigma-video-time="">{player.formatTime(duration, duration)}</span>}

                    {show.volume && (
                        <div data-enigma-video-volume="">
                            <button type="button" data-enigma-video-button="" aria-label={muted ? labels.unmute ?? "Unmute" : labels.mute ?? "Mute"} title={muted ? labels.unmute ?? "Unmute" : labels.mute ?? "Mute"} onClick={toggleMute}>
                                {muted || volume === 0 ? <icons.Muted /> : volume < 0.5 ? <icons.VolumeLow /> : <icons.Volume />}
                            </button>
                            <Rail value={muted ? 0 : volume} label={labels.volume ?? "Volume"} onChange={setVolumeTo} />
                        </div>
                    )}

                    {show.captions && captionList.length > 0 && (
                        <button type="button" data-enigma-video-button="" aria-pressed={caption !== -1} aria-label={captionsLabel} title={captionsLabel} onClick={toggleCaptions}>
                            {caption === -1 ? <icons.CaptionsOff /> : <icons.Captions />}
                        </button>
                    )}

                    {show.settings && (
                        <div data-enigma-video-menu="">
                            <button
                                ref={settingsRef}
                                type="button"
                                data-enigma-video-button=""
                                aria-haspopup="menu"
                                aria-expanded={menu}
                                aria-label={labels.settings ?? "Settings"}
                                title={labels.settings ?? "Settings"}
                                onClick={() => setMenu((current) => !current)}
                            >
                                <icons.Settings />
                            </button>
                            {menu && (
                                <div
                                    data-enigma-video-panel=""
                                    role="menu"
                                    aria-label={labels.settings ?? "Settings"}
                                    style={panelMax === null ? undefined : { maxHeight: `${panelMax}px` }}
                                    onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); }}
                                >
                                    <p data-enigma-video-heading="">{speedLabel}</p>
                                    {speeds.map((rate) => (
                                        <button
                                            key={rate}
                                            type="button"
                                            role="menuitemradio"
                                            data-enigma-video-option="speed"
                                            aria-checked={speed === rate}
                                            onClick={() => { setRate(rate); setMenu(false); }}
                                        >
                                            <span>{rate === 1 ? normalLabel : `${rate}x`}</span>
                                            {speed === rate && <icons.Check />}
                                        </button>
                                    ))}

                                    {captionList.length > 0 && (
                                        <>
                                            <p data-enigma-video-heading="">{subtitlesLabel}</p>
                                            <button
                                                type="button"
                                                role="menuitemradio"
                                                data-enigma-video-option="captions"
                                                aria-checked={caption === -1}
                                                onClick={() => { chooseCaption(-1); setMenu(false); }}
                                            >
                                                <span>{offLabel}</span>
                                                {caption === -1 && <icons.Check />}
                                            </button>
                                            {captionList.map((track) => (
                                                <button
                                                    key={track.index}
                                                    type="button"
                                                    role="menuitemradio"
                                                    data-enigma-video-option="captions"
                                                    aria-checked={caption === track.index}
                                                    lang={track.language || undefined}
                                                    onClick={() => { chooseCaption(track.index); setMenu(false); }}
                                                >
                                                    <span>{track.label}</span>
                                                    {caption === track.index && <icons.Check />}
                                                </button>
                                            ))}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {show.download && (
                        <a
                            data-enigma-video-button=""
                            href={download ?? sources[0]?.src ?? "#"}
                            download
                            rel="noopener"
                            aria-label={labels.download ?? "Download"}
                            title={labels.download ?? "Download"}
                        >
                            <icons.Download />
                        </a>
                    )}

                    {cast && (
                        <button
                            type="button"
                            data-enigma-video-button=""
                            aria-pressed={remote?.connected ?? false}
                            aria-label={remote?.connected ? labels.stopCast ?? "Stop casting" : labels.cast ?? "Play on a TV"}
                            title={remote?.connected ? labels.stopCast ?? "Stop casting" : labels.cast ?? "Play on a TV"}
                            onClick={goCast}
                        >
                            <icons.Cast />
                        </button>
                    )}

                    {pip && (
                        <button type="button" data-enigma-video-button="" aria-label={labels.pip ?? "Picture in picture"} title={labels.pip ?? "Picture in picture"} onClick={goPip}>
                            <icons.Pip />
                        </button>
                    )}

                    {show.fullscreen && (
                        <button
                            type="button"
                            data-enigma-video-button=""
                            aria-label={fullscreenLabel}
                            title={fullscreenLabel}
                            onClick={goFullscreen}
                        >
                            {fullscreen ? <icons.Collapse /> : <icons.Expand />}
                        </button>
                    )}
                </div>
            )}

            {menuOptions && armed && menuRows.length > 0 && (
                <Suspense fallback={null}>
                    <VideoMenu rows={menuRows} title={menuOptions.title} onSelect={onMenuSelect} onReady={onMenuReady} />
                </Suspense>
            )}
        </div>
    );
}

export type { VideoProps, VideoSource, VideoTrack, VideoControls, VideoLabels, VideoContextMenuOptions } from "@/react/video/types";
