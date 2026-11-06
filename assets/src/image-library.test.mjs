// 素材库离线测试：不联网、不碰真实 state。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageLibrary, materialLabels, matchMaterial, cleanLabel } from './image-library.mjs';

const cfgOf = (o = {}) => ({ socialV2: { imageLibrary: { maxEntries: 5, maxTotalBytes: 1e6, ...o } } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
const png = n => Buffer.alloc(64, n);

test('cleanLabel 去掉控制字符并截断', () => {
  assert.equal(cleanLabel('  a\u0000b\nc  '), 'a b c');
  assert.equal(cleanLabel('12345', 3), '123');
  assert.equal(cleanLabel(null), '');
});

test('materialLabels：空库返回空数组，不再给「（暂无）」', () => {
  assert.deepEqual(materialLabels([], 60), []);
});

test('materialLabels：localNote 与 tags 合并去重、按 limit 截断', () => {
  const entries = [
    { localNote: '憨笑', tags: ['无语'], useCount: 3 },
    { localNote: '', tags: ['憨笑', '得意'], useCount: 1 }
  ];
  const labels = materialLabels(entries, 10);
  assert.deepEqual(labels, ['得意', '无语', '憨笑'].sort((a, b) => labels.indexOf(a) - labels.indexOf(b)));
  assert.equal(labels.length, 3);
  assert.deepEqual(materialLabels(entries, 2).length, 2);
});

test('materialLabels：useCount 低的排前面，让新图先被用上', () => {
  const entries = [{ tags: ['老图'], useCount: 9 }, { tags: ['新图'], useCount: 0 }];
  assert.equal(materialLabels(entries, 1)[0], '新图');
});

test('matchMaterial：localNote 精确优先于 tags', () => {
  const entries = [
    { id: 'a', kind: 'sticker', localNote: '', tags: ['笑'], useCount: 5 },
    { id: 'b', kind: 'sticker', localNote: '笑', tags: [], useCount: 9 }
  ];
  assert.equal(matchMaterial(entries, '笑').id, 'b');
  assert.equal(matchMaterial(entries, '  笑 ').id, 'b');
  assert.equal(matchMaterial(entries, '没这个'), null);
  assert.equal(matchMaterial(entries, ''), null);
});

test('add：同一张图按 sha256 去重，不重复入库', () => {
  const lib = createImageLibrary({ stateDir: tmp(), cfg: cfgOf(), log: () => {} });
  const a = lib.add(png(1), 'image/png', { senderId: '1' });
  const b = lib.add(png(1), 'image/png', { senderId: '1' });
  assert.equal(a.sha256, b.sha256);
  assert.equal(lib.view().length, 1);
});

test('add：超 maxEntries 时淘汰最久没用的，且文件一起删', () => {
  const dir = tmp();
  const lib = createImageLibrary({ stateDir: dir, cfg: cfgOf({ maxEntries: 2 }), log: () => {} });
  const a = lib.add(png(1), 'image/png', {});
  const b = lib.add(png(2), 'image/png', {});
  lib.markUsed(b, 'test');
  const c = lib.add(png(3), 'image/png', {});
  const ids = lib.view().map(e => e.sha256);
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(a.sha256), '最久未用的应被淘汰');
  assert.ok(ids.includes(c.sha256));
  assert.equal(fs.existsSync(lib.imagePath(a)), false);
  assert.equal(fs.existsSync(lib.imagePath(b)), true);
});

test('markUsed：写回 overlay，useCount 递增', () => {
  const lib = createImageLibrary({ stateDir: tmp(), cfg: cfgOf(), log: () => {} });
  const a = lib.add(png(7), 'image/png', {});
  lib.markUsed(a, '刚才用了');
  const v = lib.view().find(e => e.sha256 === a.sha256);
  assert.equal(v.useCount, 1);
  assert.ok(v.lastUsedAt > 0);
});

test('坏库：降级只读，不覆盖原文件', () => {
  const dir = tmp();
  const file = path.join(dir, 'image-library.json');
  fs.writeFileSync(file, '{坏掉的 json');
  const lib = createImageLibrary({ stateDir: dir, cfg: cfgOf(), log: () => {} });
  assert.equal(lib.writable, false);
  assert.equal(lib.add(png(9), 'image/png', {}), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{坏掉的 json');
});

test('view：收藏表情合并 overlay 标签，且不写回 stickers.json', () => {
  const dir = tmp();
  const stickers = [{ id: 'sid1', url: 'http://x/1.gif', localNote: '', tags: [] }];
  const lib = createImageLibrary({ stateDir: dir, cfg: cfgOf(), getStickers: () => stickers, log: () => {} });
  lib.patch('sticker', 'sid1', { tags: ['憨笑'], desc: '熊猫眯眼笑' });
  const v = lib.view().find(e => e.id === 'sid1');
  assert.deepEqual(v.tags, ['憨笑']);
  assert.equal(v.kind, 'sticker');
  assert.equal(stickers[0].tags.length, 0, '原始 stickers 数组不能被动过');
  assert.ok(materialLabels(lib.view(), 10).includes('憨笑'));
});
