"""Disposable local NanoClaw stack: up, down, status and report. See docs/local-stack.md."""
import argparse
import base64
from contextlib import closing
import datetime
import functools
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.local'
STATE = LOCAL / 'stack.json'
# A fixed path, not TMPDIR, so every shell of this user sees the same full-profile lock.
LOCK = Path('/tmp') / f'nanoclaw-full-{os.getuid()}.lock'
NODE = ['mise', 'x', 'node@24.22.2', '--']
# Mirrors setup/lib/install-slug.sh: the host names this checkout's image and labels its containers with it.
SLUG = hashlib.sha1(str(ROOT).encode()).hexdigest()[:8]
PROXY_HOST = '127.0.0.1.sslip.io'
CLI_PLATFORM_ID = 'local'
PORT_OFFSETS = dict(host=0, livekit=2, gateway=5, caddy=6, delay=7, traefik=8, worker=9)
CADDY, CADDY_L4 = 'v2.11.9', 'v0.1.3'
TRAEFIK = 'v3.6.14'
TRAEFIK_SHA256 = dict(arm64='b38f6cf569f1579205ac6b7e6d1f2dff8dddded5a3eeb3c14e926e6dea9f971e',
                      amd64='e596cb52b7c5a47b4fd86255130afcf9d9703aacbac24518b845531d0ea7db42')
# Operator-specific names live outside the checkout, so every disposable checkout shares them.
SETTINGS = Path(os.environ.get('NANOCLAW_LOCAL_SETTINGS') or Path.home() / '.config/nanoclaw/local-stack.env')
# Rendered .env key -> the setting naming its secret-store entry.
VOICE_SECRETS = dict(VOICE_MODE_GEMINI_API_KEY='LOCAL_GEMINI_API_KEY_ENTRY', JEV_API_KEY='LOCAL_JEV_API_KEY_ENTRY')
CLOUD_SECRETS = dict(LIVEKIT_URL='LOCAL_LIVEKIT_URL_ENTRY', LIVEKIT_API_KEY='LOCAL_LIVEKIT_API_KEY_ENTRY',
                     LIVEKIT_API_SECRET='LOCAL_LIVEKIT_API_SECRET_ENTRY')
WAKE_MODEL = 'data/voice-models/wake.onnx'


@functools.cache
def file_settings():
    try:
        lines = SETTINGS.read_text().splitlines()
    except FileNotFoundError:
        return {}
    values = {}
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep:
            raise RuntimeError(f'{SETTINGS}:{number} is not KEY=VALUE')
        values[key.strip()] = value.strip()
    return values


def setting(key, default=None):
    return os.environ.get(key) or file_settings().get(key) or default


def require(*keys):
    missing = [key for key in keys if not setting(key)]
    if missing:
        raise RuntimeError('Set ' + ', '.join(missing) + f' in the environment or {SETTINGS}; see docs/local-stack.md')


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as out:
        out.write(value)


def save(state):
    write(STATE, json.dumps(state, indent=2))


def claim(state):
    try:
        fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError('This checkout already has a stack; use just local down') from None
    with os.fdopen(fd, 'w') as out:
        out.write(json.dumps(state, indent=2))


def load_state(profile=None):
    state = json.loads(STATE.read_text())
    if state['root'] != str(ROOT) or (profile and state['profile'] != profile):
        raise RuntimeError('Requires this checkout\'s ' + (profile + ' ' if profile else '') + 'local stack')
    return state


def read_env():
    return dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines())


def result(state, ident, status, detail, evidence=None):
    write(Path(state['run']) / 'results' / (ident + '.json'), json.dumps(dict(
        id=ident, title=ident.replace('-', ' '), status=status, detail=detail,
        evidence=evidence or [], at=datetime.datetime.now(datetime.timezone.utc).isoformat())))


def clean_env():
    # Only machine/runtime inputs cross into children; inherited channel credentials never do.
    return {k: v for k, v in os.environ.items() if k in (
        'PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'SSH_AUTH_SOCK', 'DOCKER_HOST',
        'MISE_DATA_DIR', 'XDG_CONFIG_HOME', 'LANG', 'GOPASS_STORE_DIR')}


def run(args, state, name, env=None):
    log = Path(state['run']) / 'logs' / (name + '.log')
    with open(log, 'ab') as out:
        done = subprocess.run(args, cwd=ROOT, env=env or clean_env(), stdout=out, stderr=out)
    if done.returncode:
        raise RuntimeError(f'{name} failed ({done.returncode}); see logs/{name}.log')


def birth(pid):
    # lstart follows locale and timezone; pin both so up and down compare the same text.
    return subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True,
                          env=clean_env() | {'LC_ALL': 'C', 'TZ': 'UTC'}).stdout.strip()


def start(args, state, name, env=None):
    with open(Path(state['run']) / 'logs' / (name + '.log'), 'ab') as out:
        child = subprocess.Popen(NODE + ['node', 'scripts/local/transport.mjs', 'supervise'] + args, cwd=ROOT, env=env or clean_env(),
                                 stdout=out, stderr=out, start_new_session=True)
    state['processes'].append(dict(name=name, pid=child.pid, birth=birth(child.pid)))
    save(state)


def wait_port(port, name):
    for _ in range(480):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return
        except OSError:
            time.sleep(.25)
    raise RuntimeError(f'{name} did not listen on {port}; see logs/{name}.log')


def secret(key):
    command = shlex.split(setting('LOCAL_SECRET_CMD', 'gopass show --password')) + [setting(key)]
    proc = subprocess.run(command, env=clean_env(), capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(f'Secret store entry named by {key} is unavailable')
    value = proc.stdout.strip()
    if not value or '\n' in value or '\r' in value:
        raise RuntimeError(f'Secret store entry named by {key} is not a single value')
    return value


def secret_file(key, path):
    # A whole multi-line entry, such as a key file, goes from the store straight into a mode-0600 file.
    command = shlex.split(setting('LOCAL_SECRET_FILE_CMD', 'gopass show -n')) + [setting(key)]
    write(path, '')
    path.chmod(0o600)
    with open(path, 'wb') as out:
        proc = subprocess.run(command, env=clean_env(), stdout=out, stderr=subprocess.DEVNULL)
    if proc.returncode or not path.stat().st_size:
        path.unlink(missing_ok=True)
        raise RuntimeError(f'Secret store entry named by {key} is unavailable')


def wake_model():
    # A local file is read in place; any other source is an scp source, fetched once into a per-digest cache.
    source = setting('LOCAL_WAKE_MODEL_SOURCE', '')
    if source.startswith(('/', '~', '.')):
        return Path(source).expanduser(), None
    return LOCAL / 'cache' / f"wake-{setting('LOCAL_WAKE_MODEL_SHA256')[:16]}.onnx", source


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(state):
    run(NODE + ['pnpm', 'install', '--frozen-lockfile'], state, 'install')
    run(['bun', 'install', '--cwd', 'container/agent-runner', '--frozen-lockfile'], state, 'runner-install')
    run(NODE + ['pnpm', 'run', 'build'], state, 'build')
    run(NODE + ['pnpm', 'exec', 'tsx', 'scripts/upgrade-state.ts', 'set'], state, 'upgrade')
    marker = LOCAL / 'image-built'
    image = f'nanoclaw-agent-v2-{SLUG}:latest'
    present = subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    built = not marker.exists() or marker.read_text() != str(ROOT) or not present
    if built:
        run(['bash', 'container/build.sh'], state, 'image')
        write(marker, str(ROOT))
    result(state, 'install', 'pass', 'Installed, built, upgrade state set, image ' + ('built' if built else 'present') + ' for this path')


def binaries(state):
    dest = LOCAL / 'bin'
    dest.mkdir(exist_ok=True)
    caddy = dest / f'caddy-{CADDY}-l4-{CADDY_L4}'
    if not caddy.exists():
        env = clean_env() | {'GOFLAGS': '-buildvcs=false'}
        run(['mise', 'x', 'go@1.27.4', 'go:github.com/caddyserver/xcaddy/cmd/xcaddy@0.4.7',
             '--', 'xcaddy', 'build', CADDY, '--with', f'github.com/mholt/caddy-l4@{CADDY_L4}',
             '--output', str(caddy)], state, 'caddy-build', env)
    traefik = dest / f'traefik-{TRAEFIK}'
    if not traefik.exists():
        arch = 'arm64' if platform.machine() == 'arm64' else 'amd64'
        archive = dest / 'traefik.tar.gz'
        run(['curl', '-fsSL', f'https://github.com/traefik/traefik/releases/download/{TRAEFIK}/traefik_{TRAEFIK}_darwin_{arch}.tar.gz', '-o', str(archive)], state, 'traefik-download')
        if sha256(archive) != TRAEFIK_SHA256[arch]:
            raise RuntimeError(f'Traefik {TRAEFIK} download checksum mismatch')
        run(['tar', '-xzf', str(archive), '-C', str(dest), 'traefik'], state, 'traefik-extract')
        (dest / 'traefik').rename(traefik)
    return caddy, traefik


def chain(state):
    caddy, traefik = binaries(state)
    b = state['base']
    ca = LOCAL / 'ca'
    ca.mkdir(exist_ok=True)
    root = ca / 'root.crt'
    # Renew a CA that would expire within the server certificate's 7 days.
    current = root.exists() and (ca / 'format-v1').exists() and subprocess.run(
        ['openssl', 'x509', '-checkend', str(7 * 86400), '-noout', '-in', str(root)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not current:
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
             '-subj', '/CN=NanoClaw local test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
             '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', str(ca / 'root.key'),
             '-out', str(root)], state, 'ca')
        write(ca / 'format-v1', '1')
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={PROXY_HOST}',
         '-keyout', str(ca / 'server.key'), '-out', str(ca / 'server.csr')], state, 'cert')
    write(ca / 'extensions', f'subjectAltName=DNS:{PROXY_HOST}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
    run(['openssl', 'x509', '-req', '-in', str(ca / 'server.csr'), '-CA', str(root),
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
            'rule': f'Host(`{PROXY_HOST}`) && PathPrefix(`/voice`)', 'service': 'host', 'tls': {}},
            'app': {'entryPoints': ['websecure'],
                'rule': f'Host(`{PROXY_HOST}`) && PathPrefix(`/app`)', 'service': 'host', 'tls': {}}},
            'services': {'host': {'loadBalancer': {'servers': [{'url': f'http://127.0.0.1:{b}'}]}}}}}))
    # Caddy also listens on ::1 so verify.py can tell the PROXY v2 client address from Traefik's own peer.
    write(config / 'Caddyfile', f'''{{
    admin off
    auto_https off
    servers {{
        protocols h1 h2
    }}
}}
https://{PROXY_HOST}:{b+6} {{
    bind 127.0.0.1 [::1]
    tls {ca}/server.crt {ca}/server.key
    @app path /app /app/*
    request_body @app {{
        max_size 26MiB
    }}
    reverse_proxy https://127.0.0.1:{b+7} {{
        stream_close_delay 5m
        header_up Host {{host}}
        transport http {{
            tls_server_name {PROXY_HOST}
            tls_trust_pool file {{
                pem_file {root}
            }}
            proxy_protocol v2
        }}
    }}
}}
''')
    start([str(traefik), '--configFile=' + str(config / 'traefik.json')], state, 'traefik')
    start(NODE + ['node', 'scripts/local/transport.mjs', 'delay', str(b+7), str(b+8),
                  str(config / 'logs/proxy.jsonl')], state, 'delay')
    start([str(caddy), 'run', '--config', str(config / 'Caddyfile')], state, 'caddy', clean_env() | {'XDG_DATA_HOME': str(LOCAL / 'caddy-data'), 'XDG_CONFIG_HOME': str(LOCAL / 'caddy-config')})
    for name in ['caddy', 'delay', 'traefik']:
        wait_port(b + PORT_OFFSETS[name], name)
    state['ca'] = str(root)
    state['url'] = f'https://{PROXY_HOST}:{b+6}'
    save(state)


def ncl(*args):
    p = subprocess.run(NODE + ['node', 'dist/cli/client.js', *args, '--json'],
                       cwd=ROOT, env=clean_env(), capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('ncl ' + ' '.join(args[:2]) + f' failed ({p.returncode}); response withheld')
    return json.loads(p.stdout)['data']


def send_cli(state, text):
    ncl('messaging-groups', 'send', '--channel-type', 'cli', '--platform-id', CLI_PLATFORM_ID,
        '--sender-id', state['owner'], '--text', text)


def connect_ro(path):
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)


# (outbound.db path, message id, content, delivery status) for every session's outbound messages.
def outbound_rows():
    rows = []
    for path in (ROOT / 'data/v2-sessions').rglob('outbound.db'):
        try:
            with closing(connect_ro(path)) as outbound, closing(connect_ro(path.with_name('inbound.db'))) as inbound:
                delivered = dict(inbound.execute('select message_out_id,status from delivered'))
                rows += [(str(path), ident, json.loads(content), delivered.get(ident))
                         for ident, content in outbound.execute('select id,content from messages_out')]
        except sqlite3.OperationalError:
            continue  # A session the host is still creating has no schema yet.
    return rows


def seed(state):
    owner = state['owner']
    ncl('users', 'create', '--id', owner, '--kind', 'telegram', '--display-name', 'Local owner')
    ncl('roles', 'grant', '--user', owner, '--role', 'owner')
    folder = state['folder']
    if state['profile'] == 'full':
        # ncl generates IDs; seed the approved identifier before its idempotent filesystem setup.
        ident = setting('LOCAL_TEST_AGENT')
        sql = "INSERT INTO agent_groups (id,name,folder,created_at) VALUES (" + ','.join(
            "'" + v.replace("'", "''") + "'" for v in [ident, 'Local test', folder,
            datetime.datetime.now(datetime.timezone.utc).isoformat()]) + ')'
        run(NODE + ['pnpm', 'exec', 'tsx', 'scripts/q.ts', 'data/v2.db', sql], state, 'group-identity')
    group = ncl('groups', 'create', '--folder', folder, '--name', 'Local test')
    state['group'] = group['id']
    save(state)
    provider = setting('LOCAL_AGENT_PROVIDER', 'stand-in' if state['profile'] == 'fast' else '')
    if provider:
        ncl('groups', 'config', 'update', '--id', group['id'], '--provider', provider)
    cli = ncl('messaging-groups', 'create', '--channel-type', 'cli', '--platform-id', CLI_PLATFORM_ID, '--name', 'Local CLI')
    ncl('wirings', 'create', '--agent-group-id', group['id'], '--messaging-group-id', cli['id'])
    mg = ncl('messaging-groups', 'create', '--channel-type', 'telegram',
             '--platform-id', owner, '--name', 'Local test DM')
    ncl('wirings', 'create', '--agent-group-id', group['id'], '--messaging-group-id', mg['id'])
    if mg['platform_id'] != owner:
        raise RuntimeError('Seeded Telegram DM platform id does not match owner')
    result(state, 'seed', 'pass', 'Fresh DB, owner, role, group and DM wiring created; no inbound messages')


def up(args):
    if STATE.exists():
        raise RuntimeError('This checkout already has a stack; use just local down')
    for path in ['.env', 'data', 'store']:
        if (ROOT / path).exists() or (ROOT / path).is_symlink():
            raise RuntimeError(f'Refusing existing {path}; use a disposable checkout')
    livekit = 'cloud' if args.profile == 'full' else args.livekit
    needed = [*VOICE_SECRETS.values(), 'LOCAL_WAKE_MODEL_SHA256', *(CLOUD_SECRETS.values() if livekit == 'cloud' else [])]
    if args.profile == 'full':
        needed += ['LOCAL_TEST_AGENT', 'LOCAL_ANTHROPIC_SECRET_ID']
        if not args.proof:
            needed += ['LOCAL_OWNER_ID', 'LOCAL_ONECLI_URL', 'LOCAL_TEST_BOT_TOKEN_ENTRY']
    if setting('LOCAL_APNS') == '1':
        needed += ['LOCAL_APNS_KEY_ENTRY', 'LOCAL_APNS_KEY_ID_ENTRY', 'LOCAL_APNS_TEAM_ID', 'LOCAL_APNS_TOPIC']
    require(*needed)
    if not re.fullmatch(r'[0-9a-f]{64}', setting('LOCAL_WAKE_MODEL_SHA256')):
        raise RuntimeError('LOCAL_WAKE_MODEL_SHA256 must be 64 lowercase hex digits')
    model, remote = wake_model()
    if not model.exists():
        if remote is None and setting('LOCAL_WAKE_MODEL_SOURCE'):
            raise RuntimeError(f'LOCAL_WAKE_MODEL_SOURCE file not found: {model}')
        require('LOCAL_WAKE_MODEL_SOURCE')
    owner = setting('LOCAL_OWNER_ID', 'telegram:1' if args.profile == 'fast' or args.proof else '')
    if not re.fullmatch(r'telegram:[1-9][0-9]*', owner):
        raise RuntimeError('Set LOCAL_OWNER_ID to telegram:<positive numeric user id>')
    b = int(setting('LOCAL_PORT_BASE', '4100'))
    if b < 1024 or b > 65400:
        raise RuntimeError('LOCAL_PORT_BASE must be 1024..65400')
    run_dir = Path(setting('LOCAL_RUN_DIR', str(LOCAL / 'runs' /
        datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')))).resolve()
    (run_dir / 'logs').mkdir(parents=True, exist_ok=True)
    state = dict(run=str(run_dir), root=str(ROOT), owner=owner, base=b, profile=args.profile, proof=args.proof,
                 livekit=livekit, processes=[], folder='local-' + secrets.token_hex(6), lock=False)
    claim(state)
    try:
        if args.profile == 'full':
            try:
                LOCK.mkdir(mode=0o700)
            except FileExistsError:
                raise RuntimeError(f'full profile locked: {LOCK}') from None
            write(LOCK / 'owner', str(ROOT))
            state['lock'] = True
            save(state)
        for offset in range(10):
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', b+offset))
        install(state)
        env = dict(NANOCLAW_GATEWAY_PROVIDER='onecli', ONECLI_URL=f'http://127.0.0.1:{b+5}',
                   WEBHOOK_HOST='127.0.0.1', WEBHOOK_PORT=str(b),
                   NANOCLAW_MAILBOX_HTTP_PORT=str(b+1), NANOCLAW_MAILBOX_HTTP_BIND='127.0.0.1',
                   LIVEKIT_HOST_URL=f'http://127.0.0.1:{b}', VOICE_MODE_WORKER_HEALTH_PORT=str(b+9),
                   VOICE_MODE_PUBLIC_URL=(f'https://{PROXY_HOST}:{b+6}' if args.chain or args.profile == 'full' else f'http://127.0.0.1:{b}'),
                   LIVEKIT_AGENT_NAME='local-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12],
                   NANOCLAW_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
                   JEV_URL=setting('LOCAL_JEV_URL', 'https://openrouter.ai/api/v1/systemone'),
                   JEV_MODEL=setting('LOCAL_JEV_MODEL', 'jev-1.14'), VOICE_MODE_WAKE_MODEL=WAKE_MODEL)
        for key, entry_setting in VOICE_SECRETS.items():
            env[key] = secret(entry_setting)
        # WAKE_PHRASE and VOCABULARY name the agent, so they come only from settings.
        voice = dict(WAKE_THRESHOLD='0.75', WAKE_HOP_MS='40', SILENCE_MS='1500', MAX_CALLS_PER_HOUR='40',
                     MAX_CALL_SECONDS='3600', MAX_SPOKEN_CHARS='0', WAKE_PHRASE=None, VOCABULARY=None)
        for key, default in voice.items():
            value = setting('LOCAL_VOICE_MODE_' + key, default)
            if value is not None:
                env['VOICE_MODE_' + key] = value
        configured = [k for k in ['LOCAL_JEV_URL', 'LOCAL_JEV_MODEL', *('LOCAL_VOICE_MODE_' + key for key in voice)] if setting(k)]
        if not model.exists():
            partial = model.with_name(model.name + '.part')
            partial.parent.mkdir(parents=True, exist_ok=True)
            run(['scp', remote, str(partial)], state, 'wake-model')
            partial.rename(model)
        if sha256(model) != setting('LOCAL_WAKE_MODEL_SHA256'):
            raise RuntimeError(f'Wake model {model} does not match LOCAL_WAKE_MODEL_SHA256'
                               + ('' if remote is None else '; remove it to fetch it again'))
        target = ROOT / WAKE_MODEL
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(model, target)
        result(state, 'voice-settings', 'pass', 'Wake model SHA-256 verified; from settings: ' + (
            ', '.join(configured) or 'none') + '; other voice values are the stack.py defaults')
        if state['livekit'] == 'cloud':
            for key, entry_setting in CLOUD_SECRETS.items():
                env[key] = secret(entry_setting)
        else:
            env.update(LIVEKIT_URL=f'ws://127.0.0.1:{b+2}', LIVEKIT_API_KEY='devkey', LIVEKIT_API_SECRET='secret')
        if args.profile == 'full':
            if not args.proof:
                env['TELEGRAM_BOT_TOKEN'] = secret('LOCAL_TEST_BOT_TOKEN_ENTRY')
                env['ONECLI_URL'] = setting('LOCAL_ONECLI_URL')
            write(ROOT / 'data/onecli/provider-credentials.json', json.dumps({
                'providers': {'claude': [setting('LOCAL_ANTHROPIC_SECRET_ID')]}, 'matched': ['claude']}))
        env['APP_PUBLIC_BASE'] = env['VOICE_MODE_PUBLIC_URL']
        env['APP_LIVEKIT_URL'] = env['LIVEKIT_URL']
        if setting('LOCAL_APNS') == '1':
            key_path = LOCAL / 'apns-sandbox.p8'
            secret_file('LOCAL_APNS_KEY_ENTRY', key_path)
            env['APP_APNS_TEAM_ID'] = setting('LOCAL_APNS_TEAM_ID')
            env['APP_APNS_TOPIC'] = setting('LOCAL_APNS_TOPIC')
            env['APP_APNS_SANDBOX_KEY_ID'] = secret('LOCAL_APNS_KEY_ID_ENTRY')
            env['APP_APNS_SANDBOX_KEY_PATH'] = str(key_path)
        write(ROOT / '.env', ''.join(k + '=' + v + '\n' for k, v in env.items()))
        result(state, 'env', 'pass', 'Profile allowlist rendered at mode 0600; fresh encryption key')
        if args.profile == 'fast' or args.proof:
            start(NODE + ['node', 'scripts/local/transport.mjs', 'gateway', str(b+5), str(run_dir / 'logs/gateway-requests.jsonl')], state, 'gateway')
            wait_port(b+5, 'gateway')
        if state['livekit'] == 'dev':
            config = run_dir / 'livekit.yaml'
            write(config, f'port: {b+2}\nrtc:\n  tcp_port: {b+3}\n  udp_port: {b+4}\n')
            start(['livekit-server', '--dev', '--bind', '127.0.0.1', '--config', str(config)], state, 'livekit')
            wait_port(b+2, 'livekit')
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
        wait_port(b+9, 'worker')
        result(state, 'boot', 'pass', 'Host CLI and worker health ready' + ('; local LiveKit ready' if state['livekit'] == 'dev' else '; Cloud configured'))
        if args.proof:
            bounded = 'TELEGRAM_BOT_TOKEN' not in env and env['ONECLI_URL'] == f'http://127.0.0.1:{b+5}'
            result(state, 'full-boundary', 'pass' if bounded else 'fail',
                   'Rendered env has no bot token and the local gateway; verify.py checks that no session started')
        status()
    except BaseException:
        try:
            result(state, 'up', 'fail', 'Startup failed; see command error and logs')
        finally:
            down()
        raise


def containers():
    p = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label=nanoclaw-install={SLUG}'],
                       env=clean_env(), capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('docker ps failed; start Docker and retry just local down')
    return p.stdout.split()


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
    # The host leaves session containers running when it stops; only a host that ran can have made any.
    left = []
    if not remaining and any(p['name'] == 'host' for p in state['processes']):
        left = containers()
        if left:
            subprocess.run(['docker', 'rm', '-f', *left], env=clean_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            left = containers()
    if remaining or left:
        result(state, 'down', 'fail', 'Owned processes or agent containers still present; retained state and data for retry')
        raise RuntimeError('Cleanup could not verify process and container exit; retry just local down')
    (LOCAL / 'apns-sandbox.p8').unlink(missing_ok=True)
    for item in ['.env', 'data', 'store', 'groups/' + state['folder']]:
        path = ROOT / item
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    if state['lock']:
        try:
            owned = (LOCK / 'owner').read_text() == str(ROOT)
        except FileNotFoundError:
            owned = False
        if owned:
            shutil.rmtree(LOCK)
    result(state, 'down', 'pass', 'Owned process groups and agent containers stopped; .env, data, store and test group removed')
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
    print('LiveKit: ' + state['livekit'])
    print('CA: ' + state.get('ca', 'chain disabled'))
    print('Voice: ' + state.get('url', 'http://127.0.0.1:' + str(state['base'])) + '/voice')
    for p in state['processes']:
        port = state['base'] + PORT_OFFSETS[p['name']]
        print(p['name'] + ': ' + ('running' if birth(p['pid']) == p['birth'] else 'stopped') + ' on 127.0.0.1:' + str(port))


def report():
    directory = setting('LOCAL_RUN_DIR')
    if not directory:
        directory = json.loads(STATE.read_text())['run'] if STATE.exists() else (LOCAL / 'last-run').read_text()
    run_dir = Path(directory)
    rows = [json.loads(p.read_text()) for p in (run_dir / 'results').glob('*.json')]
    rows.sort(key=lambda r: ({'fail': 0, 'skip': 1, 'pass': 2}[r['status']], r['id']))
    write(run_dir / 'report.md', '\n'.join(f"- {r['status'].upper()}: {r['title']}: {r['detail']}" for r in rows) + '\n')
    print(run_dir / 'report.md')


def client(args):
    state = load_state('fast')
    if args.chain and 'ca' not in state:
        raise RuntimeError('Start the local stack with --chain first')
    base = state['url'] if args.chain else f"http://127.0.0.1:{state['base']}"
    env = clean_env() | {'LOCAL_RUN_DIR': state['run']}
    if args.chain:
        env['NODE_EXTRA_CA_CERTS'] = state['ca']
    run(NODE + ['pnpm', 'exec', 'tsx', 'scripts/app-client.ts', args.scenario,
                '--base', base], state, 'app-client-command', env)
    print('Client results: ' + state['run'])


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Settings, requirements, ports and probes: docs/local-stack.md. '
                                     'Run full only with owner approval: its bot may receive messages and spawn real agents. '
                                     'The client sends scripted messages to the fast-profile agent; check a running stack with python3 -B scripts/local/verify.py.')
    parser.add_argument('command', choices=['up', 'down', 'status', 'report', 'client'])
    parser.add_argument('scenario', nargs='?', default='all', choices=['pair', 'send', 'stream', 'upload', 'security', 'all'])
    parser.add_argument('--profile', choices=['fast', 'full'], default='fast',
                        help='fast: stand-in agent and local gateway; full: the approved test agent, test bot and LiveKit Cloud')
    parser.add_argument('--livekit', choices=['dev', 'cloud'], default='dev', help='fast only: local LiveKit dev server or Cloud')
    parser.add_argument('--chain', action='store_true', help='route voice through the local Caddy, delay relay and Traefik chain (always on for full)')
    parser.add_argument('--proof', action='store_true', help='full only: local gateway, no bot token; checks startup and seeding')
    args = parser.parse_args()
    if args.proof and args.profile != 'full':
        parser.error('--proof applies to --profile full')
    os.umask(0o077)
    os.chdir(ROOT)
    LOCAL.mkdir(exist_ok=True)
    try:
        if args.command == 'up':
            up(args)
        elif args.command == 'client':
            client(args)
        else:
            globals()[args.command]()
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
