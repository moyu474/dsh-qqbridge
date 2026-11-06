#!/bin/bash
# 独立的在线看门狗（2026-10-24 加）
# 和 bridge 进程里的自检分开：bridge 自己挂了也能报警。
# 每 30 分钟由 cron 跑一次：查 OneBot 端口 -> 查 bridge 进程 -> 查 health.json。
# 有任何异常就发邮件（每小时最多一封，靠 state/watchdog-alert-stamp 节流）。
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
STAMP=$BASE/state/watchdog-alert-stamp
LOG=$BASE/state/watchdog.log
BOT_IP=172.17.0.2

log() { echo "$(date "+%Y-%m-%d %H:%M:%S")  $*" >> "$LOG"; }

problems=()

CODE=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -X POST "http://$BOT_IP:3000/get_login_info" \
  -H "content-type: application/json" -d "{}" 2>/dev/null || echo 000)
[ "$CODE" != "200" ] && problems+=("OneBot 无响应（HTTP $CODE）")

systemctl is-active --quiet qqbridge || problems+=("qqbridge 服务没在运行")

if [ -f "$BASE/state/health.json" ]; then
  # 2026-11-03：只信 10 分钟内的状态。bridge 重启/恢复后 health.json 可能还停在旧的
  # ok:false，watchdog 会据此误报（21:30 那封「已经好了还在报掉线」就是这么来的）。
  HEALTH_FRESH=$(python3 -c "import json,sys,time; d=json.load(open(sys.argv[1])); print('1' if time.time()*1000-d.get('updatedAt',0) < 600000 else '0')" "$BASE/state/health.json" 2>/dev/null || echo 1)
  if [ "$HEALTH_FRESH" = "1" ]; then
    grep -q "\"ok\": *false" "$BASE/state/health.json" && problems+=("health.json 记录为掉线")
  else
    log "health.json 超过 10 分钟没更新，跳过判断（避免读到重启前的旧状态）"
  fi
fi

if [ ${#problems[@]} -eq 0 ]; then
  log "正常（端口 $CODE）"
  rm -f "$STAMP"
  exit 0
fi

MSG=$(printf "%s\n" "${problems[@]}")
log "异常：$MSG"

now=$(date +%s)
last=0
[ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -lt 3600 ]; then
  log "邮件已节流（距上次 $(( (now - last) / 60 )) 分钟）"
  exit 0
fi

BODY=$(printf "机器人 掉线了\n\n检测到的问题：\n%s\n\n检查时间：%s\n\n处理：跟我说一声要一张新二维码扫码登录。\n" "$MSG" "$(date "+%Y-%m-%d %H:%M:%S")")
printf "%s" "$BODY" | python3 "$BASE/notify-mail.py" "机器人掉线了（看门狗）" >> "$LOG" 2>&1
echo "$now" > "$STAMP"
