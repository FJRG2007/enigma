# Design craft: the fundamentals behind a polished interface

Read this before building or restyling any screen, and run the closing checklist before calling a UI done. It is the working knowledge that separates "it renders" from "it looks designed": systems instead of one-off values, hierarchy instead of everything shouting, and the small finishing decisions that make a screen feel deliberate. The aesthetic direction (palette, faces, signature) comes from SKILL.md; this file is how to execute any direction well.

Where a rule here meets a rule in frontend-policy's "Visual Hierarchy & Layout Restraint" or SKILL.md's "Template tells", those win: they record decisions this project already made.

## 1. Start from a feature, in low fidelity

- Design one real piece of functionality first (the search form, the record view), not the app shell. Navigation, header and sidebar are decided after a few features exist, because only then do you know what they must hold.
- Work in grayscale first. With no colour to lean on, hierarchy has to come from spacing, contrast and size, and a design that reads in grayscale only gets better when colour is added.
- Skip typefaces, shadows and icons until the layout works. Sketches and wireframes are disposable; build the real thing as soon as the idea holds, then iterate on the working version, where the edge cases actually show up.
- Design the smallest useful version. Do not draw functionality that is not going to be built now (an attachments area on a comment form nobody is implementing): it blocks shipping the part that is ready. Nice-to-haves come later.

## 2. Decide the personality on purpose

A few concrete levers set how a design feels, and each must be chosen, then held consistently:

- **Type:** a serif reads elegant or classic, a rounded sans reads playful, a neutral sans steps back and lets other elements carry the voice.
- **Colour:** blue reads safe and familiar, gold or deep tones read premium, pink or saturated warm hues read playful. Choose by the audience and the subject, not by habit.
- **Corner radius:** none reads formal and serious, small reads neutral, large reads friendly. Pick one family and never mix square and rounded corners in the same interface.
- **Words:** formal copy feels official, casual copy feels friendly. Copy is as much a part of the personality as colour (SKILL.md "More on writing in design", technical-writing-policy).
- When unsure, look at what the target audience already uses and match its register, without borrowing from direct competitors.

## 3. Constrain every decision with a system

Choosing from an unlimited range makes every decision slow and every screen inconsistent. Define small scales up front, as design tokens (CSS custom properties or the framework's theme), and pick only from them:

- **Spacing and sizing:** a non-linear scale where no two neighbours are closer than about 25%. A practical one on a 16px base: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 640, 768 px. A linear "multiples of 4" scale does not help: it still leaves you choosing between 120 and 124.
- **Type sizes:** a hand-picked scale for interfaces, for example 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72 px. Define it in `px` or `rem`, never `em`: a nested `em` compounds into a size that is not on the scale.
- **Font weights:** two are usually enough for UI, a regular (400-500) and a bold (600-700). Below 400 is for large display text only; to de-emphasise small text, use a lighter colour or a smaller size, not a thin weight.
- **Colour:** 8-10 shades per hue (section 6).
- **Shadows:** a fixed elevation scale (section 7).
- **Radius, border widths, opacity, line heights, widths:** the same idea. When you notice yourself agonising over a low-level value twice, that is a missing scale.
- **Choosing within a scale:** guess the likely value, then try its neighbours on both sides. With values far enough apart, the wrong ones are obviously wrong; if a neighbour wins, repeat from there.

## 4. Hierarchy is the main tool

Visual hierarchy, how important each element looks relative to the others, does more to make a screen feel designed than any styling. When everything competes, nothing reads.

- **Use weight and colour before size.** Leaning on font size alone makes primary text too big and secondary text too small. A bolder primary element can stay a sensible size; secondary text in a softer colour stays readable at a normal size.
- **Two or three text colours:** dark for primary content, a mid grey for secondary (a date, a byline), a lighter grey for tertiary (a footer notice).
- **Emphasise by de-emphasising.** When the main element does not stand out and nothing more can be added to it, soften what competes with it: inactive nav items in a quieter colour, a sidebar with no background so the content owns the page.
- **Text on colour:** de-emphasised text on a coloured background is not grey and not white with reduced opacity (it looks washed out, and over an image or pattern the background shows through). Pick a colour of the background's own hue, adjusting saturation and lightness until it sits back at the right contrast.
- **Labels are a last resort.** Data whose format explains itself needs no label (an email, a phone number, a price). Merge label and value where you can ("12 left in stock", "3 bedrooms", not "Stock: 12"). Where labels are needed, as in a scannable dashboard, treat them as supporting text: smaller, lighter or lower contrast than the value. The exception is a spec sheet the user scans BY label: there the label leads and the value is only slightly lighter.
- **Visual hierarchy is not document hierarchy.** Use the right heading element for semantics, then style it for its role. Section titles in an app usually act as labels and should be small; the content under them is the focus. A title can even be visually hidden while kept for screen readers when the content speaks for itself.
- **Balance weight with contrast.** A solid icon beside text is visually heavier than the text, so give it a softer colour. Conversely, a 1px border that disappears in a soft colour can get a 2px width instead of a harsher colour.
- **Actions follow a pyramid.** One primary action per view: solid, high-contrast fill. Secondary actions: an outline or a low-contrast fill. Tertiary actions: styled as links. A destructive action is not automatically big and red; when it is not the main thing on the page it gets the secondary or tertiary treatment, and the bold red styling belongs on the confirmation step, where destroying IS the primary action.

## 5. Layout and spacing

- **Start with too much white space, then remove it.** Space added only until something stops looking broken is never enough. What feels like slightly too much around one element is usually right in the full screen.
- **Density is a decision, not a default.** A dashboard that must fit on one screen can be compact; choose that deliberately.
- **Do not fill the screen because it is there.** If the content needs 600px, give it 600px. Not every section has to be full width because the nav is.
- **Design mobile first on a narrow canvas** (~400px), then widen and fix only what felt compromised. When a narrow element looks lost in a wide layout, split supporting content into a column beside it instead of stretching it.
- **Fixed where it should be fixed, fluid where it should flow.** A sidebar gets a fixed width suited to its content and the main area takes the rest; percentages for a sidebar waste space on wide screens and squeeze it on narrow ones. A card or form with an ideal width gets a `max-width` and only shrinks when the screen is narrower than that, instead of being a grid fraction that can end up narrower on a large screen than on a medium one.
- **Sizes do not scale proportionally.** Large elements must shrink faster than small ones on small screens: a 45px desktop headline over 18px body text becomes about 20-24px over 14px on a phone, not 2.5 times the body. Inside a component, a larger button gets proportionally MORE padding and a smaller one tighter padding; padding defined in `em` only zooms the button.
- **No ambiguous spacing.** When spacing alone shows grouping, the space around a group must be clearly larger than the space within it: more space between form groups than between a label and its input, more above a heading than below it, more between list items than between their wrapped lines.

## 6. Text

- **Line length:** 45-75 characters per line for paragraphs (`max-width` of about 20-35em, or `max-inline-size: 65ch`). In a wide content area that mixes images, the paragraphs still keep that measure.
- **Line height is proportional:** taller for small text and long lines (up to 2 for very wide lines), shorter for large text (headlines can sit at 1 to 1.25).
- **Baseline, not centre:** when several font sizes share a line (a big title with small actions beside it), align them on the text baseline (`align-items: baseline`), not vertically centred.
- **Choosing faces:** a neutral sans is the safe UI default, and the system stack is acceptable as a deliberate choice for a data-dense tool. Prefer families with at least five weights (a sign of care). For small UI text avoid condensed faces with a short x-height; display faces with tight spacing are for headlines only. Popular and well-loved families are a reasonable filter; so is studying what strong product teams ship.
- **Alignment:** start-aligned for anything longer than two or three lines. If a centred block grows too long, shorten the copy instead of left-aligning one block among centred ones. Right-align numbers in tables so magnitudes line up (`font-variant-numeric: tabular-nums`). Justified text needs `hyphens: auto`.
- **Letter spacing:** leave it alone by default. Tighten it slightly on headlines set in a face built for body text; widen it on all-caps labels, which lose the shape cues lowercase has.
- **Links:** inside running copy a link must look like a link. In an interface where almost everything is clickable, a heavier weight or darker colour is enough, and ancillary links can reveal colour or underline only on hover.

## 7. Colour

- **Think in HSL (or OKLCH).** Hue, saturation and lightness map to how people perceive colour, so related colours look related in code. HSL lightness is not HSB brightness.
- **A real palette is large:**
  - Greys: 8-10 shades, from a near-black for text (true black looks unnatural) to an off-white background. Almost everything on screen is grey.
  - Primary: one or two hues with 5-10 shades each. The lightest tint backgrounds (an alert), the darkest makes coloured text.
  - Accents and semantic colours: red for destructive, amber for warning, green for positive, plus attention colours for new features; each with several shades, used sparingly. Data visualisation, tags and calendars may need more categorical hues.
  - A complex product easily needs ten hues with 5-10 shades each. A five-colour generator palette builds nothing.
- **Define shades up front, never on the fly.** No `lighten()`/`darken()`/`color-mix()` at the call site: that is how 35 near-identical blues appear. Build each scale once (100-900): pick the base (500, a colour that works as a button fill), then the darkest (900, for text) and lightest (100, for tinted backgrounds), then fill 700 and 300, then the remaining gaps. Adjust by eye, then freeze the scale; add a shade only when one is truly missing.
- **Keep saturation as lightness moves away from the middle:** very light and very dark shades need MORE saturation or they look washed out.
- **Change brightness by rotating hue too:** hues differ in perceived brightness (yellow, cyan and magenta read light; red, green and blue read dark). To lighten a shade, rotate its hue a little toward the nearest bright hue (60, 180, 300 degrees); to darken, toward the nearest dark hue (0, 120, 240). Keep the rotation under 20-30 degrees. This is what keeps dark yellows warm instead of muddy brown.
- **Tinted greys:** a touch of blue makes greys cool, a touch of yellow or orange makes them warm. Raise the saturation at the light and dark ends to keep the temperature even.
- **Accessible without being ugly:** body text needs 4.5:1, large text 3:1. White text on a colour often needs a very dark fill, which then shouts; flip it to dark coloured text on a light tint of the same hue. For secondary text on a dark coloured panel, rotate the hue toward a brighter one instead of pushing toward white.
- **Never colour alone.** A trend shown only in red and green is invisible to colour-blind users: add an icon or a sign. In charts, distinguish series by lightness and contrast, and by markers or direct labels, not by hue alone (see the dataviz skill when present).

## 8. Depth

- **Light comes from above.** A raised element shows a slightly lighter top edge (an inset top highlight or top border, a hand-picked lighter colour rather than white at low opacity) and casts a small, sharp, slightly offset shadow below. An inset element (an input, a well, a checkbox) shows the reverse: an inner shadow at the top and a lighter bottom edge. Borrow these cues lightly; realism is not the goal.
- **Shadows encode elevation, not decoration.** Decide where the element sits on the z-axis, then take that level's shadow: small for a button or card, medium for a dropdown or popover, large for a dialog. The closer it looks, the more attention it draws.
- **A fixed elevation scale of up to five levels,** from the smallest to the largest shadow with even steps between them. For example: `0 1px 3px`, `0 4px 6px`, `0 5px 15px`, `0 10px 24px`, `0 15px 35px`, each in a low-alpha near-black.
- **A good shadow token has two layers with distinct jobs:** a larger, softer layer with more offset (the cast shadow from a direct light) and a tight, darker layer close to the edge (where ambient light cannot reach). The tight layer fades as elevation rises and is nearly gone at the top level. This two-layer token is ONE elevation, not stacked decoration: still one token per element, still one light direction.
- **Shadows respond to interaction:** a dragged item lifts to a higher level, a pressed button drops to a lower one or none.
- **Flat designs still have depth:** a surface lighter than its background feels raised, darker feels inset. A short solid shadow with no blur keeps a flat style while lifting a card or button.
- **Overlap creates layers:** a card that straddles the boundary between two background sections, or an element taller than its container. When images overlap, give each a border in the background colour so they do not clash.

## 9. Images and icons

- **Use good photos or none.** A placeholder planned to be replaced by a phone snapshot later never works out. Use professional or quality stock imagery that fits the palette.
- **Text over an image needs steady contrast:** a semi-transparent dark or light overlay, a lower-contrast image, an image colourised toward one brand hue (lower contrast, desaturate, multiply a solid fill), or a soft, unoffset text glow. Verify contrast over the brightest and darkest parts of the image.
- **Everything has an intended size.** Icons drawn for 16-24px look chunky at 3-4 times that size: keep the icon near its native size inside a larger tinted shape instead. Do not shrink a full-app screenshot until its text is unreadable: capture at a smaller viewport, crop to the part that matters, or draw a simplified version with lines for text. A favicon is a redrawn, simplified mark, not a downscaled logo.
- **User uploads cannot be art-directed,** so constrain them: fixed aspect-ratio frames with `object-fit: cover`, and a subtle inner shadow or semi-transparent inner border so an image whose background matches the page keeps its edge.

## 10. Finishing touches

- **Upgrade the defaults before adding new elements:** bullets replaced by meaningful icons (a check, an arrow, a padlock for security items), a large coloured quote mark on a testimonial, links with a custom underline, checkboxes and radios in the brand colour instead of browser defaults.
- **A touch of colour where it carries meaning:** a coloured bar across the top of a card or of the whole layout, an active-nav indicator, a short accent under a headline. The thick left stripe on a rounded card stays banned (frontend-policy); a status uses an icon plus a tint.
- **Backgrounds can carry energy:** a different background colour per section, a slight gradient between two hues no more than about 30 degrees apart, a low-contrast repeating pattern along one edge, or a single simple shape. Keep any decoration low contrast so it never competes with content, and within the "Template tells" limits in SKILL.md.
- **Empty states are a first impression, not an afterthought:** an illustration or icon, one line saying what belongs here, and the primary call to action. Hide tabs, filters and bulk actions that do nothing until there is content.
- **Fewer borders:** separate with spacing, then a background tone, then a subtle shadow; a border only where it carries information (frontend-policy).
- **Question the stock shape of a component.** A dropdown can have sections, columns, descriptions and icons. A table can merge related columns into one cell with a primary and a secondary line, and show avatars, status colours or badges. A short set of important options can be selectable cards instead of a stack of radio buttons. Keep the semantics and keyboard behaviour of the underlying control.

## 11. Keep improving the eye

When a design you admire does something you would not have thought of (an inverted calendar header, a button inside an input, a two-colour headline), note the decision and reuse the idea. Rebuilding an admired screen from scratch is the fastest way to discover its small rules: tighter line height on headings, tracking on uppercase, layered shadows.

## Closing checklist

Run this pass on every screen before calling it done, with a screenshot when the environment allows:

1. Squint (or blur the screenshot): the one primary element and the one primary action are the first things you see. If not, de-emphasise what competes before enlarging anything.
2. Every font size, weight, colour, spacing, radius and shadow comes from the defined scales. No one-off values.
3. Grayscale check: the hierarchy survives without colour.
4. Grouping: space between groups is clearly larger than space within them; no border, background and shadow stacked on one boundary.
5. Text: paragraphs within 45-75 characters, line heights proportional, mixed sizes baseline-aligned, numbers right-aligned in tables, all-caps tracked.
6. Colour: text on colour uses the surface's hue, not grey; contrast meets 4.5:1 (3:1 for large text); no meaning carried by colour alone.
7. Depth: every shadow is an elevation token with one light direction; nothing raised that does not float.
8. Images: steady contrast under any overlaid text, icons at their intended size, uploads in fixed frames.
9. States: empty, loading, error and long-content states exist and look as considered as the happy path.
10. Every window size and zoom level (frontend-policy, "Responsive & Adaptive Layout").
