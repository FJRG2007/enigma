/**
 * The prop shapes for `<Video>`.
 *
 * Shaped after Plyr, which is the player this one is measured against: the same control set,
 * the same shortcuts, the same auto-hiding bar. What differs is that the controls are the
 * component's own markup rather than a string of HTML it parses, so a project styles them
 * with the attributes below instead of overriding a stylesheet it did not write.
 */

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { ContextMenuItem, ContextMenuNode } from "@/react/context-menu/context";

export interface VideoSource {
    src: string;
    /** `video/mp4`, `video/webm`. The browser picks the first one it can play. */
    type?: string;
}

export interface VideoTrack {
    src: string;
    /** BCP 47: `en`, `es-419`. */
    srcLang: string;
    label: string;
    kind?: "subtitles" | "captions" | "descriptions" | "chapters" | "metadata";
    default?: boolean;
}

/** Which controls the bar carries. Everything is on except `download`, as Plyr has it. */
export interface VideoControls {
    play?: boolean;
    progress?: boolean;
    currentTime?: boolean;
    duration?: boolean;
    volume?: boolean;
    captions?: boolean;
    settings?: boolean;
    pip?: boolean;
    /** Play on a TV. Feature-detected, and absent until the browser reports a screen to cast to. */
    cast?: boolean;
    fullscreen?: boolean;
    /** Off by default: a video a page shows is not always one it means to hand over. */
    download?: boolean;
}

export interface VideoLabels {
    play?: string;
    pause?: string;
    mute?: string;
    unmute?: string;
    volume?: string;
    seek?: string;
    captions?: string;
    /** The row that turns subtitles off. Default "Off". */
    captionsOff?: string;
    /** The heading over the language rows. Default "Subtitles". */
    subtitles?: string;
    settings?: string;
    speed?: string;
    normal?: string;
    pip?: string;
    cast?: string;
    /** While it is playing on the other screen. Default "Stop casting". */
    stopCast?: string;
    /** The context menu's rows. */
    loop?: string;
    copyUrl?: string;
    copyUrlAtTime?: string;
    enterFullscreen?: string;
    exitFullscreen?: string;
    download?: string;
    /** The player itself, as a screen reader announces the region. Default "Video player". */
    player?: string;
}

// `contextMenu` is taken off the element's own props: it is a long-dead HTML attribute
// naming a `<menu>` element, and this one is a menu the player draws.
export interface VideoProps extends Omit<ComponentPropsWithoutRef<"video">, "controls" | "children" | "src" | "contextMenu"> {
    /** One file, or the list the browser should choose from. */
    src?: string | readonly VideoSource[];
    poster?: string;
    tracks?: readonly VideoTrack[];
    /** The control bar. `false` leaves a bare `<video>` with nothing over it. */
    controls?: boolean | VideoControls;
    /** Rates the settings menu offers. Defaults to Plyr's 0.5 through 2. */
    speeds?: readonly number[];
    /** Space, arrows, M, F, C and the digits. On by default, and never while typing. */
    keyboard?: boolean;
    /** A press on the picture plays and pauses. On by default. */
    clickToPlay?: boolean;
    /** Hide the bar while playing, until the pointer moves. On by default. */
    autoHide?: boolean;
    /** How long the pointer has to be still before the bar goes, in ms. Default 2600. */
    autoHideDelay?: number;
    /**
     * The menu a right-click opens, shaped the way YouTube's is. ON by default.
     *
     * `false` gives the browser's own menu back - which is what a page wants when the point of
     * the video is that it can be saved from the native menu.
     */
    contextMenu?: boolean | VideoContextMenuOptions;
    /** The player's stylesheet, injected once. There is no useful unstyled player. */
    styles?: boolean;
    labels?: VideoLabels;
    /** The URL the download control saves. Defaults to what is playing. */
    download?: string;
    /** Rendered over the picture, under the controls - a title, a badge, your own overlay. */
    children?: ReactNode;
    /** Props for the element wrapping the video and its controls; this is what you size. */
    wrapperProps?: ComponentPropsWithoutRef<"div">;
}

export interface VideoContextMenuOptions {
    /** Rows of your own, after the built-in ones. */
    items?: readonly ContextMenuNode[];
    /** A row was invoked - yours, or one of the built-in ids. */
    onSelect?: (item: ContextMenuItem) => void;
    /** The two "copy the link" rows. On whenever the menu is, where there is a URL to copy. */
    copyUrl?: boolean;
    /** The heading over the rows, naming what the menu is acting on. */
    title?: string;
}

export const CONTROL_DEFAULTS: Required<VideoControls> = {
    play: true,
    progress: true,
    currentTime: true,
    duration: true,
    volume: true,
    captions: true,
    settings: true,
    pip: true,
    cast: true,
    fullscreen: true,
    download: false
};
