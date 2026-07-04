import { normalizeTask, tokenize } from "./tokenize.js";

export interface GapDisplayTerm {
  display: string;
  concepts: string[];
}

const CJK_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

const CJK_DISPLAY_SINGLE_STOP_WORDS = new Set([
  "把",
  "并",
  "並",
  "的",
  "对",
  "對",
  "和",
  "或",
  "及",
  "将",
  "將",
  "了",
  "请",
  "請",
  "让",
  "讓",
  "为",
  "為",
  "与",
  "與",
  "用",
  "在",
  "中"
]);

const DISPLAY_CONCEPTS = new Map<string, readonly string[]>([
  ["every", []],
  ["keep", ["preserve"]],
  ["kept", ["preserve"]],
  ["preservation", ["preserve"]],
  ["preserve", ["preserve"]],
  ["develop", ["development"]],
  ["development", ["development"]],
  ["一个", []],
  ["一個", []],
  ["一些", []],
  ["不断", []],
  ["不斷", []],
  ["会", []],
  ["會", []],
  ["仍然", []],
  ["正在", []],
  ["请在", []],
  ["請在", []],
  ["保留", ["preserve"]],
  ["保存", ["preserve"]],
  ["保持", ["preserve"]],
  ["澄清", ["clarification"]],
  ["开发", ["development"]],
  ["開發", ["development"]],
  ["制作", ["generation"]],
  ["製作", ["generation"]],
  ["文件", ["file"]]
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

const NEGATIVE_USAGE_CLAUSE =
  /(?:do\s+not|don't)\s+use(?:\s+this\s+skill)?\s+(?:for|when)\s+[^.!?\n]+/giu;

function mappedConcepts(value: string): string[] | undefined {
  const mapped = DISPLAY_CONCEPTS.get(value);
  return mapped ? [...mapped] : undefined;
}

function stripInflectionDouble(value: string): string {
  if (
    value.length > 2 &&
    value.at(-1) === value.at(-2) &&
    INFLECTION_DOUBLED_CONSONANTS.has(value.at(-1) ?? "") &&
    !LEXICAL_DOUBLE_ROOTS.has(value)
  ) {
    return value.slice(0, -1);
  }
  return value;
}

function latinGapLemma(value: string): string {
  let term = value;
  if (term.endsWith("ing") && term.length > 5) {
    const base = stripInflectionDouble(term.slice(0, -3));
    term = /(at|iz|v)$/u.test(base) ? `${base}e` : base;
  } else if (term.endsWith("ed") && term.length > 4) {
    const base = stripInflectionDouble(term.slice(0, -2));
    term = /(at|iz|v)$/u.test(base) ? `${base}e` : base;
  } else if (term.endsWith("ies") && term.length > 4) {
    term = `${term.slice(0, -3)}y`;
  } else if (
    term.endsWith("s") &&
    term.length > 3 &&
    !/(ss|us|is)$/u.test(term)
  ) {
    term = term.slice(0, -1);
  }
  return term;
}

function canonicalLatinConcepts(value: string): string[] {
  const lemma = latinGapLemma(value);
  const mapped = mappedConcepts(lemma);
  if (mapped) return mapped;
  return tokenize(lemma).terms.flatMap((term) =>
    mappedConcepts(term) ?? [term]
  );
}

function canonicalConcepts(value: string): string[] {
  const normalized = normalizeTask(value).toLowerCase();
  const direct = mappedConcepts(normalized);
  if (direct) return direct;
  if (/^[a-z0-9]+$/u.test(normalized)) {
    return [...new Set(canonicalLatinConcepts(normalized))];
  }
  return [...new Set(tokenize(normalized).terms.flatMap((term) =>
    mappedConcepts(term) ?? canonicalLatinConcepts(term)
  ))];
}

function cjkDisplayTerms(value: string): string[] {
  const terms: string[] = [];
  let pendingSpecificSingles = "";
  const flushSpecificSingles = () => {
    if ([...pendingSpecificSingles].length >= 2) terms.push(pendingSpecificSingles);
    pendingSpecificSingles = "";
  };
  for (const part of CJK_SEGMENTER.segment(value)) {
    if (!part.isWordLike) continue;
    if ([...part.segment].length === 1) {
      if (CJK_DISPLAY_SINGLE_STOP_WORDS.has(part.segment)) {
        flushSpecificSingles();
      } else {
        pendingSpecificSingles += part.segment;
      }
      continue;
    }
    flushSpecificSingles();
    if (canonicalConcepts(part.segment).length > 0) terms.push(part.segment);
  }
  flushSpecificSingles();
  return terms;
}

/** @internal Capability-gap presentation only; never use for recommendation routing. */
export function gapDisplayTerms(value: string): GapDisplayTerm[] {
  const terms: GapDisplayTerm[] = [];
  for (const match of normalizeTask(value).toLowerCase().matchAll(
    /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+/gu
  )) {
    const segment = match[0];
    const displayTerms = /^[a-z0-9]+$/u.test(segment)
      ? [segment]
      : cjkDisplayTerms(segment);
    for (const display of displayTerms) {
      const concepts = canonicalConcepts(display);
      if (concepts.length > 0) terms.push({ display, concepts });
    }
  }
  return terms;
}

/** @internal Positive candidate metadata projected into the gap-only namespace. */
export function positiveGapConcepts(name: string, description: string): Set<string> {
  const positiveDescription = description.replace(NEGATIVE_USAGE_CLAUSE, " ");
  return new Set(gapDisplayTerms(
    `${name.replace(/[-_]+/gu, " ")} ${positiveDescription}`
  ).flatMap(({ concepts }) => concepts));
}
