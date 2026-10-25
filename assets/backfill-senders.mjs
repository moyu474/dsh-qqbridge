#!/usr/bin/env node
// 一次性回填：给历史归档（10-21 ~ 10-24 那些 chat-*.jsonl）里的「群友」补上昵称和 QQ 号。
//
// 背景：activity.log 在 2026-10-25 之前只记正文不记发送者，所以冷存储里全是「群友」。
// 现在 bridge 已经改了写入格式（新消息带 [昵称(QQ号)]），但旧数据还得从别处找回人：
//   - social-v2.json 最近 40 条（带 sender / userId）
//   - lite-turns.jsonl 近 300 轮的上下文原文（每轮都带着「昵称(QQ号)：内容」）
// 匹配规则和 sync-today/archive 用的是同一份（chat-source.mjs）：正文前 10 字，
// 同一前缀只有一个人说过才补，宁缺勿错。
//
// 只补 who === '群友' 且没有 uid 的行；跑前每个文件备份成 .bak-backfill。
import fs from 'node:fs';
import path from 'node:path';
import { knownSenders, senderKey } from './src/chat-source.mjs';

const ROOT = '/root/qq-bridge';
const DIR = path.join(ROOT, 'state/memory/group___GROUP_ID__');

const known = knownSenders(ROOT);
const index = new Map();
for (const s of known) {
  if (s.isSelf || !s.sender) continue;
  const key = senderKey(s.text);
  if (!key) continue;
  const prev = index.get(key);
  if (!prev) index.set(key, { who: s.sender, uid: s.uid });
  else if (prev.who !== s.sender) index.set(key, null);
}
const usable = [...index.values()].filter(Boolean).length;
console.log(`已知发送者条目 ${known.length} 条，可用唯一映射 ${usable} 个`);

let totalFixed = 0;
let totalLeft = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  const file = path.join(DIR, f);
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  let fixed = 0;
  for (const r of rows) {
    if (r.who !== '群友' || r.uid) continue;
    const hit = index.get(senderKey(r.text));
    if (hit) {
      r.who = hit.who;
      r.uid = hit.uid;
      fixed += 1;
    }
  }
  const left = rows.filter((r) => r.who === '群友').length;
  totalFixed += fixed;
  totalLeft += left;
  if (fixed > 0) {
    fs.copyFileSync(file, file + '.bak-backfill');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    fs.writeFileSync(file.replace(/\.jsonl$/, '.txt'), rows.map((r) => `[${r.hms}] ${r.who}: ${r.text}`).join('\n') + '\n');
  }
  console.log(`${f}: 补 ${fixed} 条，仍为「群友」 ${left} 条`);
}
console.log(`\n合计补 ${totalFixed} 条，仍无昵称 ${totalLeft} 条`);
