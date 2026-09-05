"use client";

import * as player from "@/core/player";
import { Rail } from "@/react/video/rail";
import * as icons from "@/react/video/icons";
import { VIDEO_STYLES } from "@/react/video/styles";
import { CONTROL_DEFAULTS } from "@/react/video/types";
import type { VideoLabels, VideoProps, VideoSource } from "@/react/video/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
 * own state is one that says "playing" after the browser refused to autoplay.
 */

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

    const [playing, setPlaying] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [captions, setCaptions] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [menu, setMenu] = useState(false);
    const [idle, setIdle] = useState(false);

    const show = useMemo(() => (controls === false ? null : { ...CONTROL_DEFAULTS, ...(controls === true ? {} : controls) }), [controls]);
    const sources: readonly VideoSource[] = useMemo(() => (typeof src === "string" ? [{ src }] : src ?? []), [src]);
    const pip = show?.pip && player.supportsPip();

    /* -------- reading the element back -------- */

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const sync = (): void => {
            setPlaying(!video.paused && !video.ended);
            setVolume(video.volume);
            setMuted(video.muted);
            setSpeed(video.playbackRate);
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

    const toggleCaptions = useCallback(() => {
        const list = videoRef.current?.textTracks;
        if (!list?.length) return;
        const on = !captions;
        for (let at = 0; at < list.length; at += 1) {
            // Only the first one is turned ON: several tracks showing at once stack two
            // languages over the picture.
            list[at]!.mode = on && at === 0 ? "showing" : "disabled";
        }
        setCaptions(on);
    }, [captions]);

    const setRate = useCallback((rate: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.playbackRate = rate;
        setSpeed(rate);
    }, []);

    const goFullscreen = useCallback(() => {
        const wrapper = wrapperRef.current;
        if (wrapper) void player.toggleFullscreen(wrapper, videoRef.current);
    }, []);

    const goPip = useCallback(() => {
        const video = videoRef.current;
        if (video) void player.togglePip(video).catch(() => { /* refused, or already gone */ });
    }, []);

    /* -------- the keyboard, and the bar that gets out of the way -------- */

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (!keyboard || event.defaultPrevented || player.isTypingTarget(event.target)) return;
        const command = player.commandFor(event.key);
        if (!command) return;
        event.preventDefault();

        if (command.type === "toggle") return toggle();
        if (command.type === "seek") return seekBy(command.by);
        if (command.type === "seekTo") return seekTo(command.fraction);
        if (command.type === "volume") return setVolumeTo((videoRef.current?.volume ?? 0) + command.by);
        if (command.type === "mute") return toggleMute();
        if (command.type === "fullscreen") return goFullscreen();
        if (command.type === "captions") return toggleCaptions();
        if (command.type === "pip" && pip) return goPip();
    }, [keyboard, toggle, seekBy, seekTo, setVolumeTo, toggleMute, goFullscreen, toggleCaptions, goPip, pip]);

    const wake = useCallback(() => {
        setIdle(false);
    }, []);

    useEffect(() => {
        // Only while playing, and never with a menu open: a bar that vanishes under the
        // pointer takes the panel the visitor is reading with it.
        if (!autoHide || !playing || menu || idle) return;
        const timer = window.setTimeout(() => setIdle(true), autoHideDelay);
        return () => window.clearTimeout(timer);
    }, [autoHide, playing, menu, idle, autoHideDelay, time]);

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

    const text: Required<Pick<VideoLabels, "play" | "pause">> & VideoLabels = {
        play: labels.play ?? "Play",
        pause: labels.pause ?? "Pause",
        ...labels
    };
    const played = player.progress(time, duration);

    return (
        <div
            {...wrapperProps}
            ref={wrapperRef}
            data-enigma-video=""
            data-playing={playing ? "" : undefined}
            data-hidden={idle ? "" : undefined}
            data-fullscreen={fullscreen ? "" : undefined}
            role="region"
            aria-label={labels.player ?? "Video player"}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onPointerMove={wake}
            onPointerLeave={() => { if (playing && autoHide) setIdle(true); }}
            onFocus={wake}
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
                <div data-enigma-video-controls="">
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

                    {show.captions && tracks && tracks.length > 0 && (
                        <button type="button" data-enigma-video-button="" aria-pressed={captions} aria-label={labels.captions ?? "Captions"} title={labels.captions ?? "Captions"} onClick={toggleCaptions}>
                            <icons.Captions />
                        </button>
                    )}

                    {show.settings && (
                        <div data-enigma-video-menu="">
                            <button
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
                                <div data-enigma-video-panel="" role="menu" aria-label={labels.speed ?? "Speed"} onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); }}>
                                    <p data-enigma-video-heading="">{labels.speed ?? "Speed"}</p>
                                    {speeds.map((rate) => (
                                        <button
                                            key={rate}
                                            type="button"
                                            role="menuitemradio"
                                            data-enigma-video-option=""
                                            aria-checked={speed === rate}
                                            onClick={() => { setRate(rate); setMenu(false); }}
                                        >
                                            {rate === 1 ? labels.normal ?? "Normal" : `${rate}x`}
                                        </button>
                                    ))}
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

                    {pip && (
                        <button type="button" data-enigma-video-button="" aria-label={labels.pip ?? "Picture in picture"} title={labels.pip ?? "Picture in picture"} onClick={goPip}>
                            <icons.Pip />
                        </button>
                    )}

                    {show.fullscreen && (
                        <button
                            type="button"
                            data-enigma-video-button=""
                            aria-label={fullscreen ? labels.exitFullscreen ?? "Exit fullscreen" : labels.enterFullscreen ?? "Fullscreen"}
                            title={fullscreen ? labels.exitFullscreen ?? "Exit fullscreen" : labels.enterFullscreen ?? "Fullscreen"}
                            onClick={goFullscreen}
                        >
                            {fullscreen ? <icons.Collapse /> : <icons.Expand />}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export type { VideoProps, VideoSource, VideoTrack, VideoControls, VideoLabels } from "@/react/video/types";
