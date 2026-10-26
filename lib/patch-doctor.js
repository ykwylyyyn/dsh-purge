/**
 * 补丁诊断层（v2）：版本漂移 + 半完成状态检测。
 *
 * 旧 `patchStatus` 只有 applied / pending / skipped 三档，用户看到一片
 * skipped 也分不清是「版本不对」「只打了一半」还是「本来就该跳过」。
 *
 * 这里按文件给出可执行的判定：
 *
 *   clean       marker 在，且所有 pattern 都已不在（正常完成）
 *   duplicate   marker 出现 >1 次（重复叠加，旧版 skipIfMarked 失效的遗留）
 *   partial     marker 在，但仍有 pattern 命中（多半只打了一部分）
 *   pending     没有 marker，但按匹配链能定位到原文（可直接应用）
 *   drifted     没有 marker，逐字/归一都定位不到（版本漂移，需要更新补丁）
 *   missing_file 目标文件不在（这套布局没有这个包）
 *
 * `pending` 与 `drifted` 的区别就是「能不能自动修」：前者点应用即可，
 * 后者必须改补丁定义。token 级命中只用于给 drifted 补一条「接近哪一行」的线索。
 */
import { locatePattern, countOccurrences, normalizeLf } from './patch-match.js';

export const PATCH_STATES = Object.freeze([
  'clean', 'pending', 'partial', 'duplicate', 'drifted', 'missing_file', 'na',
]);

/** 状态严重度（聚合多个文件时取最严重）。 */
const SEVERITY = Object.freeze({
  clean: 0, missing_file: 1, pending: 2, drifted: 3, partial: 4, duplicate: 5, na: -1,
});

export function worseState(a, b) {
  const sa = SEVERITY[a] ?? -1;
  const sb = SEVERITY[b] ?? -1;
  return sb > sa ? b : a;
}

/** 取一条补丁的 pattern / replacement 列表（与旧引擎同构）。 */
export function replacementsOf(patch) {
  if (Array.isArray(patch?.replacements)) return patch.replacements;
  return (patch?.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
}

/** 取标记列表。 */
export function markersOf(patch) {
  if (Array.isArray(patch?.markers) && patch.markers.length > 0) return patch.markers;
  if (patch?.marker) return [patch.marker];
  return [];
}

function countMarker(text, marker) {
  return countOccurrences(normalizeLf(text), normalizeLf(marker));
}

function hasMarkers(text, patch) {
  const markers = markersOf(patch);
  if (markers.length === 0) return false;
  const counts = markers.map((m) => countMarker(text, m));
  return patch?.markersAny ? counts.some((c) => c > 0) : counts.every((c) => c > 0);
}

function markerDuplicated(text, patch) {
  const markers = markersOf(patch);
  if (markers.length === 0) return false;
  const counts = markers.map((m) => countMarker(text, m));
  return patch?.markersAny ? counts.some((c) => c > 1) : counts.some((c) => c > 1);
}

/** 逐字/空白归一层面是否还有待做的事。 */
function remainingWork(text, patch) {
  for (const { pattern } of replacementsOf(patch)) {
    if (!pattern) continue;
    const loc = locatePattern(text, pattern, { quotes: true, tokens: false });
    if (loc.ok || loc.ambiguous) return { remaining: true, strategy: loc.strategy };
  }
  return { remaining: false, strategy: 'none' };
}

/** 只在诊断里用：找一段原文的「漂移线索」。 */
function driftClue(text, patch) {
  for (const { pattern } of replacementsOf(patch)) {
    if (!pattern) continue;
    const loc = locatePattern(text, pattern, { quotes: true, tokens: true });
    if (loc.ok || loc.ambiguous) {
      if (loc.strategy === 'token') return { hint: 'token-only', strategy: loc.strategy, line: null };
      return { hint: 'locatable', strategy: loc.strategy, line: null };
    }
  }
  return { hint: 'not-found', strategy: 'none', line: null };
}

/**
 * 单文件判定。
 * @param {string} text 文件全文
 * @param {object} patch 补丁定义
 * @param {string} [fp] 文件路径（仅用于报告）
 */
export function inspectFile(text, patch, fp = '') {
  const markers = hasMarkers(text, patch);
  if (markerDuplicated(text, patch)) {
    return { path: fp, state: 'duplicate', marker: true, remaining: false, note: 'marker 出现多次（重复叠加）' };
  }
  const work = remainingWork(text, patch);
  if (markers) {
    if (work.remaining) {
      return { path: fp, state: 'partial', marker: true, remaining: true, strategy: work.strategy, note: 'marker 在但仍有原文命中' };
    }
    return { path: fp, state: 'clean', marker: true, remaining: false, note: '已完成' };
  }
  if (work.remaining) {
    return { path: fp, state: 'pending', marker: false, remaining: true, strategy: work.strategy, note: '可定位，未应用' };
  }
  const clue = driftClue(text, patch);
  return { path: fp, state: 'drifted', marker: false, remaining: false, ...clue, note: clue.hint === 'token-only' ? '原文已变化（token 级接近）' : '原文找不到（版本漂移）' };
}

/**
 * 一组补丁的整体诊断。
 * @param {object} input
 * @param {Array} input.patches 补丁定义
 * @param {(patch:object)=>string[]|Promise<string[]>} input.resolvePaths 取该补丁的目标文件
 * @param {(path:string)=>string|Promise<string>} input.readText 读文件（不存在返回 null/抛错）
 * @param {{installed?:string, target?:string, compatible?:boolean}} [input.version] 版本信息
 * @param {(patch:object)=>boolean} [input.appliesHere] 该补丁是否适用当前宿主面
 */
export async function verifyPatchSet(input) {
  const patches = input?.patches ?? [];
  const resolvePaths = input?.resolvePaths ?? (() => []);
  const readText = input?.readText ?? (() => null);
  const appliesHere = input?.appliesHere ?? (() => true);
  const version = input?.version ?? null;

  const records = [];
  const summary = {
    clean: 0, pending: 0, partial: 0, duplicate: 0, drifted: 0, missing_file: 0, na: 0, total: 0,
  };

  for (const patch of patches) {
    const base = {
      id: patch?.id,
      name: patch?.name,
      layer: patch?.layer ?? '',
      desc: patch?.desc ?? '',
    };
    if (!appliesHere(patch)) {
      records.push({ ...base, state: 'na', files: [], note: '本宿主面不适用' });
      summary.na += 1;
      continue;
    }
    let paths = [];
    try {
      paths = (await resolvePaths(patch)) || [];
    } catch {
      paths = [];
    }
    if (paths.length === 0) {
      records.push({ ...base, state: 'missing_file', files: [], note: '目标文件不在本布局' });
      summary.missing_file += 1;
      continue;
    }

    const files = [];
    let state = 'clean';
    for (const fp of paths) {
      let text = null;
      try {
        text = await readText(fp);
      } catch {
        text = null;
      }
      if (typeof text !== 'string') {
        files.push({ path: fp, state: 'missing_file', note: '读不到文件' });
        state = worseState(state, 'missing_file');
        continue;
      }
      const file = inspectFile(text, patch, fp);
      files.push(file);
      state = worseState(state, file.state);
    }
    if (summary[state] !== undefined) summary[state] += 1;
    records.push({ ...base, state, files, version });
    summary.total += 1;
  }

  return {
    version,
    records,
    summary,
    ok: records.every((r) => ['clean', 'pending', 'na', 'missing_file'].includes(r.state)),
  };
}

/** 汇总里真正需要人处理的状态。 */
export const ACTIONABLE_STATES = Object.freeze(['partial', 'duplicate', 'drifted']);

export function actionableRecords(result) {
  return (result?.records ?? []).filter((r) => ACTIONABLE_STATES.includes(r.state));
}
