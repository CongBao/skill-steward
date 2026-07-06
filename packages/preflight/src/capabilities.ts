import { positiveTaskText } from "./polarity.js";
import { normalizeTask, tokenizeSequence } from "./tokenize.js";

const MAX_ACTIONS = 16;
const MAX_OBJECTS = 16;
const MAX_PAIRS = 16;
const PAIR_WINDOW = 4;
const MAX_INPUT_CHARACTERS = 20_000;
const AMBIGUOUS_ACTIONS = new Set(["plan", "design", "test", "review", "document"]);
const NON_ACTION_MARKERS = new Set([
  "are",
  "background",
  "is",
  "mention",
  "mentioned",
  "was",
  "were"
]);

const ACTIONS = new Map<string, string>([
  ["plan", "plan"],
  ["planning", "plan"],
  ["roadmap", "plan"],
  ["organize", "plan"],
  ["organise", "plan"],
  ["整理", "plan"],
  ["规划", "plan"],
  ["規劃", "plan"],
  ["计划", "plan"],
  ["計劃", "plan"],
  ["design", "design"],
  ["architect", "design"],
  ["设计", "design"],
  ["設計", "design"],
  ["implement", "implement"],
  ["implementation", "implement"],
  ["develop", "implement"],
  ["development", "implement"],
  ["build", "implement"],
  ["实现", "implement"],
  ["實現", "implement"],
  ["开发", "implement"],
  ["開發", "implement"],
  ["test", "test"],
  ["testing", "test"],
  ["测试", "test"],
  ["測試", "test"],
  ["verify", "verify"],
  ["verification", "verify"],
  ["validate", "verify"],
  ["validation", "verify"],
  ["验证", "verify"],
  ["驗證", "verify"],
  ["检查", "verify"],
  ["檢查", "verify"],
  ["debug", "debug"],
  ["diagnose", "debug"],
  ["troubleshoot", "debug"],
  ["调试", "debug"],
  ["調試", "debug"],
  ["诊断", "debug"],
  ["診斷", "debug"],
  ["review", "review"],
  ["审查", "review"],
  ["審查", "review"],
  ["评审", "review"],
  ["評審", "review"],
  ["research", "research"],
  ["analyze", "research"],
  ["analyse", "research"],
  ["investigate", "research"],
  ["调研", "research"],
  ["調研", "research"],
  ["分析", "research"],
  ["publish", "publish"],
  ["发布", "publish"],
  ["發布", "publish"],
  ["merge", "merge"],
  ["合并", "merge"],
  ["合併", "merge"],
  ["deploy", "deploy"],
  ["deployment", "deploy"],
  ["部署", "deploy"],
  ["install", "install"],
  ["installation", "install"],
  ["安装", "install"],
  ["安裝", "install"],
  ["migrate", "migrate"],
  ["migration", "migrate"],
  ["迁移", "migrate"],
  ["遷移", "migrate"],
  ["document", "document"],
  ["writ", "document"],
  ["write", "document"],
  ["编写", "document"],
  ["編寫", "document"],
  ["撰写", "document"],
  ["撰寫", "document"],
  ["monitor", "monitor"],
  ["monitoring", "monitor"],
  ["监控", "monitor"],
  ["監控", "monitor"]
]);

const OBJECTS = new Map<string, string>([
  ["plan", "plan"],
  ["roadmap", "plan"],
  ["方案", "plan"],
  ["spec", "specification"],
  ["specification", "specification"],
  ["规范", "specification"],
  ["規範", "specification"],
  ["requirement", "requirement"],
  ["需求", "requirement"],
  ["要求", "requirement"],
  ["feature", "feature"],
  ["functionality", "feature"],
  ["功能", "feature"],
  ["code", "code"],
  ["代码", "code"],
  ["代碼", "code"],
  ["test", "test"],
  ["测试", "test"],
  ["測試", "test"],
  ["quality", "quality"],
  ["质量", "quality"],
  ["質量", "quality"],
  ["cli", "cli"],
  ["command", "cli"],
  ["命令", "cli"],
  ["api", "api"],
  ["github", "github"],
  ["pr", "pull-request"],
  ["pull", "pull-request"],
  ["release", "release"],
  ["version", "release"],
  ["版本", "release"],
  ["document", "document"],
  ["documentation", "document"],
  ["doc", "document"],
  ["文档", "document"],
  ["文檔", "document"],
  ["readme", "readme"],
  ["ui", "ui"],
  ["interface", "ui"],
  ["界面", "ui"],
  ["browser", "browser"],
  ["浏览器", "browser"],
  ["瀏覽器", "browser"],
  ["skill", "skill"],
  ["plugin", "plugin"],
  ["插件", "plugin"],
  ["agent", "agent"],
  ["智能体", "agent"],
  ["智能體", "agent"],
  ["review", "review"],
  ["审查", "review"],
  ["審查", "review"],
  ["security", "security"],
  ["安全", "security"],
  ["performance", "performance"],
  ["性能", "performance"],
  ["bug", "bug"],
  ["failure", "bug"],
  ["错误", "bug"],
  ["錯誤", "bug"],
  ["故障", "bug"],
  ["session", "session"],
  ["context", "context"],
  ["上下文", "context"]
]);

const CLAUSE_BOUNDARY = /[.!?;,:，。！？；：、\n]+|\b(?:and|then|next)\b|(?:然后|然後|接着|接著|并且|並且|以及)/giu;

export interface CapabilitySet {
  actions: ReadonlySet<string>;
  objects: ReadonlySet<string>;
  pairs: ReadonlySet<string>;
  all: ReadonlySet<string>;
}

function addBounded(target: Set<string>, value: string, maximum: number): void {
  if (target.size < maximum || target.has(value)) target.add(value);
}

function canonicalTerms(value: string): string[] {
  return tokenizeSequence(value).map((term) => term.toLowerCase());
}

function actionAt(term: string): string | undefined {
  return ACTIONS.get(term);
}

function objectAt(term: string): string | undefined {
  return OBJECTS.get(term);
}

export function extractCapabilities(value: string): CapabilitySet {
  const positive = positiveTaskText(
    normalizeTask(value).slice(0, MAX_INPUT_CHARACTERS)
  );
  const actions = new Set<string>();
  const objects = new Set<string>();
  const pairs = new Set<string>();

  for (const clause of positive.split(CLAUSE_BOUNDARY)) {
    const terms = canonicalTerms(clause);
    if (terms.length === 0) continue;
    const actionEntries = terms.flatMap((term, index) => {
      const action = actionAt(term);
      return action ? [{ action, index }] : [];
    });
    const objectEntries = terms.flatMap((term, index) => {
      const object = objectAt(term);
      return object ? [{ object, index }] : [];
    });

    for (const { object } of objectEntries) addBounded(objects, object, MAX_OBJECTS);
    for (const { action, index } of actionEntries) {
      const nearby = objectEntries.filter(({ index: objectIndex }) =>
        Math.abs(objectIndex - index) <= PAIR_WINDOW
      );
      if (
        AMBIGUOUS_ACTIONS.has(action) &&
        (
          !nearby.some(({ object }) => object !== action) ||
          terms.some((term) => NON_ACTION_MARKERS.has(term))
        )
      ) continue;
      addBounded(actions, action, MAX_ACTIONS);
      for (const { object } of nearby) {
        if (AMBIGUOUS_ACTIONS.has(action) && object === action) continue;
        if (action === "publish" && object === "pull-request") continue;
        addBounded(pairs, `${action}:${object}`, MAX_PAIRS);
      }
    }
  }

  const all = new Set<string>();
  for (const action of actions) addBounded(all, `action:${action}`, 48);
  for (const object of objects) addBounded(all, `object:${object}`, 48);
  for (const pair of pairs) addBounded(all, `pair:${pair}`, 48);
  return { actions, objects, pairs, all };
}
