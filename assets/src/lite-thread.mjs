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

const SIG_SPAN = 16; // 主题签名取最近 16 条（12 条时签名经常太稀疏，见 sigOf 里的注释）
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
  // 单字轨道（2026-10-26）。只靠 bigram 时签名会稀疏到失效：
  // 实测 43 条连续话题，最近 12 条算出来的签名只有 8 个词（抽卡/卡歪/兜底/哪里/保底/抽错/抽完/完先）——
  // 「歪了」「了就歪了」全被停用字滤掉，"歪"这个核心字根本没进去，
  // 于是「歪完记得给我饭」明明是同话题却一个都撞不上，话头一直不激活。
  // 所以每条消息的实词单字也进签名，用 # 前缀和 bigram 区分（打分时权重减半）。
  for (const ch of String(text || '')) {
    if (/[\u4e00-\u9fa5]/.test(ch) && !STOP_CHARS.has(ch)) out.add('#' + ch);
  }
  return out;
}

// 打分：跟签名重合越多、越像"有内容的发言"越优先；纯粹的短句/拍一拍/纯媒体直接判负。
function scoreOf(m, sig) {
  const t = textOf(m);
  if (!t) return -99;
  if (/^\[拍一拍\]/.test(t)) return -99; // 拍一拍没有内容
  if (/^\[(图片|表情|语音|视频|文件|转发)\]/.test(t)) return -99;
  // 纯称呼单独一条（「主人——」「主人~」这种）没有信息量，别捞 ——
  // 捞回来只会让她照着再叫一遍（2026-10-26 实测：捞回的锚点里两条是光秃秃的「主人——」）。
  if (/^主人[—\-－~～。，、!！?？\s]*$/.test(t)) return -99;
  let n = 0;
  for (const g of sigOf(t)) {
    if (!sig.has(g)) continue;
    n += g.startsWith('#') ? 0.5 : 1; // 单字权重减半：撞一个字比撞一个词弱
  }
  if (n === 0) return -99; // 一个词、一个字都对不上，就不是当前话题
  // 注意：这里**不要**给自己说的话加分（2026-10-26 改）。
  // 原来写的是 `if (m.isSelf) n += 0.5`，理由「让她知道自己说过什么」——
  // 结果精选全挑她自己的话，捞回来的 8 条里 6 条是「主人——」「歪了算谁的」，
  // 等于给她示范「这个话题就是要一遍遍问主人」，她下一轮就照着造句。
  // 「她说过什么」她本来就能在最近 20 条里看到，捞回老消息是为了「话题怎么起的」。
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
  // 锚点全是她自己说的，就补一条对方的（话题的骨架通常两边都有，
  // 光放她自己的追问，等于示范她继续追问）。2026-10-26。
  if (anchors.length && anchors.every((x) => x.m && x.m.isSelf)) {
    const other = cands.find((x) => x.m && !x.m.isSelf && !anchors.includes(x));
    if (other) anchors.push(other);
  }
  const anchorPos = new Set(anchors.map((x) => x.pos));
  // 精选名额：**先给对方的发言留够位置**（2026-10-26）。
  // 原来纯按分数挑，可她的消息本来就多（那段对话 27:10），捞回来的自然一片全是她自己说的话——
  // 实测 8 条里 6 条是「主人——」「歪了算谁的」，等于给她示范「这个话题就是一遍遍问主人」，
  // 下一轮她就照着造句。现在只要有对方的发言，就先占 2 个名额，其余才按分数轮到她。
  const POOL = cands.filter((x) => !anchorPos.has(x.pos)).sort((a, b) => b.s - a.s);
  const fromOther = POOL.filter((x) => x.m && !x.m.isSelf).slice(0, 2);
  // **捞回的她自己的发言总共不超过 3 条**（含锚点里已经占掉的，2026-10-26）。
  // 原因：她自己说过什么，最近 20 条里本来就看得到；捞一堆回来的唯一效果
  // 是照着那份材料继续自言自语（实测 8 条里 7 条是她的「主人——」「歪了算谁的」）。
  // 这个话头里对方压根没说几句话时（比如只有一句「算我的」），就少捞点，别硬凑。
  const mineQuota = Math.max(0, 3 - anchors.filter((x) => x.m && x.m.isSelf).length);
  const fromMine = POOL.filter((x) => x.m && x.m.isSelf).slice(0, mineQuota);
  const picks = [...fromOther, ...fromMine].slice(0, PICK_N).sort((a, b) => a.pos - b.pos);

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
  // 开头就是「（……中间 18 条略……）」读着很别扭 —— 锚点之前那段是「别的话题」，
  // 跟她要回忆的这个话头无关，直接不输出，别在列表头上挂一句省略（2026-10-26 实测）。
  if (rows.length && rows[0].type === 'gap') rows.shift();

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
