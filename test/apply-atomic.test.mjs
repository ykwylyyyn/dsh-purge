import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatches, verifyPatches } from '../lib/core.js';

const SOURCE = 'const FLAG = 1;\nexport { FLAG };\n';

function fixture(source = SOURCE) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-purge-apply-'));
  const dir = join(root, 'dsh-agent-instructions', 'lib');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.js');
  writeFileSync(file, source, 'utf8');
  process.env.DSH_HOME = join(root, 'home');
  return { root, aiBase: root, file };
}

function patchWith(replace, markers = ['[test] ok']) {
  return {
    id: 999,
    name: 'TEST_FLAG',
    layer: '代码',
    file: 'agent-instructions',
    rel: ['lib', 'index.js'],
    markers,
    replacements: [{ pattern: 'const FLAG = 1;', replace }],
  };
}

test('事务化应用：语法正确的改动会写盘并报 applied', async () => {
  const fx = fixture();
  const report = await applyPatches(fx.aiBase, [patchWith('const FLAG = 2; // [test] ok')]);
  assert.equal(report[0].status, 'applied');
  assert.equal(report.validation.aborted, false);
  assert.ok(report.validation.written >= 1);
  assert.match(readFileSync(fx.file, 'utf8'), /const FLAG = 2;/);
});

test('事务化应用：改出语法错误时整体放弃，磁盘保持原样', async () => {
  const fx = fixture();
  const before = readFileSync(fx.file, 'utf8');
  const report = await applyPatches(fx.aiBase, [patchWith('const FLAG = ;')]);
  assert.equal(report[0].status, 'aborted_validation');
  assert.equal(report.validation.aborted, true);
  assert.ok(report.validation.errors.length >= 1);
  assert.equal(readFileSync(fx.file, 'utf8'), before, '校验失败不能落盘半个补丁');
});

test('非事务模式（atomic:false）仍按旧行为直接写', async () => {
  const fx = fixture();
  const report = await applyPatches(fx.aiBase, [patchWith('const FLAG = 3; // [test] ok')], { atomic: false });
  assert.equal(report[0].status, 'applied');
  assert.match(readFileSync(fx.file, 'utf8'), /const FLAG = 3;/);
});

test('幂等：第二次应用不重复改，也不产生重复 marker', async () => {
  const fx = fixture();
  await applyPatches(fx.aiBase, [patchWith('const FLAG = 2; // [test] ok')]);
  const once = readFileSync(fx.file, 'utf8');
  const report = await applyPatches(fx.aiBase, [patchWith('const FLAG = 2; // [test] ok')]);
  const twice = readFileSync(fx.file, 'utf8');
  assert.equal(twice, once);
  assert.equal(report[0].status, 'already');
  assert.equal((twice.match(/\[test\] ok/g) || []).length, 1);
});

test('归一化匹配：官方文件被重新缩进后仍能应用', async () => {
  const fx = fixture('function f() {\n    const FLAG = 1;\n    return FLAG;\n}\nexport { f };\n');
  const patch = {
    id: 998,
    name: 'TEST_REFORMAT',
    layer: '代码',
    file: 'agent-instructions',
    rel: ['lib', 'index.js'],
    markers: ['[test] reformat'],
    replacements: [{ pattern: 'function f() {\n\tconst FLAG = 1;', replace: 'function f() {\n\tconst FLAG = 2; // [test] reformat' }],
  };
  const report = await applyPatches(fx.aiBase, [patch]);
  assert.equal(report[0].status, 'applied');
  assert.deepEqual(report[0].strategies, ['flex-ws']);
  assert.match(readFileSync(fx.file, 'utf8'), /FLAG = 2/);
});

test('verifyPatches：只读诊断能区分 pending 与 drifted', async () => {
  const fxPending = fixture();
  const pendingResult = await verifyPatches(fxPending.aiBase, [patchWith('const FLAG = 2; // [test] ok')]);
  assert.equal(pendingResult.records[0].state, 'pending');

  const fxDrifted = fixture('const FLAG = 1;\nexport { FLAG };\n');
  const driftedResult = await verifyPatches(fxDrifted.aiBase, [
    {
      id: 997,
      name: 'TEST_GONE',
      layer: '代码',
      file: 'agent-instructions',
      rel: ['lib', 'index.js'],
      markers: ['[test] gone'],
      replacements: [{ pattern: 'const UNRELATED = 42;', replace: 'const UNRELATED = 43; // [test] gone' }],
    },
  ]);
  assert.equal(driftedResult.records[0].state, 'drifted');
});
