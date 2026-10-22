#!/usr/bin/env node
/**
 * Postman Collection v2.1 文档校验
 * 用法: node validate-postman.mjs <collection.json>
 * 退出码: 0 无错误, 1 有错误, 2 参数或文件错误
 */

import fs from 'node:fs';
import path from 'node:path';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const USAGE = '用法: node validate-postman.mjs <collection.json>';

const errors = [];
const warnings = [];

const err = (where, message) => errors.push({ where, message });
const warn = (where, message) => warnings.push({ where, message });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  if (argv.length !== 1 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    process.exit(argv.length === 1 ? 0 : 2);
  }
  return argv[0];
}

function collectVars(text, bag) {
  for (const m of String(text).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = m[1];
    if (!name.startsWith('$')) bag.add(name);
  }
}

function checkUrl(url, where, usedVars) {
  let raw = null;

  if (typeof url === 'string') {
    raw = url;
  } else if (isObject(url)) {
    if (typeof url.raw === 'string') raw = url.raw;
    else if (Array.isArray(url.host)) raw = `${url.host.join('.')}/${(url.path || []).join('/')}`;
    if (url.query !== undefined && !Array.isArray(url.query)) err(where, 'url.query 必须是数组');
    if (url.variable !== undefined && !Array.isArray(url.variable)) err(where, 'url.variable 必须是数组');
  } else {
    err(where, '缺少 url 或 url 类型错误');
    return;
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    err(where, 'url.raw 为空');
    return;
  }

  const trimmed = raw.trim();
  if (!/^(https?:\/\/|\{\{)/.test(trimmed)) {
    warn(where, 'URL 建议以 {{baseUrl}} 或协议开头');
  }
  if (/^https?:\/\//.test(trimmed) && !/localhost|127\.0\.0\.1/i.test(trimmed)) {
    warn(where, 'URL 硬编码了远程地址，建议改用 {{baseUrl}}');
  }
  collectVars(raw, usedVars);
}

function checkAuth(request, where) {
  if (!request.auth) return;
  if (!isObject(request.auth) || typeof request.auth.type !== 'string') {
    err(where, 'request.auth 结构不正确');
    return;
  }
  if (request.auth.type === 'bearer') {
    const list = request.auth.bearer;
    if (!Array.isArray(list)) {
      err(where, 'bearer 认证缺少 bearer 数组');
      return;
    }
    const token = list.find(x => x && x.key === 'token');
    if (!token || !String(token.value || '').trim()) {
      warn(where, 'bearer token 为空，建议使用 {{token}}');
    } else if (!String(token.value).includes('{{')) {
      warn(where, 'bearer token 不是变量，不要写明文 token');
    }
  }
}

function checkHeaders(request, where) {
  if (request.header === undefined) return;
  if (!Array.isArray(request.header)) {
    err(where, 'request.header 必须是数组');
    return;
  }
  for (const h of request.header) {
    if (!isObject(h) || typeof h.key !== 'string') {
      err(where, 'header 项缺少 key');
      continue;
    }
    const value = String(h.value ?? '');
    if (h.key.toLowerCase() === 'authorization' && value && !value.includes('{{')) {
      warn(where, `Authorization 使用了非变量值，改为 {{token}}`);
    }
  }
}

function checkBody(request, where) {
  const method = String(request.method || '').toUpperCase();
  const body = request.body;
  const needsBody = ['POST', 'PUT', 'PATCH'].includes(method);

  if (body === undefined) {
    if (needsBody) warn(where, `${method} 请求没有 body，确认是否无请求体`);
    return;
  }

  if (!isObject(body)) {
    err(where, 'request.body 必须是对象');
    return;
  }
  if (body.mode === 'raw') {
    if (typeof body.raw !== 'string' || !body.raw.trim()) {
      err(where, 'body.mode=raw 但 body.raw 为空');
    } else if (body.options?.raw?.language === 'json') {
      try {
        JSON.parse(body.raw);
      } catch {
        warn(where, 'body.raw 标记为 json 但无法解析，检查示例 JSON');
      }
    }
  }
}

function checkResponses(item, where) {
  const responses = item.response;
  if (responses === undefined) {
    warn(where, '缺少示例响应');
    return;
  }
  if (!Array.isArray(responses)) {
    err(where, 'response 必须是数组');
    return;
  }
  if (responses.length === 0) {
    warn(where, '示例响应为空');
    return;
  }
  for (const [i, res] of responses.entries()) {
    const rw = `${where}/response[${i}]`;
    if (!isObject(res)) {
      err(rw, '响应示例必须是对象');
      continue;
    }
    if (typeof res.name !== 'string' || !res.name.trim()) err(rw, '缺少响应名称');
    if (typeof res.status !== 'string' || !res.status.trim()) err(rw, '缺少 status');
    if (!Number.isInteger(res.code)) err(rw, '缺少整数 code');
    if (res.body !== undefined && typeof res.body !== 'string') {
      err(rw, '响应 body 必须是字符串');
    }
  }
}

function checkRequest(item, where, usedVars) {
  const request = item.request;
  if (!isObject(request)) {
    err(where, 'request 必须是对象');
    return;
  }

  const method = String(request.method || '').toUpperCase();
  if (!METHODS.has(method)) {
    err(where, `method 不合法: ${request.method || '(空)'}`);
  } else if (request.method !== method) {
    warn(where, `method 建议用大写: ${method}`);
  }

  checkUrl(request.url, where, usedVars);
  checkAuth(request, where);
  checkHeaders(request, where);
  checkBody(request, where);
  checkResponses(item, where);
}

function walkItems(items, folder, usedVars) {
  if (!Array.isArray(items)) {
    err(folder || 'collection', 'item 必须是数组');
    return;
  }

  const names = new Set();
  for (const [i, item] of items.entries()) {
    const where = `${folder}[${i}]`;
    if (!isObject(item)) {
      err(where, 'item 必须是对象');
      continue;
    }

    if (typeof item.name !== 'string' || !item.name.trim()) {
      err(where, '缺少 name');
    } else {
      if (names.has(item.name)) warn(where, `同一层级存在重名: ${item.name}`);
      names.add(item.name);
    }

    if (Array.isArray(item.item)) {
      walkItems(item.item, `${folder}/${item.name || i}`, usedVars);
    } else if (item.request) {
      checkRequest(item, `${folder}/${item.name || i}`, usedVars);
    } else {
      err(where, '既不是文件夹（item）也不是请求（request）');
    }
  }
}

function main() {
  const file = parseArgs(process.argv.slice(2));
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    console.error(`[错误] 文件不存在: ${file}`);
    process.exit(2);
  }

  let collection;
  try {
    collection = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`[错误] JSON 解析失败: ${e.message}`);
    process.exit(1);
  }

  if (!isObject(collection)) {
    err('root', '顶层必须是对象');
  } else {
    if (!isObject(collection.info)) {
      err('info', '缺少 info');
    } else {
      if (typeof collection.info.name !== 'string' || !collection.info.name.trim()) {
        err('info', '缺少 name');
      }
      if (typeof collection.info.schema !== 'string' || !collection.info.schema.includes('v2.1.0')) {
        err('info.schema', '必须是 Postman Collection v2.1.0');
      }
    }

    const usedVars = new Set();
    walkItems(collection.item, 'item', usedVars);

    const defined = new Map();
    if (collection.variable !== undefined) {
      if (!Array.isArray(collection.variable)) {
        err('variable', 'variable 必须是数组');
      } else {
        for (const v of collection.variable) {
          if (!isObject(v) || typeof v.key !== 'string') {
            err('variable', '变量项缺少 key');
            continue;
          }
          defined.set(v.key, v.value);
        }
      }
    }

    if (!Array.isArray(collection.item) || collection.item.length === 0) {
      err('item', 'collection 里没有请求');
    }

    for (const name of usedVars) {
      if (!defined.has(name)) warn('variable', `使用了未定义的变量 {{${name}}}（可能来自环境变量）`);
    }

    if (defined.has('token') && String(defined.get('token') || '').trim()) {
      warn('variable', 'collection 中的 token 不应有值，留空由使用者填写');
    }
    if (!defined.has('baseUrl') && usedVars.has('baseUrl')) {
      warn('variable', '使用了 {{baseUrl}} 但未定义集合变量');
    }
  }

  const rel = path.relative(process.cwd(), abs) || abs;
  console.log(`\nPostman Collection 校验 · ${rel}`);
  console.log(`名称  ${collection?.info?.name || '(未知)'}`);
  console.log('─'.repeat(56));

  if (errors.length) {
    console.log(`\n✖ 错误 ${errors.length} 项（必须修）\n`);
    errors.forEach((e, i) => console.log(`  ${i + 1}. [${e.where}] ${e.message}`));
  } else {
    console.log(`\n✔ 结构通过`);
  }

  if (warnings.length) {
    console.log(`\n⚠ 提示 ${warnings.length} 项（人工判断）\n`);
    warnings.forEach((w, i) => console.log(`  ${i + 1}. [${w.where}] ${w.message}`));
  } else {
    console.log(`\n✔ 无提示`);
  }

  console.log('\n' + '─'.repeat(56));
  if (errors.length) {
    console.log(`结果：未通过。修完 ${errors.length} 个错误后重跑。\n`);
    process.exit(1);
  }
  console.log('结果：通过。\n');
}

main();
