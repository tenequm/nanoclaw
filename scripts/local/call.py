"""Pass a locally delivered voice link directly to the Simulator harness."""
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import stack

state = stack.load_state()
if 'url' not in state:
    raise RuntimeError('Start the stack with --chain; the Simulator call goes through the proxy chain')
ios = Path(sys.argv[1]).resolve()
if not ios.is_dir():
    raise RuntimeError(f'{ios} is not a directory; pass the iOS checkout that runs just sim-e2e')
mode = sys.argv[2] if len(sys.argv) > 2 else 'plain'
if mode not in ('plain', 'jev'):
    raise ValueError('Mode must be plain or jev')
sock = socket.socket(socket.AF_UNIX)
sock.connect(str(stack.ROOT / 'data/cli.sock'))
# Claim the CLI delivery connection with a host-owned read-only command.
sock.sendall(json.dumps({'text': '/status', 'senderId': state['owner']}).encode() + b'\n')
time.sleep(1)
stack.send_cli(state, '/voice ' + mode)
buffer = b''
link = None
until = time.monotonic() + 30
while not link and time.monotonic() < until:
    sock.settimeout(max(.1, until - time.monotonic()))
    try:
        chunk = sock.recv(65536)
    except TimeoutError:
        break
    if not chunk:
        break
    buffer += chunk
    while b'\n' in buffer:
        line, buffer = buffer.split(b'\n', 1)
        text = json.loads(line).get('text') or ''
        match = re.search(r'https?://[^\s<>]+/voice\?t=[A-Za-z0-9_-]+', text)
        if match:
            link = state['url'] + '/voice?' + match[0].split('?', 1)[1]
sock.close()
if not link:
    stack.result(state, 'sim-call', 'fail', 'Host CLI delivery did not provide a local voice link within 30 seconds')
    sys.exit(1)


def deliveries():
    return {(path, ident) for path, ident, content, status in stack.outbound_rows()
            if status == 'delivered' and content.get('text')}


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
