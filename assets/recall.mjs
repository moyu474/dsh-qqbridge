#!/usr/bin/env node
// 在群聊冷存储里按关键词检索原文（不做摘要，返回原话 + 前后文）。
//
// 用法:
//   node recall.mjs <关键词...>                  默认把命中处前后各 7 条一起摊开（一段 15 条）
//   node recall.mjs <关键词> --context=31        每段展开 31 条
//   node recall.mjs <关键词> --limit=5           最多展开 5 处命中
//   node recall.mjs <关键词> --days=2            只看最近 2 天
//   node recall.mjs <关键词> --gid=__GROUP_ID__     指定群
//
// 检索逻辑统一在 src/lite-recall.mjs：冷存储读取、时间标注、窗口渲染都只有那一份，
// 这里只负责解析参数和打印 —— 免得 CLI 和 lite 注入两边各写一套、又各自过期
// （2026-10-21 那次「一直命中 0 轮」就是这么来的）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArchive, findKeywordHits, renderContext } from './src/lite-recall.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'state', 'memory');

const argv = process.argv.slice(2);
function opt(name, def) {
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}

const GID = String(opt('gid', '__GROUP_ID__'));
const LIMIT = Number(opt('limit', 5)) || 5;
const CTX = Number(opt('context', 15)) || 15;
const DAYS = Number(opt('days', 0)) || 0;
const kw = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
if (!kw.length) {
  console.log('用法: node recall.mjs <关键词...> [--context=15] [--limit=5] [--gid=__GROUP_ID__]');
  process.exit(1);
}

const dir = path.join(OUT, `group_${GID}`);
let docs = loadArchive(dir);
if (!docs.length) {
  console.log(`冷存储里没有东西: ${dir}`);
  process.exit(1);
}
const total = docs.length;
const hasToday = docs.some((d) => d.date === new Date().toISOString().slice(0, 10));
if (DAYS > 0) {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  docs = docs.filter((d) => d.date >= since);
}

const hits = findKeywordHits(docs, kw.join(' '));
console.log(`档案 ${total} 条（含当天临时库${hasToday ? '，已就绪' : '；今天还是空的'}）｜搜索范围 ${docs.length} 条｜关键词：${kw.join(' ')}`);
if (!hits.length) {
  console.log('没搜到。试试换个词，或者先把今天的临时库刷出来：node sync-today.mjs');
  process.exit(0);
}
console.log(`命中 ${hits.length} 处，展开前 ${Math.min(LIMIT, hits.length)} 处的前后文（每段 ${CTX} 条）\n`);

const r = renderContext(docs, hits.slice(0, LIMIT), {
  span: CTX,          // 每段总条数（命中前 5 条 + 后面几条）
  perLine: 200,
  maxChars: 0,        // CLI 是「人自己想吃多少就吃多少」，不设上限
  skipRecent: false,  // 主人在手动查，今天刚聊的也要看
  header: ''
});
console.log(r.block || '（这些命中都在 30 分钟以内，lite 注入会跳过；CLI 这里已经全给了）');
