"use client";

import * as player from "@/core/player";
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/**
 * One horizontal rail, used by both the scrubber and the volume.
 *
 * They are the same control: a fraction set by a press, dragged with the pointer captured so
 * it keeps following outside the box, and driven by the arrows for a keyboard. Writing it
 * twice would mean fixing the drag twice.
 */

export interface RailProps {
    /** Where the filled part ends, 0 to 1. */
    value: number;
    /** A second, dimmer fill behind it - what is buffered. Omit for a plain rail. */
    secondary?: number;
    onChange: (fraction: number) => void;
    /** Fired once the drag ends, for a caller that only wants the final value. */
    onCommit?: (fraction: number) => void;
    label: string;
    /** What a screen reader reads instead of a bare percentage. */
    valueText?: string;
    step?: number;
    className?: string;
}

export function Rail({ value, secondary, onChange, onCommit, label, valueText, step = 0.05 }: RailProps): ReactNode {
    const ref = useRef<HTMLDivElement | null>(null);
    const [dragging, setDragging] = useState(false);

    const fractionAt = useCallback((clientX: number): number => {
        const box = ref.current?.getBoundingClientRect();
        return box ? player.fractionAt(box, clientX) : 0;
    }, []);

    const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        event.preventDefault();
        event.currentTarget.focus();
        setDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer already gone */ }
        onChange(fractionAt(event.clientX));
    }, [fractionAt, onChange]);

    const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!dragging) return;
        onChange(fractionAt(event.clientX));
    }, [dragging, fractionAt, onChange]);

    const end = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!dragging) return;
        setDragging(false);
        onCommit?.(fractionAt(event.clientX));
    }, [dragging, fractionAt, onCommit]);

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        const moves: Record<string, number> = {
            ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step
        };
        const by = moves[event.key];
        if (by === undefined && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        // Stopped here as well: the player's own shortcuts answer the same arrows, and a rail
        // that lets them through would seek the video while somebody sets the volume.
        event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : Math.min(Math.max(value + (by ?? 0), 0), 1);
        onChange(next);
        onCommit?.(next);
    }, [step, value, onChange, onCommit]);

    const percent = Math.round(value * 100);

    return (
        <div
            ref={ref}
            data-enigma-video-rail=""
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={valueText ?? `${percent}%`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={onKeyDown}
        >
            <div data-enigma-video-track="">
                {secondary !== undefined && <span data-enigma-video-buffer="" style={{ width: `${Math.round(secondary * 100)}%` }} />}
                <span data-enigma-video-played="" style={{ width: `${percent}%` }} />
            </div>
            <span data-enigma-video-knob="" style={{ left: `${percent}%` }} />
        </div>
    );
}
