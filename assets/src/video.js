// 视频：下载 / 抽帧 / 缓存（2026-10-27 从 bridge.js 拆出）。
// 职责：把「B 站链接 / QQ 视频消息 / 分享卡片」变成一张抽帧拼图交给她看，
// 以及收到消息时把带 rkey 的临时直链先抢下来缓存到 state/videocache/。
// 依赖只有 stateDir（缓存目录）和 log，都是参数注入，不碰 bridge.js 的闭包。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export function createVideoModule({ stateDir, log = console.log }) {
  // ── 看视频（2026-10-23） ──────────────────────────────────────────────
  // 她原来只会把视频消息显示成「[视频]」，什么都没看到。这里把视频变成「一张抽帧拼图」：
  // 下载（yt-dlp）→ ffmpeg 每 10 秒抽一帧拼成 2x3 的图 → 当作一张图片交给她。
  // 一张图 = 384 token 级别，比"逐帧看"便宜两个数量级。
  const VIDEO_URL_RE = /(https?:\/\/(?:b23\.tv|www\.bilibili\.com\/video|bilibili\.com\/video|youtu\.be|www\.youtube\.com\/watch)[^\s"'）)]*)/i;

  function runCmd(file, args, timeoutMs = 120000) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : '' });
      });
    });
  }

  // B 站专用下载：走 API + 匿名 buvid3，绕开 yt-dlp（它在这个机房 IP 上必吃 412）。
  // 实测：spi 拿 buvid3 → view 拿 cid → playurl 拿直链 → 带 Referer 直连 bilivideo 下载。
  // 全程不需要账号，也不碰主人的 B 站号。
  const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  async function biliApi(url, cookie) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': BILI_UA,
        'Referer': 'https://www.bilibili.com/',
        ...(cookie ? { Cookie: cookie } : {})
      },
      signal: AbortSignal.timeout(20000)
    });
    const t = await r.text();
    return JSON.parse(t);
  }

  /** B 站视频（含 b23.tv 短链）→ 本地 mp4。返回 {path,title,duration} 或 null。 */
  async function downloadBilibili(url, workDir) {
    try {
      let real = String(url);
      // b23.tv 短链要先跟一次重定向拿真实地址
      if (/b23\.tv/i.test(real)) {
        const r = await fetch(real, { redirect: 'follow', headers: { 'User-Agent': BILI_UA }, signal: AbortSignal.timeout(15000) });
        real = r.url || real;
      }
      const m = real.match(/(BV[0-9A-Za-z]{10})/);
      if (!m) { log('[video] B站链接里没解析出 BV 号：' + real.slice(0, 60)); return null; }
      const bvid = m[1];
      const spi = await biliApi('https://api.bilibili.com/x/frontend/finger/spi');
      const cookie = 'buvid3=' + (spi?.data?.b_3 || '');
      const view = await biliApi('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, cookie);
      if (!view || view.code !== 0 || !view.data) { log('[video] B站 view 失败 code=' + (view?.code)); return null; }
      const duration = Number(view.data.duration) || 0;
      if (duration > 900) { log('[video] B站视频超 15 分钟，跳过（' + duration + 's）'); return null; }
      const pu = await biliApi('https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + view.data.cid + '&qn=32&fnval=1&fourk=0', cookie);
      const vurl = pu?.data?.durl?.[0]?.url;
      if (!vurl) { log('[video] B站 playurl 没给直链 code=' + (pu?.code)); return null; }
      const resp = await fetch(vurl, {
        headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(120000)
      });
      if (!resp.ok) { log('[video] B站直链下载失败 HTTP ' + resp.status); return null; }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length || buf.length > 120 * 1024 * 1024) { log('[video] B站文件异常，跳过（' + Math.round(buf.length / 1048576) + 'MB）'); return null; }
      const out = path.join(workDir, 'bili.mp4');
      fs.writeFileSync(out, buf);
      log('[video] B站下载完成：' + String(view.data.title).slice(0, 40) + '（' + Math.round(buf.length / 1024) + 'KB，' + duration + 's）');
      return { path: out, title: String(view.data.title || ''), duration };
    } catch (error) {
      log('[video] B站下载异常：' + (error?.message ?? error));
      return null;
    }
  }

  /** 把一个视频（本地路径或 URL）变成一张抽帧拼图，失败返回 null。 */
  // 视频预取：QQ 媒体直链带 rkey，过几分钟就 "download url has expired"。
  // 收到消息时先抓到 state/videocache/，唤醒时抽帧直接读本地，不受时效影响。
  const VIDEO_CACHE_DIR = path.join(stateDir, 'videocache');
  function videoCachePath(media) {
    // 种子优先用文件名：QQ 的 media.url 里带 rkey，每次分享都不一样，
    // 拿它当种子会导致同一条视频回回都重新下载（2026-10-25 实测多下了一份 3952KB）。
    const seed = String(media?.file || '').trim() || String(media?.url || '').split('?')[0];
    const h = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
    return path.join(VIDEO_CACHE_DIR, h + '.mp4');
  }
  function cachedVideoPath(media) {
    try {
      const p = videoCachePath(media);
      if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p;
    } catch { /* 读不到就当没有 */ }
    return '';
  }
  function pruneVideoCache(maxBytes = 300 * 1024 * 1024, maxAgeMs = 3 * 86400000) {
    try {
      if (!fs.existsSync(VIDEO_CACHE_DIR)) return;
      const now = Date.now();
      const items = [];
      let total = 0;
      for (const f of fs.readdirSync(VIDEO_CACHE_DIR)) {
        const p = path.join(VIDEO_CACHE_DIR, f);
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(p); continue; }
        items.push({ p, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      }
      items.sort((a, b) => a.mtime - b.mtime);
      while (total > maxBytes && items.length) {
        const it = items.shift();
        try { fs.unlinkSync(it.p); total -= it.size; } catch { /* 删不掉就算了 */ }
      }
    } catch { /* 清理失败不影响主流程 */ }
  }
  async function prewarmVideo(media) {
    try {
      if (!media || media.kind !== 'video' || !media.url) return '';
      const has = cachedVideoPath(media);
      if (has) return has;
      fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
      pruneVideoCache();
      const out = videoCachePath(media);
      const r = await downloadDirect(media.url, out);
      if (r.ok) {
        log('[video] 预下载完成 ' + Math.round(r.bytes / 1024) + 'KB —— 唤醒时直接抽帧，不怕 rkey 过期');
        return out;
      }
      log('[video] 预下载失败：' + r.error + '（唤醒时还会再试一次）');
      return '';
    } catch (error) {
      log('[video] 预下载异常：' + (error?.message ?? error));
      return '';
    }
  }

  /** 直链下载（QQ 媒体 CDN 用的是带 rkey 的临时链接，fetch 一次就够，别绕 yt-dlp）。 */
  async function downloadDirect(url, outPath) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          referer: 'https://qun.qq.com/'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return { ok: false, error: '文件太小 ' + buf.length + 'B' };
      if (buf.length > 120 * 1024 * 1024) return { ok: false, error: '文件太大 ' + Math.round(buf.length / 1048576) + 'MB' };
      fs.writeFileSync(outPath, buf);
      return { ok: true, path: outPath, bytes: buf.length };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  // ── 台词识别（2026-10-28） ─────────────────────────────────────────────
  // SenseVoice 只给一段整文字：既没有说话人分离，也没有句级时间戳。
  // 所以按固定时长切片、每片单独识别 —— 时间码由切片自己带着，天然对齐到画面格。
  // 只给内容不给说话人：引用台词时只能说「视频里有人说」，不许指名。
  // key 只从环境变量读，绝不写进代码（推 GitHub 时才不会带出去）。
  const ASR_CACHE_DIR = path.join(stateDir, 'asr-cache');
  const ASR_BASE = String(process.env.SILICONFLOW_ASR_BASE || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const ASR_MODEL = process.env.SILICONFLOW_ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall';
  const ASR_CHUNK_SEC = 15;   // 每格最多取多少秒音频。实测硬坎：≤20s 一片 0.4~1.5 秒回来，30s 一片要 23 秒（走长音频路径）
  const ASR_CONCURRENCY = 3;  // 并发片数：开太大反而被服务端排队（实测 6 并发时有 3 片超过 8 秒）
  // 单片延迟极不稳定（同一请求实测 388ms~16 秒），所以每片都设硬超时，超时就丢这一片。
  const ASR_TIMEOUT_MS = 10000;

  /** SenseVoice 会把情绪贴成 emoji（😊🎼），去掉：她读文字不需要，还占 token。 */
  const stripEmoji = (s) => String(s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  async function transcribeChunk(videoPath, fromSec, durSec, workDir, idx) {
    const key = process.env.SILICONFLOW_API_KEY || '';
    if (!key) return null;
    const wav = path.join(workDir, 'asr' + idx + '.wav');
    const cut = await runCmd('ffmpeg', [
      '-hide_banner', '-v', 'error', '-nostdin', '-y',
      '-ss', String(fromSec.toFixed(3)), '-t', String(durSec.toFixed(3)),
      '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav
    ], 60000);
    if (!cut.ok || !fs.existsSync(wav) || fs.statSync(wav).size < 1024) return null;
    const form = new FormData();
    form.set('model', ASR_MODEL);
    form.set('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'chunk.wav');
    const res = await fetch(ASR_BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error('ASR HTTP ' + res.status + ' ' + body.slice(0, 120));
    }
    const json = await res.json();
    return stripEmoji(json?.text);
  }

  /** 按画面格切音频：每格取中间一段。片数跟着**格数**走，不跟着视频长度走——
   *  否则 9 分钟的片子要识别 22 片、四十秒，而图只有 6 格，多出来的台词没有画面锚点。
   *  @param cells - [{from,to}] 每格对应的时间段（秒） */
  async function transcribeVideo(videoPath, cells, workDir) {
    if (!(process.env.SILICONFLOW_API_KEY || '')) { log('[video] 没配 SILICONFLOW_API_KEY，跳过台词'); return []; }
    if (!cells.length) return [];
    const jobs = cells.map((c, i) => {
      const span = Math.max(0, c.to - c.from);
      const win = Math.min(span, ASR_CHUNK_SEC);                       // 每格最多取 30 秒
      const from = c.from + Math.max(0, (span - win) / 2);             // 取格子的中间段
      return { index: i, from, to: from + win };
    }).filter((j) => j.to - j.from >= 1);                              // 太短的格子（<1 秒）没得识别
    if (!jobs.length) return [];
    let failed = 0;
    const out = [];
    for (let i = 0; i < jobs.length; i += ASR_CONCURRENCY) {
      const batch = jobs.slice(i, i + ASR_CONCURRENCY);
      const got = await Promise.all(batch.map((j) => transcribeChunk(videoPath, j.from, j.to - j.from, workDir, j.index)
        .catch((e) => { failed++; log('[video] 台词切片失败：' + (e?.message ?? e)); return null; })));
      got.forEach((text, k) => { if (text) out.push({ cell: batch[k].index + 1, from: batch[k].from, to: batch[k].to, text }); });
    }
    if (failed) log('[video] 台词有 ' + failed + ' 片识别失败');
    log('[video] 台词识别完成：' + out.length + '/' + jobs.length + ' 格有内容');
    return out;
  }

  async function videoToSheet(source, opts = {}) {
    const cols = Number(opts.cols) || 2;
    const rows = Number(opts.rows) || 3;
    const everySec = Number(opts.everySec) || 10;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqvid-'));
    try {
      let videoPath = String(source || '').trim();
      if (!videoPath) return null;
      const isRemote = /^https?:/i.test(videoPath);
      let via = isRemote ? 'yt-dlp' : 'local';
      let videoTitle = '';
      if (isRemote && /bilibili\.com|b23\.tv/i.test(videoPath)) {
        const got = await downloadBilibili(videoPath, workDir);
        if (got?.path) { videoPath = got.path; via = 'bilibili-api'; videoTitle = got.title || ''; }
        else return null;
      } else if (isRemote) {
        videoPath = path.join(workDir, 'video.mp4');
        // QQ 自己的媒体直链直接 fetch 最稳（yt-dlp 对带 rkey 的 CDN 链接常常抓不动）
        const direct = await downloadDirect(source, videoPath);
        if (direct.ok) {
          via = 'direct';
        } else {
          log('[video] 直链抓取失败（' + direct.error + '），改用 yt-dlp');
          // 只下 480p 以内：看得清画面就行，2C2G 的机器经不起大文件
          const dl = await runCmd('yt-dlp', [
            '-f', 'best[height<=480]/best', '--no-playlist', '--no-warnings',
            '--max-filesize', '80M', '-o', videoPath, source
          ], 180000);
          if (!dl.ok || !fs.existsSync(videoPath)) {
            log('[video] 下载失败：' + (dl.stderr || dl.error).split('\n').slice(-1)[0]);
            return null;
          }
          via = 'yt-dlp';
        }
      }
      if (!fs.existsSync(videoPath)) return null;
      const size = fs.statSync(videoPath).size;
      if (size > 120 * 1024 * 1024) { log('[video] 文件太大，跳过：' + Math.round(size / 1048576) + 'MB'); return null; }
      // 先量时长：固定「10 秒一帧 + 2x3」遇到短视频会剩黑格，遇到长视频又会漏看后面
      let duration = 0;
      try {
        const probe = await runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath], 20000);
        duration = Number(String(probe.stdout || '').trim()) || 0;
      } catch { /* 拿不到时长就按默认走 */ }
      const wantFrames = cols * rows; // 默认 6 格
      const interval = duration > 0 ? Math.max(2, Math.round(duration / wantFrames)) : everySec;
      const frames = duration > 0 ? Math.min(wantFrames, Math.max(1, Math.ceil(duration / interval))) : wantFrames;
      const tileCols = frames <= 2 ? frames : (frames <= 4 ? 2 : 3);
      const tileRows = Math.ceil(frames / tileCols);
      log('[video] 时长 ' + Math.round(duration || 0) + 's → 每 ' + interval + ' 秒一帧 × ' + frames + ' 帧（' + tileCols + 'x' + tileRows + '）');
      // ── 2026-10-28：逐点 seek 抽帧，替代 fps+tile 一刀切 ──────────────────
      // 实测 5 分钟 1080p：5047ms → 1365ms（3.7 倍）。
      // 根因：`fps=1/N` 这条滤镜仍然要让解码器把全片每一帧都解出来、再丢掉 99%，
      // 耗时长随时长线性增长；`-ss` 是跳着解码，只解真正要用的那几帧。
      // 帧数固定，所以视频越长这个改法赚得越多。
      const sheetPath = path.join(workDir, 'sheet.jpg');
      const frameTimes = [];
      for (let i = 0; i < frames; i++) {
        // 取每段中点：第 i 段是 [i*interval, (i+1)*interval)，甩开首尾更容易抽到有内容的画面
        const t = interval * i + interval / 2;
        frameTimes.push(duration > 0 ? Math.max(0, Math.min(t, duration - 0.2)) : t);
      }
      const picked = [];
      for (let i = 0; i < frameTimes.length; i++) {
        const one = path.join(workDir, 'pick' + i + '.jpg');
        const r = await runCmd('ffmpeg', [
          '-hide_banner', '-v', 'error', '-nostdin', '-y',
          '-ss', String(frameTimes[i].toFixed(3)),
          '-i', videoPath,
          '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', one
        ], 60000);
        if (r.ok && fs.existsSync(one) && fs.statSync(one).size > 0) picked.push({ file: one, t: frameTimes[i] });
        else log('[video] 第 ' + (i + 1) + ' 帧 seek 失败（' + frameTimes[i].toFixed(1) + 's）：' + (r.stderr || r.error).split('\n').slice(-1)[0]);
      }
      if (!picked.length) { log('[video] 全部 seek 失败，放弃这次抽帧'); return null; }
      // image2 的 `f%d.jpg` 要求从 0 开始连续无缺口，重新编号
      const seq = [];
      for (let i = 0; i < picked.length; i++) {
        const dst = path.join(workDir, 'f' + i + '.jpg');
        fs.renameSync(picked[i].file, dst);
        seq.push({ file: dst, t: picked[i].t, dup: false });
      }
      // 缺帧时用最后一帧补满格子位：宁可重复也不留黑格，黑格会被读成「这段没画面」
      while (seq.length < frames) {
        const last = seq[seq.length - 1];
        const dst = path.join(workDir, 'f' + seq.length + '.jpg');
        fs.copyFileSync(last.file, dst);
        seq.push({ file: dst, t: last.t, dup: true });
      }
      const ff = await runCmd('ffmpeg', [
        '-hide_banner', '-v', 'error', '-nostdin', '-y',
        '-i', path.join(workDir, 'f%d.jpg'),
        '-vf', 'tile=' + tileCols + 'x' + tileRows,
        '-frames:v', '1', '-q:v', '4', sheetPath
      ], 120000);
      if (!ff.ok || !fs.existsSync(sheetPath)) {
        log('[video] 拼图失败：' + (ff.stderr || ff.error).split('\n').slice(-1)[0]);
        return null;
      }
      const buffer = fs.readFileSync(sheetPath);
      if (!buffer.length) return null;
      const clock = (s) => {
        const mm = Math.floor(s / 60);
        const ss = Math.round(s - mm * 60);
        return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
      };
      const cellMarks = seq.map((s, i) => '第' + (i + 1) + '格=' + clock(s.t) + (s.dup ? '(重复)' : '')).join('，');
      // 台词：失败一律降级成「只有画面」，绝不让看图跟着失败
      // 每格的时间段 = 相邻两格取帧时刻的中点，首尾各自覆盖整片两端
      const cellRanges = seq.map((s, i) => ({
        from: i === 0 ? 0 : (seq[i - 1].t + s.t) / 2,
        to: i === seq.length - 1 ? (duration > 0 ? duration : s.t + interval / 2) : (s.t + seq[i + 1].t) / 2
      }));
      // 台词按「文件指纹 + 模型 + 片长」缓存：群友重发同一个视频就不用再等一遍
      let transcript = null;
      let fp = '';
      try {
        fp = crypto.createHash('sha1')
          .update([videoPath, size, fs.statSync(videoPath).mtimeMs, ASR_MODEL, ASR_CHUNK_SEC].join('|'))
          .digest('hex').slice(0, 20);
        transcript = JSON.parse(fs.readFileSync(path.join(ASR_CACHE_DIR, fp + '.json'), 'utf8'));
        if (Array.isArray(transcript)) log('[video] 台词命中缓存：' + transcript.length + ' 段');
        else transcript = null;
      } catch { transcript = null; }
      if (!Array.isArray(transcript)) {
        try {
          transcript = await transcribeVideo(videoPath, cellRanges, workDir);
        } catch (e) {
          log('[video] 台词整体失败（不影响看图）：' + (e?.message ?? e));
          transcript = [];
        }
        // 只有「每一格都拿到台词」才缓存。
        // 部分失败也存下来的话，这个视频以后永远只有那几段 —— 2026-10-28 实测踩到：
        // 6 格里 3 片超时，结果被缓存成「3 段台词」，之后再发同一个视频也不会补。
        if (fp && transcript.length && transcript.length >= cellRanges.length) {
          try {
            fs.mkdirSync(ASR_CACHE_DIR, { recursive: true });
            fs.writeFileSync(path.join(ASR_CACHE_DIR, fp + '.json'), JSON.stringify(transcript));
          } catch { /* 缓存写不进去不影响这次结果 */ }
        }
      }
      const transcriptBlock = transcript.length
        ? '\n台词（按时间码，**没有说话人标记**：引用时只说「视频里有人说」，不许指名说谁说的）：\n'
          + transcript.map((s) => '[第' + s.cell + '格 ' + clock(s.from) + '] ' + s.text).join('\n')
        : '';
      log('[video] 抽帧完成（' + via + '，' + Math.round(size / 1024) + 'KB → ' + Math.round(buffer.length / 1024) + 'KB，' + cellMarks + '，台词 ' + transcript.length + ' 段）');
      return {
        buffer,
        mimeType: 'image/jpeg',
        note: '视频联系表（总时长 ' + Math.round(duration || 0) + ' 秒）：' + cellMarks
          + '。每格是该时刻的画面，要引用某一段就说第几格。'
          + (videoTitle ? '｜视频标题：' + videoTitle.slice(0, 60) : '')
          + transcriptBlock
      };
    } catch (error) {
      log('[video] 异常：' + (error?.message ?? error));
      return null;
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  /** 本轮消息里有没有视频：QQ 视频消息 / 消息文本里的视频链接。 */
  function findVideoSourceV2(st) {
    const pools = [];
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    pools.push(...(unread.length ? unread.slice(-6) : recent.slice(-6)));
    for (const m of pools.reverse()) {
      if (!m || m.isSelf) continue;
      const media = Array.isArray(m.media) ? m.media : [];
      for (const md of media) {
        if (!md) continue;
        // 视频段：有 url 就用 url；file 只有像绝对路径时才敢当本地文件（否则那只是个文件名）
        if (md.kind === 'video') {
          const cached = cachedVideoPath(md);
          if (cached) return { source: cached, kind: 'qq-video-cache' };
          const local = /^[/\\]/.test(String(md.file || '')) ? String(md.file) : '';
          if (md.url || local) return { source: md.url || local, kind: 'qq-video' };
        }
        // 分享卡片里的视频链接（B 站 / 抖音 / 腾讯视频）
        if (md.kind === 'card' && md.url && /b23\.tv|bilibili\.com|youtu|douyin|ixigua|v\.qq\.com|\.mp4/i.test(md.url)) {
          return { source: md.url, kind: 'card' };
        }
      }
      const hit = String(m.text || m.plain || '').match(VIDEO_URL_RE);
      if (hit) return { source: hit[1], kind: 'link' };
    }
    return null;
  }
  return {
    downloadBilibili,
    videoCachePath,
    cachedVideoPath,
    pruneVideoCache,
    prewarmVideo,
    downloadDirect,
    videoToSheet,
    findVideoSourceV2,
    VIDEO_URL_RE
  };
}
