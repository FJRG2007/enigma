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
 * Colours are Vesper's, so a generated block and a static one look the same.
 */

const TOKENS: [RegExp, string][] = [
    [/\/\/[^\n]*/g, "#8b8b8b"],                                  // line comment
    [/"[^"\n]*"/g, "#99ffe4"],                                   // string
    [/\{|\}/g, "#a0a0a0"],                                       // expression braces
    [/<\/?[A-Za-z][\w.]*/g, "#a0a0a0"],                          // tag open/close
    [/\b\d[\d_]*\b/g, "#ffc799"],                                // number
    [/\b(?:true|false|null|undefined|import|from|const)\b/g, "#a0a0a0"],
    [/\b[a-zA-Z][\w-]*(?==)/g, "#ffc799"]                        // attribute name
];

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

    for (const [pattern, color] of TOKENS) {
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
