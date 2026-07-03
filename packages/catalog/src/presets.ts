import { catalogSourceSchema, type CatalogSource } from "./domain.js";

export const catalogSourcePresets: CatalogSource[] = [
  {
    id: "openai-plugins",
    name: "OpenAI Plugins",
    kind: "git",
    url: "https://github.com/openai/plugins.git",
    ref: "main",
    subdirectory: "plugins",
    enabled: false,
    trust: "vendor",
    preset: true
  },
  {
    id: "anthropic-skills",
    name: "Anthropic Skills",
    kind: "git",
    url: "https://github.com/anthropics/skills.git",
    ref: "main",
    subdirectory: "skills",
    enabled: false,
    trust: "vendor",
    preset: true
  },
  {
    id: "github-awesome-copilot",
    name: "Awesome GitHub Copilot Skills",
    kind: "git",
    url: "https://github.com/github/awesome-copilot.git",
    ref: "main",
    subdirectory: "skills",
    enabled: false,
    trust: "community",
    preset: true
  }
].map((source) => catalogSourceSchema.parse(source));
