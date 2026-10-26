#!/usr/bin/env node
// 当天滚动临时库：把「最近一次 04:00 之后」的群聊原文，实时写进 today.jsonl。
//
// 为什么要有：正式归档每天 04:00 才跑一次，所以 10-25 中午问「今天早上谁说了啥」，
// 库里最新只到 10-24 —— 今天的话要等明天凌晨才可能进库。这个脚本补的就是这个空档。
//
// 做法：每 2 分钟由 qqbridge-today-sync.timer 跑一次，从 activity.log / tool-calls.jsonl
// 重新算一遍本周期（04:00 起）的全部原文，**幂等覆盖** today.jsonl（不是追加，重跑不会重复）。
// 04:00 正式归档后周期起点翻页，这里算出来就是空的 → 删掉临时文件，等价于「正式写入后清空」。
//
// 解析规则和正式归档共用 src/chat-source.mjs，不另抄一份。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMessages, cycleStart, writeRows, listSessions, DEFAULT_GID } from './src/chat-source.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ONLY = args.find((a) => /^\d+$/.test(a));

const now = Date.now();
const { start, day } = cycleStart(now);

// 2026-10-26：原来只同步一个群（硬编码 group_GID），私聊永远没有当天库。
// 现在遍历所有会话，每个会话各写自己的 today.jsonl/.txt。
const sessions = ONLY ? [`group:${ONLY}`] : (listSessions(ROOT).length ? listSessions(ROOT) : [`group:${DEFAULT_GID}`]);

const status = { at: now, cycleStart: start, cycleDay: day, rows: 0, first: '', last: '', written: false, sessions: {} };

for (const KEY of sessions) {
  const dir = path.join(ROOT, 'state', 'memory', KEY.replace(/[:]/g, '_'));
  const jsonl = path.join(dir, 'today.jsonl');
  const txt = path.join(dir, 'today.txt');

  let rows = [];
  try {
    rows = collectMessages({ root: ROOT, key: KEY, startMs: start, endMs: now });
  } catch (error) {
    status.sessions[KEY] = { rows: 0, error: String(error?.message ?? error) };
    continue;
  }

  status.sessions[KEY] = {
    rows: rows.length,
    first: rows.length ? rows[0].hms : '',
    last: rows.length ? rows[rows.length - 1].hms : '',
    written: rows.length > 0
  };
  status.rows += rows.length;
  if (rows.length) {
    if (!status.first) status.first = rows[0].hms;
    status.last = rows[rows.length - 1].hms;
    status.written = true;
    writeRows(jsonl, rows);
  } else {
    for (const f of [jsonl, txt]) {
      try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
    }
  }
}

try {
  fs.writeFileSync(path.join(ROOT, 'state', 'today-sync.json'), JSON.stringify(status) + '\n');
} catch (error) {
  process.stderr.write('写状态失败：' + (error?.message ?? error) + '\n');
}

const parts = Object.entries(status.sessions).map(([k, v]) => `${k}=${v.rows}`).join(' ');
process.stdout.write(status.rows
  ? `[today] ${day} 04:00 起共 ${status.rows} 条（${status.first}~${status.last}）| ${parts}\n`
  : `[today] 本周期还没有对话，临时库已清空\n`);
