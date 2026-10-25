#!/bin/bash
# QQ 桥接会话白名单管理（改 config.json 并重启 qqbridge 生效）
#
#   ./allow.sh list
#   ./allow.sh add group 123456789
#   ./allow.sh add private {{OWNER_QQ}}
#   ./allow.sh del group 123456789
#   ./allow.sh del private {{OWNER_QQ}}
#
# 为什么必须重启：bridge 只在启动时把 config.json 读进内存，改文件不会热生效。
set -uo pipefail
cd /root/qq-bridge || exit 1

usage() {
  cat <<'EOF'
用法:
  ./allow.sh list
  ./allow.sh add group 1234567890
  ./allow.sh add private 1234567890
  ./allow.sh del group 1234567890
  ./allow.sh del private 1234567890
EOF
}

if [ $# -lt 1 ]; then usage; exit 1; fi

python3 - "$@" <<'PY'
import json, sys, time, shutil, os

args = sys.argv[1:]
action = args[0].lower()
CFG = '/root/qq-bridge/config.json'
cfg = json.load(open(CFG, encoding='utf-8'))
allow = cfg.setdefault('allow', {})
allow.setdefault('groups', [])
allow.setdefault('private', [])

def show():
    print('当前白名单:')
    print('  群  :', ', '.join(str(x) for x in allow['groups']) or '（空）')
    print('  私聊:', ', '.join(str(x) for x in allow['private']) or '（空）')

if action == 'list':
    show()
    sys.exit(0)

if action not in ('add', 'del'):
    print('未知操作:', action); sys.exit(1)
if len(args) < 3:
    print('缺少参数'); sys.exit(1)

kind_raw = args[1].lower()
kind = 'groups' if kind_raw in ('group', 'groups', '群') else ('private' if kind_raw in ('private', '私聊') else None)
if kind is None:
    print('类型只能是 group 或 private'); sys.exit(1)
num_raw = args[2].strip()
if not num_raw.isdigit() or not (5 <= len(num_raw) <= 12):
    print('号码不对:', num_raw); sys.exit(1)
num = int(num_raw)

shutil.copy2(CFG, CFG + '.bak-allow-' + time.strftime('%Y%m%d%H%M%S'))
if action == 'add':
    if num in allow[kind]:
        print('%d 已经在白名单里了，无需重启' % num); show(); sys.exit(2)
    allow[kind].append(num)
    allow[kind].sort()
    print('已加入 %d' % num)
else:
    if num not in allow[kind]:
        print('%d 不在白名单里，无需重启' % num); show(); sys.exit(2)
    allow[kind] = [x for x in allow[kind] if x != num]
    print('已移除 %d' % num)

json.dump(cfg, open(CFG, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
show()
PY
rc=$?
if [ $rc -eq 2 ]; then exit 0; fi
if [ $rc -ne 0 ]; then exit $rc; fi

if [ "${1,,}" = "list" ]; then exit 0; fi

echo '--- 重启 qqbridge 让配置生效 ---'
systemctl restart qqbridge
sleep 8
echo "qqbridge: $(systemctl is-active qqbridge)"
tail -2 /root/qq-bridge/bridge.log
