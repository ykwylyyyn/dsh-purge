/**
 * 事务化写入层（v2）。
 *
 * 旧引擎「边算边写」：补丁 A~M 已经写盘、补丁 N 写入失败或产生语法错误时，
 * 磁盘上就留下**半完成状态**，而调用方往往已经在重启宿主。
 *
 * 这里把写盘拆成两段：
 *   1. stage  —— 所有改动先在内存里攒着，不碰磁盘；
 *   2. validate —— 对每个待写的 JS/ESM 文件做 `node --check` 语法校验；
 *   3. commit —— 全部通过才逐文件原子写入；任一失败则整体放弃。
 *
 * 只依赖 node 内置模块，校验器/写盘函数都可注入，便于单测。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts']);

export function isJsPath(fp) {
  return JS_EXTS.has(String(extname(String(fp ?? ''))).toLowerCase());
}

/**
 * 用 `node --check` 校验一段源码。源码写成 .mjs 临时文件，
 * 避免被目标目录的 package.json（type: commonjs）影响解析模式。
 * @returns {{ok:boolean, error?:string}}
 */
export function syntaxCheck(source, options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purge-check-'));
  const file = join(dir, 'staged.mjs');
  try {
    writeFileSync(file, source, 'utf8');
    const result = spawnSync(nodePath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (result.error) return { ok: false, error: String(result.error.message || result.error) };
    if (result.status === 0) return { ok: true };
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(0, 6).join('\n');
    return { ok: false, error: detail || `exit ${String(result.status)}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 校验一批待写文件。非 JS 文件（yml/json/md/…)跳过语法校验，只登记 skipped。
 * @param {Array<{path:string, text:string}>} writes
 * @returns {{ok:boolean, errors:Array<{path:string,error:string}>, checked:number, skipped:number}}
 */
export function validateStagedSources(writes, options = {}) {
  const errors = [];
  let checked = 0;
  let skipped = 0;
  for (const write of writes || []) {
    if (!write || typeof write.path !== 'string' || typeof write.text !== 'string') {
      skipped += 1;
      continue;
    }
    if (!isJsPath(write.path)) {
      skipped += 1;
      continue;
    }
    checked += 1;
    const result = syntaxCheck(write.text, options);
    if (!result.ok) errors.push({ path: write.path, error: result.error });
  }
  return { ok: errors.length === 0, errors, checked, skipped };
}

/**
 * 逐文件提交（调用方注入原子写函数，通常是 core.js 的 saveText）。
 * 单文件失败不中断其余写入，但会把失败路径返回，交由调用方决定是否回滚。
 * @param {Array<{path:string, text:string}>} writes
 * @param {{write: (path:string, text:string) => Promise<boolean>|boolean}} io
 */
export async function commitStagedWrites(writes, io) {
  const written = [];
  const errors = [];
  const write = io?.write;
  if (typeof write !== 'function') throw new Error('commitStagedWrites: io.write 必须是函数');
  for (const item of writes || []) {
    try {
      const changed = await write(item.path, item.text);
      if (changed !== false) written.push(item.path);
    } catch (error) {
      errors.push({ path: item.path, error: String(error?.message || error) });
    }
  }
  return { written, errors };
}
