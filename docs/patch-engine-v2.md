# 补丁引擎 v2：多级匹配 / 事务化写入 / 漂移诊断

> 针对 v1 的三个硬伤：
> 1. **精确字符串命中**——DSH 一次格式化（tab→空格、换行重排、引号风格变化）就整片 `skipped`；
> 2. **`dshTarget` 写死一个版本**——升级后大面积失效，且用户分不清"版本不对"和"打了一半"；
> 3. **边算边写**——中途出错会留下半完成状态，而调用方往往已经在重启宿主。

v2 用三个新模块（`lib/patch-match.js` / `lib/patch-txn.js` / `lib/patch-doctor.js`）替换单个 `matchesPattern()`，`lib/core.js` 只做接线，原有 82 条补丁定义**一行都不用改**。

---

## 1. 多级匹配（patch-match.js）

每条替换按置信度从高到低依次尝试：

| 策略 | 触发条件 | 置信度 | 写入行为 |
| --- | --- | --- | --- |
| `literal` | 逐字命中 | 1.0 | 多处命中 = 全部替换（与旧行为完全一致） |
| `flex-ws` | 空白串归一为 `\s+` | 0.9 | 仅唯一命中时替换 |
| `flex-quote` | 在上一级基础上 `' " \`` 互换 | 0.8 | 仅唯一命中时替换 |
| `token` | 词法记号序列（允许空白/逗号/分号差异） | 0.6 | **不参与默认写入**，只用于诊断 |
| `regex` | pattern 本身是正则 | 1.0 | 与旧行为一致（含 `$1` 展开） |

关键安全约束：

- **歧义不写**：降级策略命中多处时返回 `ambiguous`，引擎只报告、不改文件。
- **literal 保持旧语义**：仍然 `split/join` 全替换，避免破坏"同一行在文件里出现多次"的既有补丁。
- **token 只做诊断**：`tokens: false` 是默认值，防止弱匹配把补丁打到错误位置。
- 正则 pattern 不进入降级链。

`describeDrift(text, pattern)` 给漂移补丁提供线索：按**最长标识符**挑锚点（避免 `consume` 这种通用词指错行），返回 `coverage`（原文覆盖比例）+ 最多 3 条候选行。

---

## 2. 事务化写入（patch-txn.js）

`applyPatches()` 默认 `atomic: true`：

```
遍历补丁 → 所有改动先攒进内存 staged Map（不落盘）
        → validateStagedSources()：对每个 .js/.mjs/.cjs 用 `node --check` 校验
        → 任一失败：整体放弃，report.validation.aborted = true，磁盘零改动
        → 全部通过：commitStagedWrites() 逐文件原子写（复用 core 的 saveText）
```

- 校验在临时目录里以 `.mjs` 落盘执行，**不受目标目录 `package.json` 的 CJS/ESM 判定影响**。
- YAML/MD 不做语法校验（只统计到 `validation.skipped`），因为旧引擎本来就是字符串手术。
- 保留 `atomic: false` 开关：`preserveClientBundles`（启动自愈写 client bundle）仍走同步直写路径，不受影响。
- 事务化之后，`applyPatchesAllHosts()` 把 `validation` 挂在 host 结果上；`hostWritten` 在校验失败时强制为 `false`，不会触发"应用成功→重启"。

---

## 3. 漂移与半完成诊断（patch-doctor.js）

`patchStatus()` 从三档细化为六档：

| 状态 | 含义 | 是否要人处理 |
| --- | --- | --- |
| `clean` | marker 在、原文已消失 | 否 |
| `pending` | 无 marker，但匹配链能定位（点应用即可） | 否（可自动修） |
| `partial` | marker 在，但仍有原文命中（打了一半） | **是** |
| `duplicate` | marker 出现 >1 次（历史重复叠层） | **是**（只报告，不自动删） |
| `drifted` | 无 marker、原文也定位不到（版本不对） | **是**（需更新补丁定义） |
| `missing_file` | 目标文件不在本布局 | 否 |

聚合优先级：`duplicate > partial > drifted > pending > clean > missing_file`。
`partial/duplicate/drifted/ambiguous` 归入 `ALWAYS_SOFT_STATUSES`，**不阻塞 apply**，但 UI 计入"待处理"（`DISPLAY_ACTION`）。

---

## 4. 版本面

不再只写死 `dshTarget`：

```js
detectVersionInfo(aiBase)
// → { installed, target, compatible, baseMatch, prereleaseDrift, reason }
```

- `installed`：依次读 `<aiBase>/dsh/package.json`、`dsh-base`、`dsh-agent-instructions`、嵌套 `dsh/node_modules/@deepseek-ai/dsh`、解包根 `package.json`。
- `target`：本插件 `package.json` 的 `dshTarget`。
- `compatible`：**主版本号相同**即兼容（rc 之间的差异交给匹配链兜底）；主版本不同时，`--verify` 会明确写"补丁大面积漂移属预期"，而不是让用户猜。

---

## 5. CLI

```sh
dsh-purge --status            # 状态 + 宿主/目标版本 + 漂移/半完成计数
dsh-purge --status --json     # 机器可读
dsh-purge --verify            # 只读诊断，列出需要处理的补丁与文件；有漂移/半完成时 exit 2
dsh-purge --verify --json
dsh-purge --explain 9         # 逐文件看每条替换命中的策略、置信度、漂移线索
dsh-purge --apply             # 事务化应用（语法校验失败则整体放弃）
```

`--apply` 的补丁行现在会附带策略，例如 `✓ 已清洗 patch #9 ... [flex-quote]`；失败时打印 `[ABORTED]` 并以 exit 1 结束，不再提示"全部完成"。

---

## 6. 测试

```sh
npm test
# 等价于
node --test test/patch-match.test.mjs test/patch-doctor.test.mjs test/patch-txn.test.mjs test/apply-atomic.test.mjs
```

覆盖：

- 逐字 / 空白归一 / 引号风格 / token / 歧义 /正则 六种定位；
- `literal` 全替换语义保持不变；
- 六种文件状态与汇总、`actionableRecords` 过滤；
- `node --check` 校验器（合法/非法/非 JS 跳过）；
- **集成**：语法正确→写盘；语法错误→整体放弃且文件字节不变；`atomic:false` 回退旧行为；二次应用幂等且 marker 不重复；官方文件被重新缩进后仍能应用（`strategies: ['flex-ws']`）。

---

## 7. 已知边界（下一轮可以继续做的）

1. **YAML 折叠标量布局**：`personaPrefix: >-\n  You are ...` 改成 `|-` 或改缩进时，`flex-ws` 能兜住（空白归一），但块形状变化（如 `prefix: |`）仍会漂移。可在 `patch-match` 里加 `flex-yaml-fold` 策略。
2. **删除/重命名**：目标函数被改名（`checkedTarget` → `checkTarget`）时 token 级只能提示、不能自动改；需要"语义补丁"（AST/正则锚点）才能自愈。
3. **跨版本补丁链**：目前仍是"一套定义 + 多级匹配"，没有按版本选择 pattern 组。`--verify` 的版本面已经就位，后续可以按 `installed` 版本挑 pattern 集。
4. **多宿主事务**：事务边界是单个 aiBase；web + desktop 同时应用时，一个宿主失败不会回滚另一个（备份机制仍在，可手工 revert）。
