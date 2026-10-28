# dsh-qqbridge

把 QQ 接入 DSH（DeepSeek Harness）的**部署插件**。

它做的事：检查环境 → 上传桥接引擎 → 装依赖 → 生成配置 → 装 DSH 端 preset/MCP → 装 systemd 服务。

---

## 这东西从哪来

`assets/` 下的桥接引擎 **fork 自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)**（MIT 许可，版权归原作者，见 [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM)）。

我们在其基础上加了一批改动，最核心的是 **lite 模式**：

| 改动 | 说明 |
|---|---|
| **lite 模式** | 绕过 DSH 直连 DeepSeek `chat/completions`，一次回应一次 HTTP 请求。实测 **¥0.0012/次**，而 agent 模式 **¥0.216/次**（约 180 倍差距） |
| **人格卡系统** | `roles/*.md` 分角色卡、可切换；带 AI 味黑名单、正反例、群暗号 |
| **图片 vision 管线** | 压缩 + 直连多模态，让 lite 也能看图。群友图片、市场表情、视频抽帧、**QQ 官方机器人的 markdown 卡片图**（`![..](qqbot.ugcimg.cn/...)`）都在同一条下载链上 |
| **视频管线** | 逐点 seek 抽帧 + 每格时间码 + 台词（SenseVoice，可选）。9 分钟 1080p 片子 2 秒出图，比旧的 fps 滤镜快 11 倍 |
| **唤醒规则** | 只认这些：@她、叫名字、关键词、被拍（**只在拍她自己时**，拍别人不醒）、在场窗口接着聊、概率、私聊。不问句、不因别人互拍而醒 |
| **视频抽帧** | 三种来源都能看：B 站链接 / B 站分享卡片（小程序 json）/ QQ 视频消息与 mp4 文件。收到即预取到 `state/videocache/`（QQ 的 rkey 直链几分钟就过期），唤醒时 ffmpeg 抽帧拼图当一张图给模型；布局按时长自适应 |
| **群聊冷存储** | 每天 04:00 归档原文（不摘要）+ **当天滚动临时库**（每 2 分钟，今天的事今天能查）；`recall.mjs` 按关键词摊开上下文，`lite-recall.mjs` 在她说「想不起来」时自动查 |
| **她自己的检索** | lite 输出里可以带 `recall: "关键词"`——她自己觉得某个梗/名字/旧事不懂时才查，平时零成本 |
| **掉线自检 + 看门狗** | 连续 30 分钟无消息主动探活；独立的 `watchdog.sh` 每 30 分钟查端口/服务/health.json，异常发邮件（QQ 掉线时 QQ 自己发不出去，必须走邮件） |
| **夜间静默 + 不乱补唤醒** | 0:00–7:00 不主动开口，有人 @ 照常醒；重启后不把「过期几小时」的潜水当成现在该醒（04:00 归档重启必踩） |
| **连发上限 / 唤醒取图 / @ 解析修正** | 详见源码注释，每处都写了踩坑原因 |

只想要干净的上游，直接用 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)；本仓库的价值在于上面这些实战改动和「一条命令部署」。

---

## 隐私边界（重要）

**本仓库不含任何账号、密钥、群号、服务器地址。**

- 引擎与人格卡里的个人信息全部是占位符：`{{OWNER_QQ}}`、`{{OWNER_NAME}}`、`{{SPONSOR_NAME}}`、`{{GROUP_NAME}}`，由部署参数替换
- 冷存储/告警脚本里的群号与收件邮箱也是占位符：`__GROUP_ID__`、`__NOTIFY_EMAIL__`
- systemd 单元里的安装路径是 `__INSTALL_DIR__`，`EnvironmentFile` 是 `__ENV_FILE__`（目标机没有该文件时自动去掉整行）
- 生成的 `config.json` 写到目标机，权限 600，不进仓库；SMTP 授权码单独存 `state/mail-auth.json`（600）
- 插件代码里没有默认 QQ 号 —— `ownerQQ` 缺失直接抛错，不猜

---

## 安装

```bash
dsh plugin --profile web add dsh-qqbridge
```

装完重启 `dsh web`。

Windows 上如果 pnpm 报符号链接权限错误，把目录复制到 `~/.dsh/profiles/web/node_modules/dsh-qqbridge`，
再在 profile 的 `package.json` 里加依赖与 `dsh.profile.bundles` 条目。

---

## 四个工具

### `qqbridge_check` —— 只读体检

查六步各缺什么：Node / Docker 与协议端容器 / DSH 是否在线 / 桥接代码 / `config.json` / DSH 端 preset / 服务状态。

第 2、3 步最容易漏，**漏了的表现是 QQ 上毫无反应且不报错** —— 这个工具就是为了让它显出形来。

### `qqbridge_config` —— 生成配置

```json
{
  "host": "myserver",
  "installDir": "~/qq-bridge",
  "ownerQQ": "你的QQ号",
  "allowGroups": "群号1,群号2",
  "napcatWsUrl": "ws://127.0.0.1:3001",
  "napcatHttpUrl": "http://127.0.0.1:3000"
}
```

以现有 `config.json` 为底稿，只覆盖传入的字段。

### `qqbridge_deploy` —— 一键部署

上传引擎 → 填人格卡占位符 → `npm install` → 生成配置 → `scripts/setup-dsh.mjs` → 装 systemd。

```json
{
  "host": "myserver",
  "ownerQQ": "你的QQ号",
  "ownerName": "你的群昵称",
  "sponsorName": "最初教你说话的人",
  "groupName": "群名",
  "allowGroups": "群号"
}
```

重复执行安全：已有配置只在传了对应参数才覆盖。

### `qqbridge_status` —— 看它活着没

服务状态 + 协议端端口 + 日志里值得看的行。

排查顺序固定：**服务 → 协议端端口 → 日志里的「唤醒投递失败」**。

---

## 装完会跑起来的四个定时任务

`qqbridge_deploy` 会装好并启用这四组 systemd 单元（漏一个都会静默出问题）：

| 单元 | 时间 | 干什么 | 漏了会怎样 |
|---|---|---|---|
| `qqbridge.service` | 常驻 | 桥接主进程 | —— |
| `qqbridge-daily-archive.timer` | 每天 04:00 | 归档昨天原文到 `state/memory/<会话>/chat-*.jsonl`（群聊 `group_<群号>`、私聊 `private_<QQ号>`，各写各的目录）、轮转 `qq-activity.log`、开新会话 | 冷存储永远是空的，检索永远查不到 |
| `qqbridge-today-sync.timer` | 每 2 分钟 | 把「最近一次 04:00 之后」的原文刷进 `today.jsonl`（幂等覆盖） | 今天发生的事要等明天 04:00 才能查 |
| `qqbridge-watchdog.timer` | 每 30 分钟 | 查 OneBot 端口 / 服务 / `health.json`，异常发邮件（每小时最多一封） | 掉线没人喊 |

冷存储相关的命令（在安装目录下）：

```bash
node archive.mjs                    # 手动归档所有会话（群聊 + 私聊各写各的目录）
node archive.mjs <群号>             # 只归档指定的群
node archive.mjs --switch           # 归档并开新会话（之后要重启 bridge）
node sync-today.mjs                 # 手动刷今天的临时库
node recall.mjs 白饭 --context=15   # 按关键词翻原文，每段 15 条带时间
node recall.mjs github --limit=3    # 最多展开 3 处命中
```

**往事检索是怎么进 prompt 的**（`src/lite-recall.mjs`）：群聊默认不注入；只有出现「上次 / 之前 / 还记得 / 老梗」这类词，或**她自己**在输出里写了 `recall: "关键词"`（表示这个梗/名字/旧事她不懂）时才查。命中结果按「▸ 时间范围（几天前）」分段、每条带 `MM-DD HH:MM` 和说话人，最多 3 段、每段 10 条、整块 ≤2400 字。**私聊每轮都查**（本地纯计算、0 次 API，只有你们两个人，滥一点没有副作用）。

**群聊与私聊共享记忆、但出口单向**：两边都能检索到对方的记录，可是在群聊里查到的私聊内容会**逐行**标 `〔私聊〕`、段头加「｜私聊」、整段前加硬警告（不许复述任何细节，被追问就装傻）。私聊视角看不到这条警告。物理上仍然分目录存，永不混写。

**长话题靠「话头追踪」**（`src/lite-thread.mjs`）：每轮先从最近 12 条算出话题签名，再把窗口外跟它沾边的前因捞回来，拼成「开头锚点 + 中间最要紧的 6 条 + 最近 N 条」，中间如实标出略过多少条。想让这个生效，`socialV2.context.recentLimit`（内存保留条数）别低于 100，默认给的是 200。

---

## 部署前必须有的东西

插件**不会**替你装这些：

1. **DSH** 在目标机跑着（默认 `127.0.0.1:3080`）
2. **协议端**（NapCat / SnowLuma）已安装并**扫码登录**，OneBot HTTP(3000) 与 WS(3001) 开着
3. 目标机能 `ssh` 免密登录

协议端那一步最容易卡：QQ 掉线是常态（实测约 24 小时一次），掉线时协议端会跟着停，恢复要重新扫码。

---

## 常见坑（都踩过）

- **DSH 端 preset 没装** → QQ 上毫无反应，日志也不报错
- **`allowAllWhenEmpty: true`** → 白名单空着就放行全部，等于把账号交给模型
- **把 WS 端口填进 `httpUrl`** → 报 HTTP 426
- **NapCat 容器重启后要重新扫码**，登录态不一定保得住
- **掉线时告警别走 QQ** —— QQ 都挂了，消息发不出去
- **媒体入库时把 `kind` 拍平** → 视频存成 image，之后找 `kind==='video'` 永远落空，抽帧一步静默不执行（改媒体字段时务必核对 `appendSocialV2Message` 的归一化）
- **QQ 媒体直链带 rkey、几分钟就过期** → 下载必须在收到消息的当下做，等唤醒再下就是 `download url has expired`
- **B 站分享到 QQ 是小程序卡片** → 真链在 `meta.detail_1.qqdocurl`，整串 JSON 的 `/` 是 `\/`，按 `https://` 正则抠不到
- **04:00 归档会重启 bridge** → 恢复定时器时别把「过期几小时」的潜水当成现在该醒，否则每天凌晨莫名冒泡一次
- **`qq-activity.log` 有行数上限**（默认 5000）→ 上限太小会在活跃日悄悄丢消息，归档跟着缺

---

## License

本仓库的插件代码与我们的改动：MIT。

`assets/` 下的引擎源自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT，版权归原作者，见 [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM)。
