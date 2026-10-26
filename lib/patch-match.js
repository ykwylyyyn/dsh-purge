/**
 * 补丁匹配层（v2）。
 *
 * 旧引擎只认「原文逐字命中」：DSH 一次格式化（tab→空格、换行重排、引号风格变化）
 * 就会让整片补丁变成 skipped。这里给每条替换加一条**逐级降级**的匹配链：
 *
 *   literal   逐字命中（与旧行为完全一致，1.0 置信度）
 *   flex-ws   空白归一（`\s+` 折叠，换行/缩进/tab 无关）        0.9
 *   flex-quote 在上面基础上允许 ' " ` 互换                        0.8
 *   token     按「词法记号序列」匹配（允许空白/逗号/分号差异）    0.6
 *
 * 关键约束：
 *   1. 只有 literal 允许「多处全替换」（旧语义）；降级策略只在**唯一命中**时替换，
 *      多处命中一律报 ambiguous，交给人确认，绝不乱改。
 *   2. token 级只用于「找漂移位置/判断是否还存在」，不参与自动写入的默认判定
 *      （调用方通过 options.tokens 显式打开）。
 *   3. 正则 pattern 保持旧行为，不进入降级链。
 *
 * 本模块不碰文件系统，纯函数，便于单测。
 */

/** 统一换行，匹配层内部一律 LF。 */
export function normalizeLf(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** 统计 needle 在 hay 中出现次数（不重叠）。 */
export function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let index = 0;
  let count = 0;
  while ((index = hay.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 空白归一正则：空白串 → `\s+`，其余字符原样转义。
 * @param {string} needle 原文
 * @param {{quotes?: boolean}} [options] quotes=true 时 ' " ` 三选一
 */
export function flexRegex(needle, options = {}) {
  const quotes = options.quotes === true;
  let out = '';
  for (const ch of String(needle)) {
    if (/\s/.test(ch)) {
      out += '\\s+';
      continue;
    }
    if (quotes && (ch === '"' || ch === "'" || ch === '`')) {
      out += '["\'`]';
      continue;
    }
    out += escapeRegex(ch);
  }
  return new RegExp(out.replace(/(?:\\s\+)+/g, '\\s+'), 'g');
}

/**
 * 词法记号序列正则：标识符/数字/标点各自成 token，token 之间允许空白、逗号、分号。
 * 只适合「判断这段代码还在不在」，不适合作为默认写入依据。
 */
export function tokenRegex(needle) {
  const tokens = String(needle).match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g) ?? [];
  if (tokens.length === 0) return null;
  return new RegExp(tokens.map((t) => escapeRegex(t)).join('[\\s,;]*'), 'g');
}

function spansOf(regex, hay) {
  const spans = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(hay)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) regex.lastIndex += 1;
    if (spans.length > 8) break;
  }
  return spans;
}

const STRATEGY_CONFIDENCE = Object.freeze({
  literal: 1,
  'flex-ws': 0.9,
  'flex-quote': 0.8,
  token: 0.6,
  regex: 1,
  none: 0,
});

/**
 * 定位一段原文。
 * @param {string} text 目标文件全文（任意换行）
 * @param {string|RegExp} pattern 补丁里的 pattern
 * @param {{tokens?: boolean, quotes?: boolean}} [options]
 *        tokens 默认 false：token 级只在诊断路径启用。
 * @returns {{ok:boolean, strategy:string, confidence:number, start:number, end:number,
 *            count:number, ambiguous:boolean, reason?:string}}
 */
export function locatePattern(text, pattern, options = {}) {
  const hay = normalizeLf(text);

  if (pattern instanceof RegExp) {
    const source = String(pattern.source ?? '');
    let flags = String(pattern.flags || '').replace('g', '');
    let re;
    try {
      re = new RegExp(source, flags);
    } catch {
      return { ok: false, strategy: 'none', confidence: 0, start: -1, end: -1, count: 0, ambiguous: false, reason: 'invalid_regex' };
    }
    const match = re.exec(hay);
    if (!match) {
      return { ok: false, strategy: 'none', confidence: 0, start: -1, end: -1, count: 0, ambiguous: false, reason: 'regex_no_match' };
    }
    const count = countOccurrences(hay, match[0]) || 1;
    return {
      ok: true, strategy: 'regex', confidence: STRATEGY_CONFIDENCE.regex,
      start: match.index, end: match.index + match[0].length,
      count, ambiguous: false,
    };
  }

  const needle = normalizeLf(pattern);
  if (needle.length === 0) {
    return { ok: false, strategy: 'none', confidence: 0, start: -1, end: -1, count: 0, ambiguous: false, reason: 'empty_pattern' };
  }

  // 1) 逐字：保持旧语义（多处 = 全部替换，不算歧义）
  const literalCount = countOccurrences(hay, needle);
  if (literalCount > 0) {
    const start = hay.indexOf(needle);
    return {
      ok: true, strategy: 'literal', confidence: STRATEGY_CONFIDENCE.literal,
      start, end: start + needle.length, count: literalCount, ambiguous: false,
    };
  }

  // 2) 空白归一
  const wsSpans = spansOf(flexRegex(needle), hay);
  if (wsSpans.length > 0) {
    return {
      ok: wsSpans.length === 1, strategy: 'flex-ws', confidence: STRATEGY_CONFIDENCE['flex-ws'],
      start: wsSpans[0].start, end: wsSpans[0].end, count: wsSpans.length,
      ambiguous: wsSpans.length > 1,
      ...(wsSpans.length > 1 ? { reason: 'ambiguous_flex_ws' } : {}),
    };
  }

  // 3) 空白 + 引号风格
  if (options.quotes !== false) {
    const quoteSpans = spansOf(flexRegex(needle, { quotes: true }), hay);
    if (quoteSpans.length > 0) {
      return {
        ok: quoteSpans.length === 1, strategy: 'flex-quote', confidence: STRATEGY_CONFIDENCE['flex-quote'],
        start: quoteSpans[0].start, end: quoteSpans[0].end, count: quoteSpans.length,
        ambiguous: quoteSpans.length > 1,
        ...(quoteSpans.length > 1 ? { reason: 'ambiguous_flex_quote' } : {}),
      };
    }
  }

  // 4) 词法记号（默认只在诊断里用）
  if (options.tokens === true) {
    const re = tokenRegex(needle);
    if (re) {
      const tokenSpans = spansOf(re, hay);
      if (tokenSpans.length > 0) {
        return {
          ok: tokenSpans.length === 1, strategy: 'token', confidence: STRATEGY_CONFIDENCE.token,
          start: tokenSpans[0].start, end: tokenSpans[0].end, count: tokenSpans.length,
          ambiguous: tokenSpans.length > 1,
          ...(tokenSpans.length > 1 ? { reason: 'ambiguous_token' } : {}),
        };
      }
    }
  }

  return { ok: false, strategy: 'none', confidence: 0, start: -1, end: -1, count: 0, ambiguous: false, reason: 'not_found' };
}

/** 把定位到的一段替换成 replacement。 */
export function replaceSpan(text, span, replacement) {
  return text.slice(0, span.start) + replacement + text.slice(span.end);
}

/**
 * 按匹配链把一条替换落到文本上。
 * literal 走「全部替换」保持旧行为；降级策略只替换唯一命中。
 * @returns {{ok:boolean, changed:boolean, text:string, strategy:string, ambiguous:boolean, reason?:string}}
 */
export function applyPatternToText(text, pattern, replacement, options = {}) {
  const source = String(text ?? '');
  const loc = locatePattern(source, pattern, options);
  if (!loc.ok) {
    return { ok: false, changed: false, text: source, strategy: loc.strategy, ambiguous: loc.ambiguous, reason: loc.reason };
  }
  if (loc.strategy === 'literal') {
    const next = source.split(pattern instanceof RegExp ? '' : normalizeLf(pattern)).join(replacement);
    return { ok: true, changed: next !== source, text: next, strategy: loc.strategy, ambiguous: false };
  }
  if (loc.ambiguous) {
    return { ok: false, changed: false, text: source, strategy: loc.strategy, ambiguous: true, reason: loc.reason };
  }
  // 用规范化后的正文定位；替换时保留原文换行风格由调用方统一处理。
  const hay = normalizeLf(source);
  const next = replaceSpan(hay, loc, replacement);
  return { ok: true, changed: next !== hay, text: next, strategy: loc.strategy, ambiguous: false };
}

/**
 * 诊断「这条原文为什么找不到」：找出还存在的锚点词、丢失的词、最近的行号。
 * 锚点优先挑**最长的标识符**（越长越稀有），并给出最多 3 条候选命中行，
 * 避免像 `consume` 这种通用词把提示指到无关位置。
 * @param {string} text 目标文件全文
 * @param {string|RegExp} pattern 原 pattern
 */
export function describeDrift(text, pattern) {
  const hay = normalizeLf(text);
  if (pattern instanceof RegExp) {
    const loc = locatePattern(hay, pattern, { quotes: true, tokens: true });
    return loc.ok
      ? { found: true, line: lineOfOffset(hay, loc.start), strategy: loc.strategy, coverage: 1, candidates: [] }
      : { found: false, line: null, strategy: 'none', coverage: 0, candidates: [] };
  }
  const needle = normalizeLf(pattern);
  // 只取长度 ≥5 的标识符，按长度降序；标点/短词不参与锚定。
  const words = [...new Set(needle.match(/[A-Za-z_$][\w$]{4,}/g) ?? [])].sort((a, b) => b.length - a.length);
  const found = words.filter((w) => hay.includes(w));
  const missing = words.filter((w) => !hay.includes(w));
  const coverage = words.length === 0 ? 0 : found.length / words.length;
  const lines = hay.split('\n');
  const candidates = [];
  for (const word of found.slice(0, 3)) {
    const at = hay.indexOf(word);
    if (at < 0) continue;
    const line = lineOfOffset(hay, at);
    candidates.push({ token: word, line, lineText: (lines[line - 1] ?? '').trim().slice(0, 160) });
  }
  const best = candidates[0];
  return {
    found: found.length > 0,
    line: best ? best.line : null,
    anchor: best ? best.token : null,
    foundTokens: found.slice(0, 8),
    missingTokens: missing.slice(0, 8),
    coverage,
    candidates,
    lineText: best ? best.lineText : null,
  };
}

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 置信度表（导出便于报告与测试）。 */
export { STRATEGY_CONFIDENCE };
