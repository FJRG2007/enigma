# Design craft: the fundamentals behind a polished interface

Read this before building or restyling any screen, and run the closing checklist before calling a UI done. It is the working knowledge that separates "it renders" from "it looks designed": systems instead of one-off values, hierarchy instead of everything shouting, and the small finishing decisions that make a screen feel deliberate. The aesthetic direction (palette, faces, signature) comes from SKILL.md; this file is how to execute any direction well. Values below are proven starting points: keep their ratios and relationships, and derive hues from the plan's palette.

Where a rule here meets a rule in frontend-policy's "Visual Hierarchy & Layout Restraint" or SKILL.md's "Template tells", those win: they record decisions this project already made.

## 1. Start from a feature, in low fidelity

- Design one real piece of functionality first (the search form, the record view), not the app shell. Navigation, header and sidebar are decided after a few features exist, because only then do you know what they must hold.
- Work in grayscale first. With no colour to lean on, hierarchy has to come from spacing, contrast and size. When colour arrives it usually lands only on interactive and selected states (the toggle, the primary button, the selected card's border and check); text, sizes, spacing and surfaces stay as they were.
- Skip typefaces, shadows and icons until the layout works. Build the real thing as soon as the idea holds, then iterate on the working version, where the edge cases actually show up.
- Design the smallest useful version. Do not draw functionality that is not going to be built now (an attachments area on a comment form nobody is implementing): it blocks shipping the part that is ready.

## 2. Decide the personality on purpose

A few concrete levers set how a design feels; choose each, then hold it everywhere:

- **Type:** a serif reads elegant or classic, a rounded sans reads playful, a neutral sans steps back. Weight shifts it too: a thin (300) large headline reads luxurious, a heavy (800) one reads loud and fun.
- **Colour:** blue reads safe and familiar, gold and muted beige read premium (often with black-and-white photography), hot pink and saturated warm hues read playful.
- **Corner radius:** 0 reads formal, ~4px reads neutral, pills and 8-12px cards read friendly. Pick one family; never mix square and rounded in one interface.
- **Words:** formal copy feels official, casual copy feels friendly. The same components can change tone through colour and copy alone.
- When unsure, match the register of what the target audience already uses, without copying direct competitors.

## 3. Constrain every decision with a system

Define small scales up front as design tokens (CSS custom properties or the framework theme) and pick only from them. Odd values such as 11, 13, 15, 17 or 26px in one component are the sign that no scale exists.

- **Spacing and sizing:** non-linear, no two neighbours closer than about 25%. On a 16px base: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 640, 768. A linear "multiples of 4" scale still leaves you choosing between 120 and 124. A component usually needs only two or three of them: a small gap for related items and a gap twice as large for padding and section breaks (12 and 24 is a common pair).
- **Type sizes:** 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72 px, in `px` or `rem`, never `em` (nested `em` compounds into off-scale sizes). A typical card collapses to four: 14 for labels, links, buttons and meta; 16 for body and secondary headings; 18 for the card title; 24 for the key figure. Avoid ratio-generated scales for UI: they produce fractional sizes and leave gaps exactly where interfaces need steps.
- **Below the scale:** 1px for borders and 2px for hairline offsets (pill padding, a focus-ring offset); nothing else lives under 4px.
- **Control and target sizes:** one height scale shared by inputs, selects and buttons in a row (32, 36, 40, 48), so a search field and the button beside it line up. On a coarse pointer every tap target reaches 44px (`@media (pointer: coarse)` raises the height, or a padded hit area), even where the visual control stays smaller. A link inside a sentence is exempt from the 44px; it keeps 24px of clearance from the next target instead.
- **Fixed widths are tokens too:** sidebar (200-240px), drawer (320-400px), dialog (400 / 560 / 720px), popover and menu (min 180px). Put them next to the spacing scale instead of inventing one per component.
- **Icon sizes:** 12, 16, 24, 32 for small to medium.
- **Font weights:** two for UI: regular (400-500) and bold (600-700). Below 400 only for large display text; de-emphasise small text with colour or size, never a thin weight.
- **Colour:** 9-10 shades per hue (section 7). **Shadows:** a five-step elevation scale (section 8).
- **Radius, border widths, opacity, line heights, widths:** the same idea. Agonising over a low-level value twice means a scale is missing.
- **Choosing within a scale:** guess the likely value, then compare its two neighbours. With values far enough apart the wrong ones are obviously wrong; if a neighbour wins, recentre on it and compare again.

## 4. Hierarchy is the main tool

How important each element looks relative to the others does more to make a screen feel designed than any styling.

- **Weight and colour before size.** Leaning on size alone makes primary text too big and secondary text too small. Example card: title 24px/700 in the dark text colour, price 18px/700, description 18px/400 in the mid grey, review count and footnote 16px/400 in the light grey; nothing under 16px.
- **Three text colours, one hue:** dark for primary (≈ `hsl(202 57% 15%)`), mid grey for secondary (≈ `hsl(201 23% 34%)`), light grey for tertiary (≈ `hsl(203 15% 47%)`). On white, a neutral grey must stay at or below ~42% lightness for body text and ~54% for large text to pass contrast.
- **Emphasise by de-emphasising.** When the active nav item does not stand out, keep it and turn the inactive items to a light blue-grey at the same weight. When a sidebar competes with the content, drop its card background, shadow and radius so it sits on the page and only the main panel is a surface.
- **Text on colour:** secondary text on a coloured surface takes the surface's hue with higher saturation and lightness (on teal, ≈ `hsl(183 70% 84%)`), never neutral grey and never white with opacity, which looks disabled and lets patterns or photos show through the glyphs.
- **Labels are a last resort.** Data whose format explains itself needs none (email, phone, price). Merge label and value ("12 left in stock" with the number bold; a bed icon, a bold "3" and a grey "bedrooms"). In a contact card drop the labels entirely: large dark name, a smaller medium-weight role in the accent colour, small grey contact lines. Where labels are needed (a dashboard tile), the label is tiny, uppercase, tracked and light grey; the value is large, bold and dark; a unit beside it is much smaller, bold, uppercase and grey, on the same baseline. In a spec sheet the user scans by label, so the label leads (bold, dark) and the value is only slightly lighter.
- **The small uppercase label is a workhorse:** 11-12px, uppercase, `letter-spacing: .05em`-`.1em`, mid grey, for eyebrows, table headers, section headers and meta lines (with " · " separators). Use it consistently, not everywhere.
- **Visual hierarchy is not document hierarchy.** Use the right heading element, then style it for its role: an app page title like "Manage Account" can be 16px; section titles act as labels; the content is the focus.
- **Balance weight with contrast.** A solid icon beside text is heavier than the text, so give it the same hue at a much higher lightness (text ≈ L13%, icon ≈ L68%). A 1px border too faint in a soft colour gets 2px in the same soft colour instead of a darker one.
- **Actions follow a pyramid:** one primary per view (solid, high-contrast fill), secondary actions as an outline or a light tinted fill, tertiary actions as link-styled text. Three solid buttons in three hues is the classic mistake: the destructive one becomes a plain text link, edit becomes a light fill, publish keeps the solid fill.
- **On a dark or coloured background** the primary inverts to a white fill with brand-coloured text, the secondary becomes a translucent white fill or a light 1px outline, the tertiary plain white text.
- **Destructive is not automatically big and red.** Off the main path, give it the secondary (white fill, neutral border, red text) or tertiary (grey text) treatment. The confirmation dialog is where destroying IS the primary action: a red primary, a quiet text "Cancel", both right-aligned in a light footer band.

## 5. Layout and spacing

- **Start with too much space, then remove it.** Nudging a cramped layout a few pixels at a time never gets there. What feels like slightly too much around one element is usually right in the full screen. Card padding of 24-32px is normal.
- **Density is a decision:** a dashboard that must fit one screen can be compact (28-32px table rows, panels separated by subtle shadows rather than padding).
- **Do not fill the screen because it is there.** A checkout needs ~600px: centre it (`max-width: 600px; margin-inline: auto`) and constrain the header to the same column. A login card is ~360-400px. A full-width nav does not oblige the content to be full width; a full-bleed hero can hold a content column.
- **Mobile first on a ~400px canvas,** then widen and fix only what felt compromised. To use width without stretching a form, move section titles and help text into a left column (`grid-template-columns: 1fr 2fr`, or a fixed ~240px column) and keep the fields at their ideal width on the right.
- **Fixed where it should be fixed, fluid where it should flow.** A sidebar has a fixed width suited to its content (`flex: 0 0 200px`-`240px`) and the main area flexes, with its own grid (`repeat(auto-fill, minmax(200px, 1fr))`). A card with an ideal width gets `width: 100%; max-width: 500px` and only shrinks below that, instead of grid columns that can make it narrower on a large screen than a medium one. Images and avatars beside text get `flex-shrink: 0`. The fixed sidebar holds only while the main area keeps its minimum useful width; below that it becomes a drawer, full screen on a phone (frontend-policy, "Responsive & Adaptive Layout").
- **Wide screens get a purpose, not stretch.** Past ~2000px of window, dock the selected record's detail beside the list (a pane token of ~400-480px) instead of opening it as a drawer; past ~2800px, widen the list and bring in the secondary columns it hid. Line length stays capped throughout. Selection survives crossing either threshold. A view that is not list-and-detail uses the width the same way: a multi-step flow puts its steps side by side (choose on the left, the running summary docked on the right) instead of one long column.
- **A label and its value are one unit.** A legend key, a stat and its caption, a field and its reading sit together; never let `justify-content: space-between` or a wide cell push the value to the far side of its label.
- **Data tables decide at the container, not the device.** Measure the narrowest width at which the essential columns still read (name not truncated to nothing, amounts whole); below it, switch the table to stacked rows with a container query: the primary line (name, amount) on top, the secondary line (status, due date) under it, minor columns moved into the row's detail or menu. Horizontal scrolling is for comparison tables where every column matters, and then the first column is sticky. Never squeeze every column into a phone.
- **Sizes do not scale proportionally.** Large elements shrink faster: an 18px body with a 45px headline on desktop becomes a 14px body with a 20-24px headline on a phone, set per breakpoint, not as `2.5em`. Buttons get disproportionate padding per size, as tokens, not `em`:

  | font-size | padding |
  |---|---|
  | 12px | 6px 8px |
  | 14px | 8px 10px |
  | 16px | 12px 16px |
  | 20px | 15px 30px |

- **No ambiguous spacing.** Space around a group is clearly larger than space within it, at least 2:1. Form: 20px above a label, 10px between the label and its input. Article: 36px above a heading, 12px below it. Lists: the gap between items larger than the line height of one item. Horizontal: 6px between an icon and its count, 36px between pairs. Histogram rows 8px apart, 24px between blocks.

## 6. Text

- **Line length:** 45-75 characters (`max-width: 65ch`, or 20-35em). In a wide section, the heading and a three-column grid keep the full width while the intro paragraph keeps its measure (`max-width: 34em; margin-inline: auto`).
- **Line height is proportional:** 16px at 1.5 for narrow columns, up to 2 for very wide lines, 1.75 for small text in a wide block, 1-1.2 for large headlines.
- **Baseline, not centre:** a large title with small actions beside it uses `align-items: baseline`.
- **Faces:** a neutral sans is the safe UI default, and a brand face goes first with the system stack as fallback (`"Brand", -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Helvetica Neue", sans-serif`). When web fonts cannot load (a self-contained file, an offline or locked-down page), take character from system stacks by role instead: a serif display stack (`"Iowan Old Style", Charter, "Sitka Text", Cambria, serif`), a condensed signage sans for headings and figures (`Bahnschrift, "DIN Alternate", "Avenir Next Condensed", sans-serif`, which differs per platform, so check it on each), a monospace stack for codes and ids (`ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`). Figures need lining, tabular numerals (`font-variant-numeric: lining-nums tabular-nums`); Georgia and other old-style-figure faces render amounts unevenly, so keep numbers in the sans. Prefer families with at least five weights. For body and UI text pick a tall x-height and open spacing; short x-height, tight display faces are for headlines only. Popular, well-loved families are a reasonable filter.
- **Alignment:** start-aligned for anything longer than two or three lines. Centred feature columns stay at two lines each; if one runs long, rewrite it shorter rather than mixing alignments. Right-align numeric columns and their headers, with a fixed number of decimals and `font-variant-numeric: tabular-nums`. Justified text needs `hyphens: auto` and a `lang` attribute.
- **Letter spacing:** leave it alone by default. `-0.02em` to `-0.05em` on large headlines set in a body face; `+0.05em` to `+0.1em` on all-caps labels, more as the text gets smaller.
- **Links:** inside running copy, coloured (and underlined). In link-dense UI (a video grid), titles are dark and bold, secondary links grey, metadata lighter grey, and ancillary links show an underline only on hover.

## 7. Colour

- **Think in HSL (or OKLCH):** related colours stay visibly related (a chart's three series as `hsl(220 95% 34%)`, `hsl(220 65% 61%)`, `hsl(220 69% 80%)`). HSL lightness is not HSB brightness: S100/B100 equals `hsl(h 100% 50%)`.
- **A real palette is large:**
  - Greys: 9-10 shades from a near-black (never `#000`) to an off-white, slightly tinted. Almost everything on screen is grey: labels in the darkest, help text in dark grey, input borders in grey, dividers and read-only borders in light grey, read-only backgrounds in the lightest.
  - Primary: 9-10 shades; the lightest tints backgrounds (alerts, tooltips), the darkest makes coloured text.
  - Accents and semantics: red, amber, green, plus attention hues (a teal "NEW" pill), 7-10 shades each, used sparingly. A complex product easily holds 35-100 swatches. A five-colour generator palette builds nothing, and a mid-saturated palette colour must never fill a large area such as a main panel.
- **Define shades up front, never on the fly** (no `lighten()`, `darken()` or `color-mix()` at call sites). Build each scale 100-900: the base 500 is the shade where a white uppercase button label still looks crisp; 900 is a text colour and 100 a barely tinted background (test both in an alert: 100 background, 900 bold title, a mid shade for the body, a 1px border a step darker than the background); then 700 and 300; then 800, 600, 400, 200. Adjust by eye, then freeze.
- **Saturation follows a U-curve:** lowest near 50% lightness and rising toward both ends, roughly S 55% at L50, 72% at L28 and L72, 90% at L15 and L88. Constant saturation makes the ends look washed out.
- **Change brightness by rotating hue too.** Perceived brightness differs by hue (yellow, cyan and magenta read light; red, green and blue read dark; perceived brightness ≈ `sqrt(.299r² + .587g² + .114b²)`). To lighten while staying vivid, rotate up to ~20-30° toward 60/180/300 (an icon gradient `hsl(190 100% 50%)` -> `hsl(210 100% 50%)` instead of `hsl(210 100% 75%)` -> `hsl(210 100% 50%)`); to darken, toward 0/120/240 (yellow drifting to orange as it darkens instead of turning olive).
- **Tinted greys:** cool greys carry ~12% saturation of a blue hue (≈ 210), warm greys of a yellow-orange hue (≈ 40), with saturation rising to ~15% at the dark end and ~21% at the light end, for example cool `hsl(209 15% 28%)`, `hsl(207 12% 43%)`, `hsl(208 12% 58%)`, `hsl(210 16% 76%)`, `hsl(208 21% 88%)`.
- **Accessible without being ugly:** 4.5:1 for body text, 3:1 for large text. White text on a bright badge fails and on a dark fill shouts; the fix is the same hue flipped: a 100-shade background with 800-900 text (it reaches 9:1 and up). For secondary text on a dark coloured panel, rotate the hue toward a brighter one (on indigo, a cyan-ish `hsl(188 100% 85%)`) instead of pushing toward white, so it reads as secondary and still passes.
- **Non-text contrast is 3:1:** an input's border, a focus ring, a checkbox outline, an icon that carries meaning without a label, and a chart segment that is not labelled with its value all need 3:1 against what surrounds them. On white that puts the input border at the 500 grey or darker in the starter tokens below; the 400 grey (≈1.8:1) is for dividers and decorative borders only. A focus ring in the brand 600-700 shade with a 2px offset passes on light surfaces; dark surfaces (a toast, a dark popover) get their own lighter ring token, checked separately. Focus shown only as a background highlight (a menu item reached with the arrow keys) is usually ~1.2:1 and fails: add an inset ring. Inside a scrolling or `overflow: hidden` container an outside ring is clipped, so draw it inset there (negative `outline-offset`).
- **Never colour alone.** A trend badge carries an arrow (`↑ 1.4%`, `↓ 11.1%`), not only green or red. Chart series differ by lightness (steps of ~20 points on one hue) and labels, not only by hue (see the dataviz skill when present).

## 8. Depth

- **Light comes from above.** A raised element has a slightly lighter top edge and a small, sharp shadow below; an inset element (input, checkbox, well, slider track) the reverse. Raised button: `box-shadow: inset 0 1px 0 <same hue, lighter>, 0 1px 3px hsl(0 0% 0% / .2)`, with the highlight hand-picked in the button's hue, not white with opacity. Inset well: `box-shadow: inset 0 2px 2px hsl(0 0% 0% / .1), 0 2px 0 hsl(0 0% 100% / .15)`. On a dark panel, controls lighter than the panel read raised (selects), darker read recessed (checkboxes, tracks). Stop before realism.
- **Shadows encode elevation.** Decide where the element sits on the z-axis and take that level: level 1 for a button, 2 for a dropdown, 3-4 for popovers and cards that lift, 5 for a dialog. The closer it looks, the more attention it draws.
- **A five-level scale, each level one token of two layers:** a larger, softer cast layer and a tight, darker contact layer that fades as elevation rises:

  ```css
  --shadow-1: 0 1px 3px hsl(0 0% 0% / .12), 0 1px 2px hsl(0 0% 0% / .24);
  --shadow-2: 0 3px 6px hsl(0 0% 0% / .15), 0 2px 4px hsl(0 0% 0% / .12);
  --shadow-3: 0 10px 20px hsl(0 0% 0% / .15), 0 3px 6px hsl(0 0% 0% / .10);
  --shadow-4: 0 15px 25px hsl(0 0% 0% / .15), 0 5px 10px hsl(0 0% 0% / .05);
  --shadow-5: 0 20px 40px hsl(0 0% 0% / .2);
  ```

  A single-layer scale works too (`0 1px 3px`, `0 4px 6px`, `0 5px 15px`, `0 10px 24px`, `0 15px 35px` at one alpha). Either way: one token per element, one light direction.
- **Shadows respond to interaction:** a dragged row lifts to a high level, overhangs its list slightly and shows a drag handle the resting rows do not; a pressed button drops a level (or two) and darkens slightly.
- **Flat designs still have depth:** a surface lighter than its background feels raised, darker feels inset (white card on a light grey page, light grey inputs inside it). A solid, unblurred offset keeps a flat style while lifting a row: `box-shadow: 0 3px 0 hsl(220 7% 83%)`.
- **Overlap creates layers:** a search card straddling a hero and the section below (`margin-bottom: -60px`, padding the next section to compensate), a card extending past both edges of a band, carousel arrows half outside their card (`margin-inline: -24px`). Overlapping avatars get a ring in the background colour (`border: 4px solid <surface>`) so they never merge.

## 9. Images and icons

- **Good photos or none.** The same card reads cheap or premium purely from the photo: bright, evenly lit, coherent palette. Fix the image before the type.
- **Text over an image needs steady contrast:** an overlay (`linear-gradient(hsl(0 0% 0% / .55), hsl(0 0% 0% / .55)), url(...) center/cover`); a washed-out image (≈ `brightness(1.4) contrast(.3)` on an image layer) with dark text; a colourised image (`background-blend-mode: multiply` over a brand colour, image greyscaled and lower-contrast on its own layer); or a soft glow `text-shadow: 0 0 50px hsl(0 0% 0% / .4)` with milder image treatment. Check contrast over the brightest and darkest parts.
- **Everything has an intended size.** Do not scale 16-24px icons beyond ~1.5×: keep them at native size inside a ~48px circle tinted with a very light shade of a hue, with the icon in a dark shade of the same hue. Do not shrink full-app screenshots until unreadable: capture a smaller layout and show it larger, crop to the part that matters, or draw a simplified UI with grey bars for text that keeps the structural colours. Favicons are redrawn simplified marks at 16/32px.
- **User uploads cannot be art-directed:** fixed frames (`width: 100%; aspect-ratio: 4/3; object-fit: cover`), and against bleed an inner ring that works on any image, `box-shadow: inset 0 0 0 1px hsl(0 0% 0% / .1)` (or a faint top-weighted inset shadow), on a wrapper or `::after` overlay, because an inset shadow does not paint over an `<img>`'s content. A grey border clashes with the photo's colours.

## 10. Finishing touches

- **Upgrade the defaults before adding elements:** bullets become ~16px brand circles with a white check (or a topical glyph), aligned to the first line; testimonials get oversized quote marks in a light tint, hanging outside the text; links get a heavier weight and colour, or a thick light-tinted underline that overlaps the glyph bottoms (a positioned background gradient); checkboxes become ~18px brand-filled squares with a 3px radius, radios ~20px rings with an ~8px centre dot when selected.
- **Colour where it means something:** a ~4px bar across the top of a card or the whole layout, a 2-3px bar under the active nav item, a short ~32×3px accent under a headline. The thick left stripe on a rounded card stays banned (frontend-policy); a status uses an icon plus a tint.
- **Backgrounds carry energy:** alternate section backgrounds (saturated hero, white, charcoal, pale grey), a gradient between two hues no more than ~30° apart, a low-contrast pattern (about 10% lightness off the background) or one along an edge only, a single spot graphic (`pointer-events: none`). Keep decoration low contrast and inside the "Template tells" limits in SKILL.md.
- **Empty states are a first impression,** and there are two kinds:
  - **Nothing exists yet** (a new account): a ~64px illustration or icon on a light tint circle, one line saying what belongs here, one primary button, centred with 12-16px gaps. Hide tabs, filters, search and bulk actions until there is content. The view still has one primary action: when the page header already carries it, the empty state's button replaces it (hide the header one) rather than doubling it.
  - **Nothing matches** (a search or filter came back empty): keep the search and filters on screen, name what was searched for, and offer "Clear filters" as the way out. This is not the onboarding screen.
- **Fewer borders, step by step:** a card border becomes a shadow (`0 5px 15px hsl(0 0% 0% / .15)`, on a card that differs from the page); an input or footer border becomes a light fill (≈ `hsl(200 10% 94%)`); row dividers become a ~6px gap, with the selected row as an inset, rounded, pale tint plus a leading bar or check, because the tint alone is ~1.1:1 and disappears in grayscale (the same rule as the active nav item).
- **Question the stock shape of a component, keeping its semantics and keyboard behaviour:**
  - Tables: merge related columns into one cell with a dark medium-weight primary line and a smaller light-grey secondary line; add ~32px avatars; status as small pills (light tint background, dark text of the same hue, `2px 8px` padding); row actions as a quiet "•••".
  - Dropdowns: a wide panel with a caret, a two-column grid of items (icon, semibold title, grey description, an optional tiny "NEW" pill) and a tinted footer band.
  - A selectable card never nests a second control inside its radio or button (invalid markup, two targets in one): a shortcut such as "Next free 08:10" is a sibling button laid out within the card's frame.
  - Radio groups: selectable cards (tiny tracked label, large bold value, price line); the selected card gets a 2px brand border, a faint brand tint and a check circle in the corner.
  - Inputs: a button joined to its input (shared height, outer corners rounded), or the button inside the input's container; a validation check or reveal toggle inside the input's end with matching end padding.
  - A dark popover (a date picker) over a light UI, or a two-colour headline, when it serves the content.

## 11. Keep improving the eye

When an admired design does something you would not have thought of, note the decision and reuse it. Rebuilding an admired screen from scratch is the fastest way to discover its small rules: tighter line height on headings, tracking on uppercase, layered shadows.

## Starter tokens

A neutral starting point to adapt, not a palette to ship as is: swap the hues for the plan's, keep the structure.

```css
:root {
  /* spacing */
  --space-px: 1px; --space-0_5: 2px; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px;
  --space-6: 32px; --space-7: 48px; --space-8: 64px; --space-9: 96px; --space-10: 128px;
  /* type */
  --text-xs: 12px; --text-sm: 14px; --text-base: 16px; --text-lg: 18px; --text-xl: 20px;
  --text-2xl: 24px; --text-3xl: 30px; --text-4xl: 36px; --text-5xl: 48px;
  --leading-tight: 1.2; --leading-normal: 1.5; --leading-loose: 1.75;
  --tracking-tight: -0.02em; --tracking-caps: 0.05em;
  /* cool greys (saturation rises at both ends) */
  --grey-900: hsl(210 24% 16%); --grey-800: hsl(209 20% 25%); --grey-700: hsl(209 15% 28%);
  --grey-600: hsl(207 12% 43%); --grey-500: hsl(208 12% 58%); /* lightest grey for an input border: 3.1:1 on white */
  --grey-400: hsl(210 16% 76%); /* dividers and decorative borders only */
  --grey-300: hsl(208 21% 88%); --grey-200: hsl(210 25% 93%); --grey-100: hsl(210 38% 97%);
  /* controls and fixed widths */
  --control-sm: 32px; --control-md: 36px; --control-lg: 40px; --control-xl: 48px; --target-min: 44px;
  --width-sidebar: 240px; --width-drawer: 360px; --width-dialog-sm: 400px; --width-dialog-md: 560px; --width-dialog-lg: 720px;
  /* radius */
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px; --radius-full: 9999px;
}
```

## Closing checklist

Run this pass on every screen before calling it done, with a screenshot when the environment allows:

1. Squint: apply `filter: grayscale(1) blur(2px)` to the page (or blur the screenshot): the one primary element and the one primary action are the first things you see. If not, turn down what competes before enlarging anything.
2. Every font size, weight, colour, spacing, radius and shadow comes from the defined scales. No one-off values.
3. Grayscale check: the hierarchy survives without colour.
4. Grouping: space between groups at least twice the space within them; no border, background and shadow stacked on one boundary.
5. Text: paragraphs within 45-75 characters, line heights proportional, mixed sizes baseline-aligned, numbers right-aligned and tabular, all-caps tracked.
6. Colour: text on colour uses the surface's hue, not grey or opacity; contrast meets 4.5:1 for text (3:1 large) and 3:1 for input borders, focus rings, meaningful icons and unlabelled chart segments; nothing carried by colour alone; no mid-saturated colour filling a large area.
7. Depth: every shadow is an elevation token with one light direction; nothing raised that does not float; pressed and dragged states change elevation.
8. Images: steady contrast under any overlaid text, icons at their intended size, uploads in fixed frames with an inner ring.
9. States: both empty states (nothing yet, nothing matches), loading, error and long-content states exist and look as considered as the happy path.
10. Every window size and zoom level (frontend-policy, "Responsive & Adaptive Layout"), and the coarse-pointer rules under a touch emulation (Chrome DevTools viewport `390x844x2,mobile,touch`): 44px targets, and at least 24px between small adjacent links or buttons in one cell.
