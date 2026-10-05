/**
 * Everything animation-related on a live page: @keyframes with the rules that use them,
 * motion variables, animation libraries in use, video elements (with a first-frame
 * capture), scroll-triggered patterns, canvas/WebGL/Lottie, global transitions, and a
 * scroll journey - seven viewport captures from the top of the page to the bottom.
 */

import { join } from "node:path";
import type * as types from "../types";
import { writeFileSync } from "node:fs";
import { VIEWPORT } from "../browser/page";
import type { Page } from "../browser/page";
import { keyframesInCss, keyframeUsage } from "./keyframes";

const SCROLL_PERCENTS = [0, 17, 33, 50, 67, 83, 100];
const MAX_VIDEOS = 6;

interface Analysis {
    keyframes: Array<{ name: string; stops: types.KeyframeStop[]; }>;
    usage: Record<string, { selectors: string[]; duration?: string; easing?: string; delay?: string; iteration?: string; fillMode?: string; direction?: string; }>;
    vars: Array<{ name: string; value: string; }>;
    libraries: types.DetectedLibrary[];
    videos: Array<Omit<types.VideoInfo, "firstFramePath">>;
    scrollPatterns: types.ScrollAnimationPattern[];
    canvasCount: number;
    webgl: boolean;
    lottieCount: number;
    transitions: string[];
}

/** Runs in the page: phases that only read the DOM and stylesheets. */
const ANALYSIS_SCRIPT = String.raw`() => {
    const MOTION_VAR = /duration|ease|delay|timing|animation|transition|spring|bounce|motion|speed|curve/i;
    const rulesOf = (sheet) => { try { return Array.from(sheet.cssRules || []); } catch (e) { return []; } };
    const allRules = [];
    const collect = (rules) => { for (const r of rules) { allRules.push(r); if (r.cssRules && !(r instanceof CSSKeyframesRule)) collect(Array.from(r.cssRules)); } };
    for (const sheet of Array.from(document.styleSheets)) collect(rulesOf(sheet));

    const keyframes = [];
    for (const rule of allRules) {
        if (!(rule instanceof CSSKeyframesRule)) continue;
        const stops = [];
        for (const kf of Array.from(rule.cssRules)) {
            const properties = {};
            for (let i = 0; i < kf.style.length; i++) { const p = kf.style[i]; properties[p] = kf.style.getPropertyValue(p); }
            stops.push({ stop: kf.keyText, properties });
        }
        keyframes.push({ name: rule.name, stops });
    }

    const usage = {};
    const transitions = new Set();
    const vars = [];
    for (const rule of allRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const st = rule.style;
        const names = (st.animationName || "").split(",").map((n) => n.trim()).filter((n) => n && n !== "none");
        for (const n of names) {
            const u = usage[n] || (usage[n] = { selectors: [] });
            u.selectors.push((rule.selectorText || "").slice(0, 80));
            u.duration = u.duration || st.animationDuration || undefined;
            u.easing = u.easing || st.animationTimingFunction || undefined;
            u.delay = u.delay || st.animationDelay || undefined;
            u.iteration = u.iteration || st.animationIterationCount || undefined;
            u.fillMode = u.fillMode || st.animationFillMode || undefined;
            u.direction = u.direction || st.animationDirection || undefined;
        }
        const t = st.transition;
        if (t && t !== "none" && !t.startsWith("all 0s")) transitions.add(t);
        if (rule.selectorText === ":root" || rule.selectorText === "html" || rule.selectorText === "*") {
            for (let i = 0; i < st.length; i++) {
                const p = st[i];
                if (p.startsWith("--") && MOTION_VAR.test(p)) vars.push({ name: p, value: st.getPropertyValue(p).trim() });
            }
        }
    }
    const rootStyle = getComputedStyle(document.documentElement);
    for (const p of Array.from(rootStyle)) {
        if (p.startsWith("--") && MOTION_VAR.test(p) && !vars.some((v) => v.name === p)) {
            const val = rootStyle.getPropertyValue(p).trim();
            if (val) vars.push({ name: p, value: val });
        }
    }

    const w = window;
    const libraries = [];
    const has = (name) => libraries.some((l) => l.name === name || l.name.includes(name));
    if (w.gsap) libraries.push({ name: "GSAP", version: w.gsap.version, type: "animation" });
    if (w.ScrollTrigger) libraries.push({ name: "ScrollTrigger", type: "scroll" });
    if (w.ScrollSmoother) libraries.push({ name: "ScrollSmoother", type: "scroll" });
    if (w.lottie || w.Lottie) libraries.push({ name: "Lottie", version: (w.lottie || w.Lottie).version, type: "lottie" });
    if (w.bodymovin) libraries.push({ name: "Bodymovin (Lottie)", type: "lottie" });
    if (w.THREE) libraries.push({ name: "Three.js", version: String(w.THREE.REVISION), type: "3d" });
    if (w.PIXI) libraries.push({ name: "PixiJS", version: w.PIXI.VERSION, type: "3d" });
    if (w.BABYLON || w.Babylon) libraries.push({ name: "BabylonJS", type: "3d" });
    if (w.Motion || w.motion) libraries.push({ name: "Motion One / Framer Motion", type: "animation" });
    if (w.AOS) libraries.push({ name: "AOS (Animate On Scroll)", version: w.AOS.version, type: "scroll" });
    if (w.anime) libraries.push({ name: "Anime.js", version: w.anime.version, type: "animation" });
    if (w.ScrollMagic) libraries.push({ name: "ScrollMagic", type: "scroll" });
    if (w.LocomotiveScroll || w.locomotiveScroll) libraries.push({ name: "Locomotive Scroll", type: "scroll" });
    if (w.Velocity) libraries.push({ name: "Velocity.js", type: "animation" });
    if (w.popmotion) libraries.push({ name: "Popmotion", type: "physics" });
    if (w.Matter) libraries.push({ name: "Matter.js (Physics)", type: "physics" });
    if (typeof document.getAnimations === "function") {
        const active = document.getAnimations().length;
        if (active > 0) libraries.push({ name: "Web Animations API (" + active + " active)", type: "animation" });
    }
    for (const script of Array.from(document.querySelectorAll("script[src]"))) {
        const src = script.src || "";
        const base = src.split("/").slice(0, 5).join("/");
        if (/gsap/i.test(src) && !has("GSAP")) libraries.push({ name: "GSAP", type: "animation", cdn: base });
        if (/lottie|bodymovin/i.test(src) && !has("Lottie")) libraries.push({ name: "Lottie", type: "lottie", cdn: base });
        if (/three(\.min)?\.js|three\.module/i.test(src) && !has("Three.js")) libraries.push({ name: "Three.js", type: "3d", cdn: src });
        if (/framer-motion|motion\.js/i.test(src) && !has("Framer Motion")) libraries.push({ name: "Framer Motion", type: "animation", cdn: src });
        if (/aos(\.min)?\.js/i.test(src) && !has("AOS")) libraries.push({ name: "AOS", type: "scroll", cdn: src });
    }

    const videos = Array.from(document.querySelectorAll("video")).map((v, i) => {
        const source = v.querySelector("source");
        return {
            index: i + 1, src: v.currentSrc || v.src || (source && source.getAttribute("src")) || "", poster: v.poster || "",
            autoplay: v.autoplay, loop: v.loop, muted: v.muted,
            width: Math.round(v.offsetWidth), height: Math.round(v.offsetHeight),
            role: v.offsetWidth > 800 ? "background" : "content",
        };
    });

    const scrollPatterns = [];
    const aos = {};
    document.querySelectorAll("[data-aos]").forEach((el) => { const t = el.getAttribute("data-aos") || "unknown"; aos[t] = (aos[t] || 0) + 1; });
    for (const type of Object.keys(aos)) {
        const sample = Array.from(document.querySelectorAll("[data-aos]")).find((el) => el.getAttribute("data-aos") === type);
        scrollPatterns.push({
            selector: "[data-aos=\"" + type + "\"]", library: "AOS", attribute: "data-aos=\"" + type + "\"", animationType: type,
            duration: (sample && sample.getAttribute("data-aos-duration")) || undefined,
            delay: (sample && sample.getAttribute("data-aos-delay")) || undefined,
            easing: (sample && sample.getAttribute("data-aos-easing")) || undefined,
            count: aos[type],
        });
    }
    const loco = document.querySelectorAll("[data-scroll]").length;
    if (loco) scrollPatterns.push({ selector: "[data-scroll]", library: "Locomotive Scroll", attribute: "data-scroll", animationType: "scroll-reveal", count: loco });
    const gsapEls = document.querySelectorAll("[data-gsap], [data-animation], [data-parallax]").length;
    if (gsapEls) scrollPatterns.push({ selector: "[data-gsap], [data-animation]", library: "GSAP", attribute: "data-gsap", animationType: "scroll-trigger", count: gsapEls });
    let paused = 0;
    document.querySelectorAll("[class]").forEach((el) => {
        const s = getComputedStyle(el);
        const hidden = parseFloat(s.opacity) < 0.1 || (s.transform !== "none" && s.transform !== "matrix(1, 0, 0, 1, 0, 0)");
        if (hidden && s.animationPlayState === "paused") paused++;
    });
    if (paused) scrollPatterns.push({ selector: ".animation-paused", library: "CSS + IntersectionObserver", attribute: "animation-play-state: paused", animationType: "scroll-reveal (paused -> running)", count: paused });
    const sticky = document.querySelectorAll("[style*=sticky], [class*=sticky], [class*=parallax]").length;
    if (sticky) scrollPatterns.push({ selector: ".sticky, .parallax", library: "CSS", attribute: "position: sticky", animationType: "parallax / sticky scroll", count: sticky });
    const lottiePlayers = document.querySelectorAll("lottie-player, dotlottie-player, [data-lottie]").length;
    if (lottiePlayers) scrollPatterns.push({ selector: "lottie-player", library: "Lottie", attribute: "lottie-player", animationType: "vector animation", count: lottiePlayers });

    const canvases = Array.from(document.querySelectorAll("canvas"));
    let webgl = false;
    for (const c of canvases) {
        try { if (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")) webgl = true; } catch (e) {}
    }
    const lottieCount = document.querySelectorAll("lottie-player, dotlottie-player, [data-lottie], svg[class*=lottie]").length;

    return { keyframes, usage, vars, libraries, videos, scrollPatterns, canvasCount: canvases.length, webgl, lottieCount, transitions: Array.from(transitions).slice(0, 20) };
}`;

/** Runs in the page: pause video `index` on its first frame, scroll it into view, return its document rect. */
const VIDEO_FRAME_SCRIPT = String.raw`async (index) => {
    const v = document.querySelectorAll("video")[index];
    if (!v) return null;
    v.pause();
    try { v.currentTime = 0; } catch (e) {}
    v.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 300));
    const r = v.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
}`;

function categorizeVar(name: string): types.CSSAnimationVar["category"] {
    if (/duration|speed/i.test(name)) return "duration";
    if (/ease|timing|curve|bezier/i.test(name)) return "easing";
    if (/delay/i.test(name)) return "delay";
    if (/animation|keyframe/i.test(name)) return "animation";
    return "other";
}

/** Analyse `page` (already loaded) and write its captures under `<skillDir>/screens/scroll`. */
export async function captureAnimations(page: Page, skillDir: string): Promise<types.FullAnimationResult> {
    const scrollDir = join(skillDir, "screens", "scroll");
    const a = await page.evaluate<Analysis>(ANALYSIS_SCRIPT);

    const keyframes: types.ExtractedKeyframe[] = a.keyframes.map((kf) => {
        const u = a.usage[kf.name];
        return {
            name: kf.name, stops: kf.stops, usedBy: [...new Set(u?.selectors ?? [])].filter(Boolean).slice(0, 8),
            animDuration: u?.duration, animEasing: u?.easing, animDelay: u?.delay,
            animIteration: u?.iteration, animFillMode: u?.fillMode, animDirection: u?.direction,
        };
    });
    // Sheets the page script could not read (cross-origin) still arrive as text over DevTools.
    try {
        const css = (await page.styleSheetTexts()).join("\n");
        const fromText = keyframesInCss(css).filter((kf) => !keyframes.some((k) => k.name === kf.name));
        const usage = keyframeUsage(css, new Set(fromText.map((kf) => kf.name)));
        for (const kf of fromText) keyframes.push({ ...kf, usedBy: [], ...usage.get(kf.name) });
    } catch { /* the in-page pass stands alone */ }

    const videos: types.VideoInfo[] = [];
    for (const v of a.videos.slice(0, MAX_VIDEOS)) {
        const entry: types.VideoInfo = { ...v };
        try {
            const rect = await page.evaluate<{ x: number; y: number; width: number; height: number; } | null>(VIDEO_FRAME_SCRIPT, v.index - 1);
            if (rect && rect.width > 50 && rect.height > 50) {
                const file = `video-${v.index}-frame.png`;
                writeFileSync(join(scrollDir, file), await page.screenshot({
                    x: Math.max(0, rect.x), y: Math.max(0, rect.y),
                    width: Math.min(rect.width, VIEWPORT.width), height: Math.min(rect.height, VIEWPORT.height),
                }));
                entry.firstFramePath = `screens/scroll/${file}`;
            }
        } catch { /* frame capture is best-effort */ }
        videos.push(entry);
    }

    const scrollFrames: types.ScrollFrame[] = [];
    const pageHeight = await page.evaluate<number>("() => document.documentElement.scrollHeight");
    for (const pct of SCROLL_PERCENTS) {
        const target = Math.round((pct / 100) * Math.max(0, pageHeight - VIEWPORT.height));
        try {
            await page.evaluate("(y) => window.scrollTo({ top: y, behavior: \"instant\" })", target);
            // Long enough for scroll-triggered reveals to run.
            await page.wait(700);
            const file = `scroll-${String(pct).padStart(3, "0")}.png`;
            writeFileSync(join(scrollDir, file), await page.screenshot());
            const scrollY = await page.evaluate<number>("() => window.scrollY");
            scrollFrames.push({ scrollPercent: pct, scrollY, pageHeight, filePath: `screens/scroll/${file}` });
        } catch { /* a missing frame does not void the rest */ }
    }

    return {
        keyframes,
        scrollFrames,
        libraries: a.libraries,
        videos,
        scrollPatterns: a.scrollPatterns,
        animationVars: a.vars.map((v) => ({ ...v, category: categorizeVar(v.name) })).slice(0, 40),
        globalTransitions: a.transitions,
        canvasCount: a.canvasCount,
        webglDetected: a.webgl,
        lottieCount: a.lottieCount,
    };
}
