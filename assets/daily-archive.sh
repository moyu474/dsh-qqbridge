#!/bin/bash
# 每天 04:00：把群聊原文导进冷存储 → 轮转日志 → 开新会话。
# 主人定的口径：宁可多占存储，也不要用二手摘要替代原话（所以只导原文，不做摘要）。
#
# 顺序很关键：**先停 bridge，再动 sessions.json**。
# bridge 退出时会 saveState() 把内存里的会话映射写回磁盘，
# 先改文件再重启等于白改（2026-10-21 实测：重启后映射又变回旧会话）。
set -uo pipefail
cd "$(dirname "$0")" || exit 1
LOG="$PWD/state/archive.log"
exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 每日归档开始 ====="

# 1. 先停 bridge（顺带把它内存状态落盘）
echo '--- 停止 qqbridge ---'
systemctl stop qqbridge

# 2. 归档 + 切会话
node archive.mjs __GROUP_ID__ --switch
rc=$?
if [ $rc -ne 0 ]; then
  echo "归档失败 rc=$rc，本次不轮转，直接拉起 bridge 继续用原会话"
  systemctl start qqbridge
  sleep 5
  echo "qqbridge: $(systemctl is-active qqbridge)"
  exit $rc
fi

# 3. 轮转日志：不轮转的话明天会把今天这批再导一遍。
mkdir -p state/rotated
STAMP=$(date '+%Y%m%d-%H%M%S')
for f in state/qq-activity.log state/tool-calls.jsonl; do
  if [ -s "$f" ]; then
    mv "$f" "state/rotated/$(basename "$f").$STAMP"
    echo "轮转 $f -> state/rotated/$(basename "$f").$STAMP"
  fi
done

# 4. 拉起（不存在的映射 = 下一条消息开新会话）
echo '--- 启动 qqbridge ---'
systemctl start qqbridge
sleep 5
echo "qqbridge: $(systemctl is-active qqbridge)"
echo "当前会话映射: $(cat state/sessions.json | tr -d '\n' | head -c 200)"
echo "===== $(date '+%F %T') 每日归档结束 ====="
