// lite 模式的「往事检索」：从群聊原文冷存储（state/memory/<key>/）里捞旧话。
//
// 三条设计约束（2026-10-25 主人拍板）：
//   1. **窄触发**：只有有人在问以前的事、提老梗时才查，平时一个字都不注入。
//      每轮都塞旧话，她会把一周前的事说成刚发生的 —— 比想不起来更穿帮。
//   2. **0 成本**：只读本地文件，不调模型、不做 embedding、不建索引
//      （6 天 1331 条，全扫一遍几毫秒）。
//   3. **中文不分词**：用 bigram 交集 + IDF 打分，和 web-knowledge 一个路子。
//
// 2026-10-25 第二版：
//   - 命中不再只给那一句，而是前后各 window 条一起给（群消息短，碎片看不出在聊什么）
//   - 每条都带「MM-DD HH:MM」，每段带时间范围与「几天前」，她才能区分不同时间的事
//   - 冷存储多了「当天滚动临时库」today.jsonl（sync-today.mjs 每 2 分钟刷一次），
//     所以今天的对话也能查到；记录里的 date 字段优先于文件名（临时库文件名里没有日期）
//
// 冷存储的落盘格式（chat-source.mjs 写，别按老格式想）：
//   JSONL 每行一条 { date:"YYYY-MM-DD", hms:"03:12:40", ts:毫秒, who:"群友"|"我", text:"…" }
//   正式归档文件名 chat-YYYY-MM-DD-*.jsonl；当天临时库固定叫 today.jsonl
import fs from 'node:fs';
import path from 'node:path';

// 「有人在问往事」的触发词。宁可漏，不可滥。
export const RECALL_TRIGGER_RE = /上次|上回|前阵子|之前|以前|先前|还记得|记不记得|记得吗|忘了吗|忘了没|说过|提过|聊过|讲过|老梗|那个梗|那次|那时候|当年|好久(以前|之前)/;

// 这些词本身出现在触发句里，绝不能用它们去检索（否则每次都命中一堆废话）。
const TRIGGER_WORDS = ['上次', '上回', '之前', '以前', '先前', '记得', '说过', '提过', '聊过', '讲过', '那次', '时候', '当年', '老梗'];

// bigram 里带这些字就不当证据：它们太常见，命中不代表同一件事。
export const STOP_CHARS = new Set(
  '的了呢吗啊吧嘛呗哦噢呀哈哇嗯呃是在有没不我你他她它这那就也都还又很太更最个一了下着过要说想会给把被让对为以而且但如所什么怎样今明昨'.split(''),
);

export function bigramsOf(text) {
  const out = new Set();
  const s = String(text || '');
  // 英文/数字整词当 token：按两位切会得到 gi/it/th 这种碎片，df 太高全被 8% 阈值滤掉，
  // 结果「github 那个链接」永远搜不到（2026-10-25 实测）。
  for (const w of s.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || []) out.add(w.toLowerCase());
  for (let i = 0; i < s.length - 1; i += 1) {
    const b = s.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(b)) out.add(b);
  }
  return out;
}

/** 本轮消息里有没有人提起往事 */
export function triggerWantsRecall(texts) {
  return (Array.isArray(texts) ? texts : []).some((t) => RECALL_TRIGGER_RE.test(String(t || '')));
}

/** 从本轮消息抽检索用的 bigram，滤掉停用字和触发词本身 */
export function queryBigrams(texts) {
  const raw = new Set();
  for (const t of texts) for (const b of bigramsOf(t)) raw.add(b);
  const kept = new Set();
  for (const b of raw) {
    if ([...b].some((ch) => STOP_CHARS.has(ch))) continue;
    if (TRIGGER_WORDS.some((w) => w.includes(b) || b.includes(w))) continue;
    kept.add(b);
  }
  return kept;
}

/**
 * 读整个冷存储目录（正式归档 + 当天临时库），按时间升序。
 * 记录里的 date 优先；老文件没有 date 字段时才拿文件名里的日期兜底。
 */
export function loadArchive(dir, scope = '') {
  const docs = [];
  if (!dir || !fs.existsSync(dir)) return docs;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const seen = new Set();
  for (const f of files) {
    const m = f.match(/^chat-(\d{4}-\d{2}-\d{2})/);
    const fileDate = m ? m[1] : '';
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let r;
      try {
        r = JSON.parse(s);
      } catch {
        continue;
      }
      const text = String(r.text ?? '').trim();
      if (!text) continue;
      const date = String(r.date || fileDate || '');
      const hms = String(r.hms || '');
      const who = String(r.who || '群友');
      // 临时库和正式归档在 04:00 那几分钟可能同时存在同一句，去重一次
      const key = `${date}|${hms}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({ date, hms, who, uid: String(r.uid || ''), text, scope });
    }
  }
  docs.sort((a, b) => (a.date + a.hms).localeCompare(b.date + b.hms));
  return docs;
}

/** 刚聊过的不用再捞：它们本来就在「群里最近的消息」里。
 *  阈值取 30 分钟 —— 以前是 3 小时，结果「两小时前说的」既不在最近 20 条里、又被这里挡掉，
 *  两头够不着（2026-10-25 实测：今天 11:48 的 github 链接查不到）。 */
const RECENT_SKIP_MINUTES = 30;

function isTooRecent(doc, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (doc.date !== today) return false;
  const [h, mi] = String(doc.hms).split(':').map(Number);
  if (!Number.isFinite(h)) return false;
  const docMin = h * 60 + (mi || 0);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin - docMin < RECENT_SKIP_MINUTES;
}

/** MM-DD HH:MM：每条都带时间，她才能分清「上周说的」和「刚才说的」 */
function fmtTime(doc) {
  const md = doc.date ? doc.date.slice(5) : '??-??';
  return `${md} ${String(doc.hms || '').slice(0, 5)}`.trim();
}

/** 今天 / 昨天 / N 天前：给模型一个相对距离感 */
function agoText(doc, now = new Date()) {
  const d = doc.date ? new Date(doc.date + 'T00:00:00') : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - d.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 关键词精确匹配（CLI 用）：空格分隔的每个词都要出现。返回命中的下标。 */
export function findKeywordHits(docs, keyword) {
  const kws = String(keyword || '').split(/\s+/).filter(Boolean).map((k) => k.toLowerCase());
  if (!kws.length) return [];
  const out = [];
  docs.forEach((d, i) => {
    const t = d.text.toLowerCase();
    if (kws.every((k) => t.includes(k))) out.push({ i, score: kws.length });
  });
  return out;
}

/**
 * 把若干「命中处」渲染成带上下文的段落（lite 注入和 CLI 共用这一份）。
 * @param {Array} docs  loadArchive 的结果
 * @param {Array<{i:number,score:number}>} centers  命中的文档下标
 * @param {{span?:number, perLine?:number, maxChars?:number, header?:string}} o
 *   span    每段一共带几条（默认 10：命中前面 5 条 + 后面 4 条，话题的起因通常在命中前）
 *   perLine 每条截多少字
 *   maxChars 整块上限（CLI 设 0 即不限）
 * @returns {{block:string, hits:Array<{time:string,who:string,text:string,score:number}>}}
 */
export function renderContext(docs, centers, { span = 10, perLine = 110, maxChars = 2400, header = '', skipRecent = true } = {}) {
  // 前面多给一条：话题怎么起的大多写在命中那句之前
  const head = Math.ceil((span - 1) / 2);
  const tail = Math.max(0, span - 1 - head);
  const picked = [];
  const usedIdx = new Set();
  for (const c of centers) {
    const from = Math.max(0, c.i - head);
    const to = Math.min(docs.length - 1, c.i + tail);
    let overlap = false;
    for (let j = from; j <= to; j += 1) if (usedIdx.has(j)) overlap = true;
    if (overlap) continue; // 跟前一段重叠了就跳过，别把同一段话说两遍
    for (let j = from; j <= to; j += 1) usedIdx.add(j);
    picked.push({ center: c.i, from, to, score: c.score });
  }
  if (!picked.length) return { block: '', hits: [] };

  const lines = header ? [header] : [];
  const hits = [];
  let total = 0;
  const now = new Date();
  for (const p of picked) {
    const seg = [];
    let segLen = 0;
    for (let j = p.from; j <= p.to; j += 1) {
      const d = docs[j];
      if (skipRecent && isTooRecent(d, now)) continue; // lite 注入时刚聊过的不用重复塞给她；CLI 手动查则照给
      const mark = j === p.center ? '▶' : ' ';
      // who 里可能是昵称（新数据），带上 QQ 号跟「群里最近的消息」保持同一种写法；
      // 老数据只有「群友」，那就照实写「群友」
      const label = d.who === '我' ? '你' : (d.uid ? `${d.who || '群友'}(${d.uid})` : (d.who || '群友'));
      // 2026-10-26：标记必须打在**每一行**上。之前只按段中心判断，
      // 结果 span 把私聊的行拉进一个「群聊」段里时那一行就没有标记 —— 那是泄露口子。
      const rowTag = d.scope === 'private' ? '〔私聊〕' : '';
      const line = `${mark}${rowTag}${fmtTime(d)} ${label}：${clip(d.text, perLine)}`;
      if (maxChars && total + segLen + line.length + 40 > maxChars) break;
      seg.push(line);
      segLen += line.length + 1;
    }
    if (!seg.length) continue;
    const span = `${fmtTime(docs[p.from])} ~ ${fmtTime(docs[p.to])}`;
    const scopeTag = docs[p.center] && docs[p.center].scope === 'private' ? '｜私聊' : '';
    const head = `▸ ${span}（${agoText(docs[p.center], now)}）${scopeTag}`;
    const block = [head, ...seg].join('\n');
    if (maxChars && total + block.length + 20 > maxChars) break;
    total += block.length + 1;
    lines.push(block);
    const d = docs[p.center];
    hits.push({ time: fmtTime(d), who: d.who === '我' ? '你' : (d.who || '群友'), text: d.text, score: Number((p.score || 0).toFixed(1)) });
  }
  if (!hits.length) return { block: '', hits: [] };
  return { block: lines.join('\n'), hits };
}

/**
 * 主入口：给一批本轮消息，返回可以直接拼进 prompt 的一段文字。
 * @returns {{ block: string, hits: Array<{time:string,score:number,who:string,text:string}> }}
 */
export function recallColdStorage({ dir, dirs, texts, viewer = '', limit = 3, span = 10, maxChars = 2400, perLine = 110 } = {}) {
  // 2026-10-26：支持一次查多个会话目录（群聊 + 私聊共享记忆）。
  // dirs 的元素可以是字符串，也可以是 { dir, scope }。
  let list2 = Array.isArray(dirs) && dirs.length ? dirs : (dir ? [dir] : []);
  const docs = [];
  for (const item of list2) {
    const d = typeof item === 'string' ? item : (item && item.dir);
    const scope = typeof item === 'string' ? '' : String((item && item.scope) || '');
    if (!d) continue;
    for (const x of loadArchive(d, scope)) docs.push(x);
  }
  if (!docs.length) return { block: '', hits: [] };
  docs.sort((a, b) => (a.date + a.hms).localeCompare(b.date + b.hms));
  // 只拿「问往事的那几句话」当查询。全塞进去会被上下文里的常用词带偏 ——
  // 实测把最近 40 条一起喂进去，问「白饭」捞回来的全是「服务器」。
  const list = Array.isArray(texts) ? texts.map((t) => String(t || '')) : [];
  const seeds = list.filter((t) => RECALL_TRIGGER_RE.test(t));
  const q = queryBigrams(seeds.length ? seeds : list.slice(-1));
  if (!q.size) return { block: '', hits: [] };

  const N = docs.length;
  const docBigrams = docs.map((d) => bigramsOf(d.text));
  const df = new Map();
  for (const set of docBigrams) for (const b of q) if (set.has(b)) df.set(b, (df.get(b) || 0) + 1);

  const cands = [];
  docs.forEach((d, i) => {
    if (isTooRecent(d)) return;
    let score = 0;
    let matched = 0;
    let dfBest = Infinity;
    for (const b of q) {
      if (!docBigrams[i].has(b)) continue;
      const c = df.get(b) || 1;
      if (c / N > 0.08) continue; // 8% 以上的文档都有的 bigram 不算证据
      score += Math.log(1 + N / c);
      matched += 1;
      if (c < dfBest) dfBest = c;
    }
    // 两个以上互不相干的词撞一起才算同一件事；
    // 只命中一个词时，它得够少见（全库 <=30 条有它，约 2%）才收，避免被「视频」这种词带偏。
    const ok = matched >= 2 || (matched === 1 && dfBest <= 30);
    if (ok) cands.push({ i, score, matched });
  });
  if (!cands.length) return { block: '', hits: [] };

  cands.sort((a, b) => b.score - a.score || b.i - a.i);
  const picked = cands.slice(0, limit);
  // 只看被选中的段落里有没有私聊行（按行判断，别漏掉 span 带进来的）
  const hasPrivate = picked.some((c) => {
    for (let j = Math.max(0, c.i - 5); j <= Math.min(docs.length - 1, c.i + 5); j += 1) {
      if (docs[j] && docs[j].scope === 'private') return true;
    }
    return false;
  }) && viewer !== 'private';
  const header = hasPrivate
    ? '【以前聊过】（下面都是过去的对话，每段开头的 ▸ 是时间范围和距今多久。\n'
      + '⚠️ 标了「｜私聊」的那几段，是你和主人**私下**说的；你现在在群里。\n'
      + '你可以记得、可以因此更懂他在说什么，但**绝对不能把私聊内容说出来**：\n'
      + '不能提「你上次私聊跟我说…」，不能复述里面的任何细节、人名、数字。\n'
      + '被别人追问就说「没什么」，宁可装傻也不能漏。）'
    : (viewer === 'private'
        ? '【以前聊过】（下面都是过去的对话，每段开头的 ▸ 是时间范围和距今多久；私聊和群里的记录都在，标〔私聊〕的是你俩私下说的。别把不同时间的事混成一件，也别当成刚发生的）'
        : '【以前群里聊过】（下面都是过去的对话，每段开头的 ▸ 是时间范围和距今多久；别把不同时间的事混成一件，也别当成刚发生的。说话人后面括号里是 QQ 号，写「群友」的是早期记录没存下具体是谁的其他人）');
  return renderContext(docs, picked, { span, perLine, maxChars, header });
}
