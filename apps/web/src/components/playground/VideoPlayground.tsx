import { useState } from "react";
import "@enigmax/primitives/video.css";
import { Video } from "@enigmax/primitives/react/video";
import { Playground, type Control, type StyleToken } from "./Playground";

/**
 * The player's playground.
 *
 * The docs ship no video: a file big enough to be worth playing is a file every reader
 * downloads to look at a control bar. So the preview plays whatever the reader points it at -
 * their own file, read locally and never uploaded - and until then the poster and the controls
 * are what there is to judge.
 */

interface Values extends Record<string, string | boolean> {
    volume: boolean;
    settings: boolean;
    pip: boolean;
    fullscreen: boolean;
    download: boolean;
    autoHide: boolean;
    captions: boolean;
}

/** A poster, generated rather than shipped, for the same reason as the gallery's pictures. */
const POSTER = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e3a8a"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
        <text x="50%" y="52%" font-family="system-ui, sans-serif" font-size="52" fill="rgba(255,255,255,0.62)" text-anchor="middle">Choose a video below</text>
    </svg>
`.replace(/\s+/g, " "))}`;

const TRACK = `data:text/vtt,${encodeURIComponent(["WEBVTT", "", "00:00:00.000 --> 00:00:10.000", "A caption track, so the control has something to turn on", ""].join("\n"))}`;

const CONTROLS: Control<Values>[] = [
    { name: "volume", label: "Volume", type: "boolean" },
    { name: "settings", label: "Speed menu", type: "boolean" },
    { name: "captions", label: "Captions", type: "boolean", hint: "shown when there are tracks" },
    { name: "pip", label: "Picture in picture", type: "boolean", hint: "Chromium and Safari" },
    { name: "fullscreen", label: "Fullscreen", type: "boolean" },
    { name: "download", label: "Download", type: "boolean", hint: "off by default" },
    { name: "autoHide", label: "Hide while playing", type: "boolean" }
];

const STYLE: StyleToken[] = [
    { name: "enigma-video-accent", label: "Accent", type: "color", property: "--enigma-video-accent", value: "#3b82f6" },
    { name: "enigma-video-panel-bg", label: "Menu", type: "color", property: "--enigma-video-panel-bg", value: "#171717" },
    { name: "enigma-video-control-size", label: "Control size", type: "px", property: "--enigma-video-control-size", value: "32px", min: 24, max: 48 },
    { name: "enigma-video-rail-height", label: "Rail", type: "px", property: "--enigma-video-rail-height", value: "5px", min: 2, max: 12 }
];

const INITIAL: Values = {
    volume: true,
    settings: true,
    captions: true,
    pip: true,
    fullscreen: true,
    download: false,
    autoHide: true
};

function code(values: Values): string {
    const off = (["volume", "settings", "captions", "pip", "fullscreen"] as const).filter((name) => !values[name]);
    const props = ['src="/demo.mp4"', 'poster="/demo.jpg"'];
    if (values.captions) props.push('tracks={[{ src: "/demo.en.vtt", srcLang: "en", label: "English" }]}');
    if (off.length > 0 || values.download) {
        const entries = [...off.map((name) => `${name}: false`), ...(values.download ? ["download: true"] : [])];
        props.push(`controls={{ ${entries.join(", ")} }}`);
    }
    if (!values.autoHide) props.push("autoHide={false}");

    return [
        'import { Video } from "@enigmax/primitives/react/video";',
        "",
        `<Video\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`
    ].join("\n");
}

export function VideoPlayground() {
    const [file, setFile] = useState<string | null>(null);
    const [name, setName] = useState("");

    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=":root"
            render={(values) => (
                <div className="pg-player">
                    <Video
                        key={file ?? "poster"}
                        src={file ?? undefined}
                        poster={POSTER}
                        tracks={values.captions ? [{ src: TRACK, srcLang: "en", label: "English" }] : undefined}
                        autoHide={values.autoHide}
                        controls={{
                            volume: values.volume,
                            settings: values.settings,
                            captions: values.captions,
                            pip: values.pip,
                            fullscreen: values.fullscreen,
                            download: values.download
                        }}
                        wrapperProps={{ className: "pg-player-frame" }}
                    />
                    <label className="pg-player-pick">
                        <input
                            type="file"
                            accept="video/*"
                            onChange={(event) => {
                                const picked = event.target.files?.[0];
                                if (!picked) return;
                                // Read from the visitor's own disk. Nothing is uploaded, and the
                                // URL dies with the tab.
                                setFile(URL.createObjectURL(picked));
                                setName(picked.name);
                            }}
                        />
                        <span>{name ? `Playing ${name}` : "Play a video from your own machine"}</span>
                    </label>
                </div>
            )}
        />
    );
}
