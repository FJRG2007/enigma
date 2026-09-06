/**
 * The prop shapes for `<Image>`, split from the component so the viewer's chunk can import
 * them without pulling the component in - the same arrangement `<Input>` is in.
 *
 * WHAT IS ON BY DEFAULT is the whole design of this API: an image that opens and zooms, and
 * nothing else. A gallery's arrows, its thumbnails, a menu and a discard action are each a
 * decision about the page they sit in, so each is a prop you turn on rather than one you
 * remember to turn off.
 */

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { ContextMenuNode } from "@/react/context-menu/context";

/** One image in a set: a URL, or the URL plus what is known about it. */
export type ImageSource = string | ImageItem;

export interface ImageItem {
    src: string;
    alt?: string;
    /** A smaller file for the strip and for the frame while the full one loads. */
    thumbnail?: string;
    /** The URL to save, when the file to download is not the one being shown. */
    download?: string;
    /** Saved under this name instead of the one in the URL. */
    filename?: string;
    caption?: ReactNode;
}

export interface ZoomOptions {
    /** How far out. 1 is the fitted image; below it the picture is smaller than its frame. */
    min?: number;
    max?: number;
    /** Zoom on the wheel. On by default - it is the gesture every image viewer answers. */
    wheel?: boolean;
    /** A double press toggles between fitted and this. `false` leaves the gesture alone. */
    doubleClick?: boolean;
}

export interface ImageMenuOptions {
    /** The download row. On whenever the menu is. */
    download?: boolean;
    /** The row that opens the picture on its own, in another tab. On whenever the menu is. */
    newTab?: boolean;
    /** Rows of your own, after the built-in ones. */
    items?: readonly ContextMenuNode[];
    onSelect?: (id: string, item: ImageItem, index: number) => void;
}

/** Every string the viewer says, for a UI that is not in English. */
export interface ImageLabels {
    open?: string;
    close?: string;
    zoomIn?: string;
    zoomOut?: string;
    reset?: string;
    previous?: string;
    next?: string;
    menu?: string;
    download?: string;
    newTab?: string;
    discard?: string;
    thumbnails?: string;
    /** The frame itself, announced as the dialog's name. Default "Image viewer". */
    viewer?: string;
    /** `{index}` and `{total}` are replaced. Default "{index} of {total}". */
    counter?: string;
}

export interface ImageProps extends Omit<ComponentPropsWithoutRef<"img">, "children" | "onSelect"> {
    src: string;
    alt: string;
    /**
     * The set this image belongs to. Without it the viewer shows this one image; with it the
     * arrows, the strip and the discard action have something to move through.
     */
    images?: readonly ImageSource[];
    /** Where in `images` this one is. Found by `src` when it is left out. */
    index?: number;
    /** Click to see it larger. ON by default: it is what an image in a page is expected to do. */
    lightbox?: boolean;
    /** Zoom, with the wheel and the keyboard. ON by default. */
    zoom?: boolean | ZoomOptions;
    /**
     * The picture flies out of the page into the viewer, and back into it on the way out. ON
     * by default, and skipped anyway for a reader who has asked for less movement.
     */
    animate?: boolean;
    /** Arrows, the counter, and Left/Right on the keyboard. Off by default. */
    navigation?: boolean;
    /** The strip of previews along the bottom. Off by default. */
    thumbnails?: boolean;
    /** The three dots, and what is under them. Off by default. */
    menu?: boolean | ImageMenuOptions;
    /**
     * Take an image out of the set and move to the next one. Off by default, because it is
     * destructive and only the caller knows whether it means anything on their page.
     */
    discardable?: boolean;
    onDiscard?: (item: ImageItem, index: number) => void;
    /** Whether the arrows and the strip wrap around at the ends. On by default. */
    loop?: boolean;
    /** The caption under the frame, when the item carries none of its own. */
    caption?: ReactNode;
    onOpenChange?: (open: boolean) => void;
    onIndexChange?: (index: number, item: ImageItem) => void;
    /** The viewer's stylesheet, injected once. There is no useful unstyled lightbox. */
    styles?: boolean;
    labels?: ImageLabels;
    /** Props for the element wrapping the thumbnail - this is what you position. */
    wrapperProps?: ComponentPropsWithoutRef<"span">;
}

/** A source in either spelling, as the one the viewer works in. */
export function toItem(source: ImageSource): ImageItem {
    return typeof source === "string" ? { src: source } : source;
}
