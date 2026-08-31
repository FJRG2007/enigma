import type { ReactNode } from "react";

/**
 * A very small JSX highlighter, for generated code only.
 *
 * The fenced blocks on this site go through Shiki at BUILD time, which a string that
 * changes as you move a control cannot use. Rather than ship a full highlighter to the
 * browser for one panel, this colours the handful of token shapes the generator can emit -
 * and its input space is exactly that: output from `code()` in the playground beside it,
 * never arbitrary source a reader pasted in.
 *
 * Colours are Vesper's, so a generated block and a static one look the same. It highlights
 * CSS too, because the Style tab emits a stylesheet, and an uncoloured wall of text beside a
 * coloured one reads as broken rather than as different.
 */

const JSX_TOKENS: [RegExp, string][] = [
    [/\/\/[^\n]*/g, "#8b8b8b"],                                  // line comment
    [/"[^"\n]*"/g, "#99ffe4"],                                   // string
    [/\{|\}/g, "#a0a0a0"],                                       // expression braces
    [/<\/?[A-Za-z][\w.]*/g, "#a0a0a0"],                          // tag open/close
    [/\b\d[\d_]*\b/g, "#ffc799"],                                // number
    [/\b(?:true|false|null|undefined|import|from|const)\b/g, "#a0a0a0"],
    [/\b[a-zA-Z][\w-]*(?==)/g, "#ffc799"]                        // attribute name
];

/**
 * The Style tab emits CSS, and CSS run through the JSX rules is a wall of one colour: no
 * tags, no expression braces, and `background: #e0a458` reads as an attribute followed by
 * nothing. So it gets its own token set, chosen for what a generated block can contain: a
 * selector, a custom property, a declaration, a colour, a length.
 */
const CSS_TOKENS: [RegExp, string][] = [
    [/\/\*[\s\S]*?\*\//g, "#8b8b8b"],                             // comment
    [/#[0-9a-fA-F]{3,8}\b/g, "#99ffe4"],                          // colour
    [/\b\d[\d.]*(?:px|rem|em|%|vh|vw|ms|s|fr)?\b/g, "#ffc799"],   // number, with its unit
    [/--[\w-]+/g, "#ffc799"],                                     // custom property
    [/^[^\n{]*(?=\{)/gm, "#a0a0a0"],                              // selector
    [/\b[a-z-]+(?=\s*:)/g, "#a0a0a0"],                            // property
    [/[{};]/g, "#8b8b8b"]
];

/**
 * CSS, or the component's code.
 *
 * Read from the text rather than passed in, because the panel emits both from one string and
 * the tab that produced it is not something the block is told. A line that ENDS in `{` and a
 * document with no `<` in it is CSS; JSX has tags, and its braces never sit at end of line.
 */
function tokensFor(code: string): [RegExp, string][] {
    const looksLikeCss = /\{\s*$/m.test(code) && !code.includes("<");
    return looksLikeCss ? CSS_TOKENS : JSX_TOKENS;
}

interface Piece {
    text: string;
    color?: string;
}

/**
 * Split once, left to right, so an earlier rule wins the overlap - a string inside a
 * comment stays comment-coloured rather than being re-split by the string rule.
 */
export function highlight(code: string): ReactNode {
    let pieces: Piece[] = [{ text: code }];

    for (const [pattern, color] of tokensFor(code)) {
        const next: Piece[] = [];
        for (const piece of pieces) {
            if (piece.color) { next.push(piece); continue; }
            let last = 0;
            for (const match of piece.text.matchAll(pattern)) {
                const at = match.index ?? 0;
                if (at > last) next.push({ text: piece.text.slice(last, at) });
                next.push({ text: match[0], color });
                last = at + match[0].length;
            }
            if (last < piece.text.length) next.push({ text: piece.text.slice(last) });
        }
        pieces = next;
    }

    return pieces.map((piece, index) => (
        <span key={index} style={piece.color ? { color: piece.color } : undefined}>{piece.text}</span>
    ));
}
