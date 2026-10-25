// 群聊原文的「采集」层：archive.mjs（每天 04:00 正式归档）和 sync-today.mjs（当天滚动临时库）
// 共用这一份解析规则。
//
// 为什么单独抽出来：10-21 那次 archive.mjs 落盘改成 {hms,ts,who,text}，而 recall.mjs 还按
// {time,user,replies} 读 —— 两边各抄一份，字段对不上也不报错，检索静默 0 命中到现在才发现。
// 同一条链上只留一份解析，写入侧改了读取侧自动跟着变。
//
// 数据来源两条（都不改，只是读）：
//   state/qq-activity.log     群消息。每行 `[HH:MM:SS] group:<gid> [x] 消息已入未读：<正文>`，没有日期
//   state/tool-calls.jsonl    我真正发到群里的话（qq_send_* 调用），带毫秒时间戳
// 所以群消息的日期只能按「归档周期起点」推：每天北京时间 04:00 切一次周期，
// hms >= 04:00 属于周期当天，hms < 04:00 属于次日凌晨。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GID = '__GROUP_ID__';

const DAY = 86400000;

/** 归档周期起点：最近一次北京时间 04:00。返回 { start, day }（day = 周期起点那天 YYYY-MM-DD）。 */
export function cycleStart(now = Date.now()) {
  const d = new Date(now);
  const t4 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime();
  const start = now >= t4 ? t4 : t4 - DAY;
  return { start, day: dateOf(start) };
}

/** YYYY-MM-DD（本地时区）。 */
export function dateOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** HH:MM:SS（本地时区）。 */
export function hmsOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 activity.log 里的 HH:MM:SS 塞回周期起点那一天，落在起点之前的算次日凌晨。 */
export function tsOfHms(hms, cycleStartMs) {
  const m = String(hms).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const base = new Date(cycleStartMs);
  let ts = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(m[1]), Number(m[2]), Number(m[3] || 0), 0).getTime();
  if (ts < cycleStartMs) ts += DAY;
  return ts;
}

/** 补昵称用的匹配键：去掉空白后取前 10 个字；短于 6 个字的不参与（「[图片]」「666」这种认不定人） */
export function senderKey(text) {
  const t = String(text ?? '').replace(/\s+/g, '').slice(0, 10);
  return t.length >= 6 ? t : '';
}

/**
 * 已知发送者清单：social-v2.json 的最近 40 条 + lite-turns.jsonl 里近 300 轮的上下文原文
 * （每轮 ctx 都带着「昵称(QQ号)：内容」）。用来给「旧格式没昵称」的 activity.log 行补人。
 */
export function knownSenders(root) {
  const stateDir = path.join(root, 'state');
  const out = [];

  // 1. social-v2：结构化，最准
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, 'social-v2.json'), 'utf8'));
    for (const c of Object.values(j?.conversations || {})) {
      for (const m of Array.isArray(c?.recentMessages) ? c.recentMessages : []) {
        if (!m || !m.text) continue;
        out.push({
          time: Number(m.time) || 0,
          text: String(m.text),
          sender: String(m.sender || ''),
          uid: String(m.userId || ''),
          isSelf: !!m.isSelf
        });
      }
    }
  } catch { /* 没有就算了 */ }

  // 2. lite-turns：每轮的 ctx 原文里，群友那几行是「昵称(QQ号)：内容」
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'lite-turns.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let turn;
      try { turn = JSON.parse(line); } catch { continue; }
      const t = Number(turn.t) || 0;
      for (const ln of String(turn.ctx || '').split('\n')) {
        const m = ln.match(/^(?:【主人】)?([^：:\n]{1,30})\((\d{5,12})\)[：:](.+)$/);
        if (!m) continue;
        out.push({ time: t, text: m[3], sender: m[1].trim(), uid: m[2], isSelf: false });
      }
    }
  } catch { /* 没有就算了 */ }

  return out;
}

/**
 * 采一段周期里的原文。
 * @param {object} o
 * @param {string} o.root          qq-bridge 根目录
 * @param {string} [o.gid]
 * @param {number} o.startMs       周期起点（也是 hms 推日期的基准）
 * @param {number} [o.endMs]       右界，默认现在
 * @returns {Array<{date:string,hms:string,ts:number,who:string,text:string}>}
 */
export function collectMessages({ root, gid = DEFAULT_GID, startMs, endMs = Date.now() } = {}) {
  const stateDir = path.join(root, 'state');
  const ACT = path.join(stateDir, 'qq-activity.log');
  const TOOL = path.join(stateDir, 'tool-calls.jsonl');
  const KEY = `group:${gid}`;
  const rows = [];
  const seen = new Set();

  const push = (r) => {
    const text = String(r.text ?? '').trim();
    if (!text) return;
    if (startMs && r.ts < startMs) return;
    if (endMs && r.ts > endMs) return;
    const key = `${r.ts}|${r.who}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ date: dateOf(r.ts), hms: hmsOf(r.ts), ts: r.ts, who: r.who, uid: String(r.uid || ''), text });
  };

  // 1. 群消息。新格式带发送者：`消息已入未读 [群友B(123456)]：正文`；
  //    今天之前的旧行只有 `消息已入未读：正文`，靠下面 social-v2 的最近 40 条尽量补。
  if (fs.existsSync(ACT)) {
    for (const line of fs.readFileSync(ACT, 'utf8').split('\n')) {
      const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\] (group:\d+) .*?消息已入未读(?: \[([^\[\]]+)\])?[：:](.*)$/);
      if (!m || m[4] !== KEY) continue;
      const hms = `${m[1]}:${m[2]}:${m[3]}`;
      let who = '群友';
      let uid = '';
      const tag = (m[5] || '').match(/^(.*?)\s*\((\d*)\)$/);
      if (tag) {
        who = tag[1].trim() || '群友';
        uid = tag[2] || '';
      }
      push({ ts: tsOfHms(hms, startMs), who, uid, text: m[6] });
    }
  }

  // 2. 我发出去的话（带真实时间戳，不用推）
  if (fs.existsSync(TOOL)) {
    for (const line of fs.readFileSync(TOOL, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== 'call' || e?.key !== KEY) continue;
      const ts = Number(e.time);
      if (!Number.isFinite(ts)) continue;
      const tool = String(e.tool || '');
      let a = e.args;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      if (!a || typeof a !== 'object') continue;
      if (/qq_send_sticker/.test(tool)) {
        // 表情包只记一个占位，别把图片 ID 当话读
        if (!startMs || ts >= startMs) push({ ts, who: '我', text: '[表情包]' });
      } else if (/qq_send_(message|group|reply|burst)/.test(tool)) {
        const arr = Array.isArray(a.messages) ? a.messages : (a.message ? [a.message] : (a.text ? [a.text] : []));
        for (const t of arr) if (typeof t === 'string' && t.trim()) push({ ts, who: '我', text: t.trim() });
      }
    }
  }

  // 3. 旧格式补昵称：今天之前的 activity.log 行没保存发送者，全显示「群友」，
  //    检索注入回去她分不清谁说的。用已知发送者清单按「正文前缀唯一匹配」补上 ——
  //    同一条内容如果不同的人都说过，就宁可不补（错配比缺更误导）。
  const known = knownSenders(root);
  if (known.length) {
    const index = new Map();
    for (const s of known) {
      if (s.isSelf || !s.sender) continue;
      const key = senderKey(s.text);
      if (!key) continue;
      const prev = index.get(key);
      if (!prev) index.set(key, { who: s.sender, uid: s.uid });
      else if (prev.who !== s.sender) index.set(key, null);
    }
    for (const r of rows) {
      if (r.who !== '群友' || r.uid) continue;
      const hit = index.get(senderKey(r.text));
      if (hit) {
        r.who = hit.who;
        r.uid = hit.uid;
      }
    }
  }

  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

/** 落一对文件：<jsonlBase>.jsonl（给程序读）+ <jsonlBase>.txt（给人看）。rows 空就不写。 */
export function writeRows(jsonlPath, rows) {
  if (!rows.length) return 0;
  const body = rows.map((r) => `[${r.hms}] ${r.who}: ${r.text}`).join('\n');
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  const tmp = jsonlPath + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, jsonlPath);
  fs.writeFileSync(jsonlPath.replace(/\.jsonl$/, '.txt'), body + '\n');
  return rows.length;
}
