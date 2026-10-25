#!/bin/bash
# 调整 QQ 机器人的每日人民币额度（改完热生效，不用重启 qqbridge）
#
#   ./budget.sh                 查看当前额度 / 今天已花 / 今天是否被覆盖
#   ./budget.sh 5               把【默认】每日额度改成 ¥5
#   ./budget.sh today 10        只把【今天】改成 ¥10，明天 04:00 自动回到默认额度
#   ./budget.sh today off       今天完全不限额，明天自动恢复
#   ./budget.sh tomorrow 5      只把【明天】改成 ¥5
#   ./budget.sh clear           清掉所有按天覆盖（回到默认额度）
#   ./budget.sh off             全局关闭额度限制（一直关到 on）
#   ./budget.sh on              重新打开额度限制
#   ./budget.sh reset           把「今天已花」的起算点挪到此刻（今天重新计）
#
# 预算日以 04:00 为分界（跟每日归档/开新会话同一个点），所以「今天」= 最近一个 04:00 之后到现在。
set -uo pipefail
cd /root/qq-bridge || exit 1

CFG=/root/qq-bridge/config.json

calc_keys() {
python3 - "$CFG" <<'PY'
import json, sys, datetime
CFG = sys.argv[1]
cfg = json.load(open(CFG, encoding='utf-8'))
b = cfg.get('socialV2', {}).get('budget', {}) or {}
reset = int(b.get('resetHour', 4) or 4)
BJ = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(BJ)
start = now.replace(hour=reset, minute=0, second=0, microsecond=0)
if now.hour < reset:
    start -= datetime.timedelta(days=1)
print(start.strftime('%Y-%m-%d'), (start + datetime.timedelta(days=1)).strftime('%Y-%m-%d'))
PY
}

if [ $# -lt 1 ]; then
  read -r TODAY TOMORROW <<< "$(calc_keys)"
  python3 - "$CFG" "$TODAY" "$TOMORROW" <<'PY'
import json, sys, datetime
CFG, today, tomorrow = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(CFG, encoding='utf-8'))
b = cfg.get('socialV2', {}).get('budget', {}) or {}
BJ = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(BJ)
reset = int(b.get('resetHour', 4) or 4)
start = now.replace(hour=reset, minute=0, second=0, microsecond=0)
if now.hour < reset:
    start -= datetime.timedelta(days=1)
since = int(b.get('sinceMs') or 0)
win = max(int(start.timestamp() * 1000), since)
ov = b.get('overrides') or {}
def show(v):
    if v == 'off':
        return '不限额'
    try:
        return '¥%s' % float(v)
    except Exception:
        return str(v)
print('额度开关 :', '开' if b.get('enabled') else '关')
print('默认额度 : ¥%s / 天' % b.get('dailyCny', 0))
print('今天(%s): %s%s' % (today, show(ov.get(today, b.get('dailyCny', 0))), '  ← 按天覆盖' if today in ov else ''))
if tomorrow in ov:
    print('明天(%s): %s  ← 已预设' % (tomorrow, show(ov[tomorrow])))
print('分界点   : 每天 %02d:00' % reset)
print('额度起算 : %s' % (datetime.datetime.fromtimestamp(win / 1000, BJ).strftime('%Y-%m-%d %H:%M') if win else '（未设置）'))
print('@ 免额度 : %s' % ('是' if b.get('urgentBypass', True) else '否'))
PY
  echo
  echo '用法: ./budget.sh <金额> | today <金额|off> | tomorrow <金额|off> | clear | off | on | reset'
  exit 0
fi

ACTION="$1"
VALUE="${2:-}"

# 把 today/tomorrow 解析成具体的预算日 key，再统一写入 overrides
TARGET_KEY=""
case "$ACTION" in
  today|tomorrow)
    read -r TODAY TOMORROW <<< "$(calc_keys)"
    if [ "$ACTION" = "today" ]; then TARGET_KEY="$TODAY"; else TARGET_KEY="$TOMORROW"; fi
    if [ -z "$VALUE" ]; then
      echo "缺少金额。用法: ./budget.sh $ACTION <金额> 或 ./budget.sh $ACTION off"
      exit 1
    fi
    ;;
esac

python3 - "$CFG" "$ACTION" "$VALUE" "$TARGET_KEY" <<'PY'
import json, sys, time, shutil, datetime
CFG, action, value, target_key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(CFG, encoding='utf-8'))
sv = cfg.setdefault('socialV2', {})
b = sv.setdefault('budget', {})
b.setdefault('enabled', True)
b.setdefault('dailyCny', 1.0)
b.setdefault('resetHour', 4)
b.setdefault('urgentBypass', True)
ov = b.setdefault('overrides', {})
shutil.copy2(CFG, CFG + '.bak-budget-' + time.strftime('%Y%m%d%H%M%S'))

low = (value or '').lower()
def parse_amount(raw):
    if raw.lower() in ('off', 'unlimited', 'inf', '无限'):
        return 'off'
    f = float(raw)
    if f < 0:
        raise ValueError('金额不能是负数')
    return f

if action in ('today', 'tomorrow'):
    try:
        amt = parse_amount(value)
    except ValueError as e:
        print('参数不对:', e); sys.exit(1)
    ov[target_key] = amt
    # 顺手清掉已经过去的日子，防止 overrides 无限增长
    BJ = datetime.timezone(datetime.timedelta(hours=8))
    now = datetime.datetime.now(BJ)
    reset = int(b.get('resetHour', 4) or 4)
    start = now.replace(hour=reset, minute=0, second=0, microsecond=0)
    if now.hour < reset:
        start -= datetime.timedelta(days=1)
    # 注意：overrides 的 key 是「日期」(00:00)，而 keep_from 是「该日 resetHour」——
    # 直接比 datetime 会把今天自己判成过期（今天 00:00 < 今天 04:00），
    # 于是 today 一写就被删。必须按日期比较。
    keep_from_date = start.date()
    for k in list(ov):
        try:
            if datetime.datetime.strptime(k, '%Y-%m-%d').date() < keep_from_date:
                del ov[k]
        except Exception:
            del ov[k]
    print('%s 已设为 %s（仅当天有效，之后自动回到默认 ¥%s）' % (target_key, '不限额' if amt == 'off' else '¥%s' % amt, b['dailyCny']))
elif action == 'clear':
    b['overrides'] = {}
    print('已清掉所有按天覆盖，回到默认额度 ¥%s' % b['dailyCny'])
elif action in ('off', 'on'):
    b['enabled'] = (action == 'on')
    print('全局额度限制已' + ('打开' if action == 'on' else '关闭'))
elif action == 'reset':
    b['sinceMs'] = int(time.time() * 1000)
    print('已把额度起算点挪到此刻，今天重新开始计')
else:
    try:
        amt = float(value or action)
    except ValueError:
        print('看不懂这个参数:', value or action); sys.exit(1)
    if amt < 0:
        print('金额不能是负数'); sys.exit(1)
    b['dailyCny'] = amt
    b['enabled'] = amt > 0
    print('默认每日额度已改为 ¥%s' % amt if amt > 0 else '默认额度设为 0 → 等于全局关闭')

json.dump(cfg, open(CFG, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('生效方式：bridge 按文件 mtime 热读，下一次唤醒就用新额度，不用重启。')
PY
