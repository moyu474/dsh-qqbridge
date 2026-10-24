// MiniMax TTS 客户端：把一段文字合成成 mp3。
//
// 设计要点：
// - **纯函数，无全局状态**：配置由调用方传进来（bridge 有自己的 config 单例与热读逻辑）。
// - 计费单位是**字符**：1 个汉字算 2 个字符，英文/标点/空格各算 1 个。
//   本地先用 countTtsChars 估算，再用返回的 usage_characters 校正（以服务端为准）。
// - 不重试重活：调用方拿到异常后自己决定降级（语音失败必须退回文字，不能哑掉）。
//
// 官方定价（platform.minimax.cn/docs/pricing/overview，2026-10）：
//   speech-2.8-hd / 2.6-hd / 02-hd       3.50 元/万字符
//   speech-2.8-turbo / 2.6-turbo / 02-turbo 2.00 元/万字符
//   音色快速复刻 9.90 元/音色（首次真正合成时计费）

export const TTS_PRICE_CNY_PER_10K = {
  'speech-2.8-hd': 3.5,
  'speech-2.8-turbo': 2.0,
  'speech-2.6-hd': 3.5,
  'speech-2.6-turbo': 2.0,
  'speech-02-hd': 3.5,
  'speech-02-turbo': 2.0,
  'speech-01-hd': 3.5,
  'speech-01-turbo': 2.0
};

/** 按 MiniMax 的计费口径估算字符数：汉字 2，其余 1。 */
export function countTtsChars(text) {
  const s = String(text ?? '');
  let n = 0;
  for (const ch of s) {
    n += /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1;
  }
  return n;
}

/** 按模型单价把字符数换算成人民币。 */
export function ttsCostCny(chars, model) {
  const unit = TTS_PRICE_CNY_PER_10K[model] ?? TTS_PRICE_CNY_PER_10K['speech-2.8-turbo'];
  return (Number(chars) || 0) / 10000 * unit;
}

/**
 * 调一次 MiniMax 同步语音合成（POST /v1/t2a_v2）。
 *
 * @param {object} o
 * @param {string} o.apiKey            必填，Bearer key
 * @param {string} [o.baseUrl]        默认 https://api.minimax.cn
 * @param {string} [o.model]          默认 speech-2.8-turbo
 * @param {string} o.text             必填
 * @param {string} o.voiceId          必填，系统/复刻音色 id
 * @param {number} [o.speed]          0.5~2
 * @param {number} [o.vol]            (0,10]
 * @param {number} [o.pitch]          -12~12
 * @param {string} [o.emotion]        happy/sad/angry/fearful/disgusted/surprised/calm
 * @param {number} [o.sampleRate]     默认 32000
 * @param {number} [o.bitrate]        默认 128000
 * @param {number} [o.timeoutMs]      默认 30000
 * @returns {Promise<{buffer: Buffer, chars: number, model: string, traceId: string, durationMs: number, audioBytes: number}>}
 */
export async function synthesizeMiniMax(o) {
  const apiKey = String(o?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('TTS 缺少 API key（socialV2.voice.tts.apiKey 或环境变量 MINIMAX_API_KEY）');
  const text = String(o?.text ?? '').trim();
  if (!text) throw new Error('TTS 文本为空');
  const baseUrl = String(o?.baseUrl || 'https://api.minimax.cn').replace(/\/+$/, '');
  const model = String(o?.model || 'speech-2.8-turbo');
  const voiceId = String(o?.voiceId ?? '').trim();
  if (!voiceId) throw new Error('TTS 缺少音色 id（socialV2.voice.tts.voiceId）');

  const voiceSetting = { voice_id: voiceId };
  if (Number.isFinite(Number(o.speed)) && Number(o.speed) > 0) voiceSetting.speed = Number(o.speed);
  if (Number.isFinite(Number(o.vol)) && Number(o.vol) > 0) voiceSetting.vol = Number(o.vol);
  if (Number.isFinite(Number(o.pitch))) voiceSetting.pitch = Number(o.pitch);
  if (o.emotion) voiceSetting.emotion = String(o.emotion);

  const body = {
    model,
    text,
    stream: false,
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: Number(o.sampleRate) || 32000,
      bitrate: Number(o.bitrate) || 128000,
      format: 'mp3',
      channel: 1
    },
    output_format: 'hex'
  };

  const started = Date.now();
  const res = await fetch(`${baseUrl}/v1/t2a_v2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(o.timeoutMs) || 30000)
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`TTS 返回不是 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`); }
  const code = json?.base_resp?.status_code;
  if (!res.ok || (code !== undefined && code !== 0)) {
    const msg = json?.base_resp?.status_msg || json?.message || raw.slice(0, 200);
    throw new Error(`TTS 失败（HTTP ${res.status} / code ${code}）：${msg}`);
  }
  const hex = json?.data?.audio;
  if (!hex || typeof hex !== 'string') throw new Error('TTS 返回里没有音频数据（data.audio 为空）');
  const buffer = Buffer.from(hex, 'hex');
  if (!buffer.length) throw new Error('TTS 音频解码后为空');
  const usage = Number(json?.extra_info?.usage_characters);
  return {
    buffer,
    chars: Number.isFinite(usage) && usage > 0 ? usage : countTtsChars(text),
    model,
    traceId: String(json?.trace_id || ''),
    durationMs: Date.now() - started,
    audioBytes: buffer.length
  };
}
