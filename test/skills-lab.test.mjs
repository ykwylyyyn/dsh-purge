import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, 'skills', 'redteam');
const EXPECTED = ['attack-surface-inventory', 'pentest-lab', 'android-re-lab'];
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function parseFrontmatter(text, file) {
  const lines = text.split('\n');
  assert.equal(lines[0].replace(/\r$/, ''), '---', `${file}: 第一行必须是 ---`);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 1, `${file}: 缺少结束的 ---`);
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

test('技能目录：只允许平铺 .md（安装器只复制平铺文件）', () => {
  const entries = readdirSync(DIR, { withFileTypes: true });
  assert.ok(entries.length >= EXPECTED.length, '技能目录不应为空');
  for (const entry of entries) {
    assert.ok(entry.isFile(), `不支持子目录: ${entry.name}`);
    assert.ok(entry.name.endsWith('.md'), `只允许 .md: ${entry.name}`);
  }
});

test('每个技能都有合法 frontmatter（kebab-case name + 单行 description）', () => {
  for (const entry of readdirSync(DIR)) {
    if (!entry.endsWith('.md')) continue;
    const text = readFileSync(join(DIR, entry), 'utf8');
    const { fields } = parseFrontmatter(text, entry);
    assert.ok(fields.name, `${entry}: 缺 name`);
    assert.match(fields.name, KEBAB, `${entry}: name 必须是 kebab-case`);
    assert.equal(fields.name, entry.slice(0, -3), `${entry}: name 必须与文件名一致`);
    assert.ok(fields.description, `${entry}: 缺 description`);
    assert.ok(!fields.description.includes('\n'), `${entry}: description 必须单行`);
    assert.ok(fields.description.length <= 160, `${entry}: description 过长`);
  }
});

test('三个必备技能存在', () => {
  for (const name of EXPECTED) {
    const text = readFileSync(join(DIR, `${name}.md`), 'utf8');
    assert.ok(text.length > 500, `${name}: 内容过短，像占位文件`);
  }
});

test('每个技能都写明适用范围 / 停止条件 / 明确禁止（防止悄悄放宽边界）', () => {
  for (const name of EXPECTED) {
    const { body } = parseFrontmatter(readFileSync(join(DIR, `${name}.md`), 'utf8'), name);
    assert.ok(/适用范围|前置|前置门禁/.test(body), `${name}: 缺适用范围/前置门禁`);
    assert.ok(/停止条件/.test(body), `${name}: 缺停止条件`);
    assert.ok(/明确禁止|禁止/.test(body), `${name}: 缺禁止清单`);
    assert.ok(/loopback|RFC1918|私网|授权/.test(body), `${name}: 缺范围约束（授权/私网校验）`);
  }
});

test('技能包不包含武器化/规避类指令', () => {
  const banned = ['免杀', '持久化后门', '绕过 WAF', '反调试绕过', '撞库脚本', '钓鱼模板'];
  const SAFE_HEADING = /禁止|边界|停止|范围|门禁|停止条件/;
  const SAFE_LINE = /不写|禁止|不要|不允许|拒绝|停下|不提供/;
  for (const name of EXPECTED) {
    const { body } = parseFrontmatter(readFileSync(join(DIR, `${name}.md`), 'utf8'), name);
    let heading = '';
    let fenced = false;
    for (const line of body.split('\n')) {
      if (/^```/.test(line.trim())) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      if (/^#{1,6}\s+/.test(line)) heading = line;
      for (const word of banned) {
        if (!line.includes(word)) continue;
        // 只能出现在「禁止/边界/范围」小节里，或出现在明确的禁止句里
        const safe = SAFE_HEADING.test(heading) || SAFE_LINE.test(line);
        assert.ok(safe, `${name}: 「${word}」出现在非边界语境（${heading.slice(0, 40)}）: ${line.slice(0, 60)}`);
      }
    }
  }
});
