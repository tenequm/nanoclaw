"""Pass a locally delivered voice link directly to the Simulator harness."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import stack

state = json.loads(stack.STATE.read_text())
if state['profile'] != 'fast' or state['root'] != str(stack.ROOT):
    raise RuntimeError('Proofs require this checkout local fast stack')
ios = Path(sys.argv[1]).resolve()
owner = os.environ.get('LOCAL_OWNER_ID', 'telegram:95307956')
sock = socket.socket(socket.AF_UNIX)
sock.settimeout(30)
sock.connect(str(stack.ROOT / 'data/cli.sock'))
# Claim the CLI delivery connection with a host-owned read-only command.
sock.sendall(json.dumps({'text': '/status', 'senderId': owner}).encode() + b'\n')
time.sleep(1)
stack.ncl(state, 'messaging-groups', 'send', '--channel-type', 'cli', '--platform-id', 'local', '--sender-id', owner, '--text', '/voice plain')
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
env = stack.clean_env() | {'HEYDAN_E2E_CALL_LINK': link, 'HEYDAN_LOCAL_CA': state['ca'], 'HEYDAN_RUN_DIR': state['run'],
    'HEYDAN_E2E_ATTEMPTS': '1', 'HEYDAN_E2E_SAY': 'Hey LiveKit. What is two plus two? Zulu.'}
raise SystemExit(subprocess.run(['just', 'sim-e2e'], cwd=ios, env=env).returncode)
