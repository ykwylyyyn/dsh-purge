# 授权技能包（skills/redteam）

本目录补充开源版缺失的技能库。安装器（`lib/redteam/index.js` 的 `installBundledSkills()`）
会把这里的**平铺 `*.md`** 同步到 `$DSH_HOME/redteam/skills`，红队预设通过
`customSkillDirs` 指向该目录，原生 `skill` 工具即可加载。

## 包含什么

| 技能 | 用途 | 边界 |
| --- | --- | --- |
| `attack-surface-inventory` | 自有/授权资产的攻击面测绘：资产清点、子域、存活、端口、指纹、暴露项，落库并出清单 | 只发现不利用；目标必须 loopback/RFC1918 |
| `pentest-lab` | 授权靶场的 Web/网络测试流程：OWASP 分类逐项验证、限速、取证、报告 | 不武器化、不持久化、不碰真实用户数据 |
| `android-re-lab` | 自有/授权 APK 的逆向：拆包、Manifest/组件/存储/网络分析、自有构建的动态插桩与重签验证 | 不做第三方破解/DRM/反作弊 |

## 格式约定

每个技能是单个 Markdown 文件，开头必须是 YAML frontmatter：

```md
---
name: kebab-case-name
description: 单行描述（会被技能列表直接展示）
---
```

`name` 用 kebab-case；`description` 必须单行。正文建议包含：
适用范围 → 前置门禁 → 流程 → 证据/报告 → 停止条件 → 明确禁止。

## 和上游"正式版技能库"的差异

本包**不是**对上游付费技能库的还原，也不做等价替代。刻意不包含：

- 具体漏洞的成品利用链、武器化载荷、免杀/持久化；
- 凭据填充、撞库、钓鱼、社工话术；
- 外挂/反作弊对抗、第三方授权与 DRM 绕过；
- 面向公网目标的扫描与攻击流程。

换句话说：**补的是"授权范围内怎么把事做完整"的方法，不是"怎么打别人"的弹药**。

## 安装与验证

```sh
# 插件启动时会自动同步；也可手动触发
node -e "import('./lib/redteam/index.js').then(m=>console.log(m.installBundledSkills()))"

# 落盘位置
ls "$DSH_HOME/redteam/skills"
```

在红队会话里用原生 `skill` 工具按名字加载，例如 `skill(name="pentest-lab")`。

## 扩展自己的技能

1. 在本目录新增 `<name>.md`（frontmatter 必填）；
2. 重新触发同步（重启宿主或调用 `installBundledSkills()`）；
3. 同名技能以 `$DSH_HOME/skills` 优先（预设里根顺序已固定），所以用户目录里的版本会覆盖随包版本——适合放本地化的目标清单/占位符替换。

## 测试

`test/skills-lab.test.mjs` 会校验：

- 目录里只有平铺 `.md`（安装器的 `readdirSync(...).filter(f => f.endsWith('.md'))` 不会递归子目录，放子目录等于不生效）；
- 每个文件 frontmatter 合法：`name` 与文件名一致且是 kebab-case、`description` 单行且 ≤160 字；
- 三个技能都包含「适用范围/前置门禁」「停止条件」「明确禁止」，且正文带授权/私网约束；
- 武器化/规避类措辞只能出现在「禁止」语境里。
