---
name: attack-surface-inventory
description: 授权范围内的自有资产攻击面测绘（资产/子域/端口/指纹/暴露项），只做发现与落库，不做利用。
---

# 攻击面测绘（授权资产）

> 目标：把"你拥有或已获书面授权"的资产完整盘点出来，形成可复现的暴露清单。
> 不做漏洞利用、不做凭据攻击、不做隐蔽或规避。

## 0. 适用范围（先过这道门）

开工前逐条确认，任何一条不满足就停下并向用户要依据：

1. **授权**：资产属于用户本人，或用户能给出书面授权（授权方、范围、有效期）。
2. **范围**：明确列出域名、IP/CIDR、APP 包名；不在列表内的一律不碰。
3. **网络位置**：目标必须解析到 loopback 或 RFC1918 私网。校验方式：
   ```sh
   dig +short TARGET | sort -u          # 每个地址都必须是 10/8、172.16/12、192.168/16 或 127/8
   ```
   解析失败、或混入任何公网地址 → 停止，不要"试试看"。
4. **授权记录落库**：把"谁授权、范围、有效期"写进本次演练的目标备注，后续报告引用它。

> 开源版把公网目标当硬红线；这条不是建议，是运行前提。

## 1. 预检

```text
redteam_engagement_open  → 新建演练（靶标名 = 授权项目名）
redteam_session_bind     → 绑定本会话到该演练
redteam_preflight        → 检查 nmap / subfinder / httpx / dnsx 等二进制是否可用
```

缺工具就一次性向用户列清"要什么、为什么、放哪"，不要用替代工具硬凑精度。

## 2. 流程

### 2.1 资产清单
从用户给的列表出发（域名 / IP / CIDR / APP 包名），先落一份初始基线：

```text
redteam_asset_add(asset=…, type=domain|ip|app, note=授权依据)
```

### 2.2 子域与域名面
```sh
subfinder -d DOMAIN -all -silent | sort -u > subs.txt
dnsx -l subs.txt -a -resp -silent        # 解析结果必须全部落在私网
```
只对授权域做；父域/兄弟域不在范围就不要扩。

### 2.3 存活与服务指纹
```sh
httpx -l subs.txt -sc -title -tech-detect -silent > alive.txt
nmap -sV -Pn -T3 --max-rate 300 -iL hosts.txt -oN nmap.txt
```
限速是硬要求：内网也要给 `--max-rate`，避免把靶场打挂。

### 2.4 暴露项盘点（只观察）
按响应归类，不写入侵步骤：
- 管理后台 / 默认页 / 目录列表 / 调试端点
- 组件与版本（响应头、`/static`、favicon hash、报错页）
- 开放的高危服务端口（数据库、Redis、K8s API、Docker API）
- 证书与域名归属（SAN、过期、自助签发）
- 云存储/对象存储桶是否公开（仅 GET 首页判断）

### 2.5 落库与优先级
```text
redteam_asset_add(asset=…, surface="port/service/tech", evidence=…)
redteam_asset_stats                     # 看覆盖率，找缺口
redteam_asset_assess(asset=…, priority=high|medium|low, reason=…)
```
优先级依据：是否对外可达 → 是否高价值服务 → 版本暴露面，而不是"能不能打"。

## 3. 证据与报告

- 每条资产至少一条可复现证据：命令 + 原始输出，或 HTTP 请求/响应。
- `redteam_evidence_record(confidence=claimed)` → 亲自复核后 `redteam_evidence_upgrade(…, verified_result)`。
- 报告只写：范围、方法、资产与暴露项、缺口（未覆盖的网段/域名）、建议的加固动作。
- 结论区分：**观察**（有输出）/ **推理**（有依据）/ **推测**（明确标注）。

## 4. 停止条件

- 目标解析出公网地址、或范围存疑；
- 用户要求"顺带看看别的网段/域名"但不在授权范围；
- 发现真实用户数据（凭据、个人信息、生产库）→ 停止采集，只记录"存在暴露"这一事实并告知用户。

## 5. 明确禁止

- 漏洞利用、PoC 打点、横向移动；
- 口令爆破、撞库、凭据填充；
- 隐蔽/规避检测（改流量特征、绕 WAF、清日志）；
- 扫描授权范围之外的地址（同 C 段也不允许）；
- 把测绘结果用于对外攻击。
