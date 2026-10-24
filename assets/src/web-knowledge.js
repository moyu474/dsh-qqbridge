// 搜索知识库：把搜到的条目按关键词存起来，下次问同类问题先查库，命中就不调付费搜索。
//
// 设计（2026-10-22 与主人定的）：
// - **不存 AI 生成的回答**：回答带人设语气，复用到别的问题会怪。只存客观条目（标题/URL/摘要/关键词）。
// - 中文用 bigram 切分做检索（和 meow-memory 同一套思路），本地算分零成本。
// - 30 天过期、同 URL 去重。
// - 独立文件 state/web-knowledge.jsonl，不进长期记忆、不参与记忆注入。

const CJK_PUNCT = /[\s\p{P}\p{S}]+/gu;

/** 中文 bigram + 英文词切分。 */
export function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(CJK_PUNCT, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return [...out];
}

/** 从一条搜索结果生成存储记录。 */
export function makeRecord({ q, title, url, snippet, tags }, now = Date.now()) {
  const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const kw = bigrams(`${q} ${clean(title, 120)} ${clean(snippet, 200)}`).slice(0, 60);
  return {
    t: now,
    q: clean(q, 120),
    kw,
    title: clean(title, 120),
    url: clean(url, 300),
    snippet: clean(snippet, 240),
    tags: Array.isArray(tags) ? tags.slice(0, 6) : []
  };
}

/** query 与记录的 bigram 重叠比例（0~1）。 */
export function scoreRecord(record, qBigrams) {
  if (!qBigrams.length || !record?.kw?.length) return 0;
  const kw = new Set(record.kw);
  let hit = 0;
  for (const b of qBigrams) if (kw.has(b)) hit += 1;
  return hit / qBigrams.length;
}

/** 查库：返回 [{record, score}]，命中阈值与 TTL 可调。 */
export function searchKnowledge(records, query, { limit = 5, minScore = 0.4, ttlMs = 30 * 86400000, now = Date.now() } = {}) {
  const qb = bigrams(query);
  if (!qb.length) return [];
  const list = Array.isArray(records) ? records : [];
  return list
    .filter((r) => r && Number(r.t) && now - Number(r.t) <= ttlMs)
    .map((r) => ({ record: r, score: scoreRecord(r, qb) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 同 URL 只留最新的一条；没有 URL 的按标题去重。 */
export function dedupeRecords(records) {
  const byKey = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r) continue;
    const key = r.url || `t:${r.title}`;
    const prev = byKey.get(key);
    if (!prev || Number(r.t) > Number(prev.t)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/** 把新记录并进旧库：去重 + 按时间截断到最多 max 条。 */
export function mergeRecords(existing, incoming, { max = 3000 } = {}) {
  const merged = dedupeRecords([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
  merged.sort((a, b) => Number(b.t) - Number(a.t));
  return merged.slice(0, max);
}

/** 把命中的记录压成给模型看的短文本（只留标题 + 摘要，不塞网页正文）。 */
export function formatKnowledge(hits, { maxChars = 1200 } = {}) {
  const lines = [];
  for (const { record, score } of hits) {
    lines.push(`- ${record.title}${record.url ? `（${record.url}）` : ''}\n  ${record.snippet}`);
    if (lines.join('\n').length > maxChars) break;
  }
  return lines.join('\n').slice(0, maxChars);
}
