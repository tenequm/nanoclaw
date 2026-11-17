"""Check stand-in turns against the real host delivery ledger."""
import os
import json
import sqlite3
import time
from pathlib import Path
import stack

state = json.loads(stack.STATE.read_text())
if state['profile'] != 'fast' or state['root'] != str(stack.ROOT):
    raise RuntimeError('Proofs require this checkout local fast stack')
owner = os.environ.get('LOCAL_OWNER_ID', 'telegram:95307956')

def send(text):
    stack.ncl(state, 'messaging-groups', 'send', '--channel-type', 'cli', '--platform-id', 'local', '--sender-id', owner, '--text', text)

def rows():
    paths = list((stack.ROOT / 'data/v2-sessions').rglob('outbound.db'))
    output = []
    for path in paths:
        with sqlite3.connect(path) as db, sqlite3.connect(path.with_name('inbound.db')) as inbound:
            delivered = dict(inbound.execute('select message_out_id,status from delivered'))
            output.extend((r[0], json.loads(r[1]), delivered.get(r[0])) for r in db.execute('select id,content from messages_out'))
    return output

def wait(predicate, seconds=45):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate(): return True
        time.sleep(.25)
    return False

for mode in ['reply', 'multi', 'long', 'file', 'edit', 'question']:
    before = {r[0] for r in rows()}
    send(mode)
    fresh = lambda: [r for r in rows() if r[0] not in before]
    active = False
    if mode == 'long':
        def tool():
            for p in (stack.ROOT / 'data/v2-sessions').rglob('outbound.db'):
                with sqlite3.connect(p) as d:
                    if d.execute("select 1 from container_state where current_tool='stand_in_wait'").fetchone(): return True
            return False
        active = wait(tool, 10)
    count = 3 if mode == 'multi' else 2 if mode == 'file' else 1
    wait(lambda: len([r for r in fresh() if r[2] == 'delivered']) >= count)
    current = fresh()
    passed = False
    if mode == 'reply': passed = any(c.get('text') == 'Stand-in reply.' and d == 'delivered' for _, c, d in current)
    if mode == 'multi': passed = [c.get('text') for _,c,d in current if d == 'delivered'] == ['First message.', 'Second message.', 'Third message.']
    if mode == 'long': passed = active and any(c.get('text') == 'Long tool complete.' and d == 'delivered' for _,c,d in current)
    detail = f'{len(current)} outbound rows; {sum(r[2] == "delivered" for r in current)} acknowledged by host'
    if mode in ['file', 'edit', 'question']:
        detail += '; CLI adapter has no file rendering, message IDs/edit support or question-response input; end-to-end behavior unproven'
    if mode == 'long': detail += f'; current tool observed={active}'
    stack.result(state, 'turn-' + mode, 'pass' if passed else 'fail', detail)
    print(mode + ': ' + ('pass' if passed else 'fail'), flush=True)
