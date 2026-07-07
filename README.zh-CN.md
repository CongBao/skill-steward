# Skill Steward

[English](README.md) | 简体中文

**看清你的 Skills，只选真正有用的，放心完成每次变更。**

**统一管理 Codex、Claude Code 和 GitHub Copilot CLI 中的 Agent Skills。**

**盘点资产，预检任务，审核变更。**

Skill Steward 为不同 Harness 提供同一份 Skill 资产视图：它能看清已经安装了什么，为当前任务挑出最小且真正有用的组合，并让每次 Skill 变更都可以检查、撤回和恢复。它在 Codex、Claude Code 和 GitHub Copilot CLI 旁边工作，不会取代 Harness，也不会代替 Harness 执行任务。

分析过程在本地、确定性运行。Skill Steward 不会调用 LLM。目录刷新必须由用户主动开启，任务提交时的预检只读取经过验证的本地缓存。

> **当前状态：Beta 发布候选版 0.5.0-beta.1。** Skill Steward CLI 尚未发布到 npm，GitHub 预发布版本也尚未创建。在完成一段时间的本地人工测试前，发布流程保持暂停；请先安装下面的本地候选版本。

## 它主要做三件事

### 1. 看清 Skill 资产

扫描 30 种 Harness 约定下的用户级和项目级 Skill 目录，找出重复内容、失效引用、上下文成本、脚本、可执行文件和作用域重叠；同时区分插件归属，以及一个 Skill 当前究竟有效、被遮蔽还是未启用。

### 2. 在任务开始前预检

同时比较已安装 Skills 和用户主动启用的目录候选项。结果分为**立即使用**、**建议安装**、能力缺口和排除项，并尽量只留下彼此互补、能为当前任务增加价值的少量 Skills。

### 3. 安全地完成变更

安装前检查本地目录、ZIP、公开 Git 来源或目录候选项，展示目标位置和准确的文件操作，再由用户明确确认。安装、隔离、恢复、Harness 接入和断开、回滚以及中断恢复都会在证据发生漂移时停止。

## Skill Steward 的闭环

`资产盘点 → 任务预检 → 审核变更 → 本地证据 → 故障恢复`

这条闭环才是产品本身：跨 Harness 资产视图为任务选择提供依据；每次被接受的变更都保留来源和回滚证据；反馈与生命周期历史记录发生过什么，但不保存原始任务。最终是否采用推荐、怎样使用 Skill，仍由 Harness 决定。

## 产品界面

![中文资产概览](docs/images/overview-light-zh-CN.png)

![同时展示已安装项和可用候选项的任务预检](docs/images/preflight-discovery-light-zh-CN.png)

![带验证和恢复能力的隔离计划](docs/images/governance-dark-zh-CN.png)

[英文 README](README.md) 使用对应的英文界面截图。

## 本地安装

环境要求：Node.js 22+、pnpm 10+；macOS/Linux 还需要 `cc` 来构建生命周期辅助程序。Windows 会安装不含该辅助程序的完整 CLI。

```bash
git clone https://github.com/CongBao/skill-steward.git
cd skill-steward
pnpm install --frozen-lockfile
pnpm candidate:install
skill-steward --version
```

候选版本安装器会先核对 CLI 和当前平台唯一对应的原生辅助程序，再把它们一起安装；这个过程不会发布任何软件包。参与源码开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 第一次使用

```bash
skill-steward scan
skill-steward preflight \
  --task "Review this TypeScript change for security regressions and missing tests" \
  --harness codex
skill-steward dashboard
```

这些命令会在 `~/.skill-steward` 中生成本地资产数据和经过隐私裁剪的证据，但不会安装推荐项，也不会修改 Harness 配置。所有写入操作都必须先预览，再使用输出的准确 plan ID 明确确认。

## 已验证的支持范围

| Harness 覆盖 | 资产盘点 | 任务时接入 | 审核后的生命周期操作 |
|---|---|---|---|
| Codex | 原生目录与插件可见性 | 推荐并观察 | 在可验证的 macOS/Linux 路径上支持 |
| Claude Code | 原生目录与插件可见性 | 推荐并观察 | 在可验证的 macOS/Linux 路径上支持 |
| GitHub Copilot CLI | 原生目录与插件可见性 | 仅观察；通过配套 Skill/CLI 推荐 | 在可验证的 macOS/Linux 路径上支持 |
| 其他 27 种 Harness 约定 | 目录盘点与安装 | 尚未验证原生 Hook 行为 | 尚未验证原生生命周期行为 |

Dashboard 支持中英文、浅色与深色外观，并能从内嵌浏览器的窄窗口自然适配到宽屏桌面。

## 当前边界

- 原生行为只在 Codex、Claude Code 和 GitHub Copilot CLI 上经过验证。更广的 30-Harness 目录属于约定级覆盖，不代表已经验证原生语义。
- Windows 支持资产盘点、任务预检、报告和 Dashboard；在原生文件系统证明完成前，不开放 Harness 生命周期写入。
- 每次扫描只覆盖当前工作区和用户级作用域，不会遍历机器上的所有项目。
- 原生插件管理的 Skills 可以显示，但在 Skill Steward 中只读；请通过所属 Harness 管理它们。
- 任务预检是可解释的本地排序器，不是通用语义理解。证据不足时，宁可不给推荐。
- 目录来源默认关闭。刷新只支持不含凭据的公开 HTTPS Git 来源；目录记录只是元数据，不是安全背书。
- Skill Steward 会阻止检测到的漂移，但不能隔离同一操作系统用户权限下运行的恶意进程。

## 更多资料

- [架构与信任边界](docs/architecture.md)
- [Beta 候选版本测试说明](docs/alpha-testing.md)
- [版本变化](CHANGELOG.md)
- [参与贡献](CONTRIBUTING.md)与[项目治理](GOVERNANCE.md)
- [使用支持](SUPPORT.md)与[私密安全报告](SECURITY.md)
- [MIT License](LICENSE)
