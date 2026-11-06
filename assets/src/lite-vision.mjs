export function createImageHistory({ ttl = 30 * 60 * 1000, limit = 200, now = Date.now } = {}) {
  const entries = new Map();
  function prune() {
    for (const [k, v] of entries) if (now() - v.at >= ttl) entries.delete(k);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }
  return {
    get(session, hash) { prune(); return entries.get(JSON.stringify([session, hash]))?.text || ''; },
    put(session, hash, text) { if (!hash || !text) return; prune(); const k = JSON.stringify([session, hash]); entries.delete(k); entries.set(k, {at: now(), text: String(text).slice(0, 500)}); prune(); }
  };
}
export function validateImageReplies(reply, selected, topReplyTo) {
  if (!Array.isArray(selected)) selected = [];
  const errors = [];
  let index = 0;
  for (const r of (Array.isArray(reply) ? reply : [reply])) {
    const currentIndex = index++;
    if (!r) continue;
    const obj = typeof r === 'object' && !Array.isArray(r) ? r : null;
    const ref = obj?.imageRef;
    if (Array.isArray(ref) || (ref != null && !/^img[1-9]\d*$/.test(String(ref)))) { errors.push('imageRef 必须是单个 imgN'); continue; }
    const image = ref ? selected[Number(String(ref).slice(3)) - 1] : null;
    if (ref && !image) { errors.push('imageRef 不存在'); continue; }
    const target = String(obj?.replyTo || (currentIndex === 0 ? topReplyTo : '') || '').replace(/^\[(m\d+)\]$/, '$1');
    if (image && target && target !== String(image.source._replyRef || '')) errors.push('imageRef 与 replyTo 不一致');
  }
  return errors;
}
