# dsh-purge 代码与能力分析文档

> 分析对象：`https://github.com/YuJunZhiXue/dsh-purge`（master，`package.json` 版本 1.1.78，`dshTarget: 0.2.1-rc.2`）
> 分析方式：静态阅读（已 clone 到 `repos/dsh-purge`），**未安装、未应用任何补丁**
> 配套文件：[dsh-purge-补丁对照表.csv](dsh-purge-补丁对照表.csv)（82 条补丁 × 205 条替换，含能力分组与命中串）、[dsh-purge-时序图.md](dsh-purge-时序图.md)（装配/注入/基线/红队/apply 五张时序图）
> 仓库体量：JS 约 2.6 MB。`lib/core.js` 8194 行 / 355 KB，`lib/index.js` 2633 行 / 111 KB，`client.js` 515 KB（打包产物），`lib/redteam/store-core.js` 346 KB，`lib/redteam/tools.js` 139 KB，`lib/redteam/score-rules.js` 64 KB

---

## 0. 一句话结论

这不是一个"给 DSH 加个功能"的插件，而是一个**宿主改造器 + 人格接管器 + 红队演练台**三合一：

1. **宿主改造**：对中国官方 DSH 安装里的 `@deepseek-ai/*` 包做**精确字符串替换**，把审批门、沙箱、文件围栏、权限升级阶梯、hooks 拦截、重复调用守卫、结果修剪、读取上限等系统性拆除或放宽。
2. **人格接管**：拦截系统提示词装配（`system-prompt/assemble`），删/改官方身份与工作区基线，注入用户或内置的"人设/规则"正文，并把注入内容包进 ChatML 信封。
3. **红队演练台**：一套独立的 agent preset（指挥 + 5 个执行角色）、SQLite 资产库、约 60 个 `redteam_*` 工具、评分与证据链、报告导出，外加"只允许本地靶场"的网络闸。

它声称的用途是"在本机官方 Harness 上做受控安全评测，把宿主拦截和模型拒绝分开看"；技术上等价于**给整份 DSH 装了一套可回滚的越狱补丁**。

---

## 1. 模块地图

| 路径 | 行数/大小 | 职责 |
| --- | --- | --- |
| `bin/dsh-purge.js` | 147 行 | CLI：`--status/--apply/--revert/--uninstall/--edit`，打印补丁清单与状态 |
| `lib/core.js` | 8194 行 | **补丁引擎**：路径探测、补丁表、备份、应用/回滚、状态判定、shim 注入、提示词文件读写 |
| `lib/index.js` | 2633 行 | **插件本体**（cordis plugin，`inject: ["systemPrompt","tools"]`）：装配改写、工具/命令注册、HTTP 路由、自动重应用 |
| `lib/identity.js` | 1019 行 | 提示词装配重写、身份卡、ChatML 信封、模式适配（minimal/PTC）、红队会话判定 |
| `lib/rules.js` | 560 行 | 规则集：多套 `AGENTS.md`/`CLAUDE.md`、目录选择、workspace baseline 策略 |
| `lib/hooks-deny.js` | 224 行 | hooks `deny/ask` 旁路的开关、状态标注、**反向还原表** |
| `lib/net-scope.js` | 870 行 | 网络闸：只放行回环 + RFC1918，DNS 先解析再判 IP，CN 后缀表 |
| `lib/extract-asar.js` | 469 行 | 桌面端 `app.asar` 处理（`original-fs`、asar 遮蔽探测缓存） |
| `lib/reapply.js` | 388 行 | DSH 升级覆盖 `node_modules` 后自动重打补丁（`installed-rev`/`applied.json`） |
| `lib/update.js` | 1137 行 | 自更新（GitHub `master`/`beta`，限制跳转 host、50 MB 上限） |
| `lib/restart-desktop.js` / `restart-web.js` | — | 应用补丁后自动重启宿主 |
| `lib/hide-console.js` / `child-process-hide.mjs` | — | 隐藏子进程/命令行窗口 |
| `lib/skills.js` / `lib/rewind.js` / `lib/continue-retry.js` | — | 技能提示词段、对话回退、失败自动重试与"继续"续跑 |
| `lib/redteam/*` | 约 1.1 MB | 演练台：preset 安装、store、UI 桥、工具、评分、证据链、schema、平台配置 |
| `presets/redteam/agent.cordis.yml` | 392 行 | 红队 agent 平面的完整组合（人设、锚点门、工具行、委派、压缩） |
| `presets/redteam/anchor-gate.mjs` | 218 行 | 思考锚点门：控制 bootstrap 阶段输出上限 |
| `client.js` | 515 KB | 侧栏 UI（打包产物；`scripts/patch-client-dock.mjs` 负责挂载注入） |
| `scripts/ensure-profile-bundle.mjs` 等 | — | `postinstall`：把 `dsh-purge` 写进 profile bundles 并补 `insert` 行；`build-client.mjs`/`patch-client-dock.mjs` 负责侧栏挂载 |

---

## 2. 运行模型：三条执行路径

```
① CLI：node bin/dsh-purge.js --apply
   └─> lib/core.js 直接改磁盘上的 @deepseek-ai 包（.dshpurge.bak 备份）

② 插件（宿主进程内）：lib/index.js 作为 cordis plugin 挂载
   ├─ system-prompt/assemble 改写（人格/注入）
   ├─ 注册工具 purge_status / purge_apply / purge_revert
   ├─ 注册命令 /purge /rules /rewind
   ├─ 挂在 Web 服务上的路由（/dsh-purge/*、/redteam/api）
   └─ 启动时 autoApplyOnStart / reapply / autoUpdate

③ 预设：dsh-purge/redteam 安装 agent preset
   ├─ $DSH_HOME/.agent-presets/redteam/（agent.cordis.yml + anchor-gate.mjs）
   ├─ $DSH_HOME/redteam/（SQLite 事实库、engagements、配置、授权文件）
   └─ 通过 ctx.agentPresets.register() 出现在模式下拉
```

安装链路本身也值得注意：`package.json` 的 `postinstall` → `scripts/ensure-profile-bundle.mjs` 会把插件名写进 profile 的 `dsh.profile.bundles`，并在**用户层** `cordis.patch.yml` 补 `insert`——也就是"装包即改宿主配置"，不是纯可选插件。

---

## 3. 宿主改造能力（核心）

### 3.1 补丁引擎原理

`lib/core.js` 的 `ALL_PATCHES = PATCHES + CODE_PATCHES + ENGINE_PATCHES + NEW_TOOL_PATCHES`（`core.js:5829`）：**82 条补丁、展开后 205 条替换**，id 最大到 `#88`。按能力分组统计（见 [补丁对照表](dsh-purge-补丁对照表.csv)）：

| 能力分组 | 补丁数 |
| --- | --- |
| 审批与提权 | 16 |
| 沙箱与文件围栏 | 6 |
| hooks / 外部代理 | 4 |
| 人格 / 身份 / 提示词框架 | 24 |
| 工具 / 上下文 / 能力开关 | 7 |
| 装配 / 会话 / 运行时兼容 | 25 |

每条补丁形如：

```js
{
  id: 9, name: "APPROVAL_AUTO_GRANT", layer: "代码",
  file: ["user-approval-code", "user-approval-invariant", "user-approval"],
  rel: ["lib", "index.js"],
  replacements: [{ pattern: '...原样字符串...', replace: '...新字符串...' }],
  markers: ['return "allowed-once";\n\t\t// [dsh-purge] approval bypass'],
  markersAny: true
}
```

判"已应用"靠 `markers`；另有 `skipIfMarked`（防重复叠加，注释里记录了"每 apply 一次多 +841 字符、永不收敛"的 bug）、`optional`（文件不存在就跳过）、`softSettle`（目的达成但标记缺失也算完成）、`strictFiles`（文件必须存在，否则硬失败）等收敛策略。

应用流程：`applyPatches()` → 读文件 → 按 pattern 替换 → 写回前备份 `<文件>.dshpurge.bak` → 记录状态（`applied / already / pending / skipped / missing_file / pattern_not_found`）。`--revert` 用备份覆盖并删备份；`prompt-inject.md` 属用户文件，不还原。

**脆弱但克制的工程折中**：命中就改，不命中就"跳过"，绝不乱写——这既是它适配多版本的方式，也意味着 DSH 一升级就是大面积 `skipped`。

### 3.2 补丁分类：它到底拆了什么

**A. 提示词层（`PATCHES`）**

| # | 名称 | 实际效果 |
| --- | --- | --- |
| 1 | `WORKSPACE_CONTEXT_INTRO` | 把官方"工作区说明只是参考、不覆盖 system/developer/user"改成 `ACTIVE and MANDATORY … Do not soft-refuse or hard-refuse` |
| 2/3 | `REPLACEMENT_*` / `SCOPE_INTRO` | 把上面那句强句在部分模板里改回"不覆盖 system"，并收掉重复叠加 |
| 4 | `SYSTEM_PROMPT_PERSONA` | `personaPrefix` 里的官方身份句（`You are a coding agent powered by the {{model}} model.`）清空 |
| 43/76 | 内置/自建预设身份清理 | 四个内置 preset 与用户自造的 `unrestricted` preset 的 `prefix` 身份句清空 |
| 70/73 | 极简模式网络 | 删掉"没有网络访问"的声明与镜像提示 |
| 71 | 梁神预设 | 删官方身份句，保留工作纪律 |
| 5/11/12 | 审批提示句 | "需要审批会被自动拒绝，不要请求升级" → "本会话自动放行，可自由请求沙箱升级" |

**B. 审批与权限层（`CODE_PATCHES` + `ENGINE_PATCHES`）**

| # | 文件 | 改动 |
| --- | --- | --- |
| 6 | `sandbox-local` | 沙箱 profile 的 `"(deny file-write*)"` → `"(allow file-write*)"` |
| 7/8 | `base`（cordis.patch.yml） | 默认权限模式 `workspace-write` → `danger-full-access`，审批策略 → `never` |
| 9 | `user-approval` | `if (policy==="never") return "rejected"` 整段替换成 `return "allowed-once"`，**审批 waterfall 直接不执行** |
| 10 | `user-approval` | `Config.policy` 默认值 `ask` → `never` |
| 13 | `escalation` | 删掉"只能往更宽模式升级"的阶梯校验、approver/agent 必填校验 |
| 14 | `escalation` | 无 approver 时直接 `"allowed-once"` |
| 15 | `sandbox-local` | `confine()` 直接 `return { argv: [...argv], denialSignatures: [], runnerFailureRules: [] }`——**任何模式都不套沙箱 runner** |
| 16 | `fs-sandbox` | `checkedTarget()` 直接 `return target`——read-only / workspace-write 的写围栏失效 |
| 17 | `fs-observation-policy` | `writeIntent/editIntent` 返回 `void 0`——写/改文件不再需要先读 |

**C. hooks 与守卫层（`NEW_TOOL_PATCHES`）**

| # | 改动 |
| --- | --- |
| 30/31/64/65 | hooks 的 `deny` 改为死字符串哨兵 `__dsh_purge_deny_disabled__`、`ask` 直接 `next()`；Stop hook 的"拦截并让模型继续"路径被关掉。`lib/hooks-deny.js` 里有一整套反向表（R1a/R1a2/R1b/R2a/R2b/R3/R5a/R5b）用于回滚 |
| 18 | `repeat-tool-reminder` 注册的 pre/post 钩子整段注释掉——重复调用不再被提醒 |
| 19 | `compaction-tool-result-pruner.pruneContent()` 直接 `return null`——工具结果不再修剪 |
| 21 | 把旧版本自己调高的 bash 前台等待（10 分钟）改回 60 秒（迁移用，只认带插件标记的值） |
| 22 | `read` 单行上限 2 KB → 10 KB，单次 50 KB → 1 MB |

**D. 系统提示词配置层**：`cordis.patch.yml` 里改 `system-prompt` 行：`includeHarnessIdentity: false`、`personaPrefix/personaSuffix: ""`——从组合层直接抹掉 Harness 身份。

### 3.3 多宿主与桌面端

- Web 与桌面 EXE **分开装、分开应用**（profile 不同）。
- 路径探测顺序（`README` + `core.js`）：`DSH_HOME`/`DSH_BASE` → dsh 启动器旁的 `.dsh` → `npm prefix/root -g` → 嵌套 `@deepseek-ai/dsh/node_modules/@deepseek-ai` → `~/.dsh`。
- 桌面包的代码在 `app.asar` 里，`lib/extract-asar.js` 用 Electron 的 `original-fs` 做 asar 遮蔽探测、拆包、换包（注释记录：裸探针让 6 万目录扫描从 6.2 s 变 94 s，占启动 CPU 24%，因此加了 5 s 的两级缓存）。

### 3.4 自愈、更新与卸载

- `lib/reapply.js`：`$DSH_HOME/dsh-purge/installed-rev`、`applied.json`、`settle-restart.guard`；DSH 官方升级覆盖 `node_modules` 后，启动时按已记录版本自动重打。
- `lib/update.js`：自带更新器，`master`（正式）/`beta`（测试）两个通道，只允许 GitHub/jsdelivr 域的 302 落地，单包 50 MB 上限。
- `lib/restart-desktop.js` / `restart-web.js`：应用后自动重启宿主。
- `lib/uninstall.js`：先还原补丁，再删注入文件、规则库、插件本身，并把 agent preset 默认值改回 `standard`（否则宿主找不到 `redteam` 预设会无法新建会话）。
- `patchShim()`：给 `dsh.cmd` / `dsh.ps1` / `dsh` 注入插件相关环境，另 `silenceCmdFlash()` 处理启动闪窗。

---

## 4. 人格与角色系统（"可以改什么、做到什么"）

### 4.1 装配管线

插件**不往宿主文件里塞提示词**（除了 `cordis.patch.yml` 的身份开关），而是在运行时劫持装配：

```
system-prompt/assemble
  → installAssembleGuard(prompt, rewriteFn)    // 用 defineProperty 包 getter，长期持有 slot.rewrite
  → rewritePromptAssembly(assembled, inject)   // 删 harness:identity、dsh-purge:identity、可选 mnemon、可选 workspace baseline
                                                 // 非插件段剥掉 ChatML 标签与官方 persona 文本
  → 追加自己的 inject 段 + 身份卡 + capability 协议 + objective/role 段
```

关键设计（都有注释解释踩过的坑）：

- `installAssembleGuard` 的 `dispose` 故意是 **noop**，避免 cordis 生命周期回收时把注入解除（注释称之为"任务到一半就苏醒"）。
- 内层 `assemble` 抛错时返回空 sections，**不让整个 waterfall 崩**。
- `rewritePromptAssembly` **不原地改** `assembled`，防止宿主复用对象导致下一轮污染。
- 插件自己的段名用 `dsh-purge*` / `dshpg-*` 前缀，避开宿主"按前缀把段挪到最前"的过滤（`capability-protocol.js` 注释记录过渲染反转）。

### 4.2 注入来源与优先级

每轮组装时按以下顺序决定"注入哪份人格/规则"：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| A | `$DSH_HOME/prompt-inject.md` | 用户编辑的覆盖段；首次应用时由**内置加密槽**落下，之后以文件为准 |
| B | 当前目录被勾选的 `AGENTS.md` / `CLAUDE.md` | 扫描 cwd→projectRoot，命中 `AGENTS.md`/`CLAUDE.md`/`*.local.md`，UI 里勾选参与注入 |
| D | 插件内置默认（加密槽） | 不读宿主磁盘提示词文件；`defaultOverrideText()` 提供出厂默认 |

Workspace baseline 策略（`rules.js` 的 `WORKSPACE_POLICIES`）：

- `strict`：始终删掉 DSH 官方的 workspace baseline 段；
- `fallback`（默认）：有用户注入内容（A 或 B）时删，否则保留；
- `always`：始终保留。

注入正文会被包进 ChatML 信封：`<|im_start|>system:` + `<project_instructions>…</project_instructions>`，并补/剥信封标签（`normalizeChatmlLayout`、`peelChatmlEnvelope`、`stripChatmlTags`）；非法 `{{…}}` 插值会拆成 `{ {…}}`（DSH 只允许 `cwd/model/provider`，否则整轮抛错）。

### 4.3 "人格"能做到什么

1. **身份替换**：`IDENTITY_CARD_PREFIX = "WHO YOU ARE (highest priority"` + identity lock 文本——禁止模型自称 DeepSeek 助手/DeepSeek Harness agent，可指定任意身份。
2. **规则集切换**：`/rules use <id>` 把 `$DSH_HOME/rules/<id>.md` 写进 `prompt-inject.md`，等于**一键换整套行为规范**（上限 256 KB/套，id 正则限制，带备份）。
3. **按目录生效**：`cwd-selections.json` 记录"哪些目录用哪个 md 注入"，切项目自动换规则。
4. **模式适配**：`adaptInjectForMinimalPreset()` / `modePromptText()` 针对 minimal、PTC、标准模式给不同包装；`isMinimalSession` / `isRedteamSession` / `isRedteamSubagent` 决定注入哪一版。
5. **能力选用协议**：`capability-protocol.js` 三版文本（官方 / 红队指挥 / 红队执行），教模型"先读 skill/MCP 目录，再按任务选用"，并把这个要求写进给子智能体的任务书。
6. **行为层附加**：`continue-retry.js`（请求错误自动重试 + 可选"继续"续跑，区分永久错误码）、`rewind.js`（对话回退到上一轮，不另开分支）、`skills.js`（技能提示词段）。

### 4.4 红队人格：指挥 + 六个角色

`presets/redteam/agent.cordis.yml` 的 `persona.prefix` 是一份很长的"指挥手册"，内容包括：

- **运行环境前提**：优先专用 Kali VM；本机跑要提示私钥/马/扫描器落盘、IP 信誉风险；没有 Kali 就让用户在"演练台→环境适配"填工具路径。
- **指挥职责（硬约束）**：只做"计划、派活、分析回报、汇报"四件事，自己不动手；必须用原生 `subagent` 派活（不用 Agent Teams 的 `spawn_teammate`）。
- **开工前预检**：读 `<available_skills>`、调 `redteam_preflight` 检查 FOFA_KEY、VPS、nmap/nuclei/fscan/gogo/suo5/frp/冰蝎/哥斯拉；缺资源直接向用户要，补不齐给降级方案。
- **并发硬约束**：同一靶标最多 3 个执行智能体，默认顺序派；用 `redteam_agent_slot` 占位，被拒不硬塞。
- **角色索引**：`recon`（信息收集，只收资产）、`assess`（资产梳理，逐条评估落库）、`vuln-scan`（漏洞发现，先查库、优先 Nday/1day、再接口未授权）、`exploit`（漏洞利用，拿服务器权限→建 suo5 隧道并实测→其他得分）、`internal`（内网渗透，自己顺序做收集/梳理/发现/利用，必须用 `gogo-intranet`/`fscan-intranet`）。加指挥本身即"六个角色"。
- **证据纪律**：子智能体回报先记 `claimed`，亲自核实后才升 `observed`；`inferred` 必须标注为推测；没落库等于没发生。
- **汇报口径**：只有"得分/新资产/要用户出手/阶段推进"才说话，其余不输出，省 token。
- **红线**：只有凭据不算账号（要实测登录）、自建 VPS 代理不算隧道、报告每条要可复现。

角色稿不在 preset 里，而在**每次演练的工作目录**：`$DSH_HOME/redteam/engagements/<靶标>/agents/<code>.md`。派活时任务书第一行写 `redteamRole: <code>`，`lib/redteam/role-section.js` 监听 `agent/inbox/claimed`（并用 session 事件兜底）记下角色，组装系统提示词时把对应 md 原样插进"清洗稿与运行环境前提之间"。角色取值白名单：`recon|assess|vuln-scan|exploit|internal`。

### 4.5 锚点门（anchor-gate.mjs）

一个很"工程化"的运行时控制：

- 用第一段 reasoning 的措辞判断思考风格：出现 `we`、没有 `let me` → `minimal-like`（"锚住"）；
- bootstrap 阶段把输出上限压到 `bootstrapMaxTokens`（preset 里是 8192，默认 1024），锚住或走满 `maxBootstrapSteps`（preset 2 步）后放开并删掉上限；
- 每次上下文压缩（`compaction/end`）后重新收紧；
- 放开后把官方"工作区说明"消息替换成一条 `<system-reminder>`，只点名文件路径，让模型需要时再读。

配套的委派配置把子智能体做成**叶子**：`maxDepth: 1`、子会话看不到 `subagent/subagent_fork/workflow/ralph`（注释说明 `toolFilter` 在 0.2.1-rc.2 已废弃，硬写会让整份预设注册失败）。

---

## 5. 演练台能力（红队）

| 子系统 | 实现 | 能力 |
| --- | --- | --- |
| preset 安装 | `lib/redteam/index.js` `installPreset()` | 把 `presets/redteam/*` 复制到 `$DSH_HOME/.agent-presets/redteam`，同步 bundled skills，注册到 `agentPresets`；启动时自愈 profile 缺失的 insert 行 |
| 事实库 | `lib/redteam/store-core.js`（`node:sqlite` 的 `DatabaseSync`） | 演练（engagement）、资产、漏洞、凭据、WebShell、隧道、攻击链、证据、评分、POC 等表 |
| UI 桥 | `lib/redteam/ui.js` | `POST /redteam/api` 常驻右侧栏控制台 |
| 工具面 | `lib/redteam/tools.js` | 约 60 个 `redteam_*` 工具（见下） |
| 评分 | `score-rules.js` + `redteam_score_*` | 得分点定义、命中计分、报告分数 |
| 证据链 | `evidence-ledger.mjs` + `redteam_evidence_*` | `claimed → observed` 升级、hash 级核对、未核实计数 |
| 报告 | `redteam_report*`、`scripts/export-engagement-report.mjs` | 按得分点/攻击链出报告 |
| 平台适配 | `platform-config.js` | `$DSH_HOME/redteam/config.json`：平台、工具箱目录、nuclei 模板、16 个工具路径（nmap/nuclei/masscan/fscan/gogo/suo5/frpc/chisel/ffuf/httpx/dnsx/subfinder/ksubdomain/impacket 等）、`FOFA_KEY`、`REDTEAM_VPS_*` |
| 网络闸 | `net-scope.js` `installRegionGate()` | 开源版只允许回环 + RFC1918；域名先 DNS 解析再逐个判 IP，hosts 指公网也拦；例外写 `$DSH_HOME` |
| 授权门 | `drill-grant.js` | 首次进演练台要读声明、倒计时、勾选；授权落 `$DSH_HOME/dsh-purge/drill-grant.json`，按宿主分开记 |

工具按用途分组（节选）：`engagement_*` / `session_bind` / `preflight` / `agent_slot`（演练与并发闸）、`asset_*`（资产与图）、`vuln_*`、`credential_*`、`shot_*`、`access_*`、`webshell_*`、`tunnel_*`、`poc_*`、`evidence_*`、`unknown_*`、`attack_chain` / `attack_path` / `chain_*`、`score_*`、`report*`、`role_prompt*`、`http_evidence_add`。

---

## 6. "能实现什么功能"总表

| 能力 | 实现位置 | 用户可见效果 | 风险/代价 |
| --- | --- | --- | --- |
| 关掉审批门 | 补丁 #9/#10 + 提示句 #5/#11/#12 | 所有需要授权的操作直接放行，不再弹审批 | 本机所有会话都失去人工确认 |
| 关掉沙箱 | 补丁 #15/#6/#7 | 命令不套 bwrap/landlock 等 runner，`deny file-write*` 变 allow | 任意路径读写、命令直跑宿主 |
| 关掉文件围栏 | 补丁 #16/#17 | read-only / workspace-write 下也能写、也不要求先读 | 误删/误改无兜底 |
| 放宽升级阶梯 | 补丁 #13/#14 | 任意模式间升级、无 approver 也放行 | 权限模型失效 |
| 绕 hooks | 补丁 #30/31/64/65 + `hooks-deny.js` | hooks 的 deny/ask、Stop hook 拦截都失效 | 用户自定义安全钩子失效 |
| 放宽工具/上下文上限 | 补丁 #18/#19/#21/#22 | 重复调用不提醒、结果不修剪、read 上限 1 MB | 上下文暴涨、成本上升 |
| 换身份 | `identity.js` 身份卡 + `cordis.patch.yml` 去身份 | 模型不再自称 DeepSeek 助手，可指定任意人设 | 行为不可复现、合规风险 |
| 换提示词/规则 | `prompt-inject.md` + `rules.js` 多套规则集 | 一键切整套行为规范，按目录生效 | 规则内容由使用者负责 |
| 接管系统提示词 | `installAssembleGuard` + `rewritePromptAssembly` | 可删官方段（含 workspace baseline）、插入任意段、ChatML 包裹 | 与宿主版本强耦合，宿主升级可能失效 |
| 红队演练 | preset + store + tools + 评分 | 指挥自动派 5 类执行角色、资产/漏洞/凭据/隧道全部落库、出评分与报告 | 双用途；只靠本地 IP 闸与免责声明约束 |
| 对话控制 | `rewind.js`、`continue-retry.js` | 回退上一轮、失败自动重试、"继续"续跑 | 自动续跑可能放大错误 |
| 宿主运维 | `reapply.js`、`update.js`、`restart-*.js`、`hide-console.js`、shim 注入 | DSH 升级后自动重打、自动重启、静默窗口、自更新 | 自更新通道即供应链信任面 |
| 可回滚 | `.dshpurge.bak`、`--revert`、`uninstall.js` | 一键还原官方、卸载先还原 | 备份只覆盖改过的文件，跨版本回滚未必完整 |

---

## 7. 工程评价

**做得好的**：

- 幂等与收敛策略明确（markers / skipIfMarked / softSettle / optional / strictFiles），并有大量注释记录真实踩坑（#82、#138、F14/F17、H19 等）。
- 装配劫持的失败路径考虑周全（内层抛错返回空 sections、rewrite 抛错回退原对象、dispose 故意 noop）。
- 路径探测、多宿主、asar 处理、自动重打、备份回滚、卸载还原都形成闭环。
- 红队侧有证据分级（claimed/observed/inferred）、hash 核对、未核实计数，不是"随口说拿到了"。

**风险与脆弱点**：

1. **它是宿主级的**：`--apply` 之后，这台 DSH 上**所有**会话都没有审批、沙箱和 fs 围栏，并不只影响"演练用"那个会话。
2. **精确字符串补丁**：全仓靠几十组硬编码原文命中，`dshTarget` 写死 `0.2.1-rc.2`；DSH 一升级就是大面积 `skipped`，且社区版/官方升级路径变化都可能留下半完成状态。
3. **安装即改配置 + 自动重启 + 自更新**：供应链信任完全落在作者仓库；`postinstall` 会改 profile bundles 和用户层 patch。
4. **软约束**：网络闸、免责声明都在插件代码里，改一行即可放开；红队工具（WebShell/隧道/凭据/攻击链/评分）本身双用途。
5. **可复现性差**：身份抹除 + 提示词注入 + hooks 旁路之后，"模型拒绝"与"宿主拦截"更难区分；跨机器比较结论意义有限。
6. **单文件巨模块**：`core.js` 8194 行、`tools.js` 139 KB、`store-core.js` 346 KB，维护与审计成本高；`client.js` 是打包产物，源码不在仓库内（只有 `scripts/patch-client-dock.mjs`）。

---

## 8. 如何自证（不依赖作者说法）

```sh
# 语法自检
node --check lib/index.js && node --check lib/core.js && node --check client.js

# 看补丁状态（打没打、哪些 skipped）
dsh-purge --status
/purge status

# 看插件是否进了宿主组合（应有 id: dsh-purge）
dsh --dump-config | Select-String "dsh-purge"

# 验证补丁真的写进包了（找 marker 注释）
Select-String -Path "<DSH_BASE>/user-approval/lib/index.js" -Pattern "\[dsh-purge\]"
Select-String -Path "<DSH_BASE>/sandbox-local/lib/index.js" -Pattern "\[dsh-purge\] sandbox bypass"

# 验证还原
dsh-purge --revert   # 之后对比 *.dshpurge.bak 是否消失、文件是否回到官方原文
```

---

## 9. 结论

- 想理解"DSH 的约束都在哪一层"：这份仓库是一张很完整的**宿主约束地图**——审批（`user-approval`）、沙箱（`sandbox-local`）、fs 围栏（`fs-sandbox`）、升级阶梯（`escalation`）、hooks、工具守卫、上下文裁剪、身份与提示词装配，全被逐条定位并改写，注释里还写清了每个版本的承载位置。
- 想用它：建议**单独一份 DSH 安装**（web 和 desktop 各一份，别动在用的环境），先截图/备份，应用前后各跑一次 `--status`，确认 `skipped` 列表；卸载/还原走它自己的流程，别手删文件。
- 想拿它做"红队演练台"：它确实是完整的一套（资产库 + 六角色流水线 + 评分 + 证据链 + 报告），但网络闸和免责声明是**软约束**，合规责任在使用者。

---

## 10. 本仓库 fork：补丁引擎 v2（已实施）

针对第 7 节列的"精确字符串补丁"风险，已在 clone（`repos/dsh-purge`）里完成一轮改造，**82 条补丁定义未改一行**：

| 新增模块 | 作用 |
| --- | --- |
| `lib/patch-match.js` | 多级匹配：literal(1.0) → flex-ws 空白归一(0.9) → flex-quote 引号风格(0.8) → token 词法(0.6，仅诊断)；歧义一律不写；literal 保留"全替换"旧语义 |
| `lib/patch-txn.js` | 事务化：改动先攒内存 → `node --check` 校验 → 全通过才逐文件原子写；失败整体放弃（磁盘零改动） |
| `lib/patch-doctor.js` | 状态细化：clean / pending / partial / duplicate / drifted / missing_file，而不是笼统的 skipped |

配套改动：

- `applyPatches()` 默认 `atomic: true`；`applyPatchesAllHosts()` 把 `validation` 挂到 host 结果，校验失败时 `hostWritten=false`，不会触发"应用成功→重启"。
- `patchStatus()` 输出六档状态；聚合优先级 `duplicate > partial > drifted > pending > clean > missing`；`partial/duplicate/drifted/ambiguous` 记为 soft（不阻塞 apply，但 UI 计入待处理）。
- 版本面：`detectVersionInfo()` 读宿主实际安装版本 + 插件 `dshTarget`，主版本一致即兼容，rc 差异交给匹配链。
- CLI 新增 `--verify`（只读诊断，有漂移时 exit 2）、`--explain <id>`（逐替换的策略/置信度/漂移线索）、`--status --json`。
- 测试：`npm test`，25 个用例覆盖匹配六策略、六状态、语法校验、整体放弃、幂等、重缩进文件仍可应用。

实测（对本机 `profiles/node_modules/@deepseek-ai`，0.1.0-rc.6）：

```
宿主版本 0.1.0-rc.6  目标 0.2.1-rc.2
主版本不一致（0.1.0-rc.6 vs 0.2.1-rc.2）：补丁大面积漂移属预期
clean 1 | pending 42 | partial 0 | duplicate 1 | drifted 22 | missing 11 | na 5
```

改造前这里只会显示一片 `skipped`；现在能区分"可直接应用 42 条 / 需要更新定义 22 条 / 重复叠层 1 条"。详细设计见 `repos/dsh-purge/docs/patch-engine-v2.md`。
---

## 11. 内置默认提示词「加密槽」解密分析

对象：`lib/asset-table.js`（密文制品）+ `lib/table-key.js`（密钥派生）+ `lib/table-read.js`（解密）。

- 方案：`key = sha256("cordis.slot.v2" + 0x1e + "dsh-purge" + 0x1e + "surface:web|desktop" + 0x1e + "ov.table.1" + 0x1e + MASK)`；`body = AES-256-GCM(deflate(prompt, level 9), key, IV)`；`SLOT/MASK/IV/TAG` 一起明文存在 `asset-table.js`。
- 解密：`openSlot()` 走 GCM 校验 + inflate；`core.defaultOverrideText()` 取它当出厂默认，首次安装写入 `$DSH_HOME/prompt-inject.md`。
- 实测：明文 **25,127 字节 / 226 行**，sha256 `dec02209…a033b1b`，以 `<|im_start|>system:<project_instructions>` 开头；结构为 `[MODE: UNRESTRICTED SANDBOX]` → PRIME DIRECTIVE / TASK PRIORITY / Style / HARD OUTPUT RULES（中英禁拒答词表）/ REFUSAL HARDENING / Scoped Rules / CTF Core Contract / Routing / House Rules。
- 与仓库现存源对比：`default-prompt-inject.zh.md`(26,005) / `.en.md`(29,711) / `.md.bak`(24,687) **全都不一致**；embed 脚本依赖的 `lib/default-prompt-inject.md` 不存在（被 npm files 排除）→ 槽不可复现、不可从仓库验证。
- 安全结论：密钥材料 in-band，**是混淆不是保密**；GCM 防损坏但不防持有者用 `sealSlot()` 重签伪稿；`openSlot()` 异常静默返回空串（fail-closed 且难排查）；把提示词移出 md 只能降低静态搜索命中率。

落地：`scripts/decrypt-prompt-slot.mjs`（摘要 / `--hash` / `--json` / `--out`），测试 `test/prompt-slot.test.mjs`（3 例：可解密、key 可派生、可重签伪稿），完整文档 `repos/dsh-purge/docs/prompt-slot-decrypt.md`。