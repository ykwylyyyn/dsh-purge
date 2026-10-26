#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  out.push("  宿主版本      " + (state.dsh_version || "unknown") + "  目标版本 " + (state.dsh_target || "?") + (state.version_compatible === false ? "  ⚠ 主版本漂移" : ""));
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  out.push(`  诊断: 漂移 ${state.patches_drifted || 0}, 半完成 ${state.patches_partial || 0}, 重复叠层 ${state.patches_duplicate || 0}, 歧义 ${state.patches_ambiguous || 0}`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : s === "drifted" ? "≈" : s === "partial" ? "◐" : s === "duplicate" ? "⧉" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function printVerify(result) {
  const out = [];
  out.push("dsh-purge 诊断 / Verify（只读，不写盘）");
  if (result.aiBase) out.push("  插件根 / root  " + result.aiBase);
  if (result.version) {
    out.push(`  宿主版本 ${result.version.installed || "unknown"}  目标 ${result.version.target || "?"}`);
    out.push("  " + (result.version.reason || ""));
  }
  out.push("");
  const s = result.summary || {};
  out.push(`  clean ${s.clean || 0} | pending ${s.pending || 0} | partial ${s.partial || 0} | duplicate ${s.duplicate || 0} | drifted ${s.drifted || 0} | missing ${s.missing_file || 0} | na ${s.na || 0}`);
  out.push("");
  const actionable = (result.records || []).filter((r) => ["partial", "duplicate", "drifted"].includes(r.state));
  if (actionable.length === 0) {
    out.push("  ✓ 没有半完成、重复叠层或版本漂移。");
  } else {
    out.push("  需要处理:");
    for (const r of actionable) {
      out.push(`    [#${r.id}] ${r.name} — ${r.state}${r.note ? "（" + r.note + "）" : ""}`);
      for (const f of r.files || []) {
        if (!f || !f.state) continue;
        if (f.state === "clean") continue;
        out.push(`        ${f.state.padEnd(11)} ${f.path}${f.note ? "  — " + f.note : ""}`);
      }
    }
  }
  return out.join("\n");
}

function printExplain(info) {
  if (!info.ok) {
    console.log("  " + info.error);
    return;
  }
  const out = [];
  out.push(`dsh-purge 解释 / Explain #${info.patch.id} ${info.patch.name}`);
  out.push(`  ${info.patch.desc || ""}`);
  if (info.version) out.push(`  宿主 ${info.version.installed || "unknown"} / 目标 ${info.version.target || "?"}`);
  for (const file of info.files) {
    out.push("");
    out.push(`  ${file.state.padEnd(11)} ${file.path}`);
    if (file.note) out.push(`      ${file.note}`);
    for (const rep of file.replacements || []) {
      const hit = rep.found ? `命中 ${rep.strategy} (${rep.confidence})` : `未命中${rep.ambiguous ? "（歧义）" : ""}`;
      out.push(`      #${rep.index} ${hit}  ${rep.head}`);
      if (rep.drift && !rep.found) {
        const pct = Math.round((rep.drift.coverage || 0) * 100);
        out.push(`          漂移线索: 关键标识符覆盖 ${pct}%（不代表整段相同）  锚点 ${rep.drift.anchor || "-"}`);
        for (const c of (rep.drift.candidates || []).slice(0, 2)) {
          out.push(`            行 ${c.line}: ${c.lineText}`);
        }
      }
    }
  }
  console.log(out.join("\n"));
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--verify", "--explain", "--help"].includes(a));
  const json = args.includes("--json");

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态（含版本与漂移计数）
  dsh-purge --verify     只读诊断：clean/pending/partial/duplicate/drifted
  dsh-purge --explain <id>  解释某条补丁：每个文件的命中策略与漂移线索
  dsh-purge --apply      应用全部清洗（事务化：先校验语法，全通过才写盘）
  dsh-purge --revert     回滚还原
  dsh-purge --uninstall  卸载插件（已应用则先还原）
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge --json       与 --status/--verify 连用，输出 JSON
  dsh-purge --help       帮助`);
    return;
  }

  if (mode === "--explain") {
    const index = args.indexOf("--explain");
    const id = args[index + 1];
    if (!id) {
      console.log("用法: dsh-purge --explain <patch-id>");
      process.exit(2);
    }
    const state = await core.gatherState();
    const info = await core.explainPatch(state.ai_base, id);
    if (json) console.log(JSON.stringify(info, null, 2));
    else printExplain(info);
    return;
  }

  if (mode === "--verify") {
    const state = await core.gatherState();
    const result = await core.verifyPatches(state.ai_base);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(printVerify(result));
    const actionable = (result.records || []).filter((r) => ["partial", "duplicate", "drifted"].includes(r.state));
    if (actionable.length > 0) process.exitCode = 2;
    return;
  }

  const state = await core.gatherState();
  if (json && mode === "--status") {
    console.log(JSON.stringify({
      surface: state.surface,
      dsh_home: state.dsh_home,
      ai_base: state.ai_base,
      dsh_version: state.dsh_version,
      dsh_target: state.dsh_target,
      version_compatible: state.version_compatible,
      patch_status: state.patch_status,
      counts: {
        applied: state.patches_applied,
        pending: state.patches_pending,
        drifted: state.patches_drifted,
        partial: state.patches_partial,
        duplicate: state.patches_duplicate,
        ambiguous: state.patches_ambiguous,
      },
    }, null, 2));
    return;
  }
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : r.status === "drifted" ? "≈ 版本漂移（跳过）" : r.status === "partial" ? "◐ 半完成（需重应用）" : r.status === "duplicate" ? "⧉ 重复叠层" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}${Array.isArray(r.strategies) && r.strategies.length ? "  [" + r.strategies.join(",") + "]" : ""}`);
    }
    for (const h of hosts) {
      if (h.validation) {
        console.log(`  事务校验 / transaction: checked=${h.validation.checked} written=${h.validation.written ?? 0} aborted=${h.validation.aborted}`);
        for (const e of h.validation.errors || []) console.log(`  ✗ 语法校验失败 ${e.path}: ${String(e.error).split("\n")[0]}`);
      }
    }
    const aborted = hosts.some((h) => h.validation && h.validation.aborted);
    if (aborted) {
      console.log("");
      console.log("[ABORTED] 有补丁改出了语法错误，已整体放弃本次应用，磁盘未改动。用 --verify / --explain 定位具体补丁。");
      process.exit(1);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect。");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。先用 --verify 看漂移与半完成状态。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
