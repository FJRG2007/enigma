import "@enigmax/primitives/image.css";
import { Image } from "@enigmax/primitives/react/image";
import { Playground, type Control, type StyleToken } from "./Playground";

/**
 * The image viewer's playground.
 *
 * The pictures are generated rather than shipped: a gradient with a number on it is enough to
 * judge zoom, panning and the strip, and the docs site stays free of photographs it would have
 * to license and serve.
 */

interface Values extends Record<string, string | boolean> {
    navigation: boolean;
    thumbnails: boolean;
    menu: boolean;
    discardable: boolean;
    zoom: boolean;
    captions: boolean;
    animate: boolean;
}

function photo(from: string, to: string, label: string, width = 1200, height = 800): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
        <text x="50%" y="52%" font-family="system-ui, sans-serif" font-size="180" font-weight="600" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " "))}`;
}

const PHOTOS = [
    { src: photo("#1e3a8a", "#3b82f6", "1"), alt: "A blue gradient", caption: "Blue, 1200 by 800" },
    { src: photo("#14532d", "#22c55e", "2", 800, 1200), alt: "A green gradient", caption: "Green, and taller than it is wide" },
    { src: photo("#7c2d12", "#f97316", "3"), alt: "An orange gradient", caption: "Orange, 1200 by 800" },
    { src: photo("#4c1d95", "#a855f7", "4"), alt: "A purple gradient", caption: "Purple, 1200 by 800" }
];

const CONTROLS: Control<Values>[] = [
    { name: "zoom", label: "Zoom", type: "boolean", hint: "wheel, pinch, double press" },
    { name: "animate", label: "Flight", type: "boolean", hint: "out of the page and back" },
    { name: "navigation", label: "Arrows", type: "boolean", hint: "and a counter" },
    { name: "thumbnails", label: "Preview strip", type: "boolean" },
    { name: "menu", label: "Three dots", type: "boolean", hint: "download lives here" },
    { name: "discardable", label: "Discard", type: "boolean", hint: "drops one and moves on" },
    { name: "captions", label: "Captions", type: "boolean", hint: "the line under the picture" }
];

const STYLE: StyleToken[] = [
    { name: "enigma-image-backdrop", label: "Backdrop", type: "color", property: "--enigma-image-backdrop", value: "#000000" },
    { name: "enigma-image-control-bg", label: "Controls", type: "color", property: "--enigma-image-control-bg", value: "#171717" },
    { name: "enigma-image-control-size", label: "Control size", type: "px", property: "--enigma-image-control-size", value: "36px", min: 24, max: 56 },
    { name: "enigma-image-thumb-size", label: "Preview size", type: "px", property: "--enigma-image-thumb-size", value: "56px", min: 32, max: 96 }
];

/** Everything off but the two that ship on, which is what the component's defaults are. */
const INITIAL: Values = {
    zoom: true,
    animate: true,
    navigation: false,
    thumbnails: false,
    menu: false,
    discardable: false,
    captions: false
};

function code(values: Values): string {
    const props = ["src={photos[0].src}", 'alt="A blue gradient"'];
    if (values.navigation || values.thumbnails || values.discardable) props.push("images={photos}");
    if (!values.zoom) props.push("zoom={false}");
    if (!values.animate) props.push("animate={false}");
    if (values.navigation) props.push("navigation");
    if (values.thumbnails) props.push("thumbnails");
    if (values.menu) props.push("menu");
    if (values.discardable) props.push("discardable", "onDiscard={(item) => drop(item)}");

    return [
        'import { Image } from "@enigmax/primitives/react/image";',
        "",
        `<Image\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`
    ].join("\n");
}

export function ImagePlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=":root"
            render={(values) => (
                <div className="pg-gallery">
                    {PHOTOS.map((item, index) => (
                        <Image
                            key={item.src}
                            src={item.src}
                            alt={item.alt}
                            index={index}
                            images={values.captions ? PHOTOS : PHOTOS.map(({ caption, ...rest }) => rest)}
                            zoom={values.zoom}
                            animate={values.animate}
                            navigation={values.navigation}
                            thumbnails={values.thumbnails}
                            menu={values.menu}
                            discardable={values.discardable}
                            wrapperProps={{ className: "pg-gallery-item" }}
                        />
                    ))}
                </div>
            )}
        />
    );
}
