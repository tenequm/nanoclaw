"""Exercise a running stack without creating a call or sending a message."""
import base64
import http.client
import json
from pathlib import Path
import socket
import ssl
import stat
import statistics
import time
import stack

state = stack.load_state()
b = state['base']


def check(ident, fn):
    try:
        detail = fn()
        stack.result(state, ident, 'pass', detail)
        print('PASS ' + ident + ': ' + detail)
    except Exception as err:
        stack.result(state, ident, 'fail', str(err) or type(err).__name__)
        raise


def request(conn):
    start = time.monotonic()
    conn.request('GET', '/voice')
    response = conn.getresponse()
    body = response.read()
    return response.status, body, (time.monotonic() - start) * 1000


def proxied(context, address='127.0.0.1'):
    conn = http.client.HTTPSConnection(stack.PROXY_HOST, b+6, timeout=10, context=context)
    # Dial the chosen loopback address; the proxy host stays the SNI and Host name.
    conn.sock = context.wrap_socket(socket.create_connection((address, b+6), timeout=10),
                                    server_hostname=stack.PROXY_HOST)
    return conn


def route():
    context = ssl.create_default_context(cafile=state['ca'])
    direct = http.client.HTTPConnection('127.0.0.1', b, timeout=10)
    proxy = proxied(context)
    a, c = request(direct), request(proxy)
    assert a[:2] == c[:2], 'Direct and proxy responses differ'
    deltas = [request(proxy)[2] - request(direct)[2] for _ in range(7)]
    median = statistics.median(deltas)
    assert 45 <= median <= 110, f'Unexpected warmed hop RTT: {median:.1f} ms'
    direct.close()
    proxy.close()
    # Traefik's own peer is always 127.0.0.1, so only the PROXY v2 header can bring ::1 to the host.
    v6 = proxied(context, '::1')
    request(v6)
    v6.close()
    evidence = Path(state['run']) / 'logs'
    proxy_rows = [json.loads(s) for s in (evidence / 'proxy.jsonl').read_text().splitlines()]
    assert any(r['proxyV2'] for r in proxy_rows), 'Missing PROXY v2 header'
    addresses = [json.loads(s) for s in (evidence / 'address.jsonl').read_text().splitlines()]
    assert any(r['forwarded'] == '::1' for r in addresses), 'Host did not see the ::1 client address from PROXY v2'
    return f'HTTP {a[0]} identical body; host X-Forwarded-For ::1 from PROXY v2; median added RTT {median:.1f} ms'


def lock():
    try:
        stack.LOCK.mkdir()
    except FileExistsError:
        assert (stack.LOCK / 'owner').read_text() == str(stack.ROOT), 'Full-profile lock held by another checkout'
        return f'Full-profile lock {stack.LOCK} held by this checkout, so a second full up is refused before install'
    stack.LOCK.rmdir()
    raise AssertionError('Full-profile lock is not held')


def configuration():
    env_file = stack.ROOT / '.env'
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600, '.env is not mode 0600'
    values = stack.read_env()
    assert len(base64.b64decode(values['NANOCLAW_ENCRYPTION_KEY'], validate=True)) == 32, 'Sealing key is not 32 bytes'
    assert values['LIVEKIT_HOST_URL'] == f'http://127.0.0.1:{b}', 'LiveKit host URL is not loopback'
    health = http.client.HTTPConnection('127.0.0.1', b+9, timeout=10)
    health.request('GET', '/')
    response = health.getresponse()
    assert response.status == 200, f'Worker health: {response.status}'
    response.read()
    health.close()
    assert 'registered worker' in (Path(state['run']) / 'logs/worker.log').read_text(), 'Worker not registered with LiveKit'
    if state['profile'] == 'full':
        assert not stack.ncl('sessions', 'list'), 'Unexpected agent session in full startup proof'
    if values['ONECLI_URL'].startswith('http://127.0.0.1:'):
        records = [json.loads(line) for line in (Path(state['run']) / 'logs/gateway-requests.jsonl').read_text().splitlines()]
        allowed = ('GET',) if state['profile'] == 'full' else ('GET', 'POST')
        assert records and all(r['method'] in allowed for r in records), 'Unexpected local gateway request method'
    return '0600 env, valid sealing key, loopback host URL, registered LiveKit worker with HTTP 200 health; local gateway methods checked when configured'


check('configuration-and-worker', configuration)
if 'ca' in state:
    check('voice-route-through-chain', route)
else:
    stack.result(state, 'voice-route-through-chain', 'skip', 'Start with --chain to check the proxy path')
if state['profile'] == 'full':
    check('full-lock', lock)
stack.report()
