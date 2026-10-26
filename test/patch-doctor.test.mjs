import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile, verifyPatchSet, actionableRecords } from '../lib/patch-doctor.js';

const PATCH = {
  id: 900,
  name: 'DEMO',
  layer: '代码',
  markers: ['[demo] patched'],
  replacements: [{ pattern: 'const A = 1;', replace: 'const A = 2;' }],
};

test('clean：marker 在、原文已消失', () => {
  const file = inspectFile('const A = 2;\n// [demo] patched\n', PATCH, 'x.js');
  assert.equal(file.state, 'clean');
});

test('partial：marker 在、原文还在（打了一半）', () => {
  const file = inspectFile('const A = 1;\n// [demo] patched\n', PATCH, 'x.js');
  assert.equal(file.state, 'partial');
});

test('duplicate：marker 出现多次', () => {
  const file = inspectFile('// [demo] patched\n// [demo] patched\n', PATCH, 'x.js');
  assert.equal(file.state, 'duplicate');
});

test('pending：没有 marker，但原文可定位', () => {
  const file = inspectFile('const A = 1;\n', PATCH, 'x.js');
  assert.equal(file.state, 'pending');
});

test('drifted：既没有 marker，原文也被改掉了', () => {
  const file = inspectFile('const A = 42;\n', PATCH, 'x.js');
  assert.equal(file.state, 'drifted');
});

test('verifyPatchSet：汇总、状态聚合与 actionable 过滤', async () => {
  const texts = new Map([
    ['a.js', 'const A = 2;\n// [demo] patched\n'],
    ['b.js', 'const A = 1;\n// [demo] patched\n'],
    ['c.js', '// [demo] patched\n// [demo] patched\n'],
    ['d.js', 'const A = 1;\n'],
    ['e.js', 'const A = 0;\n'],
  ]);
  const patches = [
    { ...PATCH, id: 1, name: 'CLEAN' },
    { ...PATCH, id: 2, name: 'PARTIAL' },
    { ...PATCH, id: 3, name: 'DUPLICATE' },
    { ...PATCH, id: 4, name: 'PENDING' },
    { ...PATCH, id: 5, name: 'DRIFTED' },
    { ...PATCH, id: 6, name: 'MISSING' },
    { ...PATCH, id: 7, name: 'NA', surfaces: ['desktop'] },
  ];
  const mapping = { 1: ['a.js'], 2: ['b.js'], 3: ['c.js'], 4: ['d.js'], 5: ['e.js'], 6: ['nope.js'] };
  const result = await verifyPatchSet({
    patches,
    resolvePaths: (p) => mapping[p.id] ?? [],
    readText: (fp) => {
      const text = texts.get(fp);
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    appliesHere: (p) => p.id !== 7,
    version: { installed: '0.2.1-rc.3', target: '0.2.1-rc.2', compatible: true },
  });

  const byName = Object.fromEntries(result.records.map((r) => [r.name, r.state]));
  assert.equal(byName.CLEAN, 'clean');
  assert.equal(byName.PARTIAL, 'partial');
  assert.equal(byName.DUPLICATE, 'duplicate');
  assert.equal(byName.PENDING, 'pending');
  assert.equal(byName.DRIFTED, 'drifted');
  assert.equal(byName.MISSING, 'missing_file');
  assert.equal(byName.NA, 'na');
  assert.equal(result.summary.partial, 1);
  assert.equal(result.summary.duplicate, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(actionableRecords(result).map((r) => r.name).sort(), ['DUPLICATE', 'DRIFTED', 'PARTIAL'].sort());
});
