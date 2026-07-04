# Skill Steward

[English](README.md) | 简体中文

先看清、再选择、最后安全地调整你的 Agent Skills。

Skill Steward 是 Codex、Claude Code、GitHub Copilot 等编程工具的本地助手。它不是 Harness，不会替你回答提示词、运行 Agent，也不会取代这些产品原有的 Skill 或插件体系。它负责盘点本机已有的 Skills，判断眼前任务可能需要哪些能力，并让安装、隔离和恢复都有清楚的检查步骤。

> 当前状态：活跃 Alpha。现在可以从源码或本地 tarball 安装；npm 包尚未发布。

## 它主要做三件事

### 1. 看懂手上的 Skill 资产

扫描 30 种 Harness 的常见用户级与项目级目录，检查完整 Skill 内容包，并把重复内容、失效引用、上下文过大、脚本、可执行文件、可移植性和作用域重叠集中到一个本地 Dashboard 中。

### 2. 开工前做一次任务预检

把当前任务同时与已安装 Skills、以及你主动启用的公共目录候选项比较。结果分为**立即使用**、**建议安装**、**能力缺口**和**未选候选项**。尚未安装的 Skill 可以进入视野，但不会因此被当作已经可信。

### 3. 只执行看过、能撤回的修改

安装前先检查来源版本和具体文件操作。确认后才写入，并记录来源、备份和漂移状态，必要时可以回滚。隔离与恢复能让 Skill 暂时退出使用，而不是直接永久删除。

排序过程在本机确定性运行，不依赖 LLM。最终是否使用推荐项、以及如何执行任务，仍由你正在使用的 Harness 决定。

## 原生盘点可见性

找到目录，并不代表 Harness 就能使用其中的 Skill。核心原生盘点适配器会检查 Codex、Claude Code 和 GitHub Copilot CLI 文档所定义的本地直接 Skill 目录和插件内 Skill 入口，报告与界面再分别展示三类状态：

- **来源状态：** `scanned`、`missing`、`unreadable`、`invalid`、`disabled`、`stale`、`ambiguous`、`truncated`
- **Harness 覆盖状态：** `verified`、`partial`、`unavailable`、`convention-only`
- **Skill 可见状态：** `effective`、`shadowed`、`inactive`、`ambiguous`

缺少本地运行时或 MDM 证据时，Copilot 的 Harness 覆盖状态可能是 `partial`。本地文件无法证明启用状态或优先级时，相关来源或 Skill 可见状态可能是 `ambiguous`。

由原生插件管理的 Skills 在 Skill Steward 治理中只读；用户应通过所属 Harness 管理它们。隔离与恢复只适用于 Skill Steward 直接管理的 Skills。在总计 30 种 Harness 中，三种核心适配器之外的覆盖仅提供基于目录约定的盘点和安装，Harness 覆盖状态为 `convention-only`，并未验证原生语义。

扫描结果只是当前工作区及用户级作用域的快照，不会遍历本机上的每个项目或工作区。

## 界面截图

这些界面使用本地示例数据展示完整状态；其中的分数和证据数量并不是项目自身的使用结果。

![中文资产概览](docs/images/overview-light-zh-CN.png)

![同时显示已安装和可发现候选项的中文任务预检](docs/images/preflight-discovery-light-zh-CN.png)

![包含明确反馈、生命周期、Harness 和算法指标的中文证据看板](docs/images/evidence-light-zh-CN.png)

![包含恢复校验且不提供永久删除的中文隔离计划](docs/images/governance-dark-zh-CN.png)

本页截图均切换到中文界面；第三方 Skill 的名称和说明保留来源语言。[英文 README](README.md) 使用对应的英文版本。

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

如果电脑上已有较旧的全局版本，测试仓库新改动前要重新打包并安装。可以用 `skill-steward --version` 确认当前实际调用的版本。

CLI 包中会带上专用的 `README.md`、MIT `LICENSE`、自动生成的 `THIRD_PARTY_NOTICES.txt` 和机器可读的第三方依赖清单。校验程序会同时检查 npm 和 pnpm 生成的真实 tarball，并拿包内文件与可信构建目录、仓库锁定的 `runtime-audit.json` 对照；普通构建只验证这份审计记录，不会悄悄改写它。

## 第一次使用

最短的体验路径只有三步：扫描一次、拿一个真实任务做预检、再打开 Dashboard 查看全貌。

```bash
skill-steward scan
skill-steward preflight \
  --task "检查这次 TypeScript 变更的安全回归和缺失测试" \
  --harness codex
skill-steward dashboard
```

这三步都是只读操作，不需要为了体验盘点和推荐而修改任何 Skill。以后真正要安装、改策略或隔离时，先停在预览结果，确认无误后再执行其中给出的完整命令。当前 Alpha 的 Harness 集成设置仍只提供检查和预览，不会给出应用命令。

如果只需要命令行清单和报告：

```bash
skill-steward doctor --json
skill-steward discover --json
skill-steward report --format markdown
```

状态默认保存在 `~/.skill-steward`。可以单独修改状态目录，不影响 Skill 扫描位置：

```bash
SKILL_STEWARD_HOME=/path/to/private/state skill-steward dashboard --no-open
```

## 任务预检

任务预检会在开工前回答两个问题：

1. 哪些已安装 Skills 对当前任务有独特价值？
2. 哪些尚未安装的 Skills 可能补上明确缺口？

```bash
skill-steward preflight --task-file ./task.txt --max-skills 3
printf '%s' "检查这个 Pull Request" | skill-steward preflight --stdin --compact-json
skill-steward preflight --task "检查这个 Pull Request" --installed-only
```

条件相近时，已安装项排在目录候选项之前。存在严重风险、与目标 Harness 不兼容，或与已安装内容重复时，候选项不会进入安装建议。算法 v8 与结果格式 v4 保留范围明确的英文排除说明和非名称命中的双词门槛，并对一组有限的简体/繁体中文概念做确定性归一化，覆盖长会话、需求演变和上下文压缩意图。对于较长的任务，算法 v8 使用版本化的窄规则：当前只把 `review ... before merge` 与名称中同时包含 `request`、`code`、`review`，且正向路由说明也包含 `before merge` 的 Skill 对应起来。泛化名称词不能触发，短语也不会跨 Unicode 标点或符号拼接。一个内部规则会统一识别任务中的 `do not`、直引号或弯引号形式的 `don't`、`never`、`avoid`、`without`，以及候选路由说明中由 use/invoke/call/run/apply 构成的否定表达。否定子句只在分号、句末标点或换行处结束；逗号/冒号列表和技术名称里的标点、符号、emoji 保持否定，但明确的 `, but ...` 或冒号后正向动作会打开对比子句。识别出的否定任务内容不参与普通相关性、完整名称匹配、触发证据或能力缺口。当前生命周期规则只在正负对象冲突时用 `code` 判别：否定代码评审仍会阻止正向文档评审误触发，而独立的正向代码评审不会被否定文档评审连带排除。严重风险或 Harness 不可用仍会排除候选项。能力缺口是高置信的 Skill 搜索提示：名称匹配只有在候选名称能贡献具体能力概念时才足以佐证提示，否则候选元数据必须达到具体概念的多词相关性门槛；泛化的单词名称不能只靠名称相同来绕过门槛。没有可信候选的简短任务只使用保守的非泛化词回退。任务里的正向展示别名、候选项的正向元数据和已选项的正向覆盖会进入同一个 gap-only canonical 命名空间；其相关性门槛以正向匹配为分子、完整元数据为分母，所以否定内容绝不会增强佐证。canonical 去重先于六项上限。未分词且只由泛化汉字组成的两字片段属于低置信输入，不会形成路由、名称匹配或孤立缺口。这些展示规则不会改变推荐评分。它仍是词法路由，不是通用的跨语言语义理解。结果会展示相关性、独特覆盖、风险、冗余、上下文估算、来源版本、兼容性和易读原因。

任务明确排除代码评审时，requesting 和 receiving 两类代码评审工作流都不会被推荐。冒号后的动作名称列表仍按否定内容处理，不会误开正向对比。

需要把结果交给 Harness 或配套 Skill 时，使用 `--compact-json`。compact 格式 v3 输出单行且不超过 4,096 UTF-8 字节，只保留选中的使用/安装建议与稳定警告码，不包含原始任务；证据未能保存时，反馈命令为 `null`。`--json` 返回完整的 `PreflightResult`，包括候选决策、评分、特征、原因、冲突、盘点警告、能力缺口和汇总覆盖率；可安装的目录候选项仍可带有自身的 `source` 元数据，但不包含原生盘点的来源、所有权、插件或可见状态记录。资产报告与 Dashboard 会保留这些记录；Preflight 使用已经解析好的可见状态，并通过候选原因码和盘点警告表达相关结果。配套 Hook 仍以 2,048 字节为上限。

如果私有状态目录可以读取，但当前 Harness 沙箱不允许写入，Preflight 仍会以退出码 0 返回推荐，同时给出 `PREFLIGHT_PERSISTENCE_UNAVAILABLE`。警告不会暴露失败路径，并会明确说明本次报告和证据没有保存，因此不能为这次运行补录反馈。

CLI 的普通输出会给出本次预检 ID；只有成功保存的运行才会同时给出可直接执行的反馈命令。完整候选项和机器可读原因仍可通过 `--json` 查看。

```bash
skill-steward evidence feedback --preflight <run-id> --label useful
skill-steward evidence feedback \
  --preflight <run-id> \
  --label incomplete \
  --candidate <complete-correct-candidate-set>
```

使用 `incomplete` 时，`--candidate` 需要给出本次预检应当推荐的完整集合；原推荐中正确的候选项也要一并列出。这样修正指标才不会被误读。

原始任务文本不会写入磁盘。持久化证据只保留白名单内的哈希、ID、汇总数量、数值评分、来源 ID 和可选反馈。

### 主动启用的发现来源

内置来源默认全部停用：

- [OpenAI Plugins](https://github.com/openai/plugins)，索引公共插件包内的 Skills；
- [Anthropic Skills](https://github.com/anthropics/skills)；
- [Awesome GitHub Copilot](https://github.com/github/awesome-copilot)，标记为社区来源。

需要明确启用并刷新：

```bash
skill-steward catalog enable openai-plugins
skill-steward catalog refresh
skill-steward catalog list --json
```

自定义来源必须是不含凭据的公共 HTTPS Git 仓库，添加后仍保持停用。只有目录刷新会访问网络；Hook 和任务预检都读取已经校验的本地缓存，任务提交时不访问网络。“已知发布者”只说明仓库归属，不代表内容安全。

## 证据与数据策略

**最小模式是默认模式**。它保留经过隐私缩减的预检元数据，以及 `useful`、`incomplete`、`incorrect` 三类明确反馈，但不保存生命周期关联键或排序特征快照。

学习模式需要主动开启。它会额外保存有数量上限的数值特征快照，以及使用 HMAC-SHA256 匿名键的无正文 Hook 事件。每次安装生成的私有盐值以 `0600` 权限保存，不会出现在导出、API 响应或 Dashboard 中。提示词、提取词、工作目录、原始会话/轮次 ID、转录、助手消息、工具参数和工具输出都不会保存。

```bash
skill-steward evidence policy --json
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000
skill-steward evidence policy set --plan <id> --confirm
skill-steward evidence summary --json
skill-steward evidence export --output ./skill-steward-evidence.json
skill-steward evidence compact
skill-steward evidence erase
skill-steward evidence erase --plan <id> --confirm
```

不带 `--confirm` 的命令只负责生成一份准确、会过期的计划。真正执行时必须使用输出中的 `--plan <id> --confirm`；即使换到另一个进程，读取的仍是刚才看过的内容，而不是根据参数重新生成一份。计划一旦进入执行阶段就只能使用一次；如果随后发现漂移或执行失败，需要重新预览。保留时间可设为 7 到 365 天，生命周期事件上限可设为 100 到 10,000 条。

证据看板会同时展示反馈率、有用/不完整/不正确标签、修正集合精确率/召回率/F1，以及只按明确来源记录计算的安装转化率；每个比例都包含分子与分母。生命周期原因与明确标签分开显示，并可按 Harness、算法版本和 7/30 天滚动窗口比较。**生命周期结束不等于任务成功**。校准评审至少需要 **100 次带标签的预检**、30 个修正后的候选集合和 20 个不同的组合指纹。系统**不会自动修改任何排序阈值或权重**；未来校准必须单独评审和发布。

## Harness 集成

当前 Alpha 可以检查 Codex、Claude Code 和 GitHub Copilot CLI 的集成状态，并生成内容完整、可复核的计划。JSON 状态会把 Harness Hook 与共享 companion Skill 分开显示，因此 Hook 已安装时，缺失、过期、被修改或无法读取的 companion 不会被掩盖：

```bash
skill-steward integrate status --json
skill-steward integrate plan --harness codex
skill-steward integrate plan --harness claude-code
skill-steward integrate plan --harness github-copilot
```

预览结果会保存配置与备份位置、companion 完整文件树、包内来源和所有权证据。应用命令会先在共享修改锁内领取这份一次性计划，再重新检查这些字段、Harness 当前配置、记录头和 consumer 集合。

**当前 Alpha 仍刻意禁用生命周期应用。** 即使计划完全有效，也会在写入 Hook 或 companion 之前停止。带事务保障的 companion 新建/升级、就绪失败回滚和共享 consumer 移除属于下一阶段。CLI 暂时保留 apply 命令，用于验证安全拒绝行为，但它还不是可用的安装入口。

如果你曾用更早的 Alpha 安装过托管 Hook，仍可用 `skill-steward integrate remove --harness <id> --confirm` 做有限清理。它只移除能够证明由 Skill Steward 管理的 Hook 条目，并保留共享 companion；按 consumer 安全删除 companion 的能力尚未启用。这个清理命令不属于新的集成设置流程。

启用应用能力后，托管 Hook 会读取本地缓存，出错时不阻断 Harness。已经实现的 Codex 和 Claude Code 适配器覆盖 `UserPromptSubmit` 与结束 Hook，两者只接收精简推荐，不包含原始任务文本或目录 URL；Codex 可能要求原生信任确认。GitHub Copilot CLI 适配器明确保持仅观察：其文档化 Hook 只接收生命周期事件，推荐仍通过 companion Skill 或显式 CLI 预检获取。

## Harness 能力矩阵

| Harness | 托管事件 | 推荐能力 | 本地证据 |
|---|---|---|---|
| Codex | `UserPromptSubmit`、`Stop` | 通过提示词 Hook 推荐 + 观察 | 轮次生命周期 |
| Claude Code | `UserPromptSubmit`、`Stop`、`SessionEnd` | 通过提示词 Hook 推荐 + 观察 | 轮次与会话生命周期 |
| GitHub Copilot CLI | `userPromptSubmitted`、`sessionEnd` | **仅观察**；通过配套 Skill/CLI 获取推荐 | 提示词提交记录与会话生命周期 |

三种适配器的配置都使用临时 HOME 目录测试，并保留无关配置；公共生命周期应用仍按上文说明保持禁用。“仅观察”是 Copilot 适配器的明确边界，它不会把推荐注入提示词。

## 支持的 Harness

目录规则覆盖 30 种 Harness：Amazon Q、Antigravity、Auggie、Bob、Claude Code、Cline、CodeBuddy、Codex、ForgeCode、Continue、CoStrict、Crush、Cursor、Factory、Gemini CLI、GitHub Copilot、iFlow、Junie、Kilo Code、Kimi、Kiro、Lingma、Vibe、OpenCode、Pi、Qoder、Qwen Code、RooCode、Trae 和 Windsurf。

在总计 30 种 Harness 中，三种核心适配器之外的覆盖只提供基于目录约定的盘点和安装。原生工作流集成范围更窄，以上方能力矩阵为准。

## 安全安装如何工作

Skill Steward 绝不会自动安装推荐项。目录候选项与手动提供的文件夹、ZIP 或公共 Git 来源一样，都要经过以下流程：

1. **检查来源**——解析记录的 commit，重新核对指纹、文件、脚本、可执行项、引用和问题。
2. **选择目标**——指定 Harness、全局/项目作用域、工作区和目标名称。
3. **处理冲突**——相同内容不重复写入；不同内容必须改名或明确替换。
4. **确认计划**——查看具体文件操作后再确认。
5. **执行写入**——原子创建或替换，记录来源并重新扫描。
6. **必要时回滚**——只有目标未漂移时才恢复备份。

安装目录候选项时，先预览，再照着输出中的命令执行：

```bash
skill-steward install --catalog-candidate <candidate-id> --harness codex --scope global
skill-steward install --plan <id> --confirm
```

预览完成后，经过检查的来源会暂存在私有状态目录，直到计划执行或过期。稍后在另一个进程中应用时，系统直接使用这份暂存内容，并再次核对来源和目标指纹；不会绕过已审核计划重新联网拉取。

安装、回滚和 Harness 集成共用同一把状态级跨进程锁。CLI 会先取得锁，再使用已经审核的计划；准备好校验后的副本后，还会再检查一次目标。多个替换操作同时到来时会依次执行，后进入的旧计划会因漂移而停止，不会覆盖刚完成的安装，也不会留下指向错误备份的记录。

ZIP 中的路径穿越、绝对路径、链接、大小写折叠冲突、过多条目和异常膨胀会被拒绝。Git 暂存使用非交互模式，禁用仓库 Hook 和 submodule，也不会执行来源内容。

## 可恢复治理

隔离可以让已安装 Skill 退出活跃发现，而不永久删除。系统会先创建私有副本并校验，再通过相邻回滚位置原子移动原目录、提交保险库副本并记录事务。恢复时会再次校验；原位置已被占用、计划过期，或来源/目标发生漂移时都会停止。

```bash
skill-steward govern history --json
skill-steward govern quarantine --skill <skill-id>
skill-steward govern quarantine --plan <id> --confirm
skill-steward govern restore --transaction <quarantine-id>
skill-steward govern restore --plan <id> --confirm
```

Dashboard 展示同一份操作计划，且没有“删除”操作。如果事务在复制、校验、移动、保险库、日志或恢复任一阶段失败，恢复逻辑会至少保留一份经过校验的副本。

## 竞品比较

Codex、Claude Code 和 GitHub Copilot 已经拥有任务执行环境，以及各自原生的 Skill/插件体验。Skill Steward 补充的是本地统一清单、针对具体任务的候选比较，以及跨已知 Skill 目录的检查与恢复流程。

| 产品 | 任务开始前发现外部候选项 | 原生工作流集成 | 跨 Harness 分析 | 可逆安装 |
|---|---|---|---|---|
| **Skill Steward** | 主动启用的公共 Git 本地索引；统一比较已安装和可发现候选项 | 基于所有权证据的状态与适配器计划；公共 Hook/companion 应用尚未启用 | **以同一套清单、评分、证据与治理模型覆盖 30 种目录规则** | **跨进程精确计划、持续暂存、漂移拒绝、安装回滚和校验后的隔离/恢复** |
| [Codex Skills 与 Plugins](https://developers.openai.com/codex/plugins) | 插件目录与 Marketplace 浏览；安装后使用 | 原生 Skills、Plugins 和生命周期 Hook | Codex 范围 | 原生启停与卸载；不使用 Skill Steward 事务日志 |
| [Claude Code Skills 与 Plugins](https://code.claude.com/docs/en/discover-plugins) | Marketplace 注册与具体插件安装分离 | 原生 Skills、Plugins、Marketplace 和 Hook | Claude Code 范围 | 原生更新与移除；不使用 Skill Steward 事务日志 |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` 可从 GitHub 仓库发现和安装 Skills | Copilot CLI/云 Agent 的原生 Skills 与 Hook | Copilot 兼容作用域 | 原生 Skill 管理；不使用 Skill Steward 事务日志 |

## 隐私与安全

- 服务只监听 `127.0.0.1`，并拒绝不符合预期的 Host 和 Origin。
- 打包 UI 使用同源资源，不加载远程字体、脚本、图片或分析服务。
- 修改操作需要当前进程生成并注入页面的随机令牌。
- Dashboard 读取接口不会返回完整 Skill 正文。
- 提示词提交时只使用缓存状态，不联系目录来源。
- 最小证据模式默认启用；学习模式需要先检查策略变更。
- 持久化证据不包含任务文本、提取词、描述、原因、URL、本地路径、转录、助手内容、工具数据或原始 Harness ID。
- 净化导出和 API 响应不会包含私有 HMAC 盐值。
- 不执行安装来源中的脚本、包管理器、构建命令、仓库 Hook 或 submodule。
- CLI 的安装、集成应用、证据策略、证据清除、隔离和恢复计划保存在私有目录、会过期且只能使用一次；确认命令不会根据原始参数临时重建计划。
- 安装与回滚使用跨进程锁。公共集成应用目前会在集成锁内重新检查已领取的计划，随后在写入 Hook 或 companion 之前停止；带事务保障的写入路径尚未启用。
- npm 和 pnpm 的打包结果都会与完整文件树、第三方声明和锁定的运行时审计记录核对。
- 治理只提供经过校验的隔离/恢复，不提供永久删除，并在漂移时停止。

安全问题请按照 [SECURITY.md](SECURITY.md) 说明提交。包结构与信任边界详见 [docs/architecture.md](docs/architecture.md)。

## 当前限制

- 任务评分仍是确定性的词法基线。算法 v8 只新增一项范围明确、需要双重佐证的生命周期触发信号，并保留有限的简体/繁体中文概念与高置信能力缺口提示；它不等于通用的跨语言语义理解，也不衡量真实任务成败。
- 证据描述推荐和生命周期事件，不证明任务成功，也不会自动修改排序。
- Harness 集成已经能生成基于所有权证据的计划，并分别显示 Hook/companion 状态；公共生命周期应用会保持禁用，直到 companion 安全事务阶段完成。
- GitHub Copilot CLI 仅观察，不支持自动提示词推荐注入。
- 原生盘点只覆盖 Codex、Claude Code 和 GitHub Copilot CLI 文档所定义的本地入口。缺少本地运行时或 MDM 证明时，Copilot 的 Harness 覆盖状态可能为 `partial`；相关来源或 Skill 可见状态可能为 `ambiguous`。
- 每次扫描只覆盖当前工作区和用户作用域，不会遍历机器上的全部项目或工作区。
- 在总计 30 种 Harness 中，三种核心适配器之外的覆盖仍按目录约定处理；能扫描某个 Harness，不代表已经验证其原生插件或 Hook 语义。
- 原生插件管理的 Skills 只读；请通过所属 Harness 管理。Skill Steward 的隔离与恢复只处理直接管理的 Skills。
- 计划进入执行阶段后即视为已使用；后续即使因为漂移而停止，也要重新生成计划再试。
- Skill Steward 会拦截已检测到的路径异常和文件漂移，但无法隔离同一操作系统用户权限下运行的恶意进程。
- 目录刷新只支持不含凭据的公共 HTTPS Git 来源，不支持私有仓库或 SSH。
- 目录记录是元数据快照，不是安全背书；生成安装计划前始终重新检查来源。
- Dashboard 使用中文时，底层问题说明仍然是英文。

## 路线图

1. 只在本地优先级、启用状态、生命周期与信任行为都可测试时，验证更多原生适配器。
2. 达到公开证据门槛后，再评估经过评审的排序校准。
3. 在可恢复治理日志之上增加作用域迁移和更广的策略基线。
4. 增加签名发布产物和供应链证明。

版本变化见 [CHANGELOG.md](CHANGELOG.md)；历史 Alpha.3 结论、真实操作证据、基线和优先级见 [2026-07-03 产品评审](docs/product-review-2026-07-03.md)。

## 参与贡献

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 [GOVERNANCE.md](GOVERNANCE.md)。一般问题请参考 [SUPPORT.md](SUPPORT.md)，安全问题请使用 [SECURITY.md](SECURITY.md) 中的私密渠道。项目采用 [MIT License](LICENSE)。
