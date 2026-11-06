#!/usr/bin/env node
// 补历史的日摘要：给一段时间里每一天各生成一张 daily/YYYY-MM-DD.json。
//
// 用法：
//   node backfill-daily.mjs --state ../state --key group:1234567890 \
//        --from 2026-10-21 --to 2026-11-02 [--base-url https://api.deepseek.com] [--model deepseek-chat]
//
// API key 从环境变量 DEEPSEEK_API_KEY 读，或用 --env-file 指向一个 .env 文件。
// 已有的日期会跳过，所以可以反复跑到补齐为止。
import fs from 'node:fs';
import path from 'node:path';
import { buildDailySummary, readDailySummary } from './lite-recency.mjs';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`--${name} 需要一个值`);
  return v;
}

const stateDir = path.resolve(arg('state', 'state'));
const sessionKey = arg('key', '');
const from = arg('from', '');
const to = arg('to', '');
const baseUrl = arg('base-url', 'https://api.deepseek.com');
const model = arg('model', 'deepseek-chat');
const envFile = arg('env-file', '');

if (!sessionKey || !from || !to) {
  console.error('用法：node backfill-daily.mjs --state <state目录> --key <group:群号 / private:QQ号> --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(2);
}

let apiKey = process.env.DEEPSEEK_API_KEY || '';
if (!apiKey && envFile) {
  const text = fs.readFileSync(envFile, 'utf8');
  apiKey = (text.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*"?([^"\n]+)"?/m) || [])[1]?.trim() || '';
}
if (!apiKey) {
  console.error('没有拿到 DEEPSEEK_API_KEY：请设环境变量，或用 --env-file 指定文件。');
  process.exit(2);
}

const cfg = { socialV2: { lite: { baseUrl, apiKey, model, timeoutMs: 60000 } } };

const dates = [];
const start = new Date(`${from}T00:00:00+08:00`);
const end = new Date(`${to}T00:00:00+08:00`);
if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
  console.error('--from / --to 格式不对，应为 YYYY-MM-DD，且 from 不能晚于 to');
  process.exit(2);
}
for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
  dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
}

let ok = 0, skip = 0, fail = 0;
for (const date of dates) {
  if (readDailySummary({ stateDir, key: sessionKey, date })) {
    console.log(date, 'exists');
    skip += 1;
    continue;
  }
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt += 1) {
    try {
      const c = await buildDailySummary({ stateDir, key: sessionKey, date, cfg });
      console.log(date, c ? `lines=${c.content.split('\n').length} tok=${c.completionTokens}` : 'empty');
      ok += 1;
      done = true;
    } catch (e) {
      if (attempt === 2) {
        console.log(date, 'ERR', e.message);
        fail += 1;
      }
    }
  }
}
console.log(`done ok=${ok} skip=${skip} fail=${fail}`);
