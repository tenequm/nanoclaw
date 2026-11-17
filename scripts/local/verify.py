"""Exercise a running stack without creating a call or sending a message."""
import http.client
import base64
import stat
import importlib.util
import json
from pathlib import Path
import ssl
import statistics
import tempfile
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('stack', Path(__file__).with_name('stack.py'))
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)
state = json.loads(stack.STATE.read_text())
b = state['base']


def check(ident, fn):
    try:
        detail = fn()
        stack.result(state, ident, 'pass', detail)
        print('PASS ' + ident + ': ' + detail)
    except Exception as err:
        stack.result(state, ident, 'fail', str(err))
        raise


def request(conn):
    start = time.monotonic()
    conn.request('GET', '/voice')
    response = conn.getresponse()
    body = response.read()
    return response.status, body, (time.monotonic() - start) * 1000


def route():
    direct = http.client.HTTPConnection('127.0.0.1', b, timeout=10)
    proxy = http.client.HTTPSConnection('127.0.0.1.sslip.io', b+6, timeout=10,
        context=ssl.create_default_context(cafile=state['ca']))
    a, c = request(direct), request(proxy)
    assert a[:2] == c[:2], 'Direct and proxy responses differ'
    deltas = [request(proxy)[2] - request(direct)[2] for _ in range(7)]
    median = statistics.median(deltas)
    assert 45 <= median <= 110, f'Unexpected warmed hop RTT: {median:.1f} ms'
    evidence = Path(state['run']) / 'logs'
    proxy_rows = [json.loads(s) for s in (evidence / 'proxy.jsonl').read_text().splitlines()]
    assert any(r['proxyV2'] for r in proxy_rows), 'Missing PROXY v2 header'
    addresses = [json.loads(s) for s in (evidence / 'address.jsonl').read_text().splitlines()]
    assert any(r['forwarded'] == '127.0.0.1' for r in addresses), 'Host did not see client address'
    direct.close()
    proxy.close()
    return f'HTTP {a[0]} identical body; host X-Forwarded-For 127.0.0.1; PROXY v2; median added RTT {median:.1f} ms'


def isolation():
    assert set(range(4100, 4110)).isdisjoint(range(4200, 4210))
    peer = stack.ROOT / '.local/peer'
    for suffix in ['data/ncl.sock', '.env', 'data', 'store', '.local/ca', '.local/stack.json']:
        assert peer / suffix != stack.ROOT / suffix
    return 'Disjoint 4100..4109 / 4200..4209; checkout-relative DB/socket/env/store/CA/state; image and worker names derive from install path (layout proof, second stack not booted)'


def lock():
    assert stack.LOCK.is_dir()
    old_root, old_state = stack.ROOT, stack.STATE
    with tempfile.TemporaryDirectory(dir=stack.LOCAL) as temp:
        try:
            stack.ROOT = Path(temp)
            stack.STATE = Path(temp) / 'state.json'
            try:
                stack.up(SimpleNamespace(profile='full', proof=True, chain=True, livekit='cloud'))
            except RuntimeError as err:
                assert 'full profile locked' in str(err), str(err)
            else:
                raise AssertionError('Second full accepted')
        finally:
            stack.ROOT, stack.STATE = old_root, old_state
    return 'Second checkout refused by shared full-profile lock before install or gateway access'


def configuration():
    env_file = stack.ROOT / '.env'
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    values = dict(line.split('=', 1) for line in env_file.read_text().splitlines())
    assert len(base64.b64decode(values['NANOCLAW_ENCRYPTION_KEY'], validate=True)) == 32
    assert values['LIVEKIT_HOST_URL'] == f'http://127.0.0.1:{b}'
    health = http.client.HTTPConnection('127.0.0.1', b+9, timeout=10)
    health.request('GET', '/')
    response = health.getresponse()
    assert response.status == 200, f'Worker health: {response.status}'
    response.read()
    health.close()
    assert 'registered worker' in (Path(state['run']) / 'logs/worker.log').read_text(), 'Worker not registered with LiveKit'
    if state['profile'] == 'full':
        assert not stack.ncl(state, 'sessions', 'list'), 'Unexpected agent session in full startup proof'
    if values['ONECLI_URL'].startswith('http://127.0.0.1:'):
        records = [json.loads(line) for line in (Path(state['run']) / 'logs/gateway-requests.jsonl').read_text().splitlines()]
        allowed = ('GET',) if state['profile'] == 'full' else ('GET', 'POST')
        assert records and all(r['method'] in allowed for r in records)
    return '0600 env, valid sealing key, loopback host URL, registered LiveKit worker with HTTP 200 health; local gateway methods checked when configured'


check('configuration-and-worker', configuration)
check('port-path-isolation', isolation)
if 'ca' in state:
    check('voice-route-through-chain', route)
else:
    stack.result(state, 'voice-route-through-chain', 'skip', 'Start with --chain to check the proxy path')
if state['profile'] == 'full':
    check('full-lock', lock)
stack.report()
