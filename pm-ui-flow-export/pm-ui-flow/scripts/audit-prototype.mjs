#!/usr/bin/env node
/**
 * PM 原型流程审计
 * 用法: node audit-prototype.mjs <原型目录>
 *
 * 检查：结构标记、断链、孤岛页、有新建无查看、表单字段无展示、保存后跳转目标
 * 退出码: 0 = 无阻断问题, 1 = 存在阻断问题, 2 = 参数或目录错误
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`[错误] 目录不存在: ${process.argv[2] || '(空)'}`);
  process.exit(2);
}

const EXTERNAL = /^(https?:|mailto:|tel:|javascript:|data:|\/\/)/i;
const VIEWS = new Set(['index', 'dashboard', 'list', 'detail', 'create', 'edit']);

/* ── 收集文件 ───────────────────────────────── */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

/* ── 属性提取 ───────────────────────────────── */
function getAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2]) : null;
}

const toRel = abs => path.relative(root, abs).split(path.sep).join('/');
const norm = p => p.replace(/\\/g, '/');

/* ── 解析单页 ───────────────────────────────── */
function parsePage(abs) {
  const raw = fs.readFileSync(abs, 'utf8');
  // 先剥掉 HTML 注释，避免注释里的示例标签被误当成真实结构
  const html = raw.replace(/<!--[\s\S]*?-->/g, '');
  const bodyMatch = html.match(/<body\b[^>]*>/i);
  const bodyTag = bodyMatch ? bodyMatch[0] : '';

  const hrefs = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = getAttr(m[0], 'href');
    if (href) hrefs.push(href.trim());
  }

  // 表单提交目标
  const submitTargets = [];
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const t = getAttr(m[0], 'data-submit-to');
    if (t) submitTargets.push(t.trim());
  }

  // 所有 data-field 出现位置
  const allFields = [...html.matchAll(/data-field\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
    .map(m => (m[1] ?? m[2]).trim())
    .filter(Boolean);

  // 表单控件上的 data-field
  const inputFields = [];
  for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)) {
    const f = getAttr(m[0], 'data-field');
    if (f) inputFields.push(f.trim());
    const n = getAttr(m[0], 'name');
    if (f && !n) inputFields.push(`__noName__:${f}`);
  }

  const displayFields = allFields.filter(f => !inputFields.includes(f));

  return {
    abs,
    rel: toRel(abs),
    page: getAttr(bodyTag, 'data-page'),
    entity: getAttr(bodyTag, 'data-entity'),
    view: getAttr(bodyTag, 'data-view'),
    hrefs,
    submitTargets,
    allFields: [...new Set(allFields)],
    inputFields: [...new Set(inputFields)],
    displayFields: [...new Set(displayFields)],
  };
}

/* ── 链接解析 ───────────────────────────────── */
function resolveHref(fromRel, href) {
  if (!href || EXTERNAL.test(href) || href.startsWith('#')) return null;
  const clean = href.split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  const fromDir = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(fromDir, clean));
  if (p.endsWith('/')) p += 'index.html';
  if (!/\.html?$/i.test(p)) p += '.html'; // 允许省略扩展名
  return p.replace(/^\.\//, '');
}

/* ── 执行 ───────────────────────────────────── */
const files = walk(root);
if (files.length === 0) {
  console.error(`[错误] ${root} 下没有找到 .html 文件`);
  process.exit(2);
}

const pages = files.map(parsePage);
const byRel = new Map(pages.map(p => [p.rel, p]));
const blockers = [];
const warnings = [];
const notes = [];

const add = (arr, entity, msg, hint) => arr.push({ entity: entity || '—', msg, hint });

/* A. 结构标记 */
for (const p of pages) {
  if (!p.page) add(blockers, p.entity, `${p.rel} 缺少 data-page`, '在 <body> 上加 data-page="唯一标识"');
  if (!p.view) add(blockers, p.entity, `${p.rel} 缺少 data-view`, '取值 index|dashboard|list|detail|create|edit');
  else if (!VIEWS.has(p.view)) add(blockers, p.entity, `${p.rel} 的 data-view="${p.view}" 不在允许取值内`, VIEWS.join(' | '));
  const dup = pages.filter(q => q.page && q.page === p.page);
  if (p.page && dup.length > 1) {
    const key = `dup:${p.page}`;
    if (!notes.some(n => n.msg === key)) {
      add(blockers, p.entity, `data-page="${p.page}" 重复出现 ${dup.length} 次`, '页面标识必须全站唯一');
      notes.push({ msg: key });
    }
  }
}

/* B. 断链 */
for (const p of pages) {
  for (const href of p.hrefs) {
    const target = resolveHref(p.rel, href);
    if (target && !byRel.has(target)) {
      add(blockers, p.entity, `${p.rel} 链接到不存在的文件 → ${href}`, `解析后应为 ${target}`);
    }
  }
}

/* C. 可达性 */
const entryRel = byRel.has('index.html') ? 'index.html' : pages[0].rel;
if (!byRel.has('index.html')) {
  add(warnings, '—', '根目录没有 index.html，以第一个页面作为入口分析', '建议补一个首页作为导航入口');
}
const reached = new Set([entryRel]);
const queue = [entryRel];
while (queue.length) {
  const cur = byRel.get(queue.shift());
  if (!cur) continue;
  for (const href of cur.hrefs) {
    const t = resolveHref(cur.rel, href);
    if (t && byRel.has(t) && !reached.has(t)) { reached.add(t); queue.push(t); }
  }
}
for (const p of pages) {
  if (!reached.has(p.rel)) add(warnings, p.entity, `${p.rel} 从入口点不到（孤岛页）`, '加一条入口链接');
}

/* D. 数据查看闭环 */
const entities = new Map();
for (const p of pages) {
  if (!p.entity) continue;
  if (!entities.has(p.entity)) entities.set(p.entity, { create: [], edit: [], list: [], detail: [], inputs: new Set(), displays: new Set() });
  const e = entities.get(p.entity);
  if (e[p.view]) e[p.view].push(p.rel);
  if (p.view === 'create' || p.view === 'edit') {
    p.inputFields.filter(f => !f.startsWith('__noName__')).forEach(f => e.inputs.add(f));
  }
  if (p.view === 'list' || p.view === 'detail') {
    p.displayFields.forEach(f => e.displays.add(f));
  }
}

for (const [name, e] of entities) {
  const hasCreate = e.create.length > 0;
  const hasView = e.list.length > 0 || e.detail.length > 0;

  if (hasCreate && !hasView) {
    add(blockers, name, `有新建页（${e.create.join(', ')}），但全站没有该实体的列表页或详情页`, '数据保存后无处查看，必须补查看入口');
    continue;
  }

  if (hasView) {
    const viewPages = [...e.list, ...e.detail].filter(r => reached.has(r));
    if (viewPages.length === 0) {
      add(blockers, name, `查看页存在但都从入口点不到：${[...e.list, ...e.detail].join(', ')}`, '等于数据无处查看，补入口链接');
    }
  }

  if (hasCreate && !hasView) continue;

  // E. 字段展示覆盖
  const missing = [...e.inputs].filter(f => !e.displays.has(f));
  if (missing.length) {
    add(blockers, name,
      `表单采集但列表/详情中未展示的字段 ${missing.length} 个：${missing.join(', ')}`,
      '要么在列表/详情补展示（标 data-field），要么从表单移除');
  }
}

/* F. 提交目标 */
for (const p of pages) {
  for (const t of p.submitTargets) {
    const resolved = resolveHref(p.rel, t);
    if (resolved && !byRel.has(resolved)) {
      add(blockers, p.entity, `${p.rel} 的保存后跳转目标不存在 → ${t}`, `解析后应为 ${resolved}`);
    }
    const dest = resolved && byRel.get(resolved);
    if (dest && p.entity && dest.entity && dest.entity !== p.entity) {
      add(warnings, p.entity, `${p.rel} 保存后跳到别的实体页面（${dest.entity}）`, '确认这是否符合流程');
    }
  }
  const isFormPage = p.view === 'create' || p.view === 'edit';
  if (isFormPage && p.inputFields.length > 0 && p.submitTargets.length === 0) {
    add(warnings, p.entity, `${p.rel} 是表单页但没有 data-submit-to`, '补上保存后去哪，否则用户不知道提交完看到什么');
  }
}

/* G. 返回出口 */
for (const p of pages) {
  if (!p.entity) continue;
  const e = entities.get(p.entity);
  if (!e) continue;
  const isSubPage = p.view === 'detail' || p.view === 'create' || p.view === 'edit';
  if (!isSubPage) continue;
  const linkTargets = p.hrefs.map(h => resolveHref(p.rel, h)).filter(Boolean);
  const canReturn = linkTargets.some(t => e.list.includes(t) || t === 'index.html' || t === 'pages/index.html');
  if (!canReturn) {
    add(warnings, p.entity, `${p.rel} 没有回到列表或首页的链接`, '用户只能靠浏览器后退');
  }
}

/* H. 控件缺 name */
for (const p of pages) {
  const bad = p.inputFields.filter(f => f.startsWith('__noName__')).map(f => f.split(':')[1]);
  if (bad.length) add(warnings, p.entity, `${p.rel} 中这些字段缺少 name 属性：${bad.join(', ')}`, '表单提交需要 name');
}

/* ── 输出 ───────────────────────────────────── */
const line = '─'.repeat(56);
console.log(`\nPM 原型流程审计`);
console.log(`目录  ${root}`);
console.log(`页面  ${pages.length} 个 · 实体 ${entities.size} 个 · 入口 ${entryRel}\n${line}`);

if (blockers.length) {
  console.log(`\n✖ 阻断 ${blockers.length} 项（必须修完再交付）\n`);
  blockers.forEach((b, i) => {
    console.log(`  ${i + 1}. [${b.entity}] ${b.msg}`);
    if (b.hint) console.log(`     → ${b.hint}`);
  });
} else {
  console.log(`\n✔ 阻断项 0 —— 数据查看闭环、链接、结构标记均通过`);
}

if (warnings.length) {
  console.log(`\n⚠ 警告 ${warnings.length} 项（可带病交付，需在说明里列出）\n`);
  warnings.forEach((w, i) => {
    console.log(`  ${i + 1}. [${w.entity}] ${w.msg}`);
    if (w.hint) console.log(`     → ${w.hint}`);
  });
} else {
  console.log(`\n✔ 警告项 0`);
}

console.log(`\n${line}`);
if (blockers.length) {
  console.log(`结果：未通过。修完以上 ${blockers.length} 项后重跑本脚本。\n`);
  process.exit(1);
} else {
  console.log(`结果：通过。\n`);
  process.exit(0);
}
