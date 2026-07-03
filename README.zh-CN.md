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
- 接入 Codex 和 Claude Code 的 `UserPromptSubmit` 与结束 Hook，并在不声称提示词注入的前提下观察 GitHub Copilot CLI 生命周期；
- 在生成安装计划前，按记录的版本重新获取并检查候选项；
- 通过备份、来源记录、漂移检测和回滚执行经确认的修改；
- 用明确反馈、修正集合指标、安装来源、Harness/算法分组和隐私安全的生命周期信号衡量本地推荐质量；
- 通过经过校验、受漂移保护的事务隔离与恢复 Skills，而不是永久删除；
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

## 证据与数据策略

Skill Steward 可以在不保存任务正文的前提下，衡量任务预检建议在真实本地工作中是否持续有用。**最小模式是默认模式**：它保留经过隐私缩减的预检元数据，以及“有用”“不完整”“不正确”这三类明确反馈，但不保存生命周期关联键或排序特征快照。

学习模式必须明确选择启用。它会额外保存有数量上限的数值特征快照，以及使用 HMAC-SHA256 匿名键的无正文 Hook 事件。每次安装生成的私有盐值以 `0600` 权限保存，绝不会出现在导出、API 响应或 Dashboard 中。提示词、提取词、工作目录、原始会话/轮次 ID、转录、助手消息、工具参数和工具输出都不会保存。

```bash
skill-steward evidence policy --json
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000 --confirm
skill-steward evidence summary --json
skill-steward evidence export --output ./skill-steward-evidence.json
skill-steward evidence compact
skill-steward evidence erase
skill-steward evidence erase --confirm
```

策略修改和证据清除都会在写入前展示准确且会过期的计划。保留时间可以设置为 7 到 365 天，生命周期事件上限可以设置为 100 到 10,000 条。

证据看板会同时展示反馈率、有用/不完整/不正确标签、修正集合精确率/召回率/F1，以及仅基于明确来源记录的安装转化率；每个比例都包含分子与分母。生命周期原因与明确标签分开显示，并可按 Harness、算法版本和 7/30 天滚动窗口比较。**生命周期结束不等于任务成功**。校准评审至少需要 **100 次带标签的预检**、30 个修正后的候选集合和 20 个不同的组合指纹。系统**不会自动修改任何排序阈值或权重**；未来如需校准，必须经过单独评审和发布。

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

Skill Steward 可以管理 Codex、Claude Code 和 GitHub Copilot CLI 的原生 Hook 配置，并在修改前要求检查计划：

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex
skill-steward integrate apply --harness codex --confirm

skill-steward integrate plan --harness claude-code
skill-steward integrate apply --harness claude-code --confirm

skill-steward integrate plan --harness github-copilot
skill-steward integrate apply --harness github-copilot --confirm
```

计划会在写入前展示准确的配置位置、备份位置和修改内容。已有的无关设置与 Hook 会保留。外部修改导致配置漂移时，移除操作会停止：

```bash
skill-steward integrate remove --harness codex --confirm
```

托管 Hook 采用失败开放策略，只读取本地缓存。Codex 和 Claude Code 会注入精简建议，不把原始任务文本或目录 URL 写入上下文；Codex 可能要求用户检查并信任新 Hook。GitHub Copilot CLI 被明确标记为仅观察：它通过已公开的 Hook 接收生命周期事件，推荐仍由共享配套 Skill 或显式 CLI 预检提供。

## Harness 能力矩阵

| Harness | 托管事件 | 推荐能力 | 本地证据 |
|---|---|---|---|
| Codex | `UserPromptSubmit`、`Stop` | 通过提示词 Hook 推荐 + 观察 | 轮次生命周期 |
| Claude Code | `UserPromptSubmit`、`Stop`、`SessionEnd` | 通过提示词 Hook 推荐 + 观察 | 轮次与会话生命周期 |
| GitHub Copilot CLI | `userPromptSubmitted`、`sessionEnd` | **仅观察**；通过配套 Skill/CLI 获取推荐 | 提示词发生记录与会话生命周期 |

三种适配器都使用临时 HOME 夹具测试，并保留无关配置。“仅观察”是明确的产品边界：当前版本不会把推荐注入 Copilot 提示词。

## 支持的 Harness

目录规则覆盖 30 种 Harness：Amazon Q、Antigravity、Auggie、Bob、Claude Code、Cline、CodeBuddy、Codex、ForgeCode、Continue、CoStrict、Crush、Cursor、Factory、Gemini CLI、GitHub Copilot、iFlow、Junie、Kilo Code、Kimi、Kiro、Lingma、Vibe、OpenCode、Pi、Qoder、Qwen Code、RooCode、Trae 和 Windsurf。

这表示 Skill Steward 能够盘点这些 Harness 的已知目录，并将 Skill 安装到明确目标。原生工作流集成范围更窄，并以上方能力矩阵为准。

## 安全安装如何工作

Skill Steward 绝不会自动安装推荐项。目录候选项必须与手动提供的文件夹、ZIP 或公共 Git 来源一样，经过完整检查流程：

1. **检查**——解析记录的 commit，重新核对指纹、文件、脚本、可执行项、引用和问题。
2. **目标**——选择 Harness、全局/项目作用域、工作区和目标名称。
3. **冲突**——相同内容不重复写入；不同内容必须改名或明确选择替换。
4. **确认**——查看准确的文件系统操作并确认。
5. **提交**——原子创建或替换，记录来源并重新扫描资产组合。
6. **回滚**——只有目标漂移检查通过时才恢复备份。

ZIP 中的路径穿越、绝对路径、链接、大小写折叠冲突、过多条目和异常膨胀会被拒绝。Git 暂存使用非交互模式，禁用仓库 Hook 和 submodule，也不会执行来源内容。

## 可恢复治理

已安装 Skill 可以退出活跃发现，而无需永久删除。隔离操作会先创建私有副本并校验指纹，然后通过相邻回滚位置原子移动活跃目录、提交保险库副本并记录事务。恢复会再次校验保险库；如果原位置已被占用、计划已过期，或来源/目标发生漂移，操作会拒绝继续。

```bash
skill-steward govern history --json
skill-steward govern quarantine --skill <skill-id>
skill-steward govern quarantine --skill <skill-id> --confirm
skill-steward govern restore --transaction <quarantine-id>
skill-steward govern restore --transaction <quarantine-id> --confirm
```

Dashboard 使用同一套服务展示准确操作计划，且不提供“删除”操作。如果事务在复制、校验、移动、保险库、日志或恢复边界失败，恢复逻辑会至少保留一份经过校验的副本，并记录失败边界用于诊断。

## 竞品比较

主流 Harness 已经拥有各自的 Skill 与扩展系统。Skill Steward 聚焦于跨越这些系统的本地策略、证据和恢复层：

| 产品 | 任务时外部发现 | 原生工作流集成 | 跨 Harness 分析 | 可逆安装 |
|---|---|---|---|---|
| **Skill Steward** | 主动启用的公共 Git 本地索引；统一比较已安装和可发现候选项 | Codex/Claude 推荐+观察；Copilot 仅观察；配套 Skill、CLI、API、Dashboard | **以同一套清单、评分、证据与治理模型覆盖 30 种目录规则** | **经检查的安装/回滚，以及经过校验的隔离/恢复** |
| [Codex Skills 与 Plugins](https://developers.openai.com/codex/plugins) | 插件目录与 Marketplace 浏览；安装后使用 | 原生 Skills、Plugins 和生命周期 Hook | Codex 范围 | 原生启停与卸载；不使用 Skill Steward 的跨 Harness 事务日志 |
| [Claude Code Skills 与 Plugins](https://code.claude.com/docs/en/discover-plugins) | Marketplace 注册与具体插件安装分离 | 原生 Skills、Plugins、Marketplace 和 Hook | Claude Code 范围 | 原生更新与移除；不使用 Skill Steward 的跨 Harness 事务日志 |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` 可从 GitHub 仓库发现和安装 Skills | Copilot CLI/云 Agent 的原生 Skills 与 Hook | Copilot 兼容作用域 | 原生 Skill 管理；不使用 Skill Steward 的跨 Harness 事务日志 |

## 隐私与安全

- 服务只监听 `127.0.0.1`，并拒绝不符合预期的 Host 和 Origin。
- 打包 UI 使用同源资源，不加载远程字体、脚本、图片或分析服务。
- 修改操作需要当前进程生成并注入页面的随机令牌。
- Dashboard 读取接口不会返回完整 Skill 正文。
- 提示词提交时只使用缓存状态，不联系目录来源。
- 最小证据模式默认启用；学习模式需要经过检查的策略变更。
- 持久化证据不包含任务文本、提取词、描述、原因、URL、本地路径、转录、助手内容、工具数据或原始 Harness ID。
- 净化导出和 API 响应永远不包含私有 HMAC 盐值。
- 不执行安装来源中的脚本、包管理器、构建命令、仓库 Hook 或 submodule。
- 治理只提供经过校验的隔离/恢复，不提供永久删除，并在漂移时停止。

安全问题请按照 [SECURITY.md](SECURITY.md) 说明提交。包结构与信任边界详见 [docs/architecture.md](docs/architecture.md)。

## 当前限制

- 任务评分是确定性的词法基线，不使用 LLM，也尚未衡量实际任务成功率。
- 证据描述推荐和生命周期事件，不证明任务成功，也不会自动修改排序。
- GitHub Copilot CLI 仅观察，不支持自动提示词推荐注入。
- 目录刷新只支持不含凭据的公共 HTTPS Git 来源，不支持私有仓库或 SSH。
- 目录记录是元数据快照，不是安全背书；生成安装计划前始终重新检查来源。
- Dashboard 使用中文时，底层问题说明仍然是英文。

## 路线图

1. 只有达到公开证据门槛后，才评估经过评审的排序校准。
2. 在可恢复治理日志之上增加作用域迁移和更广泛的策略基线。
3. 只为能够充分验证生命周期与信任模型的 Harness 增加原生适配器。
4. 增加签名发布产物和供应链证明。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 [GOVERNANCE.md](GOVERNANCE.md)。一般问题请参考 [SUPPORT.md](SUPPORT.md)，安全问题请使用 [SECURITY.md](SECURITY.md) 中的私密渠道。项目采用 [MIT License](LICENSE)。
