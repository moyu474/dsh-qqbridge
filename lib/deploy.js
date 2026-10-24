/**
 * dsh-qqbridge / deploy —— 把「我们自己这套」桥接部署到目标机。
 *
 * 和只部署上游仓库不同，这里带的是**改过的引擎**：lite 模式（直连 chat/completions，
 * 一次 ¥0.001 而不是 agent 的 ¥0.2）、人格卡、图片 vision 管线、视频抽帧、掉线自检、
 * 夜间静默、连发上限、@ 解析修正……这些都固化在 assets/src/bridge.js 里。
 *
 * 【隐私边界】
 * - assets 里的引擎和人格卡已经脱敏：唯一会出现的个人信息是占位符
 *   {{OWNER_QQ}} / {{OWNER_NAME}}，由调用方参数替换。
 * - 本文件不含任何账号、密钥、群号、服务器地址。
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
const DEFAULT_DIR = '~/qq-bridge';

/* ── 基础执行 ───────────────────────────────────────────────────────── */

function ssh(host, command, timeoutMs = 300000) {
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', host, command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout ?? '').trim(),
          err: String(stderr ?? '').trim() || (err ? String(err.message || '') : '')
        });
      });
  });
}

/** 把本地目录整个推到远端：先本机 tar，再走 ssh 的 stdin。 */
function uploadTree(host, localDir, remoteDir) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `qqbridge-assets-${Date.now()}.tgz`);
    execFile('tar', ['-czf', tmp, '-C', localDir, '.'], { windowsHide: true }, (tarErr) => {
      if (tarErr) { resolve({ ok: false, err: '打包 assets 失败：' + tarErr.message }); return; }
      const remote = `mkdir -p ${remoteDir} && tar -xzf - -C ${remoteDir}`;
      const child = spawn('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', host, remote], { windowsHide: true });
      const stream = fs.createReadStream(tmp);
      let errText = '';
      child.stderr.on('data', (d) => { errText += String(d); });
      stream.pipe(child.stdin);
      child.on('close', (code) => {
        try { fs.unlinkSync(tmp); } catch {}
        resolve({ ok: code === 0, err: errText.trim(), bytes: fs.existsSync(tmp) ? 0 : undefined });
      });
      child.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {}; resolve({ ok: false, err: e.message }); });
    });
  });
}

/** 远端写文件：base64 过一层，避免引号/换行在 ssh 命令里被吃。 */
async function writeRemote(host, remotePath, content, mode = '600') {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return ssh(host, `mkdir -p "$(dirname ${remotePath})" && echo '${b64}' | base64 -d > ${remotePath} && chmod ${mode} ${remotePath} && wc -c < ${remotePath}`);
}

export function buildDeployTool() {
  return {
    name: 'qqbridge_deploy',
    description:
      '把带 lite 模式的完整桥接部署到目标机：上传引擎与人格卡 → 装依赖 → 生成 config.json → 装 DSH 端 preset/MCP → '
      + '装 systemd 服务 → 启动。所有账号/群号都必须由参数提供，插件不带任何默认值。'
      + '重复执行是安全的：已有 config.json 时只在传了对应参数才覆盖该项。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: 'ssh host 别名（必填，要求已配置免密）。' },
        installDir: { type: 'string', description: '安装目录，默认 ~/qq-bridge。' },
        ownerQQ: { type: 'string', description: '主人的 QQ 号（必填）。会替换人格卡里的 {{OWNER_QQ}}。' },
        ownerName: { type: 'string', description: '主人在群里的昵称，替换 {{OWNER_NAME}}。留空则用「主人」。' },
        sponsorName: { type: 'string', description: '最初教它说话的人（人格卡里的 {{SPONSOR_NAME}}）。留空用「群友」。' },
        groupName: { type: 'string', description: '群名（人格卡里的 {{GROUP_NAME}}）。留空用「本群」。' },
        allowGroups: { type: 'string', description: '允许接入的群号，逗号分隔。' },
        allowPrivate: { type: 'string', description: '允许私聊的 QQ 号，逗号分隔。' },
        napcatWsUrl: { type: 'string', description: 'OneBot WS 地址，默认 ws://127.0.0.1:3001。' },
        napcatHttpUrl: { type: 'string', description: 'OneBot HTTP 地址，默认 http://127.0.0.1:3000。' },
        accessToken: { type: 'string', description: 'OneBot accessToken，没设就留空。' },
        model: { type: 'string', description: 'DSH 侧模型，默认 deepseek-chat（lite 直连用这个）。' },
        skipService: { type: 'boolean', description: '只装代码和配置，不装 systemd 服务。' }
      },
      required: ['host', 'ownerQQ']
    },
    async execute(args) {
      const host = String(args?.host || '').trim();
      const ownerQQ = String(args?.ownerQQ || '').trim();
      if (!host) throw new Error('host 必填（ssh 别名）。');
      if (!/^\d{5,12}$/.test(ownerQQ)) throw new Error('ownerQQ 必填，且必须是 5~12 位数字。');
      if (!fs.existsSync(ASSETS)) throw new Error('插件 assets 目录缺失，安装不完整：' + ASSETS);

      const dir = String(args.installDir || DEFAULT_DIR).trim().replace(/^~/, '$HOME');
      const steps = [];
      const step = (ok, name, detail = '') => { steps.push({ ok, name, detail }); };

      // 1. 目标机前置
      const node = await ssh(host, 'node -v');
      if (!node.ok) throw new Error('目标机没有 node：' + node.err);
      step(true, '目标机可达', node.out);

      // 2. 推引擎
      const up = await uploadTree(host, ASSETS, dir);
      if (!up.ok) throw new Error('上传失败：' + (up.err || '无输出'));
      step(true, '引擎与人格卡已上传', dir);

      // 3. 人格卡占位符替换（{{OWNER_QQ}} / {{OWNER_NAME}}）
      // 占位符替换：sed 的替换串里 / & \ 都有特殊含义，统一转义掉再塞进去。
      const esc = (v) => String(v).replace(/[&\\/]/g, (m) => '\\' + m);
      const ownerName = esc(String(args.ownerName || '主人').trim());
      const sponsorName = esc(String(args.sponsorName || '群友').trim());
      const groupName = esc(String(args.groupName || '本群').trim());
      const fill = await ssh(host,
        `cd ${dir}/roles && sed -i 's/{{OWNER_QQ}}/${ownerQQ}/g; s/{{OWNER_NAME}}/${ownerName}/g; s/{{SPONSOR_NAME}}/${sponsorName}/g; s/{{GROUP_NAME}}/${groupName}/g' *.md && grep -l '{{' *.md 2>/dev/null | wc -l`);
      step(fill.ok, '人格卡占位符已填', fill.ok ? (fill.out.trim() === '0' ? '全部替换完成' : '仍有未替换：' + fill.out) : fill.err);

      // 4. 装依赖
      const dep = await ssh(host, `cd ${dir} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3`);
      step(dep.ok, '依赖安装', dep.ok ? dep.out.split('\n').slice(-1)[0] : dep.err.slice(0, 200));

      // 5. 生成 config.json（以现有为底稿）
      const existing = await ssh(host, `cat ${dir}/config.json 2>/dev/null || echo '{}'`);
      let cfg = {};
      try { cfg = JSON.parse(existing.out || '{}'); } catch { cfg = {}; }
      cfg.dsh = {
        baseUrl: 'http://127.0.0.1:3080',
        provider: 'deepseek-official',
        model: args.model || cfg.dsh?.model || 'deepseek-chat',
        reasoningEffort: cfg.dsh?.reasoningEffort || 'low',
        authToken: '',
        authHeader: 'authorization',
        authPrefix: 'Bearer',
        allowRemote: false,
        referringEffort: 'low'
      };
      cfg.role = { maxInjectChars: cfg.role?.maxInjectChars ?? 8000 };
      cfg.snowluma = {
        wsUrl: args.napcatWsUrl || cfg.snowluma?.wsUrl || 'ws://127.0.0.1:3001',
        httpUrl: args.napcatHttpUrl || cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000',
        accessToken: args.accessToken ?? cfg.snowluma?.accessToken ?? '',
        followDiscoveredEndpoint: cfg.snowluma?.followDiscoveredEndpoint ?? true,
        silenceWarnMs: cfg.snowluma?.silenceWarnMs ?? 600000,
        launcherPath: cfg.snowluma?.launcherPath ?? '',
        homeDir: cfg.snowluma?.homeDir ?? ''
      };
      cfg.ownerQQ = ownerQQ;
      cfg.agentPreset = cfg.agentPreset || 'qq-chat-v2';
      cfg.workspaceTitle = cfg.workspaceTitle || 'QQ 聊天';
      cfg.allow = {
        private: args.allowPrivate ?? cfg.allow?.private ?? '',
        groups: args.allowGroups ?? cfg.allow?.groups ?? '',
        deny: cfg.allow?.deny ?? { private: '', groups: '' },
        allowAllWhenEmpty: cfg.allow?.allowAllWhenEmpty ?? false
      };
      cfg.sendDelayMs = cfg.sendDelayMs ?? 300;
      cfg.consolePort = cfg.consolePort ?? 3100;
      cfg.consoleToken = cfg.consoleToken ?? '';

      const wrote = await writeRemote(host, `${dir}/config.json`, JSON.stringify(cfg, null, 2), '600');
      step(wrote.ok, 'config.json 已生成', wrote.ok ? wrote.out.trim() + ' 字节' : wrote.err);
      if (!cfg.allow.groups && !cfg.allow.private) {
        steps.push({ ok: false, name: '白名单为空', detail: '没填群号/私聊号，桥接谁都接不进来（除非 allowAllWhenEmpty=true，但那等于把账号交给模型）' });
      }

      // 6. DSH 端 preset + MCP（漏了这步，QQ 上毫无反应）
      const dshSetup = await ssh(host, `cd ${dir} && node scripts/setup-dsh.mjs 2>&1 | tail -8`);
      step(dshSetup.ok, 'DSH 端 preset/MCP', dshSetup.ok ? dshSetup.out.split('\n').filter(Boolean).slice(-2).join(' / ') : dshSetup.err.slice(0, 300));

      // 7. systemd
      if (!args.skipService) {
        const unit = `[Unit]
Description=QQ <-> DSH bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${dir.replace('$HOME', '/root')}
ExecStart=/usr/bin/env node src/bridge.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
        const svc = await writeRemote(host, '/etc/systemd/system/qqbridge.service', unit, '644');
        const enable = await ssh(host, 'systemctl daemon-reload && systemctl enable qqbridge && systemctl restart qqbridge && sleep 4 && systemctl is-active qqbridge');
        step(svc.ok && enable.out.trim() === 'active', 'systemd 服务', enable.out.trim() || enable.err.slice(0, 200));
      }

      const bad = steps.filter((s) => !s.ok);
      return [
        steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? '：' + s.detail : ''}`).join('\n'),
        '',
        bad.length
          ? `有 ${bad.length} 步没成：${bad.map((b) => b.name).join('、')}`
          : '部署完成。接下来：① 协议端扫码登录 ② qqbridge_status 看服务 ③ 群里 @ 它试一句',
        '',
        '别忘了这几件事（都是踩过的坑）：',
        '- 协议端（NapCat/SnowLuma）要单独装并扫码，桥接不会替你装',
        '- DSH 端 preset 装完要重启 dsh web 才生效',
        '- 人格卡在 ' + dir + '/roles/，改完要重启 qqbridge'
      ].join('\n');
    }
  };
}
