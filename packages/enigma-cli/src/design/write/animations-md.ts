/**
 * references/ANIMATIONS.md: the motion stack, scroll journey, videos, scroll-triggered
 * patterns, every @keyframes with its usage, motion variables, global transitions, and
 * a step-by-step guide to recreating the motion design.
 */

import type * as types from "../types";
import { code, fenced, image, text } from "./md";

const LIBRARY_PACKAGES: Record<string, string> = {
    "GSAP": "gsap", "ScrollTrigger": "gsap", "ScrollSmoother": "gsap", "Lottie": "lottie-web", "Bodymovin (Lottie)": "lottie-web",
    "Three.js": "three", "PixiJS": "pixi.js", "Framer Motion": "framer-motion", "Motion One / Framer Motion": "motion",
    "AOS (Animate On Scroll)": "aos", "AOS": "aos", "Anime.js": "animejs", "Velocity.js": "velocity-animate",
    "Matter.js (Physics)": "matter-js", "Locomotive Scroll": "locomotive-scroll",
};

function scrollLabel(pct: number): string {
    if (pct === 0) return "Top / Hero";
    if (pct <= 20) return "Opening Section";
    if (pct <= 40) return "First Feature Section";
    if (pct <= 60) return "Mid-Page";
    if (pct <= 80) return "Lower Content";
    if (pct < 100) return "Near Footer";
    return "Bottom / Footer";
}

function describeKeyframe(kf: types.ExtractedKeyframe): string {
    const props = [...new Set(kf.stops.flatMap((s) => Object.keys(s.properties)))];
    const has = (p: string): boolean => props.some((u) => u.includes(p));
    const out: string[] = [];
    if (has("opacity") && has("transform")) out.push("Fade + motion enter animation");
    else if (has("opacity")) out.push("Opacity fade");
    else if (has("transform")) out.push("Transform/motion animation");
    if (has("background")) out.push("Background color/gradient shift");
    if (has("clip-path")) out.push("Clip-path reveal");
    if (has("filter")) out.push("Filter effect (blur/brightness)");
    if (has("stroke")) out.push("SVG stroke animation");
    if (has("width") || has("height")) out.push("Dimension expand/collapse");
    if (has("border")) out.push("Border animation");
    if (has("box-shadow")) out.push("Shadow pulse/glow effect");
    if (has("color")) out.push("Text color shift");
    return out.slice(0, 2).join(" - ");
}

const AOS_SETUP = "<!-- in <head> -->\n<link rel=\"stylesheet\" href=\"https://unpkg.com/aos@2.3.1/dist/aos.css\">\n\n<!-- before </body> -->\n<script src=\"https://unpkg.com/aos@2.3.1/dist/aos.js\"></script>\n<script>AOS.init({ once: true, offset: 80 });</script>";
const GSAP_SETUP = "gsap.registerPlugin(ScrollTrigger);\n\ngsap.from(\".element\", {\n  opacity: 0,\n  y: 60,\n  duration: 0.8,\n  ease: \"power2.out\",\n  scrollTrigger: { trigger: \".element\", start: \"top 80%\", end: \"bottom 20%\" },\n});";
const IO_CSS = ".animate-on-scroll {\n  opacity: 0;\n  transform: translateY(40px);\n  animation: fadeSlideUp 0.6s ease-out forwards;\n  animation-play-state: paused;\n}\n.animate-on-scroll.visible {\n  animation-play-state: running;\n}";
const IO_JS = "const observer = new IntersectionObserver((entries) => {\n  for (const e of entries) if (e.isIntersecting) e.target.classList.add(\"visible\");\n}, { threshold: 0.1 });\ndocument.querySelectorAll(\".animate-on-scroll\").forEach((el) => observer.observe(el));";

export function generateAnimationsMd(anim: types.FullAnimationResult): string {
    let md = "# Animation Reference\n\n> Motion design extracted from the live page. Follow these specs to recreate the experience.\n\n## Motion Technology Stack\n\n";
    if (anim.libraries.length === 0 && anim.canvasCount === 0 && !anim.webglDetected) {
        md += "Pure CSS animations: no animation library detected.\n\n";
    } else {
        md += "| Library | Type | Notes |\n|---------|------|-------|\n";
        for (const lib of anim.libraries) md += `| **${text(lib.name, 60)}${lib.version ? ` v${text(lib.version, 20)}` : ""}** | ${lib.type} | ${lib.cdn ? code(lib.cdn) : ""} |\n`;
        if (anim.canvasCount > 0) {
            md += `| Canvas (${anim.canvasCount} elements) | ${anim.webglDetected ? "WebGL/3D" : "2D Canvas"} | ${anim.webglDetected ? "WebGL context detected: Three.js or a custom shader" : "2D canvas rendering"} |\n`;
        }
        if (anim.lottieCount > 0) md += `| Lottie (${anim.lottieCount} players) | vector | JSON-based vector animations |\n`;
        md += "\n";
    }

    if (anim.scrollFrames.length > 0) {
        md += `## Scroll Journey\n\nThe page is **${Math.round(anim.scrollFrames[0]!.pageHeight)}px** tall. Each frame shows what the user sees at that depth.\n\n> Use these screenshots to see WHAT animates, WHEN, and HOW it moves.\n\n`;
        for (const f of anim.scrollFrames) md += `### ${f.scrollPercent}% - ${scrollLabel(f.scrollPercent)}\n\nScroll position: ${f.scrollY}px\n\n${image(`Scroll ${f.scrollPercent}%`, `../${f.filePath}`)}\n\n`;
    }

    if (anim.videos.length > 0) {
        md += "## Video Elements\n\n| # | Role | Autoplay | Loop | Muted | Size | First Frame |\n|---|------|----------|------|-------|------|-------------|\n";
        const yes = (b: boolean): string => (b ? "yes" : "no");
        for (const v of anim.videos) {
            md += `| ${v.index} | ${v.role} | ${yes(v.autoplay)} | ${yes(v.loop)} | ${yes(v.muted)} | ${v.width && v.height ? `${v.width}x${v.height}` : "-"} | ${v.firstFramePath ? `[view](../${v.firstFramePath})` : "-"} |\n`;
        }
        md += "\n";
        for (const v of anim.videos) {
            if (v.firstFramePath) md += `**Video ${v.index} first frame:**\n\n${image(`Video ${v.index} frame`, `../${v.firstFramePath}`)}\n\n`;
            if (v.src) md += `- **Source:** ${code(v.src, 120)}\n`;
            if (v.poster) md += `- **Poster:** ${code(v.poster, 120)}\n`;
        }
        md += "\n";
    }

    if (anim.scrollPatterns.length > 0) {
        md += "## Scroll Animation Patterns\n\n| Pattern | Library | Elements | Duration | Delay | Easing |\n|---------|---------|----------|----------|-------|--------|\n";
        for (const p of anim.scrollPatterns) {
            md += `| ${text(p.animationType, 60)} | ${p.library} | ${p.count} | ${text(p.duration ?? "-", 20)} | ${text(p.delay ?? "-", 20)} | ${text(p.easing ?? "-", 40)} |\n`;
        }
        md += "\n";
        for (const lib of [...new Set(anim.scrollPatterns.map((p) => p.library))]) {
            md += `### ${lib} Implementation\n\n`;
            if (lib === "AOS") {
                md += fenced("html", AOS_SETUP);
                for (const p of anim.scrollPatterns.filter((x) => x.library === lib).slice(0, 5)) {
                    const attr = (name: string, v?: string): string => (v && /^[\w-]+$/.test(v) ? ` ${name}="${v}"` : "");
                    md += fenced("html", `<div data-aos="${p.animationType.replace(/[^\w-]/g, "")}"${attr("data-aos-duration", p.duration)}${attr("data-aos-delay", p.delay)}>...</div>`);
                }
                md += "\n";
            } else if (lib.includes("GSAP")) {
                md += `${fenced("javascript", GSAP_SETUP)}\n`;
            } else if (lib === "CSS + IntersectionObserver") {
                md += `${fenced("css", IO_CSS)}\n${fenced("javascript", IO_JS)}\n`;
            }
        }
    }

    if (anim.keyframes.length > 0) {
        md += `## CSS Keyframes (${anim.keyframes.length} extracted)\n\n`;
        for (const kf of [...anim.keyframes].sort((a, b) => b.usedBy.length - a.usedBy.length)) {
            md += `### ${code(`@keyframes ${kf.name}`)}\n\n`;
            const meta = [
                kf.animDuration && `Duration: ${code(kf.animDuration)}`, kf.animEasing && `Easing: ${code(kf.animEasing)}`,
                kf.animDelay && `Delay: ${code(kf.animDelay)}`, kf.animIteration && `Iteration: ${code(kf.animIteration)}`,
                kf.animFillMode && `Fill: ${code(kf.animFillMode)}`,
            ].filter(Boolean);
            if (meta.length > 0) md += `${meta.join(" - ")}\n\n`;
            if (kf.usedBy.length > 0) md += `Used by: ${kf.usedBy.slice(0, 4).map((s) => code(s)).join(", ")}\n\n`;
            const body = kf.stops.map((s) => `  ${s.stop} {\n${Object.entries(s.properties).filter(([, v]) => v && v !== "initial").map(([p, v]) => `    ${p}: ${v};\n`).join("")}  }`).join("\n");
            md += fenced("css", `@keyframes ${kf.name} {\n${body}\n}`);
            const desc = describeKeyframe(kf);
            md += desc ? `\n> ${desc}\n\n` : "\n";
        }
    }

    if (anim.animationVars.length > 0) {
        md += "## Motion Tokens (CSS Variables)\n\n";
        for (const cat of ["duration", "easing", "delay", "animation", "other"] as const) {
            const vars = anim.animationVars.filter((v) => v.category === cat);
            if (vars.length > 0) md += `### ${cat.charAt(0).toUpperCase()}${cat.slice(1)} Tokens\n\n${fenced("css", vars.map((v) => `${v.name}: ${v.value};`).join("\n"))}\n`;
        }
    }

    if (anim.globalTransitions.length > 0) {
        md += `## Global Transition Declarations\n\nThese \`transition\` values appear across the site's CSS rules:\n\n${fenced("css", [...new Set(anim.globalTransitions)].slice(0, 12).map((t) => `transition: ${t};`).join("\n"))}\n`;
    }

    md += "## How to Recreate This Motion Design\n\n";
    const packages = [...new Set(anim.libraries.map((l) => LIBRARY_PACKAGES[l.name]).filter((p): p is string => !!p))];
    if (packages.length > 0) md += `### Step 1 - Install Dependencies\n\n${fenced("bash", packages.map((p) => `npm install ${p}`).join("\n"))}\n`;
    const duration = anim.animationVars.find((v) => v.category === "duration")?.value ?? anim.globalTransitions[0]?.match(/\d+\.?\d*(?:ms|s)/)?.[0] ?? "0.6s";
    const ease = anim.animationVars.find((v) => v.category === "easing")?.value ?? "cubic-bezier(0.4, 0, 0.2, 1)";
    md += `### Step 2 - Scroll-Reveal Pattern\n\nElements that animate into view follow this pattern:\n\n${fenced("css",
        `/* Initial hidden state */\n.reveal {\n  opacity: 0;\n  transform: translateY(40px);\n  transition: opacity ${duration} ${ease},\n              transform ${duration} ${ease};\n}\n.reveal.visible {\n  opacity: 1;\n  transform: translateY(0);\n}`)}\n`;
    md += "### Step 3 - Key Motion Principles\n\n";
    if (anim.webglDetected) md += "- **WebGL/3D layer detected**: product visuals use Three.js or custom WebGL; render 3D with `<canvas>` and Three.js\n";
    if (anim.videos.some((v) => v.role === "background")) md += "- **Video backgrounds**: use `<video autoplay loop muted playsinline>` with a poster image fallback\n";
    if (anim.libraries.some((l) => l.name === "GSAP" || l.name === "ScrollTrigger")) md += "- **GSAP ScrollTrigger**: scroll-linked animations (rotation, parallax) use `ScrollTrigger` with `scrub` for frame-accurate sync\n";
    if (anim.canvasCount > 0) md += `- **Canvas elements (${anim.canvasCount})**: animated with a requestAnimationFrame loop (particles, gradients, WebGL scenes)\n`;
    const durations = [...new Set([
        ...anim.animationVars.filter((v) => v.category === "duration").map((v) => v.value),
        ...(anim.globalTransitions.join(" ").match(/\d+\.?\d*(?:ms|s)/g) ?? []).slice(0, 5),
    ])];
    if (durations.length > 0) md += `- **Duration scale:** ${durations.map((d) => code(d)).join(" - ")}; use these values, never invent new ones\n`;
    md += "- **Always add** `@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }`\n\n";
    if (anim.scrollFrames.length > 0) {
        md += `### Step 4 - Scroll Journey Reference\n\nMatch what happens at each scroll position:\n\n${anim.scrollFrames.map((f) => `- **${f.scrollPercent}%** (\`${f.scrollY}px\`) -> \`${f.filePath}\``).join("\n")}\n`;
    }
    return md;
}
