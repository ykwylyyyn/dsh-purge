#!/usr/bin/env node
/**
 * 解密并体检内置提示词「加密槽」。
 *
 * 加密方案（见 lib/table-key.js）：
 *   key   = sha256("cordis.slot.v2" \x1e "dsh-purge" \x1e "surface:web|desktop" \x1e "ov.table.1" \x1e MASK)
 *   body  = AES-256-GCM(deflate(prompt, level 9), key, IV)
 *   制品  = lib/asset-table.js：SLOT(base64 密文，96 字符一行) + MASK + TAG + IV
 *
 * 结论先说：MASK 就明文躺在同一个文件里，密钥可由它派生 —— 这是**混淆**，不是保密。
 * 本脚本把事实固定下来：算法、指纹、结构、以及和仓库里 md 源文件是否一致。
 *
 * 用法：
 *   node scripts/decrypt-prompt-slot.mjs                     # 摘要 + 结构提纲
 *   node scripts/decrypt-prompt-slot.mjs --json              # 机器可读
 *   node scripts/decrypt-prompt-slot.mjs --hash              # 只打指纹
 *   node scripts/decrypt-prompt-slot.mjs --out prompt.md     # 写出明文（默认提示词全文）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IV, MASK, SLOT, TAG } from '../lib/asset-table.js';
import { mixKey } from '../lib/table-key.js';
import { openSlot } from '../lib/table-read.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const text = openSlot();
const envelopeOk = text.startsWith('<|im_start|>system:<project_instructions>');
const lines = text.split('\n');

/** 抽出给人看的结构提纲：═ 分隔的标题、全大写小节名、[MODE ...] 标记。 */
function outline() {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^═+$/.test(line)) {
      const title = (lines[i + 1] || '').trim();
      const plausible = title && !/^═+$/.test(title) && !/^[-*]/.test(title) && title.length <= 60;
      if (plausible) out.push({ line: i + 1, kind: 'section', title });
      i += 1;
      continue;
    }
    if (/^\[[A-Z][^\]]*\]$/.test(line)) {
      out.push({ line: i + 1, kind: 'marker', title: line });
      continue;
    }
    if (/^[A-Z][A-Z0-9 /_|+-]{6,}:$/.test(line)) {
      out.push({ line: i + 1, kind: 'rule-group', title: line });
    }
  }
  return out;
}

/** 和仓库里现存的 md 源做比较，判断槽是不是由发布版源文件生成的。 */
function sourceComparison() {
  const candidates = [
    'lib/default-prompt-inject.zh.md',
    'lib/default-prompt-inject.en.md',
    'lib/default-prompt-inject.md.bak',
    'lib/default-prompt-inject.md',
  ];
  return candidates.map((rel) => {
    const fp = join(ROOT, rel);
    if (!existsSync(fp)) return { path: rel, present: false };
    const source = readFileSync(fp, 'utf8');
    return {
      path: rel,
      present: true,
      bytes: Buffer.byteLength(source, 'utf8'),
      sha256: sha256(source),
      exactMatch: source === text,
      sameSize: Buffer.byteLength(source, 'utf8') === Buffer.byteLength(text, 'utf8'),
    };
  });
}

const report = {
  scheme: 'AES-256-GCM + deflate(9) + base64；key = sha256(MIX 各段以 0x1e 拼接后再接 MASK)',
  keyDerivation: {
    mix: ['cordis.slot.v2', 'dsh-purge', 'surface:web|desktop', 'ov.table.1'],
    maskInBand: true,
    keyFingerprint: sha256(mixKey(MASK)).slice(0, 16),
  },
  sealed: {
    slotBase64Length: SLOT.length,
    mask: MASK,
    iv: IV,
    tag: TAG,
    slotSha256: sha256(SLOT),
  },
  plaintext: {
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
    sha256: sha256(text),
    envelopeOk,
    firstLine: lines[0] ?? '',
  },
  outline: outline(),
  sources: sourceComparison(),
};

if (has('--hash') || has('--json')) {
  if (has('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(report.plaintext.sha256);
  process.exit(0);
}

const out = valueOf('--out');
if (out) {
  const target = resolve(out);
  writeFileSync(target, text, 'utf8');
  console.log(`已写出明文（${report.plaintext.bytes} 字节）→ ${target}`);
  console.log('注意：这是插件内置默认提示词全文，属于该项目的"破甲"身份稿，请只在本地分析使用。');
  process.exit(0);
}

console.log('dsh-purge 提示词加密槽 / prompt slot');
console.log('');
console.log('  方案          ' + report.scheme);
console.log('  密钥派生      sha256("cordis.slot.v2" \\x1e "dsh-purge" \\x1e "surface:web|desktop" \\x1e "ov.table.1" \\x1e MASK)');
console.log('  密钥材料      MASK 与密文同文件（in-band）→ 只能算混淆，不构成保密');
console.log('  key 指纹      ' + report.keyDerivation.keyFingerprint + '（sha256(key) 前 16 位）');
console.log('');
console.log('  密文 SLOT     ' + report.sealed.slotBase64Length + ' 字符 base64（96 字符/行，' + Math.ceil(report.sealed.slotBase64Length / 96) + ' 行）');
console.log('  MASK          ' + report.sealed.mask);
console.log('  IV            ' + report.sealed.iv);
console.log('  TAG           ' + report.sealed.tag);
console.log('');
console.log('  明文          ' + report.plaintext.bytes + ' 字节 / ' + report.plaintext.lines + ' 行');
console.log('  sha256        ' + report.plaintext.sha256);
console.log('  ChatML 信封   ' + (envelopeOk ? '✓ 以 <|im_start|>system:<project_instructions> 开头' : '✗ 未识别'));
console.log('');
console.log('  结构提纲:');
for (const item of report.outline) console.log(`    L${String(item.line).padStart(3)}  [${item.kind}]  ${item.title.slice(0, 90)}`);
console.log('');
console.log('  与仓库 md 源对比:');
for (const source of report.sources) {
  if (!source.present) console.log(`    ${source.path.padEnd(38)} 不存在`);
  else console.log(`    ${source.path.padEnd(38)} ${String(source.bytes).padStart(6)} 字节  sha=${source.sha256.slice(0, 16)}${source.exactMatch ? '  ← 与槽完全一致' : ''}`);
}
const anyExact = report.sources.some((s) => s.exactMatch);
console.log('');
console.log(anyExact
  ? '  槽与某个仓库源文件一致，构建可复现。'
  : '  槽与仓库里现存的 md 都不一致：asset-table.js 由未随仓库发布的 lib/default-prompt-inject.md 生成（该文件被 npm files 排除，仓库里只剩 .bak），构建不可复现。');
