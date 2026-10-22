#!/usr/bin/env node
/**
 * SQL 安全守卫
 * 用法:
 *   node sql-guard.mjs --sql "DELETE FROM orders WHERE id = ?"
 *   node sql-guard.mjs --file migrations/20261022_cleanup.sql
 *   node sql-guard.mjs --scan .
 *
 * 拦截: 无顶层 WHERE 的 DELETE/UPDATE、WHERE 恒真、TRUNCATE、DROP TABLE/DATABASE/SCHEMA、
 *       ALTER TABLE ... DROP
 * 退出码: 0 安全, 1 拦截, 2 参数或路径错误
 *
 * 说明: 基于词法与括号深度的保守检查，不解析存储过程/触发器内部逻辑；
 *       这类对象需要人工复核。
 */

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `用法:
  node sql-guard.mjs --sql "<SQL 语句>"
  node sql-guard.mjs --file <file.sql>
  node sql-guard.mjs --scan <项目目录>

退出码: 0 安全, 1 拦截, 2 参数或路径错误`;

function fail(message) {
  console.error(`[错误] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  let mode = null;
  let value = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--sql' || arg === '--file' || arg === '--scan') {
      if (i + 1 >= argv.length) fail(`${arg} 缺少值`);
      mode = arg.slice(2);
      value = argv[++i];
      continue;
    }
    fail(`未知参数 ${arg}`);
  }
  if (!mode || !value) fail('必须提供 --sql、--file 或 --scan 之一');
  return { mode, value };
}

/* ── 掩码：注释和字符串替换为空格，保留换行与长度 ── */
function maskSql(sql) {
  const out = sql.split('');
  const n = sql.length;
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];

    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i++;
  }

  return out.join('');
}

/* ── 按顶层分号切分语句 ── */
function splitStatements(masked) {
  const list = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      list.push({ text: masked.slice(start, i), start });
      start = i + 1;
    }
  }
  list.push({ text: masked.slice(start), start });
  return list.filter(s => s.text.trim());
}

/* ── 顶层关键字（忽略括号内与已掩码内容） ── */
function topLevelWords(masked) {
  const words = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(c)) continue;

    let j = i + 1;
    while (j < masked.length && /[A-Za-z0-9_$]/.test(masked[j])) j++;
    words.push({ word: masked.slice(i, j).toUpperCase(), index: i });
    i = j - 1;
  }
  return words;
}

function primaryKind(words) {
  if (!words.length) return null;
  if (words[0].word === 'WITH') {
    const dml = words.find(w => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(w.word));
    return dml ? dml.word : 'WITH';
  }
  return words[0].word;
}

function lineAt(sql, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

function isTautology(text, where) {
  const rest = text.slice(where.index + 5);
  if (/^\s*\(?\s*(1\s*=\s*1|1=1|true)\b/i.test(rest)) return true;
  if (/\bOR\s+\(?\s*(1\s*=\s*1|true)\b/i.test(rest)) return true;
  return false;
}

function analyzeStatement(text, offset, fullSql) {
  const words = topLevelWords(text);
  if (!words.length) return null;

  const kind = primaryKind(words);
  const line = lineAt(fullSql, offset);
  // 展示原始语句（含字符串与注释），避免掩码后看不清真实内容
  const original = fullSql.slice(offset, offset + text.length).trim();
  const compact = original.replace(/\s+/g, ' ').slice(0, 120);
  const issue = (reason, hint) => ({ ok: false, line, text: compact, reason, hint });

  if (kind === 'TRUNCATE') {
    return issue('TRUNCATE 没有条件形式，会清空整表', '改用带 WHERE 的 DELETE，或先备份并让用户明确确认');
  }

  if (kind === 'DROP') {
    const target = (words[1] && words[1].word) || '';
    if (['TABLE', 'DATABASE', 'SCHEMA'].includes(target)) {
      return issue(`DROP ${target} 是破坏性 DDL`, '先说明影响、备份与回滚方案，由用户确认后手工执行');
    }
  }

  if (kind === 'ALTER' && words.some(w => w.word === 'DROP')) {
    return issue('ALTER TABLE ... DROP 会删除列/索引/约束，可能丢数据', '先确认依赖与备份，由用户确认后手工执行');
  }

  if (kind === 'DELETE' || kind === 'UPDATE') {
    const where = words.find(w => w.word === 'WHERE');
    if (!where) {
      return issue(`${kind} 缺少顶层 WHERE，会命中全表`, '补主键/租户/批次条件，并先用 SELECT COUNT 评估影响');
    }
    if (isTautology(text, where)) {
      return issue(`${kind} 的 WHERE 恒真，等同于无条件执行`, '改成能定位具体记录或明确批次的条件');
    }
  }

  return { ok: true, line, text: compact };
}

function analyzeSql(sql) {
  const masked = maskSql(sql);
  const statements = splitStatements(masked);
  const issues = [];
  for (const st of statements) {
    // 跳过语句前的空白与注释（已掩码为空格），让行号落在真实语句上
    const lead = st.text.match(/^\s*/)[0].length;
    const text = st.text.slice(lead);
    if (!text.trim()) continue;
    const result = analyzeStatement(text, st.start + lead, sql);
    if (result && !result.ok) issues.push(result);
  }
  return { statements: statements.length, issues };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor' || entry.name === 'dist' || entry.name === 'build') continue;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.sql$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

function printIssues(source, issues) {
  console.log(`\n✖ 发现 ${issues.length} 条危险语句\n`);
  issues.forEach((issue, i) => {
    console.log(`  ${i + 1}. ${source}:${issue.line}`);
    console.log(`     ${issue.text}`);
    console.log(`     原因：${issue.reason}`);
    console.log(`     处理：${issue.hint}`);
  });
}

function main() {
  const { mode, value } = parseArgs(process.argv.slice(2));
  const results = [];

  if (mode === 'sql') {
    const result = analyzeSql(value);
    console.log(`\nSQL 安全检查 · 内联语句`);
    if (result.issues.length) {
      printIssues('<sql>', result.issues);
      console.log(`\n结果：拦截。禁止执行，先修复或向用户确认。\n`);
      process.exit(1);
    }
    console.log(`\n✔ 通过：未发现无条件删改或破坏性 DDL\n`);
    process.exit(0);
  }

  if (mode === 'file') {
    const abs = path.resolve(value);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`文件不存在: ${value}`);
    const sql = fs.readFileSync(abs, 'utf8');
    const result = analyzeSql(sql);
    const rel = path.relative(process.cwd(), abs) || abs;
    console.log(`\nSQL 安全检查 · ${rel}（${result.statements} 条语句）`);
    if (result.issues.length) {
      printIssues(rel, result.issues);
      console.log(`\n结果：拦截。禁止执行，先修复或向用户确认。\n`);
      process.exit(1);
    }
    console.log(`\n✔ 通过：未发现无条件删改或破坏性 DDL\n`);
    process.exit(0);
  }

  const dir = path.resolve(value);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`目录不存在: ${value}`);
  const files = walk(dir);

  if (!files.length) {
    console.log(`\n扫描 ${dir}\n未找到 .sql 文件。\n`);
    process.exit(0);
  }

  let totalStatements = 0;
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const result = analyzeSql(sql);
    totalStatements += result.statements;
    if (result.issues.length) {
      results.push({ file: path.relative(dir, file).split(path.sep).join('/'), issues: result.issues });
    }
  }

  console.log(`\nSQL 安全检查 · ${dir}`);
  console.log(`扫描 ${files.length} 个 .sql 文件，共 ${totalStatements} 条语句`);

  if (results.length) {
    for (const r of results) printIssues(r.file, r.issues);
    const count = results.reduce((n, r) => n + r.issues.length, 0);
    console.log(`\n结果：拦截 ${count} 条。禁止执行，先修复或向用户确认。\n`);
    process.exit(1);
  }

  console.log(`\n✔ 通过：未发现无条件删改或破坏性 DDL\n`);
  process.exit(0);
}

main();
