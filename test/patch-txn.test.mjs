import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitStagedWrites, isJsPath, syntaxCheck, validateStagedSources } from '../lib/patch-txn.js';

test('syntaxCheck：合法 ESM 通过，非法源码报错', () => {
  assert.equal(syntaxCheck('export const a = 1;\n').ok, true);
  const bad = syntaxCheck('export const a = ;\n');
  assert.equal(bad.ok, false);
  assert.ok(bad.error && bad.error.length > 0);
});

test('isJsPath：只把 JS/TS 当语法可校验对象', () => {
  assert.equal(isJsPath('a/b/index.js'), true);
  assert.equal(isJsPath('a/b/index.mjs'), true);
  assert.equal(isJsPath('a/b/cordis.patch.yml'), false);
  assert.equal(isJsPath('a/b/README.md'), false);
});

test('validateStagedSources：逐个校验、非 JS 跳过、聚合错误', () => {
  const result = validateStagedSources([
    { path: 'ok.js', text: 'export const a = 1;\n' },
    { path: 'bad.js', text: 'export const a = ;\n' },
    { path: 'config.yml', text: 'key: value\n' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'bad.js');
});

test('commitStagedWrites：写入成功与单文件失败都返回', async () => {
  const written = [];
  const result = await commitStagedWrites(
    [
      { path: 'a.js', text: 'A' },
      { path: 'b.js', text: 'B' },
    ],
    {
      write: (fp, text) => {
        if (fp === 'b.js') throw new Error('EBUSY');
        written.push([fp, text]);
        return true;
      },
    },
  );
  assert.deepEqual(written, [['a.js', 'A']]);
  assert.equal(result.written.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'b.js');
});
