// 统一素材视图；收藏表情只读，补充标签和统计写在独立 overlay。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function imageConfig(cfg = {}) {
  const c = cfg.socialV2?.imageLibrary || {};
  const num = (v, d) => v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d;
  return { enabled: c.enabled !== false, maxEntries: num(c.maxEntries, 800),
    maxTotalBytes: num(c.maxTotalBytes, 1.5 * 1024 ** 3), maxPerDay: num(c.maxPerDay, 60) };
}
export function cleanLabel(value, max = 60) {
  return Array.from(String(value ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff]+/gu, ' ').trim()).slice(0, max).join('');
}
const order = (a, b) => (Number(a.useCount) || 0) - (Number(b.useCount) || 0);
export function materialLabels(entries, limit = 60) {
  const seen = new Set(), labels = [];
  if (!(limit > 0)) return labels;
  for (const e of [...entries].sort(order)) for (const text of [e.localNote, ...(Array.isArray(e.tags) ? e.tags : [])]) {
    const label = cleanLabel(text);
    if (!label || seen.has(label)) continue;
    seen.add(label); labels.push(label);
    if (labels.length >= limit) return labels;
  }
  return labels;
}
export function matchMaterial(entries, label) {
  if (typeof label !== 'string') return null;
  const wanted = cleanLabel(label);
  if (!wanted) return null;
  const pick = a => a.sort(order)[0] || null;
  // “tags 包含”指数组成员，不从图片描述或子串猜测。
  return pick(entries.filter(e => cleanLabel(e.localNote) === wanted))
    || pick(entries.filter(e => Array.isArray(e.tags) && e.tags.some(t => cleanLabel(t) === wanted)));
}
function validKnowledge(e) {
  return e && typeof e === 'object' && !Array.isArray(e)
    && (e.tags === undefined || (Array.isArray(e.tags) && e.tags.every(t => typeof t === 'string')))
    && (e.desc === undefined || typeof e.desc === 'string')
    && (e.status === undefined || ['pending', 'done', 'failed'].includes(e.status))
    && ['size', 'attempts', 'useCount', 'lastUsedAt', 'createdAt', 'messageTime'].every(k =>
      e[k] === undefined || (Number.isFinite(e[k]) && e[k] >= 0));
}
export function createImageLibrary({ stateDir, cfg = {}, getStickers = () => [], log = () => {} }) {
  const file = path.join(stateDir, 'image-library.json'), dir = path.join(stateDir, 'images');
  const limits = imageConfig(cfg);
  let writable = true, data = { version: 1, images: [], stickers: {} };
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
    if (x?.version !== 1 || !Array.isArray(x.images) || !x.stickers || typeof x.stickers !== 'object'
      || Array.isArray(x.stickers) || !Object.values(x.stickers).every(validKnowledge)
      || x.images.some(e => !validKnowledge(e) || !/^[a-f0-9]{64}$/.test(e.sha256)
        || !new RegExp('^' + e.sha256.slice(0,16) + '\\.(jpg|png|gif|webp)$').test(e.file)
        || !Number.isSafeInteger(e.size) || e.size <= 0)
      || new Set(x.images.map(e => e.sha256)).size !== x.images.length) throw Error('素材库结构无效');
    data = x;
  } catch (e) {
    if (e.code !== 'ENOENT') { writable = false; log('[pic] 素材库读取失败，只读不写: ' + e.message); }
  }
  function save() {
    if (!writable) throw Error('素材库只读');
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  function imagePath(e) {
    if (!/^[a-f0-9]{16}\.(jpg|png|gif|webp)$/.test(e?.file)) throw Error('图片文件名无效');
    return path.join(dir, e.file);
  }
  function view() {
    const stickers = getStickers();
    return [...(Array.isArray(stickers) ? stickers : []).filter(e => e?.id && e.url).map(e => {
      const overlay = Object.hasOwn(data.stickers, e.id) ? data.stickers[e.id] : {};
      return { ...e, ...overlay, tags: [...(overlay.tags ?? e.tags ?? [])], id: e.id,
        kind: 'sticker', url: e.url, localNote: e.localNote || '' };
    }), ...data.images.filter(e => fs.existsSync(imagePath(e)))
      .map(e => ({ ...e, tags: [...(e.tags || [])], kind: 'image', id: e.sha256 }))];
  }
  function patch(kind, id, fields) {
    if (!writable) return false;
    const previous = data;
    if (kind === 'sticker') {
      const old = Object.hasOwn(data.stickers, id) ? data.stickers[id] : {};
      const next = { ...old, ...fields };
      if (!validKnowledge(next)) throw Error('表情补充字段无效');
      data = { ...data, stickers: { ...data.stickers, [id]: next } };
    } else {
      const old = data.images.find(e => e.sha256 === id);
      if (!old) return false;
      const next = { ...old, ...fields, sha256: old.sha256, file: old.file, size: old.size };
      if (!validKnowledge(next)) throw Error('图库补充字段无效');
      data = { ...data, images: data.images.map(e => e === old ? next : e) };
    }
    try { save(); } catch (e) { data = previous; throw e; }
    return true;
  }
  function markUsed(e, context = '') {
    const current = view().find(v => v.kind === e.kind && v.id === e.id) || e;
    return patch(e.kind, e.kind === 'sticker' ? e.id : e.sha256, {
      useCount: (Number(current.useCount) || 0) + 1, lastUsedAt: Date.now(), lastContext: cleanLabel(context, 200) });
  }
  function add(buffer, mimeType, source = {}) {
    if (!writable || !limits.enabled || !Buffer.isBuffer(buffer) || !buffer.length) return null;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const old = data.images.find(e => e.sha256 === sha256);
    if (old) return { ...old, kind: 'image', id: old.sha256 };
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mimeType];
    if (!ext) throw Error('不支持的图片类型');
    if (!limits.maxEntries || buffer.length > limits.maxTotalBytes) return null;
    fs.mkdirSync(dir, { recursive: true });
    const name = sha256.slice(0,16) + '.' + ext, dest = imagePath({ file: name }), existed = fs.existsSync(dest);
    if (existed && !fs.readFileSync(dest).equals(buffer)) throw Error('图片文件名哈希冲突');
    if (!existed) fs.writeFileSync(dest, buffer, { flag: 'wx', mode: 0o600 });
    const entry = { sha256, file: name, mimeType, size: buffer.length,
      sourceKey: cleanLabel(source.sourceKey, 80), senderId: cleanLabel(source.senderId, 40), senderName: cleanLabel(source.senderName),
      messageTime: Number(source.messageTime) || Date.now(), messageId: cleanLabel(source.messageId, 40), context: cleanLabel(source.context, 160),
      createdAt: Date.now(), lastUsedAt: 0, useCount: 0, status: 'pending', attempts: 0, tags: [] };
    const previous = data, images = [...data.images, entry], removed = [];
    let bytes = images.reduce((n, e) => n + e.size, 0);
    while (images.length > limits.maxEntries || bytes > limits.maxTotalBytes) {
      images.sort((a,b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.createdAt - b.createdAt);
      const gone = images.shift(); bytes -= gone.size; removed.push(gone);
    }
    data = { ...data, images };
    try { save(); } catch (e) { data = previous; if (!existed) try { fs.unlinkSync(dest); } catch {} throw e; }
    // 先提交元数据，后清理无人引用的旧文件，不能删除库目录外的路径。
    for (const gone of removed) if (!images.some(e => e.file === gone.file)) try { fs.unlinkSync(imagePath(gone)); } catch {}
    return images.includes(entry) ? { ...entry, kind: 'image', id: sha256 } : null;
  }
  return { get writable() { return writable; }, limits, view, patch, markUsed, add, save, imagePath,
    labels: (limit = 60) => materialLabels(view(), limit), match: label => matchMaterial(view(), label),
    pending: () => data.images.filter(e => e.status === 'pending').map(e => ({ ...e, kind: 'image', id: e.sha256 })),
    stickerOverlay: id => Object.hasOwn(data.stickers, id) ? { ...data.stickers[id] } : {} };
}
