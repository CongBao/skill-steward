# Skill Steward

[English](README.md) | 简体中文

一个本地优先的跨 Harness 控制平面，用来管理 Agent Skills。Skill Steward 与 Codex、Claude Code、GitHub Copilot 等 Harness 集成，但不会取代它们，也不负责执行编码任务。

> 当前状态：活跃 Alpha。现在可以从源码或本地 tarball 安装；npm 包尚未发布。

## 为什么选择 Skill Steward

Codex、Claude Code 和 GitHub Copilot 都已经有各自成熟度不断提高的 Skill 与插件生态。真正仍然分散的是跨生态管理：同一台机器上的重复 Skill、不明确的作用域、相互冲突的触发条件、上下文成本，以及散落在不同目录中的任务能力。

Skill Steward 提供一个统一的本地决策层：

- 盘点 30 种 Harness 的标准用户级和项目级 Skill 目录；
- 检查完整内容包的结构、引用、可移植性、体积、重叠、脚本和可执行文件；
- 通过主动启用的公共来源发现尚未安装的 Skills；
- 将任务预检结果分为**立即使用**、**建议安装**、**能力缺口**和**未选候选项**；
- 接入 Codex 和 Claude Code 的 `UserPromptSubmit` Hook，并提供共享配套 Skill 与 CLI 作为其他入口；
- 在生成安装计划前，按记录的版本重新获取并检查候选项；
- 通过备份、来源记录、漂移检测和回滚执行经确认的修改；
- 让 CLI、回环 API、Hook、配套 Skill 和 Dashboard 共用同一套服务。

当前分析是确定性的，不需要 LLM。实际选择和执行 Skill 的仍然是用户使用的 Harness。

## 界面截图

![包含已安装和可发现 Skills 的任务预检](docs/images/preflight-discovery-light-zh-CN.png)

![Codex 与 Claude Code 集成设置](docs/images/integrations-dark-zh-CN.png)

## 安装

### 环境要求

- Node.js 22 或更高版本
- 从源码开发时需要 pnpm 10 或更高版本

### 从源码运行

```bash
git clone https://github.com/CongBao/skill-steward.git
cd skill-steward
pnpm install --frozen-lockfile
pnpm check
pnpm build
node packages/cli/dist/main.js dashboard
```

也可以使用 SSH：

```bash
git clone git@github.com:CongBao/skill-steward.git
```

如果只想输出回环地址而不自动打开浏览器：

```bash
node packages/cli/dist/main.js dashboard --no-open --port 4762
```

### 安装本地打包的 CLI

```bash
mkdir -p artifacts
pnpm --filter skill-steward pack --pack-destination artifacts
npm install --global ./artifacts/skill-steward-*.tgz
skill-steward dashboard
```

## 快速开始

启动本地 Dashboard：

```bash
skill-steward dashboard
```

也可以完全使用无界面的流程：

```bash
skill-steward doctor --json
skill-steward discover --json
skill-steward scan
skill-steward catalog list
skill-steward preflight --task "检查这次 TypeScript 变更的安全回归和缺失测试" --harness codex
skill-steward report --format markdown
```

状态默认保存在 `~/.skill-steward`。可以单独修改状态目录，不影响 Skill 扫描位置：

```bash
SKILL_STEWARD_HOME=/path/to/private/state skill-steward dashboard --no-open
```

## 任务预检

任务预检会在 Harness 开始工作前回答两个问题：

1. 哪些已安装 Skills 现在就能带来独特价值？
2. 哪些尚未安装的 Skills 有可能补上明确的能力缺口？

```bash
skill-steward preflight \
  --task "检查这个 Pull Request 的安全回归和缺失测试" \
  --harness codex

skill-steward preflight --task-file ./task.txt --max-skills 3
printf '%s' "检查这个 Pull Request" | skill-steward preflight --stdin --json
skill-steward preflight --task "检查这个 Pull Request" --installed-only
```

已安装候选项优先排序。可发现候选项会承担安装成本扣分；存在严重风险、与目标 Harness 不兼容，或与已安装内容重复时，不会进入安装建议。结果会展示相关性、独特覆盖、风险、冗余、上下文估算、来源版本、兼容性和机器可读原因。

原始任务文本不会写入磁盘。持久化证据只包含哈希、ID、汇总数量、数值评分、来源 ID 和可选反馈。

### 主动启用的发现来源

内置来源默认全部停用：

- [OpenAI Plugins](https://github.com/openai/plugins)，索引插件包内的 Skills；
- [Anthropic Skills](https://github.com/anthropics/skills)；
- [Awesome GitHub Copilot](https://github.com/github/awesome-copilot)，标记为社区来源。

需要明确启用并刷新：

```bash
skill-steward catalog enable openai-plugins
skill-steward catalog refresh
skill-steward catalog list --json
```

自定义来源必须是不含凭据的公共 HTTPS Git 仓库，添加后仍保持停用。只有目录刷新会访问网络；Hook 和任务预检都读取已经校验的本地缓存，任务提交时不访问网络。“已知发布者”只说明仓库归属，不代表内容安全。

## Harness 集成

Skill Steward 当前可以管理 Codex 和 Claude Code 的原生提示词 Hook：

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex
skill-steward integrate apply --harness codex --confirm

skill-steward integrate plan --harness claude-code
skill-steward integrate apply --harness claude-code --confirm
```

计划会在写入前展示准确的配置位置、备份位置和修改内容。已有的无关设置与 Hook 会保留。外部修改导致配置漂移时，移除操作会停止：

```bash
skill-steward integrate remove --harness codex --confirm
```

托管 Hook 采用失败开放策略，只读取本地缓存，并注入精简建议，不把原始任务文本或目录 URL 写入上下文。Codex 可能要求用户检查并信任新 Hook。GitHub Copilot 的目录会被扫描，也能看到共享配套 Skill，但本版本尚未管理 Copilot 的原生提示词 Hook。

## 支持的 Harness

目录规则覆盖 30 种 Harness：Amazon Q、Antigravity、Auggie、Bob、Claude Code、Cline、CodeBuddy、Codex、ForgeCode、Continue、CoStrict、Crush、Cursor、Factory、Gemini CLI、GitHub Copilot、iFlow、Junie、Kilo Code、Kimi、Kiro、Lingma、Vibe、OpenCode、Pi、Qoder、Qwen Code、RooCode、Trae 和 Windsurf。

这表示 Skill Steward 能够盘点这些 Harness 的已知目录，并将 Skill 安装到明确目标。原生任务提交集成的范围更窄：Codex 和 Claude Code Hook，以及共享配套 Skill 与 CLI。

## 安全安装如何工作

Skill Steward 绝不会自动安装推荐项。目录候选项必须与手动提供的文件夹、ZIP 或公共 Git 来源一样，经过完整检查流程：

1. **检查**——解析记录的 commit，重新核对指纹、文件、脚本、可执行项、引用和问题。
2. **目标**——选择 Harness、全局/项目作用域、工作区和目标名称。
3. **冲突**——相同内容不重复写入；不同内容必须改名或明确选择替换。
4. **确认**——查看准确的文件系统操作并确认。
5. **提交**——原子创建或替换，记录来源并重新扫描资产组合。
6. **回滚**——只有目标漂移检查通过时才恢复备份。

ZIP 中的路径穿越、绝对路径、链接、大小写折叠冲突、过多条目和异常膨胀会被拒绝。Git 暂存使用非交互模式，禁用仓库 Hook 和 submodule，也不会执行来源内容。

## 竞品比较

2026-07-03 对官方资料的复核显示，主流 Harness 都已经支持 Skills，并拥有各自的发现或扩展机制。Skill Steward 的竞争点是跨 Harness 的策略与证据层：

| 产品 | 任务时外部发现 | 原生工作流集成 | 跨 Harness 分析 | 可逆安装 |
|---|---|---|---|---|
| **Skill Steward** | 主动启用的公共 Git 本地索引；统一比较已安装和可发现候选项 | Codex、Claude Code 提示词 Hook；配套 Skill、CLI、API、Dashboard | **以同一套清单和评分模型覆盖 30 种目录规则** | **经检查的计划、备份、来源记录、漂移检测和回滚** |
| [Codex Skills 与 Plugins](https://developers.openai.com/codex/plugins) | 插件目录与 Marketplace 浏览；安装后使用 | 原生 Skills、Plugins 和生命周期 Hook | Codex 范围 | 原生启停与卸载；不使用 Skill Steward 的跨 Harness 事务日志 |
| [Claude Code Skills 与 Plugins](https://code.claude.com/docs/en/discover-plugins) | Marketplace 注册与具体插件安装分离 | 原生 Skills、Plugins、Marketplace 和 Hook | Claude Code 范围 | 原生更新与移除；不使用 Skill Steward 的跨 Harness 事务日志 |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` 可从 GitHub 仓库发现和安装 Skills | Copilot CLI/云 Agent 的原生 Skills 与 Hook | Copilot 兼容作用域 | 原生 Skill 管理；不使用 Skill Steward 的跨 Harness 事务日志 |

## 隐私与安全

- 服务只监听 `127.0.0.1`，并拒绝不符合预期的 Host 和 Origin。
- 打包 UI 使用同源资源，不加载远程字体、脚本、图片或分析服务。
- 修改操作需要当前进程生成并注入页面的随机令牌。
- Dashboard 读取接口不会返回完整 Skill 正文。
- 提示词提交时只使用缓存状态，不联系目录来源。
- 持久化证据不包含任务文本、提取词、描述、原因、URL 或本地路径。
- 不执行安装来源中的脚本、包管理器、构建命令、仓库 Hook 或 submodule。

安全问题请按照 [SECURITY.md](SECURITY.md) 说明提交。包结构与信任边界详见 [docs/architecture.md](docs/architecture.md)。

## 当前限制

- 任务评分是确定性的词法基线，不使用 LLM，也尚未衡量实际任务成功率。
- 托管的原生提示词 Hook 目前只覆盖 Codex 和 Claude Code。
- 目录刷新只支持不含凭据的公共 HTTPS Git 来源，不支持私有仓库或 SSH。
- 目录记录是元数据快照，不是安全背书；生成安装计划前始终重新检查来源。
- Dashboard 使用中文时，底层问题说明仍然是英文。

## 路线图

1. 在不保留原始提示词的前提下，从本地调用与任务结果信号中学习。
2. 增加经确认的停用、隔离、作用域迁移、卸载和恢复操作。
3. 只为能够充分验证生命周期与信任模型的 Harness 增加原生适配器。
4. 增加签名发布产物、策略基线和供应链证明。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 [GOVERNANCE.md](GOVERNANCE.md)。一般问题请参考 [SUPPORT.md](SUPPORT.md)，安全问题请使用 [SECURITY.md](SECURITY.md) 中的私密渠道。项目采用 [MIT License](LICENSE)。
