import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStickerStore } from './sticker-lib.js';
import { createImageLibrary } from './image-library.mjs';
import { createImageTagger } from './image-tagger.mjs';
import { safeFetchBuffer } from './safe-fetch.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`用法：node src/backfill-image-tags.mjs [--dry-run] [--dump-labels] [--config 配置路径] [--state 状态目录]
默认读取 src 上一级的 config.json 和 state/stickers.json；补充信息保存至 image-library.json，原 stickers.json 不改。
停掉 bridge 后运行，避免两个进程同时写库；与 bridge 共用每日额度和 image-usage.jsonl。额度用完后次日重跑续接。
部署前备份源码与 state；回滚时停服务并恢复原源码，保留或移走新库、image-usage.jsonl 与 images 即可。`);
  process.exit(0);
}
function arg(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(name + ' 缺少路径'); return path.resolve(args[i + 1]); }
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configFile = arg('--config', path.join(root, 'config.json'));
  const stateDir = arg('--state', path.join(root, 'state'));
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\ufeff/, ''));
  const stickers = loadStickerStore(path.join(stateDir, 'stickers.json'));
  const library = createImageLibrary({ stateDir, cfg, getStickers: () => stickers, log: console.error });
  if (!library.writable) throw Error('素材库只读，停止补标');
  if (args.includes('--dump-labels')) console.log('可用标签：' + (library.labels(Number.isFinite(Number(cfg.socialV2?.lite?.stickerHints)) && cfg.socialV2?.lite?.stickerHints != null ? Number(cfg.socialV2.lite.stickerHints) : 60).join('、') || '这一轮不要填 sticker'));
  const pending = library.view().filter(e => e.kind === 'sticker' && !(Array.isArray(e.tags) && e.tags.length) && e.status !== 'done' && e.status !== 'failed');
  console.log(`收藏表情 ${stickers.length}，待补 ${pending.length}${args.includes('--dry-run') ? '（dry-run，不联网、不写入）' : ''}`);
  if (!args.includes('--dry-run') && !args.includes('--dump-labels')) {
    const key = cfg.socialV2?.lite?.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) throw Error('未配置 lite.apiKey 或 DEEPSEEK_API_KEY，未消耗配额');
    const tagger = createImageTagger({library, stateDir, cfg, log: console.log, fetchImage: async e => {
      const image = await safeFetchBuffer(e.url, 8 * 1024 * 1024), b = image.buffer;
      const mimeType = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp';
      return {buffer: b, mimeType};
    }});
    for (const entry of pending) tagger.enqueue(entry);
    await tagger.drain();
    console.log(`本次结束，等待下次处理：${tagger.queued}`);
    tagger.close();
  }
} catch (error) { console.error('[pic] ' + (error?.message ?? error)); process.exitCode = 1; }
