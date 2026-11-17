"""Prove a real model turn, direct mailbox access and test-bot readiness."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import time
import urllib.request
import stack

state = stack.load_state('full')
if state.get('proof'):
    raise RuntimeError('A --proof stack has no bot or model credential; start full without --proof')
owner = state['owner']
values = stack.read_env()
statuses = []


def record(ident, passed, detail, evidence=None):
    statuses.append(passed)
    stack.result(state, ident, 'pass' if passed else 'fail', detail, evidence)


try:
    with urllib.request.urlopen('https://api.telegram.org/bot' + values['TELEGRAM_BOT_TOKEN'] + '/getMe', timeout=20) as response:
        bot_ok = json.load(response).get('ok', False)
except Exception:
    bot_ok = False
record('test-bot-getme', bot_ok, 'Test bot getMe checked; response identity and token withheld')
with closing(sqlite3.connect(stack.ROOT / 'data/v2.db')) as db:
    wired = db.execute('SELECT 1 FROM messaging_groups m JOIN messaging_group_agents w ON w.messaging_group_id=m.id WHERE m.channel_type=? AND m.platform_id=? AND w.agent_group_id=?', ('telegram', owner, state['group'])).fetchone()
record('owner-dm-wiring', bool(wired), 'Owner DM platform id and wiring ' + ('match' if wired else 'do not match') + '; no Telegram message sent')
stack.send_cli(state, 'Reply with exactly LOCAL_MODEL_OK. Do not use tools other than send_message to this chat.')
deadline = time.monotonic() + 120
reply = False
while time.monotonic() < deadline and not reply:
    reply = any('LOCAL_MODEL_OK' in (content.get('text') or '') and status == 'delivered'
                for _, _, content, status in stack.outbound_rows())
    if not reply:
        time.sleep(.5)
record('real-model-turn', reply, 'Real model expected reply and host delivery acknowledgment ' + ('observed' if reply else 'not observed within 120 seconds'))
mailbox = Path(state['run']) / 'logs/mailbox.jsonl'
deadline = time.monotonic() + 45
while True:
    rows = [json.loads(line) for line in mailbox.read_text().splitlines()] if mailbox.exists() else []
    if any(r.get('telegramPoll') for r in rows) or time.monotonic() >= deadline:
        break
    time.sleep(.5)
host = (Path(state['run']) / 'logs/host.log').read_text()
local_rows = [r for r in rows if not r.get('telegramPoll')]
clean = 'Spawning session' in host and 'Session failed' not in host
record('direct-mailbox', reply and clean and any(r['status'] == 200 for r in local_rows),
       f'Local mailbox responses={len(local_rows)}; clean session start={clean}; real reply={reply}; no proxy restart performed', ['logs/mailbox.jsonl', 'logs/host.log'])
polls = [r for r in rows if r.get('telegramPoll')]
record('test-bot-polling', bot_ok and any(r['status'] == 200 for r in polls) and all(r['status'] != 409 for r in polls),
       f'Observed getUpdates responses={len(polls)}; statuses={sorted({r["status"] for r in polls})}; no messages sent', ['logs/mailbox.jsonl'])
print('Real model turn: ' + ('pass' if reply else 'fail'))
sys.exit(0 if all(statuses) else 1)
