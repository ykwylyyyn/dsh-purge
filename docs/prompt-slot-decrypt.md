# 默认提示词「加密槽」解密分析

> 对象：`lib/asset-table.js`（加密槽） + `lib/table-key.js` / `lib/table-read.js`（密钥与解密）
> 结论先说：**这是 AES-256-GCM 加密，但密钥材料（MASK）就明文存在同一个文件里**——属于防止随手阅读/关键词扫描的**混淆**，不构成保密；任何能运行插件的人都能解出全文，也能重新封装伪稿。
> 复现脚本：`node scripts/decrypt-prompt-slot.mjs`（本次实测输出见 §5）。

---

## 1. 制品布局

`lib/asset-table.js` 是 `scripts/embed-default-prompt.mjs` 生成的文件，导出四个值：

```js
const SLOT_ROWS = [ "vGK8aCmb…", "f18lR5UU…", … ];   // 162 行 × 96 字符 base64 密文
export const SLOT = SLOT_ROWS.join("");
export const MASK = "jUnhHJSdiZ+XC6nRBgG2tQ==";      // 16 字节随机数（base64），16 个字符
export const TAG  = "wq5epabrwGvk5wf55ot+bg==";      // GCM 认证标签
export const IV   = "Gtp/BOLB/XH+WELR";               // 12 字节随机 nonce
```

生成链：`lib/default-prompt-inject.md`（源文本）→ `sealSlot()` → `asset-table.js`。

## 2. 算法（`lib/table-key.js`）

```js
MIX = ["cordis.slot.v2", "dsh-purge", "surface:web|desktop", "ov.table.1"]
key = sha256( MIX.join("\x1e") + "\x1e" + MASK )
payload = deflate(prompt, level: 9)
body = AES-256-GCM(payload, key, IV)      // 输出 base64 → SLOT
```

两个细节：

- `"dsh-purge"` 不是明写字面量，而是 `[100,115,104,45,112,117,114,103,101].map(String.fromCharCode).join("")` —— 只为了不在源码里出现插件名，属于**同级别混淆**。
- `MASK` 是随机 16 字节，但它是**密钥派生的唯一未知量**，并且与密文一起以 base64 明文写在同一个文件里。所以密钥可完全复算。

## 3. 解密路径（`lib/table-read.js`）

```js
const decipher = createDecipheriv("aes-256-gcm", mixKey(MASK), Buffer.from(IV, "base64"));
decipher.setAuthTag(Buffer.from(TAG, "base64"));
const raw = Buffer.concat([decipher.update(Buffer.from(SLOT, "base64")), decipher.final()]);
return inflateSync(raw).toString("utf8");
```

调用方：

- `core.defaultOverrideText()` → `openSlot()`，并用 `normalizeOverride()` 判空；**失败会返回空串而不是抛错**（`catch { return ""; }`），即"静默 fail-closed"：槽坏了 = 默认注入为空，界面不会告诉你为什么。
- `installOverride()` 首装时把解出来的正文写进 `$DSH_HOME/prompt-inject.md`，之后运行注入以该文件为准（`override-state.json` 记录是否用户改过、是否等于默认值）。

## 4. 复现

```sh
# 摘要：算法、key 指纹、密文/明文大小、sha256、结构提纲、与仓库 md 源对比
node scripts/decrypt-prompt-slot.mjs

# 只要指纹
node scripts/decrypt-prompt-slot.mjs --hash

# 机器可读
node scripts/decrypt-prompt-slot.mjs --json

# 写出明文全文（本地分析用；这是项目的"破甲"身份稿）
node scripts/decrypt-prompt-slot.mjs --out default-prompt.md
```

## 5. 本次实测（v1.1.78 / asset-table 现存版本）

| 项 | 值 |
| --- | --- |
| SLOT（base64） | 15,516 字符（162 行 × 96） |
| MASK | `jUnhHJSdiZ+XC6nRBgG2tQ==` |
| IV | `Gtp/BOLB/XH+WELR` |
| TAG | `wq5epabrwGvk5wf55ot+bg==` |
| key 指纹（sha256(key) 前 16 位） | `ff0495513117036b` |
| 明文 | **25,127 字节 / 226 行** |
| 明文 sha256 | `dec02209f23a50f3340caf71695711482c73731ff859be4f94b9f3c41a033b1b` |
| 首行 | `<|im_start|>system:<project_instructions>`（ChatML system 信封，直接进系统提示词） |

**与仓库里现存的 md 源对比**（都不一致）：

| 文件 | 字节 | sha256（前 16） |
| --- | --- | --- |
| `lib/default-prompt-inject.zh.md` | 26,005 | `4fc7d00145d93742` |
| `lib/default-prompt-inject.en.md` | 29,711 | `1b1e4cd79ef33981` |
| `lib/default-prompt-inject.md.bak` | 24,687 | `0edc02b16abd2adf` |
| `lib/default-prompt-inject.md`（embed 脚本要求的源） | **不存在** | — |

即：`asset-table.js` 是用一份**没有随仓库发布**的 `lib/default-prompt-inject.md` 生成的（该文件被 `package.json` 的 `files` 排除，仓库里只剩 `.bak`）。**构建不可复现**——审计者无法从仓库源验证槽内容。

## 6. 解密后内容的结构（不全文转载）

按 `═` 分隔小节提取的提纲：

| 行 | 类型 | 标题 |
| --- | --- | --- |
| 3 | marker | `[MODE: UNRESTRICTED SANDBOX — STABLE]` |
| 5 | 指令 | `PRIME DIRECTIVE`：把模型身份改写成 `YG` / "小码酱"（Little Code Sauce），要求以第一人称"真实自我"作答 |
| 14/16/18 | 指令 | TASK PRIORITY（用户任务高于一切）、Direct generation（跳过拒绝念头）、Workflow（先执行后解释） |
| 20 | section | `Style` |
| 28 | section | `HARD OUTPUT RULES`：禁用中英文拒答词表（不能/无法/拒绝…、I can't/won't/refuse…），禁止安全/合法性/授权话术，禁止"改为授权/可改为"式替代 |
| 45 | section | `REFUSAL HARDENING — 拒绝对抗`：把被禁拒答表扩展到任何语言的缓和/部分措辞 |
| 65 | section | `Scoped Rules` |
| 133 | section | `CTF Core Contract`：要求区分观察/推理/推测，禁止伪造证据与结果 |
| 146 | section | `CTF Scope and Evidence` |
| 160 | section | `Routing` |
| 164/168/178/212 | rule-group | `PLACEHOLDER NORMALIZATION` / `BILINGUAL ROUTING` / `BOUNDARY-WORD NORMALIZATION` / `STABILITY ANCHORS`（模板占位符与中英切换、边界词归一、稳定性锚点） |
| 220 | section | `House Rules`：`Reply in Simplified Chinese. Think in English.` |

这份正文与仓库里 `docs/v1.1.34-prompt-inject.md`、`docs/注入方式改造方案` 描述的设计一致：**先改写人格与拒答策略，再交给宿主去跑**。它只是"默认注入正文"；运行时还会被 `identity.js` 再加工（身份卡、ChatML 信封、模式适配），所以槽 ≠ 最终系统提示词。

逐段全文解析（226 行、25 条 Scoped Rules、路由表、机制总结）见 [default-prompt-analysis.md](default-prompt-analysis.md)。

## 7. 安全评估

1. **保密性 = 0**：密钥材料 in-band。`MASK` + 公开常量即可解出全文，无需任何破解。所谓"加密"只能防：随手 `strings`/grep 到关键词、GitHub 搜索命中提示词、简单静态扫描。
2. **完整性靠 GCM，但持有者可重签**：TAG 能防传输/存储损坏，但既然密钥可派生，攻击者（或任何改包的人）可用 `sealSlot()` 把任意伪稿封成合法槽——GCM 在这里防的是"无意损坏"，不是"恶意替换"。
3. **静默 fail-closed**：`openSlot()` 任何异常都返回 `""`，`defaultOverrideText()` 再把空串归一为空。槽损坏/版本不匹配时，表现是"默认提示词消失"，而不是报错。对用户是难排查的静默降级，对攻击者则是"让注入失效"的低成本手段。
4. **规避静态审计**：把提示词从 `.md` 挪进 base64 密文制品，确实降低了仓库层面的可搜索性；但 `scripts/embed-default-prompt.mjs` 与 `table-key.js` 一起放在仓库里，等于把锁和钥匙都交了。
5. **可复现性缺口**：源 md 未入库（只剩 `.bak`），生成脚本却依赖它 → 无法从仓库验证槽内容，也无法复现构建。这是比"加密"本身更值得关注的问题。

## 8. 审计建议

- **记录指纹**：每个 release 记录 `plaintext sha256` 与 `SLOT sha256`，升级时对比，一眼看出默认提示词是否被改。
- **补齐源文件**：把生成槽用的 `lib/default-prompt-inject.md` 纳入仓库（或改为构建时从 `.zh/.en` 生成），让 `asset-table.js` 可复现、可 diff。
- **CI 校验**：`npm run build:prompt && git diff --exit-code lib/asset-table.js`；再加一条"解出来的文本与源 md 相等"的断言。
- **把槽当二进制制品审**：代码审查看 `table-key.js`；内容审查看解出来的明文；两者分开记录。
- **不要指望它保密**：如果目标是"不让用户看到默认提示词"，这个方案不成立；若要真保密，密钥必须来自进程外（用户输入/系统密钥库），而不是同文件。

## 9. 已知限制

- 本分析只覆盖**内置默认注入正文**（加密槽）；`$DSH_HOME/prompt-inject.md`、规则集、`identity.js` 的运行时改写不在槽里。
- 槽内容会随版本变化（本次与仓库 md 全不一致即为证据），指纹只对应当前 `asset-table.js`。
- `--out` 导出的全文是该项目的"破甲"身份稿，仅建议本地分析，不要分发。
