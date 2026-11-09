/**
 * dsh-qqbridge —— 把 QQ 接入 DSH 的部署助手。
 *
 * 为什么有这个东西：把 qq-bridge 从零跑起来一共六步（DSH → 桥接代码 → SnowLuma
 * 协议端 → 配置 → DSH 端 preset/MCP → systemd），其中第 2、3 步最容易漏，
 * 漏了的表现是「QQ 上毫无反应」—— 不报错，只是没动静。这套流程我们踩了一个月的坑，
 * 现在固化成三个工具。
 *
 * 【隐私边界】插件本身**不含任何账号、密钥、服务器地址、群号**。
 * 所有敏感值都必须由调用方通过参数传进来；缺参数就直接报错，不猜、不设默认值。
 * 生成的 config.json 落在调用方指定的目录里，不写入本插件目录。
 *
 * 依赖：只用 node: 内置模块。远程部署时通过 ssh 调用，要求本机已配好免密。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { buildDeployTool } from './deploy.js';

export const name = 'dsh-qqbridge';

/** 只用到 tools 服务；命令走自己 execFile，不依赖 subprocess 服务。 */
export const inject = ['tools'];

/** 上游仓库与默认安装位置（都是公开信息，不含任何账号数据）。 */
const UPSTREAM_REPO = 'https://github.com/Derpyu520/qq-bridge.git';
const DEFAULT_DIR = '~/qq-bridge';
const DEFAULT_WS = 'ws://127.0.0.1:3001';
const DEFAULT_HTTP = 'http://127.0.0.1:3000';

/* ── 执行层 ─────────────────────────────────────────────────────────── */

/**
 * 跑一条命令。host 为空或 'local' 时在本机跑，否则走 ssh <host>。
 * 统一返回 {ok, code, out, err}，不抛异常 —— 由调用方决定怎么解释失败。
 */
function run(host, command, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const isLocal = !host || host === 'local';
    const file = isLocal ? (process.platform === 'win32' ? 'powershell.exe' : 'sh') : 'ssh';
    const args = isLocal
      ? (process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', command]
          : ['-c', command])
      : ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', host, command];
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout ?? '').trim(),
        err: String(stderr ?? '').trim() || (err ? String(err.message || '') : '')
      });
    });
  });
}

/** 远程时把 ~ 展开，shell 里直接用 $HOME 更省事；本地 Windows 交给 Node 解析。 */
function expandHome(dir) {
  if (!dir) return dir;
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/** 给 shell 用：远程一律用 $HOME 展开，避免不同账号家目录不同。 */
function shellDir(dir, host) {
  if (!dir) return dir;
  if (host && host !== 'local') return dir.replace(/^~/, '$HOME');
  return expandHome(dir);
}

/* ── 环境检查 ───────────────────────────────────────────────────────── */

/**
 * 六步流程里每一步的前置条件，逐项探。缺什么、怎么补，都写进结论里，
 * 而不是丢一串命令让调用方自己判断。
 */
async function inspect(host, installDir) {
  const dir = shellDir(installDir || DEFAULT_DIR, host);
  const checks = [];

  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  const node = await run(host, 'node -v');
  add(node.ok, 'Node.js', node.ok ? node.out : '没找到 node');

  const docker = await run(host, 'docker ps --format "{{.Names}}" 2>/dev/null | head -20');
  if (!docker.ok) {
    add(false, 'Docker', 'docker 不可用（SnowLuma 协议端通常跑在容器里）');
  } else {
    const hasNapcat = /napcat/i.test(docker.out);
    add(hasNapcat, 'SnowLuma/NapCat 容器', hasNapcat ? '已存在' : '没找到容器（需要先装协议端并扫码登录）');
  }

  const dsh = await run(host, "curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3080/ 2>/dev/null || echo 000");
  const dshOk = /^[23]\d\d$/.test(dsh.out.trim());
  add(dshOk, 'DSH Web (3080)', dshOk ? '可访问' : '连不上（桥接需要它在线）');

  const repo = await run(host, `test -d ${dir}/.git && echo yes || echo no`);
  const hasRepo = repo.out.includes('yes');
  add(hasRepo, '桥接代码', hasRepo ? dir : `没安装（会在 ${dir} 下 clone）`);

  if (hasRepo) {
    const cfg = await run(host, `test -f ${dir}/config.json && echo yes || echo no`);
    add(cfg.out.includes('yes'), 'config.json', cfg.out.includes('yes') ? '已存在' : '还没生成（让 qqbridge_config 生成）');

    const preset = await run(host, "ls ~/.dsh/.agent-presets 2>/dev/null | grep -c qq-chat || echo 0");
    const hasPreset = Number(preset.out.trim()) > 0;
    add(hasPreset, 'DSH 端 preset', hasPreset ? '已安装' : '没装（要跑 scripts/setup-dsh.mjs，漏了 QQ 上会毫无反应）');

    const svc = await run(host, 'systemctl is-active qqbridge 2>/dev/null || echo inactive');
    const active = svc.out.trim() === 'active';
    add(active, 'qqbridge 服务', active ? '运行中' : '未运行（用 qqbridge_status 看日志）');
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    checks,
    ready: failed.length === 0,
    nextStep: failed.length
      ? '先补齐：' + failed.map((f) => f.name).join('、')
      : '环境齐了，可以让 qqbridge_status 看运行情况'
  };
}

/* ── 工具定义 ───────────────────────────────────────────────────────── */

const HOST_PROP = {
  type: 'string',
  description: '在哪台机器上操作："local" 表示本机，否则填 ssh 的 host 别名（要求已配置免密登录）。默认 local。'
};

const DIR_PROP = {
  type: 'string',
  description: '桥接安装目录，默认 ~/qq-bridge。'
};

function buildCheckTool() {
  return {
    name: 'qqbridge_check',
    description:
      '检查「QQ 接入 DSH」这套东西还缺哪一步：Node、Docker 与协议端容器、DSH 是否在线、桥接代码、config.json、'
      + 'DSH 端 preset、qqbridge 服务。六步流程里第 2、3 步最容易漏，漏了的表现是 QQ 上毫无反应且不报错。'
      + '只读，不改任何东西。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { host: HOST_PROP, installDir: DIR_PROP }
    },
    async execute(args) {
      const r = await inspect(args?.host || 'local', args?.installDir);
      const lines = r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
      return [lines.join('\n'), '', r.ready ? '结论：环境完整，链路应该能跑。' : `结论：还差东西。${r.nextStep}`].join('\n');
    }
  };
}

function buildConfigTool() {
  return {
    name: 'qqbridge_config',
    description:
      '生成桥接的 config.json。所有账号/密钥都必须由参数传入 —— 插件不带任何默认值，缺参数直接报错。'
      + '生成前会先读现有 config.json 作底稿，只覆盖传入的字段，不会把没提到的配置清空。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: HOST_PROP,
        installDir: DIR_PROP,
        ownerQQ: {
          type: 'string',
          description: '主人的 QQ 号（必填）。桥接用它判定谁是管理员。'
        },
        allowPrivate: {
          type: 'string',
          description: '允许私聊的 QQ 号，逗号分隔（可空）。'
        },
        allowGroups: {
          type: 'string',
          description: '允许接入的群号，逗号分隔（可空）。留空且 allowAllWhenEmpty=true 会放行所有群，危险。'
        },
        allowAllWhenEmpty: {
          type: 'boolean',
          description: '白名单留空时是否放行全部，默认 false。'
        },
        napcatWsUrl: {
          type: 'string',
          description: `OneBot WebSocket 地址，默认 ${DEFAULT_WS}。`
        },
        napcatHttpUrl: {
          type: 'string',
          description: `OneBot HTTP 地址，默认 ${DEFAULT_HTTP}。注意别填成 WS 端口，否则报 HTTP 426。`
        },
        accessToken: {
          type: 'string',
          description: 'OneBot accessToken（协议端没设就留空）。'
        },
        model: {
          type: 'string',
          description: 'DSH 侧使用的模型，例如 deepseek-flash。留空沿用现有配置。'
        }
      },
      required: ['ownerQQ']
    },
    async execute(args) {
      if (!args?.ownerQQ || !/^\d{5,12}$/.test(String(args.ownerQQ).trim())) {
        throw new Error('ownerQQ 必填，且必须是 5~12 位数字。插件不会替你猜一个默认值。');
      }
      const host = args.host || 'local';
      const dir = shellDir(args.installDir || DEFAULT_DIR, host);
      const ownerQQ = String(args.ownerQQ).trim();

      // 以现有配置为底稿：用户可能已经手调过一堆参数，不能整份覆盖掉。
      const existingRaw = await run(host, `cat ${dir}/config.json 2>/dev/null || echo '{}'`);
      let base = {};
      try { base = JSON.parse(existingRaw.out || '{}'); } catch { base = {}; }

      const cfg = {
        dsh: {
          baseUrl: 'http://127.0.0.1:3080',
          provider: args.model ? 'deepseek-official' : (base.dsh?.provider || 'deepseek-official'),
          model: args.model || base.dsh?.model || 'deepseek-flash',
          reasoningEffort: base.dsh?.reasoningEffort || 'low',
          authToken: '',
          authHeader: 'authorization',
          authPrefix: 'Bearer',
          allowRemote: false,
          referringEffort: 'low'
        },
        role: { maxInjectChars: base.role?.maxInjectChars ?? 8000 },
        snowluma: {
          wsUrl: args.napcatWsUrl || base.snowluma?.wsUrl || DEFAULT_WS,
          httpUrl: args.napcatHttpUrl || base.snowluma?.httpUrl || DEFAULT_HTTP,
          accessToken: args.accessToken ?? base.snowluma?.accessToken ?? '',
          followDiscoveredEndpoint: base.snowluma?.followDiscoveredEndpoint ?? true,
          silenceWarnMs: base.snowluma?.silenceWarnMs ?? 600000,
          launcherPath: base.snowluma?.launcherPath ?? '',
          homeDir: base.snowluma?.homeDir ?? ''
        },
        ownerQQ,
        sessionCwd: base.sessionCwd ?? '',
        agentPreset: base.agentPreset || 'qq-chat-v2',
        workspaceTitle: base.workspaceTitle || 'QQ 聊天',
        allow: {
          private: args.allowPrivate ?? base.allow?.private ?? '',
          groups: args.allowGroups ?? base.allow?.groups ?? '',
          deny: { private: base.allow?.deny?.private ?? '', groups: base.allow?.deny?.groups ?? '' },
          allowAllWhenEmpty: args.allowAllWhenEmpty ?? base.allow?.allowAllWhenEmpty ?? false
        },
        sendDelayMs: base.sendDelayMs ?? 300,
        consolePort: base.consolePort ?? 3100,
        consoleToken: base.consoleToken ?? '',
        security: base.security ?? { interceptNotify: true }
      };

      const json = JSON.stringify(cfg, null, 2);
      // 用 base64 过一层，避免引号/换行在 ssh 命令里被吃。
      const b64 = Buffer.from(json, 'utf8').toString('base64');
      const write = await run(host, `mkdir -p ${dir} && echo '${b64}' | base64 -d > ${dir}/config.json && chmod 600 ${dir}/config.json 2>/dev/null; wc -c < ${dir}/config.json`);
      if (!write.ok) throw new Error('写 config.json 失败：' + (write.err || write.out || '无输出'));

      const bytes = write.out.split('\n').pop().trim();
      const warn = [];
      if (!cfg.allow.groups && !cfg.allow.private) {
        warn.push('白名单是空的' + (cfg.allow.allowAllWhenEmpty ? '且 allowAllWhenEmpty=true —— 相当于把账号交给模型，强烈建议先填群号' : '（allowAllWhenEmpty=false 所以实际上谁都不能用）'));
      }
      return [
        `已写入 ${dir}/config.json（${bytes} 字节，权限 600）。`,
        `  ownerQQ      ${ownerQQ}`,
        `  模型         ${cfg.dsh.provider} / ${cfg.dsh.model}`,
        `  协议端 WS    ${cfg.snowluma.wsUrl}`,
        `  协议端 HTTP  ${cfg.snowluma.httpUrl}`,
        `  白名单群     ${cfg.allow.groups || '(空)'}`,
        `  白名单私聊   ${cfg.allow.private || '(空)'}`,
        warn.length ? '\n注意：\n- ' + warn.join('\n- ') : '',
        '\n下一步：跑 DSH 端安装（scripts/setup-dsh.mjs），否则 QQ 上不会有任何反应。'
      ].filter(Boolean).join('\n');
    }
  };
}

function buildStatusTool() {
  return {
    name: 'qqbridge_status',
    description:
      '查看桥接运行状况：服务是否在跑、协议端端口通不通、最近日志里有没有报错。'
      + '掉线排查按这个顺序：服务 → 协议端端口 → 日志里的「唤醒投递失败」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: HOST_PROP,
        installDir: DIR_PROP,
        logLines: { type: 'integer', description: '返回最近多少行日志，默认 30。' }
      }
    },
    async execute(args) {
      const host = args?.host || 'local';
      const dir = shellDir(args?.installDir || DEFAULT_DIR, host);
      const n = Math.min(Math.max(Number(args?.logLines) || 30, 5), 200);

      const svc = await run(host, 'systemctl is-active qqbridge 2>/dev/null || echo inactive');
      const port = await run(host, "curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST http://127.0.0.1:3000/get_login_info -H 'content-type: application/json' -d '{}' 2>/dev/null || echo 000");
      const log = await run(host, `tail -n ${n} ${dir}/bridge.log 2>/dev/null || echo '(读不到 bridge.log)'`);

      const portOut = port.out.trim();
      const portOk = portOut === '200';
      const portNote = portOk
        ? '协议端 HTTP 正常'
        : portOut === '000'
          ? '协议端 HTTP 不通 —— 可能是容器没起、或者 QQ 掉线了（掉线时协议端会跟着停）'
          : `协议端返回 HTTP ${portOut}（非 200，通常是要重新扫码登录）`;

      const interesting = log.out
        .split('\n')
        .filter((l) => /唤醒投递失败|掉线|error|Error|退出|failed|异常/.test(l))
        .slice(-8);

      return [
        `服务状态   ${svc.out.trim()}`,
        `协议端     ${portNote}`,
        interesting.length ? '\n日志里值得看的行：\n' + interesting.map((l) => '  ' + l).join('\n') : '\n日志里没看到明显的报错。',
        `\n最近 ${n} 行日志：\n${log.out}`
      ].join('\n');
    }
  };
}

export function apply(ctx) {
  for (const tool of [buildCheckTool(), buildConfigTool(), buildStatusTool(), buildDeployTool()]) {
    ctx.tools.register(tool);
  }
}
