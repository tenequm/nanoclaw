"""Disposable local stack. Run `just local --help` for settings and safety boundaries."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.local'
STATE = LOCAL / 'stack.json'
LOCK = Path(tempfile.gettempdir()) / f'nanoclaw-full-{os.getuid()}.lock'
NODE = ['mise', 'x', 'node@24.22.2', '--']


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as out:
        out.write(value)


def save(state):
    write(STATE, json.dumps(state, indent=2))


def result(state, ident, status, detail, evidence=None):
    write(Path(state['run']) / 'results' / (ident + '.json'), json.dumps(dict(
        id=ident, title=ident.replace('-', ' '), status=status, detail=detail,
        evidence=evidence or [], at=datetime.datetime.now(datetime.timezone.utc).isoformat())))


def clean_env():
    # Only machine/runtime inputs cross into children; inherited channel credentials never do.
    return {k: v for k, v in os.environ.items() if k in (
        'PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'SSH_AUTH_SOCK', 'DOCKER_HOST',
        'MISE_DATA_DIR', 'XDG_CONFIG_HOME', 'LANG', 'GOPASS_STORE_DIR')}


def run(args, state, name, env=None, input=None):
    log = Path(state['run']) / 'logs' / (name + '.log')
    with open(log, 'ab') as out:
        done = subprocess.run(args, cwd=ROOT, env=env or clean_env(), input=input,
                              stdout=out, stderr=out)
    if done.returncode:
        raise RuntimeError(f'{name} failed ({done.returncode}); see logs/{name}.log')


def birth(pid):
    return subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True,
                          text=True).stdout.strip()


def start(args, state, name, env=None):
    with open(Path(state['run']) / 'logs' / (name + '.log'), 'ab') as out:
        child = subprocess.Popen(NODE + ['node', 'scripts/local/transport.mjs', 'supervise'] + args, cwd=ROOT, env=env or clean_env(),
                                 stdout=out, stderr=out, start_new_session=True)
    state['processes'].append(dict(name=name, pid=child.pid, birth=birth(child.pid)))
    save(state)


def wait_port(port, state, name):
    for _ in range(480):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return
        except OSError:
            time.sleep(.25)
    raise RuntimeError(f'{name} did not listen on {port}; see logs/{name}.log')


def secret(entry, optional=False):
    proc = subprocess.run(['gopass', 'show', '--password', entry], env=clean_env(),
                          capture_output=True, text=True)
    if proc.returncode:
        if optional:
            return None
        raise RuntimeError(f'gopass entry unavailable: {entry}')
    value = proc.stdout.strip()
    if not value or '\n' in value or '\r' in value:
        raise RuntimeError(f'gopass entry is not a single value: {entry}')
    return value


def install(state):
    run(NODE + ['pnpm', 'install', '--frozen-lockfile'], state, 'install')
    run(['bun', 'install', '--cwd', 'container/agent-runner'], state, 'runner-install')
    run(NODE + ['pnpm', 'run', 'build'], state, 'build')
    run(NODE + ['pnpm', 'exec', 'tsx', 'scripts/upgrade-state.ts', 'set'], state, 'upgrade')
    marker = LOCAL / 'image-built'
    image = 'nanoclaw-agent-v2-' + hashlib.sha1(str(ROOT).encode()).hexdigest()[:8] + ':latest'
    present = subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not marker.exists() or marker.read_text() != str(ROOT) or not present:
        run(['bash', 'container/build.sh'], state, 'image')
        write(marker, str(ROOT))
    result(state, 'install', 'pass', 'Installed, built, upgrade state set, image built for this path')


def binaries(state):
    dest = LOCAL / 'bin'
    dest.mkdir(exist_ok=True)
    if not (dest / 'caddy').exists():
        env = clean_env() | {'GOFLAGS': '-buildvcs=false'}
        run(['mise', 'x', 'go@1.27.4', 'go:github.com/caddyserver/xcaddy/cmd/xcaddy@0.4.7',
             '--', 'xcaddy', 'build', 'v2.11.9', '--with', 'github.com/mholt/caddy-l4@v0.1.3',
             '--output', str(dest / 'caddy')], state, 'caddy-build', env)
    if not (dest / 'traefik').exists():
        import platform
        arch = 'arm64' if platform.machine() == 'arm64' else 'amd64'
        archive = dest / 'traefik.tar.gz'
        run(['curl', '-fsSL', f'https://github.com/traefik/traefik/releases/download/v3.6.14/traefik_v3.6.14_darwin_{arch}.tar.gz', '-o', str(archive)], state, 'traefik-download')
        run(['tar', '-xzf', str(archive), '-C', str(dest), 'traefik'], state, 'traefik-extract')


def chain(state):
    binaries(state)
    b = state['base']
    ca = LOCAL / 'ca'
    ca.mkdir(exist_ok=True)
    if not (ca / 'root.crt').exists() or not (ca / 'format-v1').exists():
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
             '-subj', '/CN=NanoClaw local test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
             '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', str(ca / 'root.key'),
             '-out', str(ca / 'root.crt')], state, 'ca')
        write(ca / 'format-v1', '1')
    host = '127.0.0.1.sslip.io'
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={host}',
         '-keyout', str(ca / 'server.key'), '-out', str(ca / 'server.csr')], state, 'cert')
    write(ca / 'extensions', f'subjectAltName=DNS:{host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
    run(['openssl', 'x509', '-req', '-in', str(ca / 'server.csr'), '-CA', str(ca / 'root.crt'),
         '-CAkey', str(ca / 'root.key'), '-CAcreateserial', '-days', '7',
         '-extfile', str(ca / 'extensions'), '-out', str(ca / 'server.crt')], state, 'cert-sign')
    for key in ca.glob('*.key'):
        key.chmod(0o600)
    config = Path(state['run'])
    write(config / 'traefik.json', json.dumps({
        'entryPoints': {'websecure': {'address': f'127.0.0.1:{b+8}',
            'proxyProtocol': {'trustedIPs': ['127.0.0.1/32']},
            'transport': {'respondingTimeouts': {'readTimeout': '0s'}}}},
        'providers': {'file': {'filename': str(config / 'routes.json'), 'watch': True}},
        'log': {'level': 'ERROR'}}))
    write(config / 'routes.json', json.dumps({
        'tls': {'certificates': [{'certFile': str(ca / 'server.crt'), 'keyFile': str(ca / 'server.key')}]},
        'http': {'routers': {'voice': {'entryPoints': ['websecure'],
            'rule': f'Host(`{host}`) && PathPrefix(`/voice`)', 'service': 'host', 'tls': {}},
            'app': {'entryPoints': ['websecure'],
                'rule': f'Host(`{host}`) && PathPrefix(`/app`)', 'service': 'host', 'tls': {}}},
            'services': {'host': {'loadBalancer': {'servers': [{'url': f'http://127.0.0.1:{b}'}]}}}}}))
    write(config / 'Caddyfile', f'''{{
    admin off
    auto_https off
    servers {{
        protocols h1 h2
    }}
}}
https://{host}:{b+6} {{
    bind 127.0.0.1
    tls {ca}/server.crt {ca}/server.key
    @app path /app /app/*
    request_body @app {{
        max_size 26MiB
    }}
    reverse_proxy https://127.0.0.1:{b+7} {{
        stream_close_delay 5m
        header_up Host {{host}}
        transport http {{
            tls_server_name {host}
            tls_trust_pool file {{
                pem_file {ca}/root.crt
            }}
            proxy_protocol v2
        }}
    }}
}}
''')
    start([str(LOCAL / 'bin/traefik'), '--configFile=' + str(config / 'traefik.json')], state, 'traefik')
    start(NODE + ['node', 'scripts/local/transport.mjs', 'delay', str(b+7), str(b+8),
                  str(config / 'logs/proxy.jsonl')], state, 'delay')
    start([str(LOCAL / 'bin/caddy'), 'run', '--config', str(config / 'Caddyfile')], state, 'caddy', clean_env() | {'XDG_DATA_HOME': str(LOCAL / 'caddy-data'), 'XDG_CONFIG_HOME': str(LOCAL / 'caddy-config')})
    for offset, name in [(6, 'caddy'), (7, 'delay'), (8, 'traefik')]:
        wait_port(b+offset, state, name)
    state['ca'] = str(ca / 'root.crt')
    state['url'] = f'https://{host}:{b+6}'
    save(state)


def ncl(state, *args):
    p = subprocess.run(NODE + ['node', 'dist/cli/client.js', *args, '--json'],
                       cwd=ROOT, env=clean_env(), capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('ncl ' + ' '.join(args[:2]) + f' failed ({p.returncode}); response withheld')
    return json.loads(p.stdout)['data']


def seed(state):
    owner = state['owner']
    ncl(state, 'users', 'create', '--id', owner, '--kind', 'telegram', '--display-name', 'Local owner')
    ncl(state, 'roles', 'grant', '--user', owner, '--role', 'owner')
    folder = state['folder']
    if state['profile'] == 'full':
        # ncl generates IDs; seed the approved identifier before its idempotent filesystem setup.
        ident = os.environ['LOCAL_TEST_AGENT']
        sql = "INSERT INTO agent_groups (id,name,folder,created_at) VALUES (" + ','.join(
            "'" + v.replace("'", "''") + "'" for v in [ident, 'Local test', folder,
            datetime.datetime.now(datetime.timezone.utc).isoformat()]) + ')'
        run(NODE + ['pnpm', 'exec', 'tsx', 'scripts/q.ts', 'data/v2.db', sql], state, 'group-identity')
    group = ncl(state, 'groups', 'create', '--folder', folder, '--name', 'Local test')
    state['group'] = group['id']
    save(state)
    provider = os.environ.get('LOCAL_AGENT_PROVIDER', 'stand-in' if state['profile'] == 'fast' else '')
    if provider:
        ncl(state, 'groups', 'config', 'update', '--id', group['id'], '--provider', provider)
    cli = ncl(state, 'messaging-groups', 'create', '--channel-type', 'cli', '--platform-id', 'local', '--name', 'Local CLI')
    ncl(state, 'wirings', 'create', '--agent-group-id', group['id'], '--messaging-group-id', cli['id'])
    mg = ncl(state, 'messaging-groups', 'create', '--channel-type', 'telegram',
             '--platform-id', owner, '--name', 'Local test DM')
    ncl(state, 'wirings', 'create', '--agent-group-id', group['id'], '--messaging-group-id', mg['id'])
    if mg['platform_id'] != owner:
        raise RuntimeError('Seeded Telegram DM platform id does not match owner')
    result(state, 'seed', 'pass', 'Fresh DB, owner, role, group and DM wiring created; no inbound messages')


def up(args):
    if STATE.exists():
        raise RuntimeError('This checkout already has a stack; use just local down')
    for path in ['.env', 'data', 'store']:
        if (ROOT / path).exists() or (ROOT / path).is_symlink():
            raise RuntimeError(f'Refusing existing {path}; use a disposable checkout')
    owner = os.environ.get('LOCAL_OWNER_ID', 'telegram:1' if args.profile == 'fast' or args.proof else '')
    if not re.fullmatch(r'telegram:[1-9][0-9]*', owner):
        raise RuntimeError('Set LOCAL_OWNER_ID to telegram:<positive numeric user id>')
    b = int(os.environ.get('LOCAL_PORT_BASE', '4100'))
    if b < 1024 or b > 65400:
        raise RuntimeError('LOCAL_PORT_BASE must be 1024..65400')
    run_dir = Path(os.environ.get('HEYDAN_RUN_DIR', str(LOCAL / 'runs' /
        datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')))).resolve()
    (run_dir / 'logs').mkdir(parents=True, exist_ok=True)
    state = dict(run=str(run_dir), root=str(ROOT), owner=owner, base=b, profile=args.profile,
                 livekit=('cloud' if args.profile == 'full' else args.livekit), processes=[], folder='local-' + secrets.token_hex(6), lock=False)
    if args.profile == 'full':
        try:
            LOCK.mkdir(mode=0o700)
        except FileExistsError:
            raise RuntimeError(f'full profile locked: {LOCK}')
        state['lock'] = True
        write(LOCK / 'owner', str(ROOT))
    save(state)
    try:
        if args.profile == 'full':
            for key in ['LOCAL_TEST_AGENT', 'LOCAL_ANTHROPIC_SECRET_ID']:
                if not os.environ.get(key):
                    raise RuntimeError('Set ' + key)
        for offset in range(10):
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', b+offset))
        install(state)
        env = dict(NANOCLAW_GATEWAY_PROVIDER='onecli', ONECLI_URL=f'http://127.0.0.1:{b+5}',
                   WEBHOOK_HOST='127.0.0.1', WEBHOOK_PORT=str(b),
                   NANOCLAW_MAILBOX_HTTP_PORT=str(b+1), NANOCLAW_MAILBOX_HTTP_BIND='127.0.0.1',
                   LIVEKIT_HOST_URL=f'http://127.0.0.1:{b}', VOICE_MODE_WORKER_HEALTH_PORT=str(b+9),
                   VOICE_MODE_PUBLIC_URL=(f'https://127.0.0.1.sslip.io:{b+6}' if args.chain or args.profile == 'full' else f'http://127.0.0.1:{b}'),
                   LIVEKIT_AGENT_NAME='local-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12],
                   NANOCLAW_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
                   VOICE_MODE_GEMINI_API_KEY=secret('fleet/nanoclaw/gemini/api-key'),
                   JEV_API_KEY=secret('fleet/nanoclaw/JEV_OPENROUTER_API_KEY'),
                   JEV_URL=os.environ.get('LOCAL_JEV_URL', 'https://openrouter.ai/api/v1/systemone'),
                   JEV_MODEL=os.environ.get('LOCAL_JEV_MODEL', 'jev-1.14'))
        voice_defaults = dict(WAKE_MODEL='data/voice-models/hey_dan_v4.onnx',
            WAKE_THRESHOLD='0.75', WAKE_PHRASE='Hey Dan', WAKE_HOP_MS='40',
            SILENCE_MS='1500', MAX_CALLS_PER_HOUR='40', MAX_CALL_SECONDS='3600',
            MAX_SPOKEN_CHARS='0', VOCABULARY='Dan,Stan,Emma,Concierge')
        for key, value in voice_defaults.items():
            env['VOICE_MODE_' + key] = os.environ.get('LOCAL_VOICE_MODE_' + key, value)
        model = LOCAL / 'cache/hey_dan_v4.onnx'
        if not model.exists():
            model.parent.mkdir(parents=True, exist_ok=True)
            run(['scp', 'bl:pj/nanoclaw/data/voice-models/hey_dan_v4.onnx', str(model)], state, 'wake-model')
        if not hashlib.sha256(model.read_bytes()).hexdigest().startswith('1b19ba6248fa3f35'):
            raise RuntimeError('Cached Hey Dan wake model checksum mismatch')
        target = ROOT / 'data/voice-models/hey_dan_v4.onnx'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(model, target)
        result(state, 'voice-parity', 'pass', 'Jev and acoustic wake defaults match bl; wake model SHA-256 verified')
        if args.profile == 'full':
            for key in ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']:
                env[key] = secret('misc/' + key)
            bot = secret('misc/NANOCLAW_TEST_BOT_TOKEN', optional=True)
            if not bot:
                result(state, 'test-bot', 'skip', 'Set gopass misc/NANOCLAW_TEST_BOT_TOKEN')
                if not args.proof:
                    raise RuntimeError('Set gopass misc/NANOCLAW_TEST_BOT_TOKEN')
            elif not args.proof:
                env['TELEGRAM_BOT_TOKEN'] = bot
            if not args.proof:
                env['ONECLI_URL'] = os.environ.get('LOCAL_ONECLI_URL', 'https://onecli.opx.one')
            write(ROOT / 'data/onecli/provider-credentials.json', json.dumps({
                'providers': {'claude': [os.environ['LOCAL_ANTHROPIC_SECRET_ID']]}, 'matched': ['claude']}))
        else:
            env.update(LIVEKIT_URL=f'ws://127.0.0.1:{b+2}', LIVEKIT_API_KEY='devkey', LIVEKIT_API_SECRET='secret')
        if args.profile == 'fast' and args.livekit == 'cloud':
            for key in ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']:
                env[key] = secret('misc/' + key)
        env['APP_PUBLIC_BASE'] = env['VOICE_MODE_PUBLIC_URL']
        env['APP_LIVEKIT_URL'] = env['LIVEKIT_URL']
        if os.environ.get('LOCAL_APNS') == '1':
            key_path = LOCAL / 'apns-sandbox.p8'
            write(key_path, '')
            key_path.chmod(0o600)
            with open(key_path, 'wb') as key_file:
                proc = subprocess.run(['gopass', 'show', '-n', 'fleet/nanoclaw/apns/sandbox-key'],
                                      env=clean_env(), stdout=key_file, stderr=subprocess.DEVNULL)
            if proc.returncode or not key_path.stat().st_size:
                key_path.unlink(missing_ok=True)
                raise RuntimeError('APNs sandbox key unavailable')
            env['APP_APNS_TEAM_ID'] = os.environ.get('LOCAL_APNS_TEAM_ID', '4L9YA7S99L')
            env['APP_APNS_SANDBOX_KEY_ID'] = secret('fleet/nanoclaw/apns/sandbox-key-id')
            env['APP_APNS_SANDBOX_KEY_PATH'] = str(key_path)
        write(ROOT / '.env', ''.join(k + '=' + v + '\n' for k, v in env.items()))
        result(state, 'env', 'pass', 'Profile allowlist rendered at mode 0600; fresh encryption key')
        if args.profile == 'fast' or args.proof:
            start(NODE + ['node', 'scripts/local/transport.mjs', 'gateway', str(b+5), str(run_dir / 'logs/gateway-requests.jsonl')], state, 'gateway')
            wait_port(b+5, state, 'gateway')
        if args.profile == 'fast' and args.livekit != 'cloud':
            config = run_dir / 'livekit.yaml'
            write(config, f'port: {b+2}\nrtc:\n  tcp_port: {b+3}\n  udp_port: {b+4}\n')
            start(['livekit-server', '--dev', '--bind', '127.0.0.1', '--config', str(config)], state, 'livekit')
            wait_port(b+2, state, 'livekit')
        if args.chain or args.profile == 'full':
            chain(state)
        hostenv = clean_env() | {'LOCAL_ADDRESS_LOG': str(run_dir / 'logs/address.jsonl'),
            'LOCAL_MAILBOX_LOG': str(run_dir / 'logs/mailbox.jsonl'), 'LOCAL_MAILBOX_PORT': str(b+1)}
        if args.profile == 'fast':
            hostenv['NANOCLAW_LOCAL_STAND_IN'] = '1'
        start(NODE + ['node', '--import', str(ROOT / 'scripts/local/observe.mjs'), 'dist/index.js'], state, 'host', hostenv)
        for _ in range(480):
            if (ROOT / 'data/ncl.sock').exists():
                break
            time.sleep(.25)
        else:
            raise RuntimeError('host CLI did not become ready; see logs/host.log')
        seed(state)
        start(NODE + ['pnpm', 'run', 'voice-mode-worker'], state, 'worker')
        wait_port(b+9, state, 'worker')
        result(state, 'boot', 'pass', 'Host CLI and worker health ready' + ('; local LiveKit ready' if state['livekit'] == 'dev' else '; Cloud configured'))
        if args.proof:
            result(state, 'full-boundary', 'pass', 'Placeholder seed; local gateway stand-in; no bot poller or agent spawn')
        status()
    except BaseException:
        result(state, 'up', 'fail', 'Startup failed; see command error and logs')
        down()
        raise


def down():
    if not STATE.exists():
        print('No local stack')
        return
    state = json.loads(STATE.read_text())
    if state['root'] != str(ROOT):
        raise RuntimeError('State belongs to another checkout; refusing cleanup')
    for proc in reversed(state['processes']):
        if birth(proc['pid']) != proc['birth']:
            continue
        try:
            os.killpg(proc['pid'], signal.SIGTERM)
            for _ in range(40):
                if not birth(proc['pid']):
                    break
                time.sleep(.1)
            os.killpg(proc['pid'], signal.SIGKILL)
        except ProcessLookupError:
            pass
    for _ in range(20):
        remaining = [p for p in state['processes'] if birth(p['pid']) == p['birth']]
        if not remaining:
            break
        time.sleep(.1)
    if remaining:
        result(state, 'down', 'fail', 'Owned processes still present; retained state and data for retry')
        raise RuntimeError('Cleanup could not verify process exit; retry just local down')
    (LOCAL / 'apns-sandbox.p8').unlink(missing_ok=True)
    for item in ['.env', 'data', 'store', 'groups/' + state['folder']]:
        path = ROOT / item
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    if state['lock'] and (LOCK / 'owner').read_text() == str(ROOT):
        shutil.rmtree(LOCK)
    result(state, 'down', 'pass', 'Owned process groups stopped; .env, data, store and test group removed')
    write(LOCAL / 'last-run', state['run'])
    STATE.unlink()
    print('Stopped; secrets and data removed. Run: ' + state['run'])


def status():
    if not STATE.exists():
        print('No local stack')
        return
    state = json.loads(STATE.read_text())
    print('Run: ' + state['run'])
    print('Profile: ' + state['profile'] + '; port block: ' + str(state['base']) + '..' + str(state['base']+9))
    print('LiveKit: ' + state.get('livekit', 'dev'))
    print('CA: ' + state.get('ca', 'chain disabled'))
    print('Voice: ' + state.get('url', 'http://127.0.0.1:' + str(state['base'])) + '/voice')
    for p in state['processes']:
        offsets = {'host': 0, 'livekit': 2, 'gateway': 5, 'caddy': 6, 'delay': 7, 'traefik': 8, 'worker': 9}
        port = state['base'] + offsets[p['name']]
        print(p['name'] + ': ' + ('running' if birth(p['pid']) == p['birth'] else 'stopped') + ' on 127.0.0.1:' + str(port))


def report():
    directory = os.environ.get('HEYDAN_RUN_DIR')
    if not directory:
        directory = json.loads(STATE.read_text())['run'] if STATE.exists() else (LOCAL / 'last-run').read_text()
    run_dir = Path(directory)
    rows = [json.loads(p.read_text()) for p in (run_dir / 'results').glob('*.json')]
    rows.sort(key=lambda r: ({'fail': 0, 'skip': 1, 'pass': 2}[r['status']], r['id']))
    write(run_dir / 'report.md', '\n'.join(f"- {r['status'].upper()}: {r['title']}: {r['detail']}" for r in rows) + '\n')
    print(run_dir / 'report.md')


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Settings: LOCAL_PORT_BASE (4100), HEYDAN_RUN_DIR, LOCAL_AGENT_PROVIDER (fast: stand-in), LOCAL_TEST_AGENT and LOCAL_ANTHROPIC_SECRET_ID (required for full), LOCAL_OWNER_ID (required for full; synthetic telegram:1 for fast/proof), LOCAL_ONECLI_URL, LOCAL_APNS (1 enables sandbox push), LOCAL_APNS_TEAM_ID, LOCAL_JEV_URL, LOCAL_JEV_MODEL, LOCAL_VOICE_MODE_<key>. Full starts real services only after owner approval; --proof uses a local gateway stand-in and disables the bot. No command sends a message. A real full bot may receive messages and spawn agents. Requires Python 3, mise, Docker, openssl, gopass and livekit-server. Check the stack with python3 -B scripts/local/verify.py.')
    parser.add_argument('command', choices=['up', 'down', 'status', 'report'])
    parser.add_argument('--profile', choices=['fast', 'full'], default='fast')
    parser.add_argument('--livekit', choices=['dev', 'cloud'], default='dev')
    parser.add_argument('--chain', action='store_true')
    parser.add_argument('--proof', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    os.chdir(ROOT)
    LOCAL.mkdir(exist_ok=True)
    try:
        if args.command == 'up':
            up(args)
        else:
            globals()[args.command]()
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
