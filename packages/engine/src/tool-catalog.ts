/**
 * Tool-specific project skill directories from OpenSpec's supported-tools
 * reference. Keep this table data-only so adding a harness does not require
 * changes to discovery logic.
 */
export const openSpecToolDirectories = [
  { id: "amazon-q", skillDirectory: ".amazonq/skills" },
  { id: "antigravity", skillDirectory: ".agent/skills" },
  { id: "auggie", skillDirectory: ".augment/skills" },
  { id: "bob", skillDirectory: ".bob/skills" },
  { id: "claude", skillDirectory: ".claude/skills" },
  { id: "cline", skillDirectory: ".cline/skills" },
  { id: "codebuddy", skillDirectory: ".codebuddy/skills" },
  { id: "codex", skillDirectory: ".codex/skills" },
  { id: "forgecode", skillDirectory: ".forge/skills" },
  { id: "continue", skillDirectory: ".continue/skills" },
  { id: "costrict", skillDirectory: ".cospec/skills" },
  { id: "crush", skillDirectory: ".crush/skills" },
  { id: "cursor", skillDirectory: ".cursor/skills" },
  { id: "factory", skillDirectory: ".factory/skills" },
  { id: "gemini", skillDirectory: ".gemini/skills" },
  { id: "github-copilot", skillDirectory: ".github/skills" },
  { id: "iflow", skillDirectory: ".iflow/skills" },
  { id: "junie", skillDirectory: ".junie/skills" },
  { id: "kilocode", skillDirectory: ".kilocode/skills" },
  { id: "kimi", skillDirectory: ".kimi/skills" },
  { id: "kiro", skillDirectory: ".kiro/skills" },
  { id: "lingma", skillDirectory: ".lingma/skills" },
  { id: "vibe", skillDirectory: ".vibe/skills" },
  { id: "opencode", skillDirectory: ".opencode/skills" },
  { id: "pi", skillDirectory: ".pi/skills" },
  { id: "qoder", skillDirectory: ".qoder/skills" },
  { id: "qwen", skillDirectory: ".qwen/skills" },
  { id: "roocode", skillDirectory: ".roo/skills" },
  { id: "trae", skillDirectory: ".trae/skills" },
  { id: "windsurf", skillDirectory: ".windsurf/skills" }
] as const;

export type OpenSpecToolId =
  (typeof openSpecToolDirectories)[number]["id"];
