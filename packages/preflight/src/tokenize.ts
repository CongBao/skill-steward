const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "can",
  "change",
  "could",
  "create",
  "do",
  "does",
  "for",
  "from",
  "help",
  "i",
  "in",
  "it",
  "its",
  "make",
  "need",
  "not",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "task",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "want",
  "when",
  "with",
  "would",
  "we",
  "you",
  "your"
]);

const INFLECTION_DOUBLED_CONSONANTS = new Set([
  "b",
  "d",
  "g",
  "m",
  "n",
  "p",
  "r",
  "t"
]);

const LEXICAL_DOUBLE_ROOTS = new Set([
  "add",
  "err",
  "purr",
  "whirr"
]);

export interface TokenizedText {
  terms: string[];
  counts: Record<string, number>;
}

export function normalizeTask(value: string): string {
  return value.normalize("NFKC").trim();
}

function normalizeLatin(value: string): string {
  if (STOP_WORDS.has(value)) return "";
  let term = value;
  if (term.endsWith("ing") && term.length > 5) {
    term = term.slice(0, -3);
    if (
      term.length > 2 &&
      term.at(-1) === term.at(-2) &&
      INFLECTION_DOUBLED_CONSONANTS.has(term.at(-1) ?? "") &&
      !LEXICAL_DOUBLE_ROOTS.has(term)
    ) {
      term = term.slice(0, -1);
    }
  } else if (term.endsWith("ies") && term.length > 4) {
    term = `${term.slice(0, -3)}y`;
  } else if (
    term.endsWith("s") &&
    term.length > 3 &&
    !/(ss|us|is)$/u.test(term)
  ) {
    term = term.slice(0, -1);
  }
  return STOP_WORDS.has(term) ? "" : term;
}

export function tokenize(value: string): TokenizedText {
  const normalized = normalizeTask(value).toLowerCase();
  const terms: string[] = [];
  const counts: Record<string, number> = {};
  const emit = (term: string) => {
    if (!term) return;
    if (!(term in counts)) terms.push(term);
    counts[term] = (counts[term] ?? 0) + 1;
  };

  for (const match of normalized.matchAll(
    /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+/gu
  )) {
    const segment = match[0];
    if (/^[a-z0-9]+$/u.test(segment)) {
      const term = normalizeLatin(segment);
      if (term.length >= 2) emit(term);
      continue;
    }

    const characters = [...segment];
    characters.forEach(emit);
    for (let index = 0; index < characters.length - 1; index += 1) {
      emit(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return { terms, counts };
}
