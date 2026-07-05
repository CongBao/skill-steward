const POSITIVE_ACTION =
  "(?:add|apply|build|call|create|edit|fix|generate|implement|install|" +
  "invoke|keep|maintain|make|migrate|open|prepare|preserve|read|remove|" +
  "review|run|test|update|use|verify|write)";
const POSITIVE_ACTION_PROGRESSIVE =
  "(?:adding|applying|building|calling|creating|editing|fixing|generating|" +
  "implementing|installing|invoking|keeping|maintaining|making|migrating|" +
  "opening|preparing|preserving|reading|removing|reviewing|running|testing|" +
  "updating|using|verifying|writing)";
const STANDALONE_POSITIVE_ACTION =
  `${POSITIVE_ACTION}\\b(?![\\p{P}\\p{S}])`;
const HORIZONTAL_SPACE = "[^\\S\\r\\n\\u2028\\u2029]";
const ACTION_LIST_CONTAINER = "(?:actions?|skills?|tasks?|tools?|workflows?)";
const LIST_TARGET_MODIFIER_CHARACTER =
  "(?:(?![.:;,!?\\u3001\\u3002\\uff0c\\uff01\\uff1a\\uff1b\\uff1f])" +
  "[\\p{L}\\p{N}\\p{M}\\p{P}\\p{S}\\u200d_])";
const LIST_TARGET_MODIFIERS =
  `(?:(?:${LIST_TARGET_MODIFIER_CHARACTER}){1,64}${HORIZONTAL_SPACE}+){0,5}`;
const NEGATION_LIST_ACTION =
  `(?:${POSITIVE_ACTION}|${POSITIVE_ACTION_PROGRESSIVE})`;
const CONTRAST_ACTION_START = `${POSITIVE_ACTION}\\b`;
const ACTION_LIST_WORD_JOINER = "(?:and(?:\\s*/\\s*or)?|or)";
const ACTION_LIST_SEPARATOR =
  `(?:(?:[\\p{P}\\p{S}]+\\s*)?${ACTION_LIST_WORD_JOINER}\\s+|` +
  "[\\p{P}\\p{S}]+\\s*)";
const NEGATION_CLAUSE_TEXT =
  "[^.!?;\\r\\n\\u2028\\u2029\\u3002\\uff01\\uff1b\\uff1f]*";
const NO_COMMA_CONTRAST_TEXT =
  "[^,.!?;\\r\\n\\u2028\\u2029\\u3001\\u3002\\uff0c\\uff01\\uff1b\\uff1f]*";
const EXPLICIT_CONTRAST_TEXT =
  "(?:(?!,\\s*(?:but|however|yet)\\b)" +
  "[^.!?;\\r\\n\\u2028\\u2029\\u3002\\uff01\\uff1b\\uff1f])*";
const ACTION_LIST_AFTER_COLON =
  `(?:instead\\s+)?${POSITIVE_ACTION}\\b` +
  `(?:\\s+${ACTION_LIST_CONTAINER})?\\s*` +
  `(?:${ACTION_LIST_SEPARATOR}${POSITIVE_ACTION}\\b|` +
  `(?:,\\s*)?instead\\s+of\\s+${POSITIVE_ACTION}\\b)`;
const STANDALONE_INSTEAD_CONTRAST =
  `${CONTRAST_ACTION_START}` +
  `(?=${EXPLICIT_CONTRAST_TEXT}\\binstead\\b(?!\\s+of\\b))`;
const EXPLICIT_INSTEAD_CONTRAST =
  `(?:instead\\s+${CONTRAST_ACTION_START}|${STANDALONE_INSTEAD_CONTRAST})`;
const BOUNDED_ACTION_SEQUENCE =
  `${POSITIVE_ACTION}\\b` +
  `(?:${ACTION_LIST_SEPARATOR}${POSITIVE_ACTION}\\b)+`;
const HEADER_STANDALONE_INSTEAD_CONTRAST =
  `(?:${POSITIVE_ACTION}\\b` +
  `(?=${NO_COMMA_CONTRAST_TEXT}\\binstead\\b(?!\\s+of\\b))|` +
  `${BOUNDED_ACTION_SEQUENCE}` +
  `(?=${NO_COMMA_CONTRAST_TEXT}\\binstead\\b(?!\\s+of\\b)))`;
const HEADER_EXPLICIT_INSTEAD_CONTRAST =
  `(?:instead\\s+${CONTRAST_ACTION_START}|` +
  `${HEADER_STANDALONE_INSTEAD_CONTRAST})`;
const LIST_TARGET_INTRO =
  `${LIST_TARGET_MODIFIERS}${ACTION_LIST_CONTAINER}${HORIZONTAL_SPACE}*:` +
  `(?!${HORIZONTAL_SPACE}*${HEADER_EXPLICIT_INSTEAD_CONTRAST})` +
  `${HORIZONTAL_SPACE}*`;
const NEGATION_LIST_INTRO =
  `(?:${NEGATION_LIST_ACTION}\\b${HORIZONTAL_SPACE}*:` +
  `${HORIZONTAL_SPACE}*|` +
  `${NEGATION_LIST_ACTION}\\b${HORIZONTAL_SPACE}+${LIST_TARGET_INTRO})`;
const POSITIVE_COLON_SUFFIX =
  `:\\s*(?:${EXPLICIT_INSTEAD_CONTRAST}|` +
  `(?!${ACTION_LIST_AFTER_COLON})${STANDALONE_POSITIVE_ACTION})`;
const POSITIVE_COMMA_SUFFIX =
  `,\\s*(?=${HEADER_EXPLICIT_INSTEAD_CONTRAST})`;
const NEGATION_CLAUSE_END =
  "(?=[.!?;\\r\\n\\u2028\\u2029\\u3002\\uff01\\uff1b\\uff1f]|" +
  ",\\s*(?:but|however|yet)\\b|" +
  `${POSITIVE_COMMA_SUFFIX}|${POSITIVE_COLON_SUFFIX}|$)`;
const NEGATION_CLAUSE_BODY = `([\\s\\S]+?)${NEGATION_CLAUSE_END}`;

const TASK_NEGATION_PATTERN = new RegExp(
  `\\b(?:do\\s+not|don['\\u2019]t|never|avoid|without)` +
    `${HORIZONTAL_SPACE}+` +
    `(?:${NEGATION_LIST_INTRO})?${NEGATION_CLAUSE_BODY}`,
  "giu"
);

const ROUTING_NEGATION_PATTERN = new RegExp(
  `\\b(?:(?:do\\s+not|don['\\u2019]t|never)\\s+` +
    "(?:use|invoke|call|run|apply)\\b(?:\\s+this\\s+skill)?|" +
    "avoid\\s+(?:using|invoking|calling|running|applying)" +
    `(?:\\s+this\\s+skill)?)${HORIZONTAL_SPACE}*` +
    `(?:for|when)?${HORIZONTAL_SPACE}*:?${HORIZONTAL_SPACE}*` +
    `(?:${LIST_TARGET_INTRO})?${NEGATION_CLAUSE_BODY}`,
  "giu"
);

const TASK_NEGATION_HINT = /\b(?:do\s+not|don['\u2019]t|never|avoid|without)\b/iu;
const ROUTING_NEGATION_HINT = /\b(?:do\s+not|don['\u2019]t|never|avoid)\b/iu;

function replaceClauses(value: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  const result = value.replace(pattern, " ");
  pattern.lastIndex = 0;
  return result;
}

function capturedClauses(value: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const clauses = [...value.matchAll(pattern)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  pattern.lastIndex = 0;
  return clauses;
}

/** @internal Bounded English polarity parsing; not a package-root API. */
export function positiveTaskText(task: string): string {
  if (!TASK_NEGATION_HINT.test(task)) return task;
  return replaceClauses(task, TASK_NEGATION_PATTERN);
}

/** @internal Bounded English polarity parsing; not a package-root API. */
export function negativeTaskClauses(task: string): string[] {
  if (!TASK_NEGATION_HINT.test(task)) return [];
  return capturedClauses(task, TASK_NEGATION_PATTERN);
}

/** @internal Bounded English polarity parsing; not a package-root API. */
export function positiveRoutingText(description: string): string {
  if (!ROUTING_NEGATION_HINT.test(description)) return description;
  return replaceClauses(description, ROUTING_NEGATION_PATTERN);
}

/** @internal Bounded English polarity parsing; not a package-root API. */
export function negativeRoutingClauses(description: string): string[] {
  if (!ROUTING_NEGATION_HINT.test(description)) return [];
  return capturedClauses(description, ROUTING_NEGATION_PATTERN);
}
