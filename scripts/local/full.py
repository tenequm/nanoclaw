"""Prove a real model turn, direct mailbox access and test-bot readiness."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.request
import stack

state = json.loads(stack.STATE.read_text())
if state['profile'] != 'full' or state['root'] != str(stack.ROOT):
    raise RuntimeError('Requires this checkout full stack')
owner = state['owner']
values = dict(line.split('=', 1) for line in (stack.ROOT / '.env').read_text().splitlines())
try:
    with urllib.request.urlopen('https://api.telegram.org/bot' + values['TELEGRAM_BOT_TOKEN'] + '/getMe', timeout=20) as response:
        bot_ok = json.load(response).get('ok', False)
except Exception:
    bot_ok = False
stack.result(state, 'test-bot-getme', 'pass' if bot_ok else 'fail', 'Test bot getMe checked; response identity and token withheld')
with sqlite3.connect(stack.ROOT / 'data/v2.db') as db:
    wired = db.execute('SELECT 1 FROM messaging_groups m JOIN messaging_group_agents w ON w.messaging_group_id=m.id WHERE m.channel_type=? AND m.platform_id=? AND w.agent_group_id=?', ('telegram', owner, state['group'])).fetchone()
stack.result(state, 'owner-dm-wiring', 'pass' if wired else 'fail', 'Owner DM platform id and wiring ' + ('match' if wired else 'do not match') + '; no Telegram message sent')
stack.ncl(state, 'messaging-groups', 'send', '--channel-type', 'cli', '--platform-id', 'local', '--sender-id', owner,
          '--text', 'Reply with exactly LOCAL_MODEL_OK. Do not use tools other than send_message to this chat.')
deadline = time.monotonic() + 120
reply = False
while time.monotonic() < deadline and not reply:
    for path in (stack.ROOT / 'data/v2-sessions').rglob('outbound.db'):
        with sqlite3.connect(path) as db, sqlite3.connect(path.with_name('inbound.db')) as inbound:
            delivered = dict(inbound.execute('select message_out_id,status from delivered'))
            reply |= any('LOCAL_MODEL_OK' in json.loads(content).get('text', '') and delivered.get(ident) == 'delivered'
                         for ident, content in db.execute('select id,content from messages_out'))
    if not reply:
        time.sleep(.5)
stack.result(state, 'real-model-turn', 'pass' if reply else 'fail', 'Real model expected reply and host delivery acknowledgment ' + ('observed' if reply else 'not observed within 120 seconds'))
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
stack.result(state, 'direct-mailbox', 'pass' if reply and clean and any(r['status'] == 200 and not r.get('telegramPoll') for r in rows) else 'fail',
             f'Local mailbox responses={len(local_rows)}; clean session start={clean}; real reply={reply}; no proxy restart performed', ['logs/mailbox.jsonl', 'logs/host.log'])
polls = [r for r in rows if r.get('telegramPoll')]
stack.result(state, 'test-bot-polling', 'pass' if bot_ok and any(r['status'] == 200 for r in polls) and all(r['status'] != 409 for r in polls) else 'fail',
             f'Observed getUpdates responses={len(polls)}; statuses={sorted({r["status"] for r in polls})}; no messages sent', ['logs/mailbox.jsonl'])
print('Real model turn: ' + ('pass' if reply else 'fail'))
