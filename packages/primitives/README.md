# @enigmax/primitives

Headless interaction primitives: the behaviour, the timing and the accessibility, with no styles of their own.

**The marquee takes a speed in pixels per second, never a duration.** A lap of a looping row is as long as its content, so a duration makes the speed `content / duration` and the row runs faster every time an item is added to it. Two testimonial rows split from an odd-length array, same `--duration: 20s`, measured 53.2 px/s and 66.5 px/s and were meant to look like a pair. A provider rail on a fixed 50s duration measured 45, 67 and 87 px/s at 10, 15 and 20 items, because nobody edits the duration when they add a provider. Take a speed and derive the duration: the same rail then measured 67.0 px/s at all three counts.

## Install

```sh
npm install @enigmax/primitives
# or, to copy the source in and own it:
enigma add marquee --copy
```

## Use it

React:

```tsx
import { useMarquee } from "@enigmax/primitives/react";

function LogoWall({ logos }) {
    const { laneRef, trackRef, copies, dragging } = useMarquee({ speed: 80, hoverScale: 0.15 });

    return (
        <div ref={laneRef} style={{ cursor: dragging ? "grabbing" : "grab" }}>
            <div ref={trackRef} style={{ display: "flex" }}>
                {Array.from({ length: copies }, (_, copy) => (
                    <div key={copy} aria-hidden={copy > 0} style={{ display: "flex", gap: 32 }}>
                        {logos.map(logo => <a key={logo.id} href={logo.href}>{logo.name}</a>)}
                    </div>
                ))}
            </div>
        </div>
    );
}
```

Vanilla, Astro, or anything else that hands you two elements:

```js
import { createMarquee } from "@enigmax/primitives";

const marquee = createMarquee(document.querySelector("[data-lane]"), document.querySelector("[data-track]"), {
    speed: 80,
    hoverScale: 0.15
});
```

The core clones the track's first child to fill the lane. In React the hook reports a `copies` count instead, so React keeps ownership of the DOM.

## Options

| Option | Default | Meaning |
|---|---|---|
| `speed` | `60` | Pixels per second. Not a duration. |
| `reverse` | `false` | Scroll towards the start. |
| `vertical` | `false` | Scroll on the Y axis. |
| `draggable` | `true` | Grab and throw the row. |
| `hoverScale` | `1` | Speed multiplier while a **mouse** rests on the row. `0` pauses. |
| `decay` | `0.12` | Fraction of the remaining velocity gap left after one second. `0.35` is draggy. |
| `manageStyles` | `true` | Apply the styles the behaviour needs. Never theme styles. |

## Why the obvious implementation is wrong

Three of these cost a production bug each. They are the reason this package exists rather than a snippet.

**`setPointerCapture` silently breaks every link in the row.** A pointer capture retargets the compatibility mouse events too, so the `click` of a plain press arrives on the lane instead of on the card that was pressed, and the card's link never opens. A nine-logo carousel quietly stops being nine links and nothing in the source looks wrong. This package binds `pointermove` / `pointerup` / `pointercancel` to `window`, which is all the capture was ever for - a mousedown already captures the mouse at the OS level, so a release outside the browser window still arrives.

**`touch-action` decides whether a phone can scroll your page.** Without it the browser owns the horizontal swipe and the drag handlers never see it. With `none`, a visitor can no longer scroll the page by starting the gesture on the row, which on a phone is most of the width of the screen. The lane gets `pan-y` (or `pan-x` when vertical).

**A hover effect that ignores `pointerType` sticks forever on touch.** A tap fires `pointerenter` too, and on touch nothing ever fires the `pointerleave` that undoes it, so a "slow down on hover" leaves the row at 15% speed for good after the first tap. Every hover path here is gated to `pointerType === "mouse"`.

The rest, in short: the lap is measured from the step between two copies rather than computed from item widths; the transform is driven by one `requestAnimationFrame` loop rather than CSS keyframes, which restart on every re-author; one integrator carries cruise, hover and momentum so none of them can arrive as a cut; a drag past ~6px cancels the click in the capture phase; a right click never starts a drag; a pointer held still for ~90ms before release throws nothing; and reduced motion drops the autoplay while keeping the drag, because a drag is an answer to the pointer and not motion of the page's own accord.

## Styling

The primitive ships no visual styles. It sets only what the behaviour requires (`overflow`, `touch-action`, `user-select`, `will-change`, `transform`) and exposes state as data attributes for a theme to hook:

```css
[data-enigma-marquee]                        { cursor: grab; }
[data-enigma-marquee][data-dragging]         { cursor: grabbing; }
[data-enigma-marquee][data-hovering]         { --logo-opacity: 1; }
[data-enigma-marquee][data-reduced-motion="true"] { /* autoplay is off */ }
[data-enigma-marquee-track]                  { display: flex; }
[data-enigma-marquee-copy]                   { display: flex; gap: 2rem; }
```

## Tests

The suite drives a real browser and samples `new DOMMatrixReadOnly(getComputedStyle(track).transform).m41` on every animation frame, rather than asking the engine what it believes.

```sh
npm run test:install   # once, fetches Chromium
npm test
```

| Check | Pass condition |
|---|---|
| Same speed at 2, 9, 11, 20 items | measured px/s equal within 1% |
| Drag follows the pointer | a 200px swipe moves the row 200.0px |
| Release | decays monotonically onto cruise, no sign flip |
| Four viewport resizes | no frame moves more than one frame of cruising |
| Drag ending on a link | 0 navigations |
| Plain click and tap on a link | 1 navigation each |
| Tap on touch | row does not stick at the hover speed |
| Vertical swipe on a phone | the page still scrolls |
| `prefers-reduced-motion` | 0.00px idle drift, drag still works |
| Held still, then release | no fling |

Two ways to fool yourself, both of which produced a false alarm while this was being written: do not measure a resize as before/after, because `setViewportSize` takes several hundred milliseconds during which the row legitimately keeps moving - sample every frame and look for a single anomalous one. And discard the first few samples, because the first rAF delta after installing the sampler is near zero and produces a meaningless px/s spike.
