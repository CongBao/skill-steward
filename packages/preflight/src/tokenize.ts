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

const CJK_STOP_WORDS = new Set([
  "并",
  "並",
  "不是",
  "不再",
  "但",
  "当前",
  "當前",
  "的",
  "对",
  "對",
  "而",
  "完成",
  "该",
  "該",
  "和",
  "或",
  "及",
  "阶段",
  "階段",
  "进行",
  "继续",
  "繼續",
  "将",
  "將",
  "就",
  "了",
  "每个",
  "每個",
  "那些",
  "那个",
  "那個",
  "你",
  "您",
  "请",
  "請",
  "让",
  "讓",
  "然后",
  "如果",
  "重新",
  "整体",
  "整體",
  "是否",
  "所有",
  "他们",
  "他們",
  "它",
  "它们",
  "它們",
  "推进",
  "推進",
  "为",
  "為",
  "问题",
  "問題",
  "我",
  "我们",
  "希望",
  "想要",
  "需要",
  "也",
  "以",
  "用",
  "用户",
  "用戶",
  "与",
  "與",
  "在",
  "这个",
  "這個",
  "这些",
  "這些",
  "中"
]);

const CJK_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

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

function segmentCjk(value: string): string[] {
  const terms: string[] = [];
  let pendingSingles = "";
  const flushSingles = () => {
    if ([...pendingSingles].length >= 2 && !CJK_STOP_WORDS.has(pendingSingles)) {
      terms.push(pendingSingles);
    }
    pendingSingles = "";
  };

  for (const part of CJK_SEGMENTER.segment(value)) {
    if (!part.isWordLike) continue;
    if ([...part.segment].length === 1) {
      if (CJK_STOP_WORDS.has(part.segment)) {
        flushSingles();
      } else {
        pendingSingles += part.segment;
      }
      continue;
    }
    flushSingles();
    if (!CJK_STOP_WORDS.has(part.segment)) terms.push(part.segment);
  }
  flushSingles();
  return terms;
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

    segmentCjk(segment).forEach(emit);
  }

  return { terms, counts };
}
