/**
 * The design-extraction vocabulary: what every extractor produces (RawTokens), what the
 * normalizer turns it into (DesignProfile), and the browser-only results of an ultra run.
 * Types only; no logic lives here.
 */

export type ComponentCategory =
    | "layout" | "navigation" | "data-display" | "data-input" | "feedback"
    | "overlay" | "typography" | "media" | "other";

export type FrameworkId =
    | "tailwind" | "react" | "vue" | "next" | "nuxt" | "svelte" | "angular" | "css-in-js" | "css-modules";

export interface Framework {
    id: FrameworkId;
    name: string;
    version?: string;
}

export type TokenSource = "tailwind" | "css" | "tokens-file" | "component" | "computed";

export type ColorRole =
    | "background" | "surface" | "text-primary" | "text-muted" | "accent" | "border"
    | "danger" | "success" | "warning" | "info" | "unknown";

export interface ColorToken {
    hex: string;
    name?: string;
    role: ColorRole;
    frequency: number;
    source: TokenSource;
}

export type TypographyRole = "heading-1" | "heading-2" | "heading-3" | "heading-4" | "body" | "caption" | "code" | "unknown";

export interface TypographyToken {
    role: TypographyRole;
    fontFamily: string;
    fontSize?: string;
    fontWeight?: string | number;
    lineHeight?: string;
    source: TokenSource;
}

export interface SpacingScale {
    base: number;
    values: number[];
    unit: "px" | "rem";
}

export type ShadowLevel = "flat" | "raised" | "floating" | "overlay";

export interface ShadowToken {
    value: string;
    level: ShadowLevel;
    name?: string;
}

export interface TailwindPattern {
    backgrounds: string[];
    borders: string[];
    spacing: string[];
    typography: string[];
    effects: string[];
    layout: string[];
    interactive: string[];
}

export interface ComponentInfo {
    name: string;
    filePath: string;
    variants: string[];
    cssClasses: string[];
    jsxSnippet: string;
    props: string[];
    category: ComponentCategory;
    hasAnimation: boolean;
    animationDetails: string[];
    statePatterns: string[];
    tailwindPatterns: TailwindPattern;
}

export interface Breakpoint {
    name: string;
    value: string;
    source: "tailwind" | "css";
}

export interface CSSVariable {
    name: string;
    value: string;
    property?: string;
}

export interface AnimationToken {
    name: string;
    type: "css-keyframe" | "css-transition" | "framer-motion" | "spring";
    value: string;
    source: string;
}

export interface DarkModeVar {
    variable: string;
    lightValue: string;
    darkValue: string;
}

export interface FontSource {
    family: string;
    src: string;
    format?: string;
    weight?: string;
}

export interface PageSection {
    type: "navigation" | "hero" | "features" | "content" | "cards" | "faq" | "footer" | "cta" | "stats" | "testimonials";
    tag: string;
    classes: string[];
    childCount: number;
    description: string;
}

export interface MotionTokens {
    durations: string[];
    easings: string[];
    properties: string[];
}

export interface ProjectLibraries {
    iconLibrary: string | null;
    stateLibrary: string | null;
    animationLibrary: string | null;
}

/** Everything the extractors collect, before normalization. */
export interface RawTokens {
    colors: Array<{ value: string; frequency: number; source: TokenSource; name?: string; }>;
    fonts: Array<{ family: string; size?: string; weight?: string | number; source: TokenSource; }>;
    spacingValues: number[];
    shadows: Array<{ value: string; name?: string; }>;
    cssVariables: CSSVariable[];
    breakpoints: Breakpoint[];
    borderRadii: string[];
    gradients: string[];
    fontVarMap: Record<string, string>;
    animations: AnimationToken[];
    darkModeVars: DarkModeVar[];
    zIndexValues: number[];
    containerMaxWidth: string | null;
    fontSources: FontSource[];
    pageSections: PageSection[];
    transitionDurations: string[];
    transitionEasings: string[];
    favicon?: string | null;
    siteTitle?: string | null;
    /** Type the browser measured on real elements (`h1`, `p`, ...): the scale as rendered. */
    renderedType?: RenderedType[];
}

export interface RenderedType {
    tag: string;
    family: string;
    size: string;
    weight: string;
    lineHeight: string;
}

export interface DesignTraits {
    isDark: boolean;
    hasShadows: boolean;
    hasGradients: boolean;
    hasRoundedFull: boolean;
    maxBorderRadius: number;
    primaryColorTemp: "warm" | "cool" | "neutral";
    fontStyle: "serif" | "sans-serif" | "monospace";
    density: "compact" | "standard" | "spacious";
    hasAnimations: boolean;
    hasDarkMode: boolean;
    motionStyle: "none" | "subtle" | "expressive";
}

/** The normalized design system every writer renders from. */
export interface DesignProfile {
    projectName: string;
    siteUrl?: string;
    favicon?: string | null;
    frameworks: Framework[];
    colors: ColorToken[];
    typography: TypographyToken[];
    spacing: SpacingScale;
    shadows: ShadowToken[];
    components: ComponentInfo[];
    breakpoints: Breakpoint[];
    cssVariables: CSSVariable[];
    borderRadius: string[];
    fontVarMap: Record<string, string>;
    antiPatterns: string[];
    designTraits: DesignTraits;
    animations: AnimationToken[];
    darkModeVars: DarkModeVar[];
    iconLibrary: string | null;
    stateLibrary: string | null;
    componentCategories: Record<ComponentCategory, string[]>;
    zIndexScale: number[];
    containerMaxWidth: string | null;
    fontSources: FontSource[];
    pageSections: PageSection[];
    motionTokens: MotionTokens;
}

// -- Ultra (browser-driven) results ------------------------------------------------------

export interface PageScreenshot {
    url: string;
    slug: string;
    /** Relative to the skill dir: screens/pages/<slug>.png */
    filePath: string;
    title: string;
}

export interface SectionScreenshot {
    page: string;
    index: number;
    /** Relative to the skill dir: screens/sections/<page>-section-<n>.png */
    filePath: string;
    selector: string;
    height: number;
    width: number;
}

export interface StyleSnapshot {
    backgroundColor: string;
    color: string;
    borderColor: string;
    borderWidth: string;
    boxShadow: string;
    opacity: string;
    transform: string;
    outline: string;
    outlineColor: string;
    textDecoration: string;
    transition: string;
}

export interface StyleDiff {
    property: string;
    from: string;
    to: string;
}

export interface InteractionRecord {
    componentType: "button" | "link" | "input" | "role-button";
    label: string;
    selector: string;
    index: number;
    screenshots: { default?: string; hover?: string; focus?: string; };
    hoverChanges: StyleDiff[];
    focusChanges: StyleDiff[];
    transitionValue: string;
}

export interface LayoutRecord {
    tag: string;
    selector: string;
    display: string;
    flexDirection: string;
    flexWrap: string;
    justifyContent: string;
    alignItems: string;
    gap: string;
    rowGap: string;
    columnGap: string;
    padding: string;
    margin: string;
    gridTemplateColumns: string;
    gridTemplateRows: string;
    maxWidth: string;
    width: string;
    height: string;
    position: string;
    childCount: number;
    depth: number;
}

export interface DOMComponent {
    name: string;
    pattern: string;
    instances: number;
    commonClasses: string[];
    htmlSnippet: string;
    category: "card" | "list-item" | "nav-item" | "form-field" | "button" | "badge" | "unknown";
}

export interface KeyframeStop {
    stop: string;
    properties: Record<string, string>;
}

export interface ExtractedKeyframe {
    name: string;
    stops: KeyframeStop[];
    usedBy: string[];
    animDuration?: string;
    animEasing?: string;
    animDelay?: string;
    animIteration?: string;
    animFillMode?: string;
    animDirection?: string;
}

export interface ScrollFrame {
    scrollPercent: number;
    scrollY: number;
    pageHeight: number;
    /** Relative to the skill dir: screens/scroll/scroll-NNN.png */
    filePath: string;
}

export interface DetectedLibrary {
    name: string;
    version?: string;
    type: "animation" | "scroll" | "physics" | "3d" | "lottie" | "other";
    cdn?: string;
}

export interface VideoInfo {
    index: number;
    src: string;
    poster?: string;
    autoplay: boolean;
    loop: boolean;
    muted: boolean;
    width?: number;
    height?: number;
    role: "background" | "content" | "unknown";
    firstFramePath?: string;
}

export interface ScrollAnimationPattern {
    selector: string;
    library: string;
    attribute?: string;
    animationType: string;
    duration?: string;
    delay?: string;
    easing?: string;
    count: number;
}

export interface CSSAnimationVar {
    name: string;
    value: string;
    category: "duration" | "easing" | "delay" | "animation" | "other";
}

export interface FullAnimationResult {
    keyframes: ExtractedKeyframe[];
    scrollFrames: ScrollFrame[];
    libraries: DetectedLibrary[];
    videos: VideoInfo[];
    scrollPatterns: ScrollAnimationPattern[];
    animationVars: CSSAnimationVar[];
    globalTransitions: string[];
    canvasCount: number;
    webglDetected: boolean;
    lottieCount: number;
}

export interface UltraResult {
    pageScreenshots: PageScreenshot[];
    sectionScreenshots: SectionScreenshot[];
    interactions: InteractionRecord[];
    layouts: LayoutRecord[];
    domComponents: DOMComponent[];
    animations: FullAnimationResult;
}
