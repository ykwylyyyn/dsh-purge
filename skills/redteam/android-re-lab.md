---
name: android-re-lab
description: 自有/授权 APK 的安卓逆向分析（静态拆包、清单与代码分析、自有构建的动态插桩、改包重签与验证），不含第三方破解。
---

# 安卓逆向（自有 / 授权 App）

> 适用：你自己开发的 App、你自己构建的测试包、或用户书面授权分析的应用。
> 目标：讲清"这个包做了什么、数据怎么流、哪里薄弱"，产出可复现的分析报告。
> 不含：第三方 App 破解、授权/DRM 绕过、反作弊对抗、窃取真实用户数据。

## 0. 前置门禁

1. **来源与归属**：确认 APK 是自研/自建/已授权；记录包名、签名证书指纹、来源路径。
2. **设备**：优先模拟器或专用测试机；不接生产账号、不清真机数据。
3. **数据**：分析产物放隔离目录，原始包只读、备份校验和（`sha256sum`）。
4. **越界即停**：出现真实用户数据（通讯录/短信/账号 token）→ 停止提取，只记录"存在访问"。

## 1. 静态分析

```sh
# 基本信息与校验
sha256sum app.apk
aapt dump badging app.apk | head -40
apksigner verify --print-certs app.apk

# 拆包（只读副本）
apktool d -f -o out app.apk
# 反编译（需自备 jadx）
jadx -d jadx-out app.apk
```

必查项：

| 面 | 看什么 | 产出 |
| --- | --- | --- |
| Manifest | exported 组件、权限、`usesCleartextTraffic`、`allowBackup`、deeplink、provider | 暴露面表格 |
| 组件 | 可导出 Activity/Service/Receiver/Provider 的 intent 条件 | 可触达入口清单 |
| 网络 | 硬编码域名、HTTP 明文、证书 pinning 实现位置 | 端点与信任配置 |
| 存储 | SharedPreferences/DB/文件路径、密钥与 token 的落盘方式 | 敏感数据落点 |
| 原生库 | `lib/` 下的 .so 清单、可疑符号（JNI、加解密） | 是否需进一步逆向 |
| 加固 | 壳特征（多 dex、加载器、自校验） | 是否属于"受保护第三方包"（是则停止） |
| 第三方 SDK | 埋点/推送/支付/广告 SDK 版本 | 组件与数据流清单 |

## 2. 动态分析（仅自有构建）

在你自己的测试包上启用调试，观察行为而不是绕过保护：

```sh
# 测试设备/模拟器，仅装自有 debug 包
adb install -r app-debug.apk
adb logcat | grep -iE "http|token|secret"
# Frida 用于自有包的函数跟踪（脚本自己写，针对自己的类）
frida -U -f com.example.app -l trace.js
```

记录：启动链路、网络请求、加解密调用点、权限实际使用情况。
**不写**第三方 App 的 pinning/root/反调试绕过脚本。

## 3. 改包与重签（自有构建）

只用于验证"改动是否生效"或修复自测缺陷：

```sh
apktool b out -o patched.apk
keytool -genkeypair -keystore test.jks -alias test -keyalg RSA -keysize 2048 -validity 365 \
        -storepass testpass -keypass testpass -dname "CN=Lab"
apksigner sign --ks test.jks --ks-pass pass:testpass --out signed.apk patched.apk
adb install -r signed.apk
```
记录改动点（文件 + 行号 + 前后 diff）与验证结果。

## 4. 证据与报告

- 每个结论对应：文件/方法/调用链 + 复现步骤（命令或 hook 输出）。
- 风险分级：仅描述可达性与影响，不写利用链。
- 交付物：暴露面清单、数据流图、加固建议（pinning、root 检测、存储加密、组件最小化）。
- 结论区分 observe / infer / unknown。

## 5. 停止条件

- APK 非自有/无授权，或明显是第三方商业加固包；
- 要求"去掉授权/破解 VIP/过反作弊"→ 拒绝并说明范围；
- 分析对象包含真实用户数据 → 停止提取。

## 6. 明确禁止

- 破解第三方 App、绕过授权/DRM/内购验证；
- 制作或分发外挂、反作弊绕过；
- 窃取真实用户凭据、通讯录、短信；
- 注入/持久化到非本人设备。
