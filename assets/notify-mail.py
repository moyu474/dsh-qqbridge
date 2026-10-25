#!/usr/bin/env python3
# 掉线邮件告警：163 SMTP。授权码单独存 state/mail-auth（600 权限），不写死在代码里。
# 2026-10-24 加：主人说「不是时时刻刻开电脑」，Windows 弹窗靠不住，必须走邮件。
import os, smtplib, ssl, sys, json, time
from email.mime.text import MIMEText
from email.header import Header

BASE = os.path.dirname(os.path.abspath(__file__))
AUTH_FILE = os.path.join(BASE, "state", "mail-auth.json")
LOG_FILE = os.path.join(BASE, "state", "mail-alert.log")

def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + "  " + str(msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def load_auth():
    if not os.path.exists(AUTH_FILE):
        return None
    try:
        with open(AUTH_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("读授权文件失败: " + str(e))
        return None

def send(subject, body):
    a = load_auth()
    if not a or not a.get("password"):
        log("没有配置 SMTP 授权码，邮件未发送")
        return False
    user = a.get("user") or "__NOTIFY_EMAIL__"
    host = a.get("host") or "smtp.163.com"
    port = int(a.get("port") or 465)
    to = a.get("to") or user
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = user
    msg["To"] = to
    ctx = ssl.create_default_context()
    try:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=25) as s:
            s.login(user, a["password"])
            s.send_message(msg)
        log("已发送: " + subject)
        return True
    except Exception as e:
        log("发送失败: " + repr(e))
        return False

if __name__ == "__main__":
    subject = sys.argv[1] if len(sys.argv) > 1 else "机器人 告警"
    body = ""
    if not sys.stdin.isatty():
        try:
            body = sys.stdin.read()
        except Exception:
            body = ""
    if not body.strip() and len(sys.argv) > 2:
        body = sys.argv[2]
    ok = send(subject, body or "（无内容）")
    print("OK" if ok else "FAIL")
