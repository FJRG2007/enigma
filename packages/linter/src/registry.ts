/** The built-in rule set (style + audit), assembled in one place. */

import type { Rule } from "./types";
import { fileHygiene } from "./rules/fileHygiene";
import { noUrlImports } from "./rules/noUrlImports";
import { noUselessConcat } from "./rules/noUselessConcat";
import { requireSemicolons } from "./rules/requireSemicolons";
import { preferDoubleQuotes } from "./rules/preferDoubleQuotes";
import { noHardcodedSecrets } from "./rules/noHardcodedSecrets";
import { lengthSortedImports } from "./rules/lengthSortedImports";
import { noConsecutiveBlankLines } from "./rules/noConsecutiveBlankLines";

export const RULES: Rule[] = [
    lengthSortedImports,
    preferDoubleQuotes,
    noUselessConcat,
    requireSemicolons,
    noUrlImports,
    fileHygiene,
    noConsecutiveBlankLines,
    noHardcodedSecrets,
];
