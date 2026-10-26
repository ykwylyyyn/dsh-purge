import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatternToText,
  describeDrift,
  locatePattern,
  normalizeLf,
} from '../lib/patch-match.js';

const ORIGINAL =
  'function f(x) {\n' +
  '\tif (x === "a") return 1;\n' +
  '\treturn 0;\n' +
  '}\n';

test('literal：逐字命中，策略为 literal，count 正确', () => {
  const loc = locatePattern(ORIGINAL, 'if (x === "a") return 1;');
  assert.equal(loc.ok, true);
  assert.equal(loc.strategy, 'literal');
  assert.equal(loc.confidence, 1);
  assert.equal(loc.count, 1);
});

test('flex-ws：缩进改成空格、tab 消失后仍能定位', () => {
  const reformatted = ORIGINAL.replace(/\t/g, '    ').replace('function f(x) {\n', 'function f(x) {\n\n      ');
  const loc = locatePattern(reformatted, 'function f(x) {\n\tif (x === "a") return 1;');
  assert.equal(loc.ok, true);
  assert.equal(loc.strategy, 'flex-ws');
  assert.ok(loc.confidence >= 0.9);
});

test('flex-quote：双引号换成单引号仍能定位', () => {
  const single = ORIGINAL.replace('"a"', "'a'");
  const loc = locatePattern(single, 'if (x === "a") return 1;');
  assert.equal(loc.ok, true);
  assert.equal(loc.strategy, 'flex-quote');
});

test('ambiguous：同一段出现两次时拒绝自动写入', () => {
  const duplicated = ORIGINAL + '\n' + ORIGINAL.replace('function f', 'function g');
  const loc = locatePattern(duplicated, 'return 0;');
  // 逐字命中仍按旧语义（全部替换），不算歧义
  assert.equal(loc.strategy, 'literal');
  assert.equal(loc.count, 2);
  // 归一后才命中的两处（缩进改了，原文不再逐字命中）必须判歧义
  const flexible = duplicated.replace(/\t/g, '  ');
  const flexLoc = locatePattern(flexible, '\tif (x === "a") return 1;');
  assert.equal(flexLoc.ok, false);
  assert.equal(flexLoc.ambiguous, true);
});

test('token：空白被压掉后仍能给出近似定位（仅诊断用）', () => {
  const mangled = 'function f(x) {\n\tif(x==="a") return 1;\n\treturn 0;\n}\n';
  const loc = locatePattern(mangled, 'if (x === "a") return 1;');
  // 空白归一要求「原文有空白」，被压掉后定位不到
  assert.equal(loc.ok, false);
  const tokenLoc = locatePattern(mangled, 'if (x === "a") return 1;', { tokens: true });
  assert.equal(tokenLoc.ok, true);
  assert.equal(tokenLoc.strategy, 'token');
});

test('applyPatternToText：literal 保留旧的全替换语义', () => {
  const text = 'a = 1;\na = 1;\n';
  const out = applyPatternToText(text, 'a = 1;', 'a = 2;');
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.text, 'a = 2;\na = 2;\n');
});

test('applyPatternToText：flex 只替换唯一命中，不碰其它内容', () => {
  const text = 'function f() {\n    return 42;\n}\nfunction g() {\n    return 43;\n}\n';
  const out = applyPatternToText(text, 'function f() {\n\treturn 42;', 'function f() {\n\treturn 99;');
  assert.equal(out.ok, true);
  assert.equal(out.strategy, 'flex-ws');
  assert.match(out.text, /return 99;/);
  assert.match(out.text, /return 43;/);
});

test('normalizeLf：CRLF 统一成 LF', () => {
  assert.equal(normalizeLf('a\r\nb\r\n'), 'a\nb\n');
});

test('describeDrift：给出还存在的锚点与行号', () => {
  const changed = ORIGINAL.replace('if (x === "a")', 'if (x !== "a")');
  const drift = describeDrift(changed, 'if (x === "a") return 1;');
  assert.equal(drift.found, true);
  assert.ok(drift.foundTokens.includes('return'));
  assert.ok(drift.line >= 1);
  assert.ok(drift.missingTokens.includes('if') === false);
});
