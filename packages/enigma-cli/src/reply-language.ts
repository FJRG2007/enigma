/**
 * Which natural language a piece of prose is written in, and whether a reply matches the user's.
 *
 * WHY. The kernel says "respond in the user's language", and agents still drift into English after
 * a run of English tool output, a handoff or a plugin prompt - reported by a user who wrote every
 * message in Spanish and got the replies in English for a whole session. The rule is about the
 * REPLY only: the model may think and call tools in any language, so nothing here reads anything
 * but the final message.
 *
 * HOW. Function-word counts, the classic stopword method: every language has a small closed set
 * of words (articles, prepositions, conjunctions) that make up a large share of any sentence and
 * survive typos and technical vocabulary. A word several languages share is listed under each, so
 * it adds to all of them and decides nothing. A verdict needs a minimum count and a clear lead
 * over the runner-up; anything less is "unknown", and unknown never blocks.
 */

const WORDS: Record<string, string[]> = {
    English: [
        "the", "and", "is", "are", "was", "were", "this", "that", "these", "those", "with", "for", "not", "it", "of", "to",
        "be", "have", "has", "but", "you", "we", "they", "what", "which", "from", "by", "will", "can", "does", "there",
        "its", "now", "only", "also", "than", "then", "why", "how", "already", "still", "should", "would", "could",
        "into", "when", "been", "after", "before", "because", "here", "your", "our", "it's", "isn't", "don't",
    ],
    Spanish: [
        "el", "la", "los", "las", "que", "y", "un", "una", "es", "por", "con", "para", "se", "del", "al", "lo", "como",
        "pero", "más", "mas", "este", "esta", "esto", "estos", "ya", "porque", "pq", "cuando", "también", "tambien", "tmb",
        "hay", "son", "está", "sin", "sobre", "muy", "todo", "eso", "ese", "qué", "cómo", "sí", "ahora", "aquí", "aqui",
        "solo", "sólo", "pues", "o", "da", "donde", "dónde", "puedes", "tengo", "estoy", "hace", "hecho", "cada", "nada", "mismo",
    ],
    Portuguese: [
        "o", "os", "um", "uma", "não", "nao", "é", "com", "mas", "mais", "você", "voce", "isso", "também", "está", "esta",
        "são", "muito", "do", "da", "dos", "das", "em", "na", "ao", "pelo", "pela", "então", "agora", "que", "para", "como",
    ],
    French: [
        "le", "la", "les", "des", "une", "est", "et", "pas", "pour", "avec", "dans", "ce", "cette", "qui", "vous", "nous",
        "je", "il", "sur", "mais", "du", "au", "aux", "très", "ça", "sont", "être", "que", "un", "plus",
    ],
    German: [
        "der", "die", "das", "und", "ist", "nicht", "mit", "für", "auf", "ein", "eine", "ich", "wir", "zu", "von", "den",
        "dem", "auch", "aber", "wie", "oder", "sind", "wird", "kann", "noch", "schon", "nur", "jetzt",
    ],
    Italian: [
        "il", "gli", "che", "di", "è", "per", "non", "sono", "questo", "questa", "anche", "ma", "della", "nel", "alla",
        "la", "lo", "del", "con", "una", "un", "più", "come", "perché",
    ],
};

const LOOKUP = new Map<string, string[]>();
for (const [language, words] of Object.entries(WORDS)) {
    for (const word of words) LOOKUP.set(word, [...(LOOKUP.get(word) ?? []), language]);
}

/** Text that is not prose in anyone's language: code, commands, links, quoted material. */
function prose(text: string): string {
    return text
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .replace(/<[^>\n]+>/g, " ")
        .replace(/\bhttps?:\/\/\S+/g, " ")
        // A quoted line repeats someone else's words, in whatever language they wrote them.
        .replace(/^\s*>.*$/gm, " ")
        // A long double-quoted span is a quotation or a pasted message, not the writer's prose.
        .replace(/"[^"]{60,}"/g, " ");
}

/**
 * The language `text` is written in, or null when the evidence is too thin to say.
 * `minHits` is how many function words the winner needs; it must also double the runner-up.
 */
export function dominantLanguage(text: string, minHits = 3): string | null {
    const counts = new Map<string, number>();
    for (const token of prose(text).toLowerCase().match(/[\p{L}']+/gu) ?? []) {
        for (const language of LOOKUP.get(token) ?? []) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [first, second] = ranked;
    if (!first || first[1] < minHits) return null;
    if (second && first[1] < second[1] * 2) return null;
    return first[0];
}

/** A reply in a different language from the user's, as both language names; null when they match or either is unclear. */
export interface LanguageMismatch { user: string; reply: string; }

/**
 * The language the user writes in, by majority over their recent prompts (newest first).
 *
 * Not the newest prompt alone: a user who writes Spanish routinely sends a bare English paste - a
 * console error, a block of UI copy - without the paste tags, and replaying 870 real turns showed
 * the newest-prompt rule turning those into 21 false "reply in English" findings. A short prompt
 * ("ok", "sigue") has no verdict and does not vote. A strict majority of the voting prompts is
 * required, so a split history yields null and nothing is enforced.
 */
export function userLanguage(prompts: string[]): string | null {
    const votes = new Map<string, number>();
    let voters = 0;
    for (const prompt of prompts) {
        const language = dominantLanguage(prompt);
        if (!language) continue;
        voters++;
        votes.set(language, (votes.get(language) ?? 0) + 1);
    }
    const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    return winner && winner[1] * 2 > voters ? winner[0] : null;
}

/**
 * A reply that drifted INTO English while the user writes another language (userLanguage over
 * `prompts`, newest first).
 *
 * One direction only, on purpose. Drifting into English is the failure: the model's working
 * language is English, so a run of English tool output, a handoff or a plugin prompt pulls the
 * reply there. The other direction is where the detector is wrong: a user who writes Spanish and
 * pastes English UI copy turn after turn can out-vote their own words, and the replay of 870 real
 * turns found every "reply in English" verdict against a Spanish reply to be exactly that. Telling
 * the model to answer a Spanish speaker in English is the one outcome worse than missing a drift.
 */
export function replyLanguageMismatch(prompts: string[], reply: string): LanguageMismatch | null {
    const user = userLanguage(prompts);
    if (!user || user === "English") return null;
    // The reply needs more evidence than the prompt: a two-line status in the right language must
    // never be read as the wrong one off three shared words.
    return dominantLanguage(reply, 6) === "English" ? { user, reply: "English" } : null;
}

/** The feedback for a mismatch. It names what may stay English so the fix does not over-reach. */
export function languageMessage(mismatch: LanguageMismatch): string {
    return `enigma verify: STOP. The user writes in ${mismatch.user} and this reply is in ${mismatch.reply}. Rewrite the reply to the user in ${mismatch.user}. Only the reply changes: your thinking and tool calls may stay in any language, and code, identifiers, commands, paths, commit messages and file contents stay in English.`;
}
