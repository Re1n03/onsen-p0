/**
 * tests/messages.test.js — 错误码文案总览与静态扫描校验（U6~U8）
 *
 * 独立于假 DOM 与 ui.js：不导入 src/ui.js，不触碰 globalThis.document / setTimeout。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON_TEXT } from '../src/messages.js';

/**
 * 词法状态机：
 *  - 剥离行注释与块注释（保留换行符以精确定位行号）；
 *  - 把单引号/双引号字符串替换为占位符 __STR_n__，避免 //、/*、fail( 干扰；
 *  - 正确处理模板字符串及 ${ ... } 内嵌套模板字符串与嵌套花括号；
 *  - 返回占位后的纯代码文本与字符串值数组。
 */
function preprocessSource(source) {
  const strings = [];
  let out = '';
  let line = 1;
  let i = 0;

  // 栈元素：{ type: 'code' } 或 { type: 'template-expr', braceDepth: number }
  const stack = [{ type: 'code', braceDepth: 0 }];
  let mode = 'code'; // 'code' | 'line-comment' | 'block-comment' | 'string' | 'template-text'
  let stringQuote = '';
  let stringBuf = '';

  const pushChar = (ch) => {
    out += ch;
    if (ch === '\n') line += 1;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'line-comment') {
      if (ch === '\n') {
        mode = 'code';
        pushChar('\n');
      } else {
        pushChar(' ');
      }
      i += 1;
      continue;
    }

    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') {
        pushChar(' ');
        pushChar(' ');
        mode = 'code';
        i += 2;
      } else {
        pushChar(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }

    if (mode === 'string') {
      if (ch === '\\' && i + 1 < source.length) {
        stringBuf += next;
        if (next === '\n') line += 1;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        const id = strings.length;
        strings.push(stringBuf);
        out += `__STR_${id}__`;
        mode = 'code';
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      stringBuf += ch;
      i += 1;
      continue;
    }

    if (mode === 'template-text') {
      if (ch === '\\' && i + 1 < source.length) {
        if (next === '\n') pushChar('\n');
        else pushChar(' ');
        i += 2;
        continue;
      }
      if (ch === '`') {
        pushChar('`');
        stack.pop();
        mode = 'code';
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        pushChar('$');
        pushChar('{');
        stack.push({ type: 'template-expr', braceDepth: 0 });
        mode = 'code';
        i += 2;
        continue;
      }
      pushChar(ch === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }

    // mode === 'code'
    if (ch === '/' && next === '/') {
      pushChar(' ');
      pushChar(' ');
      mode = 'line-comment';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      pushChar(' ');
      pushChar(' ');
      mode = 'block-comment';
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      stringQuote = ch;
      stringBuf = '';
      mode = 'string';
      i += 1;
      continue;
    }
    if (ch === '`') {
      pushChar('`');
      stack.push({ type: 'template-text', braceDepth: 0 });
      mode = 'template-text';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const top = stack[stack.length - 1];
      if (top.type === 'template-expr') top.braceDepth += 1;
      pushChar(ch);
      i += 1;
      continue;
    }
    if (ch === '}') {
      const top = stack[stack.length - 1];
      if (top.type === 'template-expr') {
        if (top.braceDepth === 0) {
          pushChar('}');
          stack.pop(); // 弹出 template-expr，回到下方的 template-text
          mode = 'template-text';
          i += 1;
          continue;
        }
        top.braceDepth -= 1;
      }
      pushChar(ch);
      i += 1;
      continue;
    }

    pushChar(ch);
    i += 1;
  }

  return { code: out, strings };
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** 找到函数体内对应花括号结束位置 */
function findFunctionBodyRange(code, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return [openBraceIndex, i];
    }
  }
  return [openBraceIndex, code.length - 1];
}

/** 从下标 pos 的 '(' 起找到配对 ')' 的下标 */
function findMatchingParen(code, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 静态扫描单个源码文件里的所有失败错误码：
 *  1) fail('CODE') 调用（排除 function fail(reason) 声明，非字面量参数报错）；
 *  2) { ok: false, reason: 'CODE' } 直接返回（function fail 内部允许 { ok: false, reason } 简写）。
 */
export function scanErrorCodes(source, fileLabel = '<source>') {
  const { code, strings } = preprocessSource(source);
  const codes = new Set();

  // 记录所有名为 fail 的函数体区间，允许其内部的 { ok: false, reason } 简写
  const failFnRanges = [];
  const fnFailRe = /\bfunction\s+fail\s*\([^)]*\)\s*\{/g;
  for (const match of code.matchAll(fnFailRe)) {
    const openBrace = match.index + match[0].length - 1;
    failFnRanges.push(findFunctionBodyRange(code, openBrace));
  }
  const insideFailFn = (pos) => failFnRanges.some(([start, end]) => pos >= start && pos <= end);

  // 1) 扫描 fail(...) 调用
  const failCallRe = /\bfail\s*\(/g;
  for (const match of code.matchAll(failCallRe)) {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (/\bfunction\s+$/.test(before)) continue; // 跳过 function fail(reason) 声明

    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingParen(code, openParen);
    const lineNo = lineNumberAt(code, match.index);
    if (closeParen < 0) {
      throw new Error(`${fileLabel}:${lineNo} fail( 括号未闭合`);
    }
    const arg = code.slice(openParen + 1, closeParen).trim();
    const strMatch = /^__STR_(\d+)__$/.exec(arg);
    if (!strMatch) {
      throw new Error(`${fileLabel}:${lineNo} fail() 参数不是字符串字面量: ${arg}`);
    }
    codes.add(strings[Number(strMatch[1])]);
  }

  // 2) 扫描 { ok: false, reason: ... } 直接返回，并记录已被覆盖的 ok: false 位置
  const coveredOkFalse = new Set();
  const okFalseReasonRe = /\{\s*ok\s*:\s*false\s*,\s*reason\b(?:\s*:\s*([^,}]+))?/g;
  for (const match of code.matchAll(okFalseReasonRe)) {
    const lineNo = lineNumberAt(code, match.index);
    const okOffset = match[0].search(/\bok\s*:\s*false\b/);
    const okIndex = match.index + okOffset;
    if (match[1] === undefined) {
      // { ok: false, reason } 简写形式只允许在 function fail 内部
      if (insideFailFn(match.index)) {
        coveredOkFalse.add(okIndex);
        continue;
      }
      throw new Error(`${fileLabel}:${lineNo} 在 fail 函数外使用了 { ok: false, reason } 简写`);
    }
    const val = match[1].trim();
    const strMatch = /^__STR_(\d+)__$/.exec(val);
    if (!strMatch) {
      throw new Error(`${fileLabel}:${lineNo} reason 值不是字符串字面量: ${val}`);
    }
    coveredOkFalse.add(okIndex);
    codes.add(strings[Number(strMatch[1])]);
  }

  // 加固校验：防止漏扫其他键序或未覆盖的 ok: false 返回写法
  const allOkFalse = [...code.matchAll(/\bok\s*:\s*false\b/g)];
  if (coveredOkFalse.size < allOkFalse.length) {
    const uncovered = allOkFalse.find((m) => !coveredOkFalse.has(m.index));
    const lineNo = lineNumberAt(code, uncovered.index);
    throw new Error(`${fileLabel}:${lineNo} 存在未被覆盖的 ok: false 返回写法`);
  }

  return codes;
}

// ============================================================
// U6 错误码总览
// ============================================================
test('U6 错误码总览：src 下所有失败返回码与 REASON_TEXT 双向对齐且非空', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.js')).sort();
  const scanned = new Set();

  for (const name of files) {
    const source = fs.readFileSync(path.join(srcDir, name), 'utf8');
    for (const code of scanErrorCodes(source, `src/${name}`)) {
      scanned.add(code);
    }
  }

  // 正向检查：扫到的每个码都必须在 REASON_TEXT 里且非空字符串
  for (const code of scanned) {
    assert.equal(Object.hasOwn(REASON_TEXT, code), true, `REASON_TEXT 缺少错误码: ${code}`);
    assert.equal(typeof REASON_TEXT[code], 'string', `REASON_TEXT[${code}] 应为字符串`);
    assert.ok(REASON_TEXT[code].trim().length > 0, `REASON_TEXT[${code}] 不能为空`);
  }

  // 反向检查：REASON_TEXT 每个键都必须被扫描结果覆盖（无悬空文案）
  for (const key of Object.keys(REASON_TEXT)) {
    assert.equal(scanned.has(key), true, `REASON_TEXT 存在未被 src 使用的悬空键: ${key}`);
  }

  // 三种来源哨兵：actions.js fail / explore.js fail+直接返回 / clock.js 直接返回
  assert.equal(scanned.has('NOT_ENOUGH_MATERIALS'), true);
  assert.equal(scanned.has('NEED_SWAP'), true);
  assert.equal(scanned.has('TRAY_FULL'), true);
});

// ============================================================
// U7 扫描器自检
// ============================================================
test('U7 扫描器自检：注释、字符串、嵌套模板、非字面量报错、fail 简写与事件对象过滤', () => {
  const cleanSample = `
    function fail(reason) {
      return { ok: false, reason };
    }
    // fail('FAKE_LINE_COMMENT')
    /* fail('FAKE_BLOCK_COMMENT') */
    const s1 = "// 不应吞掉同行后续"; if (a) return fail('AFTER_STR_SLASH');
    const s2 = "fail('FAKE_IN_STRING')";
    const t1 = \`// 模板里的斜杠与 \${foo ? \`内层// \${bar}\` : 'ok'} 结束\`; if (b) return fail('AFTER_TPL_SLASH');
    const ev = { type: 'visitorDeferred', reason: 'QUEUE_FULL' };
    function demo(flag) {
      if (!flag) return fail('REAL_FROM_FAIL');
      if (flag === 2) return { ok: false, reason: 'REAL_DIRECT_RETURN' };
      return { ok: true };
    }
  `;
  const found = scanErrorCodes(cleanSample, 'synthetic.js');
  assert.deepEqual([...found].sort(), [
    'AFTER_STR_SLASH',
    'AFTER_TPL_SLASH',
    'REAL_DIRECT_RETURN',
    'REAL_FROM_FAIL',
  ]);

  // 非字面量参数必须抛错并带位置信息
  const badSample = `
    function demo(x) {
      return fail(x);
    }
  `;
  assert.throws(
    () => scanErrorCodes(badSample, 'bad.js'),
    (err) => err instanceof Error && /bad\.js:3\b/.test(err.message),
  );

  // 甲：reason 值不是字符串字面量必须抛错并带位置信息
  const nonLiteralReasonSample = `
    function demo(code) {
      return { ok: false, reason: code };
    }
  `;
  assert.throws(
    () => scanErrorCodes(nonLiteralReasonSample, 'non-lit-reason.js'),
    (err) => err instanceof Error && /non-lit-reason\.js:3\b/.test(err.message),
  );

  // 乙：在 fail 函数之外出现 { ok: false, reason } 简写必须抛错并带位置信息
  const shorthandOutsideFailSample = `
    function other(reason) {
      return { ok: false, reason };
    }
  `;
  assert.throws(
    () => scanErrorCodes(shorthandOutsideFailSample, 'outside-fail.js'),
    (err) => err instanceof Error && /outside-fail\.js:3\b/.test(err.message),
  );

  // 丙：键序为 { reason: 'X', ok: false } 时必须被加固抛错并带位置信息
  const reversedOrderSample = `
    function demo() {
      return { reason: 'X', ok: false };
    }
  `;
  assert.throws(
    () => scanErrorCodes(reversedOrderSample, 'reversed-order.js'),
    (err) => err instanceof Error && /reversed-order\.js:3\b/.test(err.message),
  );
});

// ============================================================
// U8 文案内容：既有 11 条与批 B 常用 5 条字面值锁定
// ============================================================
test('U8 文案内容：既有 11 条逐字保留且批 B 常用 5 条字面值固定', () => {
  assert.equal(REASON_TEXT.DAY_CLOSED, '今天已经打烊了');
  assert.equal(REASON_TEXT.ALREADY_CLOSED, '今天已经打过烊了');
  assert.equal(REASON_TEXT.NOT_ENOUGH_GOLD, '金币不够');
  assert.equal(REASON_TEXT.UNKNOWN_ITEM, '没有这种物品');
  assert.equal(REASON_TEXT.INVALID_SLOT, '没有这个投料槽');
  assert.equal(REASON_TEXT.SLOT_OCCUPIED, '这个槽位还在生效中');
  assert.equal(REASON_TEXT.NO_ITEM, '背包里没有这件东西');
  assert.equal(REASON_TEXT.GUEST_NOT_FOUND, '这位客人不在池里');
  assert.equal(REASON_TEXT.NO_ORDERING_GUEST, '这位客人现在没有点单');
  assert.equal(REASON_TEXT.TRAY_FULL, '托盘已经有一份小食了');
  assert.equal(REASON_TEXT.ALREADY_CHANGING, '正在换水');

  assert.equal(REASON_TEXT.PLAYER_LEVEL_TOO_LOW, '玩家等级不够');
  assert.equal(REASON_TEXT.NOT_ENOUGH_MATERIALS, '材料不够');
  assert.equal(REASON_TEXT.BUSINESS_STARTED, '营业已经开始，现在不能这样做');
  assert.equal(REASON_TEXT.EXPLORING, '正在采风，现在不能这样做');
  assert.equal(REASON_TEXT.MAX_LEVEL, '已经是最高等级了');
});
