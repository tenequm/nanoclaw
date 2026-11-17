"""Check stand-in turns against the real host delivery ledger."""
from contextlib import closing
import sqlite3
import sys
import time
import stack

state = stack.load_state('fast')
UNPROVEN = ('; the CLI adapter has no file rendering, message IDs/edit support or question-response input, '
            'so end-to-end behavior is unproven')


def wait(predicate, seconds=45):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return True
        time.sleep(.25)
    return False


def long_tool_active():
    for path in (stack.ROOT / 'data/v2-sessions').rglob('outbound.db'):
        try:
            with closing(stack.connect_ro(path)) as db:
                if db.execute("select 1 from container_state where current_tool='stand_in_wait'").fetchone():
                    return True
        except sqlite3.OperationalError:
            continue
    return False


failed = False
# `question 5` lets the unanswered card time out before a rerun can queue behind it.
for mode, command in [('reply', 'reply'), ('multi', 'multi'), ('long', 'long'),
                      ('file', 'file'), ('edit', 'edit'), ('question', 'question 5')]:
    before = {row[:2] for row in stack.outbound_rows()}
    stack.send_cli(state, command)

    def fresh():
        return [(content, status) for path, ident, content, status in stack.outbound_rows() if (path, ident) not in before]

    active = mode == 'long' and wait(long_tool_active, 10)
    count = 3 if mode == 'multi' else 2 if mode == 'file' else 1
    wait(lambda: sum(status == 'delivered' for _, status in fresh()) >= count)
    current = fresh()
    delivered = [content.get('text') for content, status in current if status == 'delivered']
    detail = f'{len(current)} outbound rows; {len(delivered)} acknowledged by host'
    if mode == 'reply':
        status = 'pass' if 'Stand-in reply.' in delivered else 'fail'
    elif mode == 'multi':
        status = 'pass' if delivered == ['First message.', 'Second message.', 'Third message.'] else 'fail'
    elif mode == 'long':
        status = 'pass' if active and 'Long tool complete.' in delivered else 'fail'
        detail += f'; current tool observed={active}'
    else:
        status = 'skip'
        detail += UNPROVEN
    failed |= status == 'fail'
    stack.result(state, 'turn-' + mode, status, detail)
    print(mode + ': ' + status, flush=True)
sys.exit(1 if failed else 0)
