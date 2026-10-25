#!/usr/bin/env node
// 群聊冷存储：每天 04:00 把「刚结束的那个归档周期」（昨天 04:00 → 今天 04:00）的原文导出来。
// 只存原文，不压缩、不摘要 —— 主人定的口径：宁可多占存储，也不用二手摘要替代原话。
//
// 解析规则统一在 src/chat-source.mjs，和当天滚动临时库 sync-today.mjs 共用一份
// （10-21 那次写入侧改了字段、读取侧没跟上，静默 0 命中了两天，所以不再各抄一套）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMessages, cycleStart, writeRows, DEFAULT_GID } from './src/chat-source.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'memory');
const SESSIONS_FILE = path.join(STATE, 'sessions.json');

const args = process.argv.slice(2);
const GID = args.find((a) => /^\d+$/.test(a)) || DEFAULT_GID;
const KEY = `group:${GID}`;
const SAFE = KEY.replace(/[:]/g, '_');
const DO_SWITCH = args.includes('--switch');
const outDir = path.join(OUT, SAFE);

const now = Date.now();
const { start } = cycleStart(now);
// 归档的是「刚结束」的周期：上一个 04:00 到现在。activity.log 里只有 HH:MM:SS，
// 日期就按这个起点往回推（04:00 之前的算次日凌晨）——所以 startMs 传周期起点而不是 0。
const cycleFrom = start - 86400000;
// 文件名里的时间戳沿用原来那套（UTC ISO 截断），只当排序用，日期部分下面按内容取。
const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);

const rows = collectMessages({ root: ROOT, gid: GID, startMs: cycleFrom, endMs: now });
console.log(`周期 ${new Date(cycleFrom).toLocaleString('zh-CN', { hour12: false })} 起：群消息 + bot 回复 = ${rows.length} 条`);

if (rows.length) {
  // 文件名用「内容里最早那条的本地日期」，别用 UTC 日期 —— 04:00 CST = 前一日 20:00 UTC，
  // 按 UTC 起名会让文件名和内容差一天，翻目录时看着别扭。
  const outFile = path.join(outDir, `chat-${rows[0].date}-${stamp}.jsonl`);
  writeRows(outFile, rows);
  console.log('归档 ->', outFile.replace(/\.jsonl$/, '.txt'), `(${(fs.statSync(outFile).size / 1024).toFixed(0)}KB)`);
  console.log('时间跨度:', rows[0].hms, '~', rows[rows.length - 1].hms);
} else {
  console.log('没有新消息，本次不生成归档文件');
}

// 临时库在周期翻页后 sync-today 本来也会清；这里再顺手删一次，
// 免得 04:00 前后那几分钟出现「正式库和临时库各有一份、内容还重叠」。
for (const f of ['today.jsonl', 'today.txt']) {
  try {
    fs.unlinkSync(path.join(outDir, f));
    console.log('清掉临时库', f);
  } catch { /* 没有就算了 */ }
}

if (DO_SWITCH) {
  // 注意：sess 必须在这里读出来。之前 --switch 分支直接引用了一个从没声明过的
  // sess，跑起来就是 ReferenceError: sess is not defined —— 归档成功、切会话失败，
  // 定时任务里会表现为「每天 4 点都白跑」。（2026-10-21 修）
  let sess = { sessions: {}, sessionPolicies: {} };
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      sess = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (error) {
      console.error('sessions.json 解析失败，本次不切会话：', error?.message ?? error);
      process.exit(2);
    }
    const bak = SESSIONS_FILE + '.bak-' + Date.now();
    fs.copyFileSync(SESSIONS_FILE, bak);
    console.log('已备份', bak);
  }
  sess.sessions = sess.sessions || {};
  delete sess.sessions[KEY];
  if (sess.sessionPolicies) delete sess.sessionPolicies[KEY];
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sess, null, 2));
  console.log('已切新会话（' + KEY + ' 的映射已删除）——需重启 bridge');
} else {
  console.log('（未切会话，加 --switch 才切）');
}
