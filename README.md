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
| **图片 vision 管线** | 压缩 + 直连多模态，让 lite 也能看图 |
| **视频抽帧** | B站链接 → 匿名 buvid3 cookie 走 API 拿直链 → ffmpeg 抽帧拼图 → 作为一张图给模型 |
| **掉线自检** | 连续 30 分钟无消息就主动探活；失败发邮件告警（QQ 掉线时 QQ 自己发不出去，必须走邮件） |
| **夜间静默** | 0:00–7:00 不主动开口，有人 @ 照常醒 |
| **连发上限 / 唤醒取图 / @ 解析修正** | 详见源码注释，每处都写了踩坑原因 |

只想要干净的上游，直接用 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)；本仓库的价值在于上面这些实战改动和「一条命令部署」。

---

## 隐私边界（重要）

**本仓库不含任何账号、密钥、群号、服务器地址。**

- 引擎与人格卡里的个人信息全部是占位符：`{{OWNER_QQ}}`、`{{OWNER_NAME}}`、`{{SPONSOR_NAME}}`、`{{GROUP_NAME}}`，由部署参数替换
- 生成的 `config.json` 写到目标机，权限 600，不进仓库
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

---

## License

本仓库的插件代码与我们的改动：MIT。

`assets/` 下的引擎源自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT，版权归原作者，见 [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM)。
