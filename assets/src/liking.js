// 好感度：按 QQ 号记「对每个人的感觉」，只增不减，上限 100。
// 判断主路径是 lite 每轮顺手给的 liking 字段（0/1/2），不额外调模型；
// 规则兜底负责补漏。数据存 state/liking.json，独立文件、不进长期记忆。
import fs from 'node:fs';
import path from 'node:path';

const MAX = 100;

export const TIERS = [
  { min: 0, max: 20, label: '陌生', hint: '客气、话少，不怎么搭理' },
  { min: 21, max: 50, label: '点头之交', hint: '正常贫两句，不亲近' },
  { min: 51, max: 80, label: '熟人', hint: '会开玩笑、主动接话、偶尔损他' },
  { min: 81, max: 100, label: '亲近', hint: '会撒娇、护着他、用昵称叫他' }
];

export function tierOf(score) {
  const s = Math.max(0, Math.min(MAX, Number(score) || 0));
  return TIERS.find((t) => s >= t.min && s <= t.max) || TIERS[0];
}

export function loadLiking(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveLiking(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

/** 加好感（只增不减，封顶 100）。返回加完之后的值。 */
export function addLiking(data, userId, delta, note = '', max = MAX) {
  const qq = String(userId ?? '').trim();
  if (!qq) return null;
  const cur = data[qq] && typeof data[qq] === 'object' ? data[qq] : {};
  const before = Math.max(0, Math.min(MAX, Number(cur.score) || 0));
  const add = Math.max(0, Math.min(2, Math.floor(Number(delta) || 0)));
  const cap = Math.max(1, Math.min(200, Number(max) || MAX));
  const after = Math.min(cap, before + add);
  data[qq] = {
    score: after,
    last: Date.now(),
    ...(note || cur.note ? { note: note || cur.note } : {})
  };
  return after;
}

/** 规则兜底：从一句话里推断该加多少分（只增，不给负数）。 */
export function ruleDelta(text) {
  const t = String(text ?? '');
  if (!t) return 0;
  if (/(可爱|好棒|厉害|喜欢你|喜欢大肥鱼|最好了|真乖|乖啊)/.test(t)) return 2;
  if (/(给你.{0,4}(白饭|token|吃的)|喂你|请你吃|留一口给|加个蛋)/.test(t)) return 2;
  if (/(别欺负|说得没错|帮你说|护着|站在你这边)/.test(t)) return 1;
  if (/(@|大肥鱼|小鲸鱼|在吗)/.test(t)) return 1;
  return 0;
}

/** 给模型看的一行印象。 */
export function describeLiking(data, userId, nickname = '') {
  const qq = String(userId ?? '').trim();
  const rec = data[qq];
  const score = rec ? Math.max(0, Math.min(MAX, Number(rec.score) || 0)) : 0;
  const tier = tierOf(score);
  const who = nickname ? `${nickname}（${qq}）` : qq;
  return `【你对 ${who} 的印象】${score}/100（${tier.label}：${tier.hint}）`;
}
