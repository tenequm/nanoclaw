"""Pass a locally delivered voice link directly to the Simulator harness."""
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import time
import stack

state = json.loads(stack.STATE.read_text())
if state['root'] != str(stack.ROOT):
    raise RuntimeError('Proofs require this checkout local stack')
ios = Path(sys.argv[1]).resolve()
mode = sys.argv[2] if len(sys.argv) > 2 else 'plain'
if mode not in ('plain', 'jev'): raise ValueError('Mode must be plain or jev')
owner = os.environ.get('LOCAL_OWNER_ID', 'telegram:95307956')
sock = socket.socket(socket.AF_UNIX)
sock.settimeout(30)
sock.connect(str(stack.ROOT / 'data/cli.sock'))
# Claim the CLI delivery connection with a host-owned read-only command.
sock.sendall(json.dumps({'text': '/status', 'senderId': owner}).encode() + b'\n')
time.sleep(1)
stack.ncl(state, 'messaging-groups', 'send', '--channel-type', 'cli', '--platform-id', 'local', '--sender-id', owner, '--text', '/voice ' + mode)
buffer = ''
link = None
until = time.monotonic() + 30
while not link and time.monotonic() < until:
    buffer += sock.recv(65536).decode()
    while '\n' in buffer:
        line, buffer = buffer.split('\n', 1)
        text = json.loads(line).get('text', '')
        match = re.search(r'https?://[^\s<>]+/voice\?t=[A-Za-z0-9_-]+', text)
        if match: link = state['url'] + '/voice?' + match[0].split('?', 1)[1]
sock.close()
if not link:
    stack.result(state, 'sim-call', 'fail', 'Host CLI delivery did not provide a local voice link')
    sys.exit(1)
def deliveries():
    found = set()
    for path in (stack.ROOT / 'data/v2-sessions').rglob('outbound.db'):
        with sqlite3.connect(path) as db, sqlite3.connect(path.with_name('inbound.db')) as inbound:
            delivered = dict(inbound.execute('select message_out_id,status from delivered'))
            found.update((str(path), ident) for ident, content in db.execute('select id,content from messages_out')
                         if delivered.get(ident) == 'delivered' and json.loads(content).get('text'))
    return found

before = deliveries()
call_run = Path(state['run']) / ('call-' + mode)
env = stack.clean_env() | {'HEYDAN_E2E_CALL_LINK': link, 'HEYDAN_LOCAL_CA': state['ca'], 'HEYDAN_RUN_DIR': str(call_run),
    'HEYDAN_E2E_ATTEMPTS': '1', 'HEYDAN_E2E_SAY': 'Hey Dan. What is two plus two? Zulu.'}
code = subprocess.run(['just', 'sim-e2e'], cwd=ios, env=env).returncode
new = deliveries() - before
stack.result(state, mode + '-agent-delivery', 'pass' if code == 0 and new else 'fail',
             f'New delivered agent text rows={len(new)}; strict Simulator call exit={code}; message text withheld')
for path in (call_run / 'results').glob('*.json'):
    row = json.loads(path.read_text())
    stack.result(state, mode + '-' + row['id'], row['status'], row['detail'],
                 ['call-' + mode + '/' + item for item in row['evidence']])
raise SystemExit(code)
