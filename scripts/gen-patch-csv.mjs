import { ALL_PATCHES } from '../lib/core.js';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node gen-patch-csv.mjs <out.csv>');

// 按能力分组（人工归类，覆盖全部 82 条）
const GROUPS = [
  ['审批与提权', [5, 8, 9, 10, 11, 12, 13, 14, 34, 35, 36, 51, 59, 60, 61, 62]],
  ['沙箱与文件围栏', [6, 7, 15, 16, 17, 33]],
  ['hooks / 外部代理', [30, 31, 64, 65]],
  ['人格 / 身份 / 提示词框架', [1, 2, 3, 4, 25, 26, 28, 29, 32, 37, 38, 40, 43, 47, 48, 49, 50, 53, 54, 63, 70, 71, 73, 76]],
  ['工具 / 上下文 / 能力开关', [18, 19, 21, 22, 23, 24, 80]],
  ['装配 / 会话 / 运行时兼容', [39, 42, 45, 46, 52, 55, 56, 57, 58, 66, 67, 68, 69, 72, 74, 75, 77, 78, 82, 83, 84, 85, 86, 87, 88]],
];
const GROUP_OF = new Map();
for (const [label, ids] of GROUPS) for (const id of ids) GROUP_OF.set(id, label);

const clip = (v, n = 160) =>
  String(v ?? '')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, ' ')
    .slice(0, n);

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const header = [
  'id', '能力分组', 'name', '层', '目标包', '目标文件', '说明',
  '替换形式', '命中串编号', '命中串字符数', '命中串摘要', '替换后摘要',
  '标记(markers)', '收敛策略',
];
const rows = [header];
const groupCount = new Map();

for (const p of ALL_PATCHES) {
  const group = GROUP_OF.get(p.id) ?? '未归类';
  groupCount.set(group, (groupCount.get(group) ?? 0) + 1);

  const files = Array.isArray(p.file) ? p.file.join(' | ') : String(p.file ?? '');
  const rels = Array.isArray(p.rel) ? p.rel.join('/') : String(p.rel ?? '');
  const target = rels ? files + ' :: ' + rels : files;

  const strategy = [
    p.skipIfMarked ? 'skipIfMarked' : '',
    p.markersAny ? 'markersAny' : '',
    p.optional ? 'optional' : '',
    p.strictFiles ? 'strictFiles' : '',
    p.softSettle ? 'softSettle' : '',
  ].filter(Boolean).join(' + ') || '命中 marker 即已应用';

  const markers = (p.markers ?? (p.marker ? [p.marker] : [])).map((m) => clip(m, 90)).join(' \\n ');

  const reps = [];
  if (Array.isArray(p.replacements)) for (const r of p.replacements) reps.push({ pattern: r.pattern, replace: r.replace });
  if (Array.isArray(p.patterns)) for (const pat of p.patterns) reps.push({ pattern: pat, replace: p.replace });
  if (reps.length === 0) reps.push({ pattern: '', replace: '' });

  reps.forEach((r, idx) => {
    const patLen = String(r.pattern ?? '').length;
    rows.push([
      p.id, group, p.name, `${p.layer || ''}${p.layer_en ? ' / ' + p.layer_en : ''}`, files, target, p.desc ?? '',
      Array.isArray(p.replacements) ? `replacements[${idx + 1}]` : Array.isArray(p.patterns) ? `patterns[${idx + 1}]` : '单替换',
      idx + 1,
      patLen === 0 ? 'regex/无' : patLen,
      patLen === 0 ? '(正则匹配)' : clip(r.pattern) + (patLen > 160 ? `…(共${patLen}字符)` : ''),
      clip(r.replace),
      markers,
      strategy,
    ]);
  });
}

writeFileSync(OUT, '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

console.log('patches=' + ALL_PATCHES.length, 'rows=' + (rows.length - 1));
for (const [label] of GROUPS) console.log('  ' + label.padEnd(28, ' ') + (groupCount.get(label) ?? 0));
const unmapped = [...GROUP_OF.keys()].filter((id) => !ALL_PATCHES.some((p) => p.id === id));
console.log('mapped-but-missing=', unmapped.length ? unmapped.join(',') : 'none');
console.log('unmapped-patch-ids=', ALL_PATCHES.filter((p) => !GROUP_OF.has(p.id)).map((p) => p.id).join(',') || 'none');
