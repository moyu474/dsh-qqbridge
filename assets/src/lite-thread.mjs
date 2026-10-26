// lite 模式的「话头追踪」（2026-10-26）
//
// 问题：以前每轮只注入「最后 20 条」。群里约 14 条/小时，20 条 ≈ 1.5 小时 ——
// 一个话题聊过 1.5 小时，**开头那几条（话题怎么起的）就永远看不到了**。
// 表现是她接得上后话、接不上前因，还会把已经说过的再说一遍。
//
// 解法：不做"更大窗口"（纯烧 token），而是把窗口外**跟当前话题沾边的**捞回来，
// 拼成「开头锚点 + 中间最要紧的 6 条 + 最近 N 条」，中间如实标出略过多少条。
// 全程本地 bigram 计算，0 次 API；见 README 里 lite 那节。
//
// 为什么**不做边界判断**（第一版试过，作废）：
//   靠「连续 N 条跟主题不沾就算断了」来找话题起点，在群里极其不可靠 ——
//   "笑死""你有""我没有"三连就把话头切断了（2026-10-26 实测 45 条连续话题
//   只捞出 5 条）。改成「扩展窗口内按相关性过滤」，不沾的消息天然被滤掉，
//   也就不需要判断哪里是边界。

import { bigramsOf, STOP_CHARS } from './lite-recall.mjs';

const SIG_SPAN = 12; // 主题签名取最近 12 条
const MAX_LOOKBACK = 40; // 窗口外最多再往前看 40 条
const MAX_AGE_MIN = 180; // 超过 3 小时的不算「这个话题」
const PICK_N = 6; // 中间精选几条
const ANCHOR_N = 3; // 开头锚点几条

function textOf(m) {
  return String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').trim();
}

function sigOf(text) {
  const out = new Set();
  for (const b of bigramsOf(text)) {
    if (![...b].some((ch) => STOP_CHARS.has(ch))) out.add(b);
  }
  return out;
}

// 打分：跟签名重合越多、越像"有内容的发言"越优先；纯粹的短句/拍一拍/纯媒体直接判负。
function scoreOf(m, sig) {
  const t = textOf(m);
  if (!t) return -99;
  if (/^\[拍一拍\]/.test(t)) return -99; // 拍一拍没有内容
  if (/^\[(图片|表情|语音|视频|文件|转发)\]/.test(t)) return -99;
  let n = 0;
  for (const b of bigramsOf(t)) if (sig.has(b)) n += 1;
  if (n === 0) return -99; // 一个词都对不上，就不是当前话题
  if (m?.isSelf) n += 0.5; // 她自己说过的话，权重略高（要知道自己说过什么）
  if (/[？?]/.test(t)) n += 0.8; // 提问的句子信息量大
  if (t.length >= 8 && t.length <= 80) n += 0.5; // 太短没信息、太长占地方
  return n;
}

/**
 * 把「窗口外跟当前话题沾边的消息」抽出来，跟最近窗口拼成一个完整话头。
 *
 * @param {Array} messages 社交状态里的 recentMessages（旧 → 新，内存上限见 config.context.recentLimit）
 * @param {{recentLimit?:number, maxLookback?:number, maxAgeMin?:number}} o
 * @returns {{active:boolean, count:number, startTime:string, startSeq:any,
 *            rows:Array<{type:'msg',m:any}|{type:'gap',n:number}>, skipped:number}}
 */
export function detectThread(messages, {
  recentLimit = 20,
  maxLookback = MAX_LOOKBACK,
  maxAgeMin = MAX_AGE_MIN,
} = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const n = msgs.length;
  const empty = {
    active: false, count: n, startTime: '', startSeq: null, rows: [], skipped: 0,
  };
  // 窗口外还不够 3 条，没什么可补的
  if (n <= recentLimit + 2) return empty;

  // ① 主题签名：最近 12 条里出现过的实词 bigram。
  //    话题一长关键词会换（抽老婆 → 芙宁娜 → 歪了算谁的），所以取最近这段的全部词，
  //    不要求"同一个词从头到尾都在"。
  const sig = new Set();
  for (let i = Math.max(0, n - SIG_SPAN); i < n; i += 1) {
    for (const b of sigOf(textOf(msgs[i]))) sig.add(b);
  }
  if (!sig.size) return empty;

  // ② 扩展窗口：最近 40 条里、最近 3 小时内、跟签名沾边的
  const outEnd = n - recentLimit; // 不含：这就是「最近窗口」的起点
  const from = Math.max(0, outEnd - maxLookback);
  const nowMs = Number(msgs[n - 1]?.time || 0) || Date.now();
  const cands = [];
  for (let i = from; i < outEnd; i += 1) {
    const m = msgs[i];
    const t = Number(m?.time || 0);
    if (t && nowMs - t > maxAgeMin * 60000) continue; // 三小时前的不是"这个话题"
    const s = scoreOf(m, sig);
    if (s > 0) cands.push({ m, pos: i - from, s });
  }
  if (cands.length < 3) return empty;

  // ③ 开口那句最要紧（前因写在最前面），所以取**时间最早的 3 条**当锚点；
  //    剩下的按分数挑 6 条当"中间最要紧的几句"。
  const anchors = cands.slice(0, Math.min(ANCHOR_N, cands.length));
  const anchorPos = new Set(anchors.map((x) => x.pos));
  const picks = cands
    .filter((x) => !anchorPos.has(x.pos))
    .sort((a, b) => b.s - a.s)
    .slice(0, PICK_N)
    .sort((a, b) => a.pos - b.pos);

  // ④ 按时间顺序拼成「消息 / 省略标记」，省略多少条也告诉她（免得她以为中间没人说话）
  const items = [...anchors, ...picks].sort((a, b) => a.pos - b.pos);
  const rows = [];
  let prev = -1;
  for (const it of items) {
    const gap = it.pos - prev - 1;
    if (gap > 0) rows.push({ type: 'gap', n: gap });
    rows.push({ type: 'msg', m: it.m });
    prev = it.pos;
  }
  const tailGap = outEnd - from - prev - 1;
  if (tailGap > 0) rows.push({ type: 'gap', n: tailGap });

  const first0 = anchors[0].m;
  const t0 = Number(first0?.time || 0);
  const d0 = t0 > 0 ? new Date(t0) : null;
  const startTime = d0
    ? `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`
    : '';

  return {
    active: true,
    // 「这个话题一共聊了多少条」：从最早锚点算到最新一条
    count: n - (from + anchors[0].pos),
    startTime,
    startSeq: first0?.seq ?? null,
    rows,
    skipped: cands.length - items.length,
  };
}
