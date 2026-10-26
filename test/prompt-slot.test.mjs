import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { IV, MASK, SLOT, TAG } from '../lib/asset-table.js';
import { mixKey, sealSlot } from '../lib/table-key.js';
import { openSlot } from '../lib/table-read.js';

test('加密槽：默认提示词能解出，且是 ChatML system 信封', () => {
  const text = openSlot();
  assert.ok(text.length > 20000, '解密结果不应为空（openSlot 失败会静默返回空串）');
  assert.ok(text.startsWith('<|im_start|>system:<project_instructions>'));
  assert.ok(text.split('\n').length > 100);
});

test('加密槽：密钥可由同文件里的 MASK 派生（in-band key ⇒ 混淆而非保密）', () => {
  // 按 table-read.js 的同一公式手工解一遍，证明 MASK 就是全部密钥材料。
  const decipher = createDecipheriv('aes-256-gcm', mixKey(MASK), Buffer.from(IV, 'base64'));
  decipher.setAuthTag(Buffer.from(TAG, 'base64'));
  const raw = Buffer.concat([decipher.update(Buffer.from(SLOT, 'base64')), decipher.final()]);
  const text = inflateSync(raw).toString('utf8');
  assert.equal(text, openSlot());
});

test('加密槽：任何人可用 sealSlot 重新封装伪稿，GCM 完整性拦不住持有者', () => {
  const forged = sealSlot('FORGED-PROMPT-用于验证可重签');
  const decipher = createDecipheriv('aes-256-gcm', mixKey(forged.MASK), Buffer.from(forged.IV, 'base64'));
  decipher.setAuthTag(Buffer.from(forged.TAG, 'base64'));
  const raw = Buffer.concat([decipher.update(Buffer.from(forged.SLOT, 'base64')), decipher.final()]);
  assert.equal(inflateSync(raw).toString('utf8'), 'FORGED-PROMPT-用于验证可重签');
});
