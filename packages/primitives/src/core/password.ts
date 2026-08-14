/**
 * Making a password, and judging one.
 *
 * Both are opt-in. A sign-in form wants neither: offering to generate a password where one
 * already exists is noise, and scoring one the visitor cannot change is worse. They belong
 * on a registration form and a change-password form, which is where an agent should switch
 * them on.
 */

/** Character classes a generated password can draw from. */
export interface PasswordAlphabet {
    lowercase?: boolean;
    uppercase?: boolean;
    digits?: boolean;
    symbols?: boolean;
}

export interface GeneratePasswordOptions extends PasswordAlphabet {
    /** Default 20. Long beats clever: length is the only term that scales. */
    length?: number;
    /**
     * Drop the characters that are read wrong off a screen or off paper - I l 1 O 0.
     * Worth it when the password will be typed by hand, not worth the entropy otherwise.
     */
    excludeAmbiguous?: boolean;
    /** Characters to remove from every class, e.g. ones your backend rejects. */
    exclude?: string;
    /**
     * Guarantee at least one character from every class asked for. Most password policies
     * demand it; it costs a little entropy, because it removes every password that happens
     * to lack one.
     */
    requireEachClass?: boolean;
}

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/**
 * No quotes, backslash, backtick or space: those are the characters that get mangled on the
 * way through a shell, a CSV, a JSON blob written by hand, or a copy out of a terminal.
 */
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";
const AMBIGUOUS = "Il1O0";

/**
 * Uniform in [0, bound), by rejection.
 *
 * `value % bound` is the version everyone writes and it is biased: 2^32 is not a multiple
 * of most bounds, so the first few characters of the alphabet come up slightly more often.
 * On a password that is a real, if small, loss of entropy, and it costs one comparison to
 * avoid.
 */
function randomIndex(bound: number): number {
    const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
    if (!random) {
        // Never Math.random. A generator that silently produces predictable passwords is
        // worse than one that refuses: nothing downstream can tell the difference.
        throw new Error("Generating a password needs crypto.getRandomValues, which browsers only expose over HTTPS (or on localhost).");
    }
    const limit = Math.floor(2 ** 32 / bound) * bound;
    const buffer = new Uint32Array(1);
    let value: number;
    do {
        random(buffer);
        value = buffer[0];
    } while (value >= limit);
    return value % bound;
}

function pick(alphabet: string): string {
    return alphabet[randomIndex(alphabet.length)];
}

function classes(options: GeneratePasswordOptions): string[] {
    const { lowercase = true, uppercase = true, digits = true, symbols = true, excludeAmbiguous = false, exclude = "" } = options;
    const banned = new Set([...(excludeAmbiguous ? AMBIGUOUS : ""), ...exclude]);
    const clean = (source: string): string => [...source].filter((character) => !banned.has(character)).join("");

    return [
        lowercase ? clean(LOWERCASE) : "",
        uppercase ? clean(UPPERCASE) : "",
        digits ? clean(DIGITS) : "",
        symbols ? clean(SYMBOLS) : ""
    ].filter(Boolean);
}

/** Fisher-Yates, with the same unbiased source. A biased shuffle undoes a fair draw. */
function shuffle(characters: string[]): string[] {
    for (let index = characters.length - 1; index > 0; index--) {
        const swap = randomIndex(index + 1);
        [characters[index], characters[swap]] = [characters[swap], characters[index]];
    }
    return characters;
}

/**
 * A random password from the classes asked for.
 *
 * @throws when the runtime has no CSPRNG, or when the options ask for something impossible
 *         (every class excluded, or a length too short to hold one of each).
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
    const { length = 20, requireEachClass = true } = options;
    const pools = classes(options);
    if (!pools.length) throw new Error("generatePassword: every character class was excluded.");
    if (length < 1) throw new Error("generatePassword: length must be at least 1.");
    if (requireEachClass && length < pools.length) {
        throw new Error(`generatePassword: length ${length} cannot hold one character from each of the ${pools.length} classes requested.`);
    }

    const everything = pools.join("");
    // One from each class first, the rest uniform, then shuffled - so the guarantee does
    // not put the digit in a predictable place.
    const required = requireEachClass ? pools.map(pick) : [];
    const rest = Array.from({ length: length - required.length }, () => pick(everything));
    return shuffle([...required, ...rest]).join("");
}

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrengthReport {
    /** 0 worst, 4 best. What the bars under the field render. */
    score: PasswordScore;
    /** Estimated bits of entropy after the penalties below. */
    bits: number;
    /**
     * Why it scored what it scored, worst first. Show the first one; showing all of them
     * turns a hint into a lecture.
     */
    warnings: string[];
    /** Empty field. Render nothing rather than a zero score, which reads as a failure. */
    empty: boolean;
}

export interface EstimateOptions {
    /**
     * Values the visitor has already typed elsewhere - email, name, company. A password
     * containing one of them is guessable by anyone who has the sign-up form in front of
     * them, and no character-class rule catches it.
     */
    userInputs?: string[];
}

/**
 * The forty or so passwords that turn up at the top of every breach corpus. Not a
 * dictionary: it is here to catch `password1`, not to be exhaustive. For real coverage
 * either replace the estimator with zxcvbn, or check the breach corpus - which is what
 * `checkPasswordBreach` in @enigmax/utils is for.
 */
const COMMON = new Set([
    "password", "passwd", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertyuiop",
    "abc123", "111111", "123123", "admin", "letmein", "welcome", "monkey", "dragon", "sunshine",
    "iloveyou", "princess", "football", "baseball", "master", "shadow", "superman", "batman",
    "trustno1", "hello", "freedom", "whatever", "starwars", "changeme", "secret", "login",
    "root", "toor", "test", "guest", "azerty", "1q2w3e4r", "zaq12wsx"
]);

const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** The pool an attacker would have to search, from the classes actually used. */
function poolSize(password: string): number {
    let size = 0;
    if (/[a-z]/.test(password)) size += 26;
    if (/[A-Z]/.test(password)) size += 26;
    if (/\d/.test(password)) size += 10;
    if (/[^\w\s]|_/.test(password)) size += SYMBOLS.length;
    if (/\s/.test(password)) size += 1;
    return size || 1;
}

/** Longest run of the same character, and longest run along a keyboard or alphabet line. */
function longestRun(password: string): number {
    let longest = 1, run = 1;
    for (let index = 1; index < password.length; index++) {
        run = password[index] === password[index - 1] ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    return longest;
}

function longestSequence(password: string): number {
    const lower = password.toLowerCase();
    let longest = 0;
    for (const line of SEQUENCES) {
        const reversed = [...line].reverse().join("");
        for (const source of [line, reversed]) {
            for (let start = 0; start < source.length; start++) {
                for (let end = source.length; end > start + longest; end--) {
                    if (lower.includes(source.slice(start, end))) {
                        longest = Math.max(longest, end - start);
                        break;
                    }
                }
            }
        }
    }
    return longest;
}

/** Strip the decoration people add to satisfy a policy: Password1! is password. */
function core(password: string): string {
    return password.toLowerCase().replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "").replace(/[0!@$]/g, (character) => ({ "0": "o", "!": "i", "@": "a", "$": "s" })[character] ?? character);
}

/**
 * Score a password.
 *
 * The bits are an estimate and the bands are a convention, not a measurement - they exist
 * to move a bar, not to certify anything. Swap this out for zxcvbn where the number has to
 * mean something, and check the breach corpus for the cases no estimator can see.
 */
export function estimatePasswordStrength(password: string, options: EstimateOptions = {}): PasswordStrengthReport {
    if (!password) return { score: 0, bits: 0, warnings: [], empty: true };

    const warnings: string[] = [];
    let bits = password.length * Math.log2(poolSize(password));

    const stripped = core(password);
    if (COMMON.has(password.toLowerCase()) || COMMON.has(stripped)) {
        // A password on every list has no entropy at all, whatever its shape.
        bits = Math.min(bits, 8);
        warnings.push("This is one of the most common passwords there is.");
    }

    for (const input of options.userInputs ?? []) {
        const needle = input.trim().toLowerCase();
        // A three-letter name matches half the passwords in the world; ignore short ones.
        if (needle.length < 4 || !password.toLowerCase().includes(needle)) continue;
        bits = Math.min(bits, 16);
        warnings.push("It contains something you already typed on this form.");
        break;
    }

    const run = longestRun(password);
    if (run >= 3) {
        bits -= (run - 2) * Math.log2(poolSize(password));
        warnings.push("A character repeats several times in a row.");
    }

    const sequence = longestSequence(password);
    if (sequence >= 4) {
        bits -= sequence * Math.log2(poolSize(password)) * 0.75;
        warnings.push("Part of it runs straight along the keyboard or the alphabet.");
    }

    if (password.length < 8) warnings.push("Short passwords fall to a brute force whatever they contain.");

    bits = Math.max(0, Math.round(bits));
    const score: PasswordScore = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
    return { score, bits, warnings, empty: false };
}
