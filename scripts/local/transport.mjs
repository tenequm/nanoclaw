import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DELAY_MS = 27;
const HIGH_WATER = 4 * 1024 * 1024;
const TAIL_LINES = 20;

const [mode, ...args] = process.argv.slice(2);
if (mode === 'supervise') {
  const [command, ...commandArgs] = args;
  const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Runtime logs may contain caller text and call links; retain only fixed lifecycle events.
  // verify.py and full.py read 'registered worker', 'Spawning session' and 'Session failed' from them.
  const events = ['registered worker', 'starting worker', 'starting server', 'server is listening',
    'CLI socket server', 'Host sweep started', 'Delivery polls started', 'Channel adapter started',
    'Gateway approval', 'Spawning session', 'Session failed', 'Session ended', '409: Conflict', 'error', 'Error', 'failed', 'Failed'];
  const tail = [];
  let stopping = false;
  for (const [stream, keep] of [[child.stdout, false], [child.stderr, true]]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (keep) {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
      const event = events.find((item) => line.includes(item));
      if (event) console.log(JSON.stringify({ at: new Date().toISOString(), event }));
    });
  }
  child.on('error', () => {
    console.error('Child failed to start');
    process.exitCode = 1;
  });
  // 'close' waits for the output streams, so the last lines before a crash are read; the
  // supervisor then exits on its own once its writes have flushed.
  child.on('close', (code, signal) => {
    // A child that dies on its own keeps its last stderr lines, so a failed startup can be diagnosed.
    if (!stopping && code !== 0) for (const line of tail) console.log(JSON.stringify({ stderr: line }));
    console.log(JSON.stringify({ event: 'exit', code, signal }));
    process.exitCode = code ?? 1;
  });
  // `down` signals the whole process group, so the child already has its own SIGTERM.
  process.on('SIGTERM', () => {
    stopping = true;
  });
} else if (mode === 'gateway') {
  const [port, requestLog] = args;
  const agents = new Map();
  http.createServer(async (req, res) => {
    if (requestLog) fs.appendFileSync(requestLog, JSON.stringify({ method: req.method, discovery: req.url === '/v1/gateway-url', poll: req.url?.startsWith('/v1/approvals/pending') }) + '\n');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/agents') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413).end('{}'); return; }
      }
      try {
        const { identifier, name } = JSON.parse(body);
        if (typeof identifier !== 'string' || typeof name !== 'string') throw new Error();
        if (agents.has(identifier)) { res.writeHead(409).end('{}'); return; }
        agents.set(identifier, { id: identifier, identifier, name });
        res.end('{}');
      } catch { res.writeHead(400).end('{}'); }
    } else if (req.method !== 'GET') {
      res.writeHead(403).end('{}');
    } else if (req.url === '/v1/gateway-url') {
      res.end(JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    } else if (req.url === '/v1/agents') {
      res.end(JSON.stringify([...agents.values()]));
    } else if (req.url === '/v1/secrets') {
      res.end('[]');
    } else if (/^\/v1\/agents\/[^/]+\/grants$/.test(req.url)) {
      res.end('{"secrets":[]}');
    } else if (req.url?.startsWith('/v1/container-config?agent=')) {
      const agent = new URL(req.url, 'http://localhost').searchParams.get('agent');
      if (!agents.has(agent)) { res.writeHead(404).end('{}'); return; }
      res.end(JSON.stringify({ env: {}, caCertificate: fs.readFileSync('/etc/ssl/cert.pem', 'utf8'),
        caCertificateContainerPath: '/tmp/local-gateway-ca.pem', credentialStubs: [] }));
    } else if (req.url === '/v1/health') {
      res.end('{}');
    } else if (req.url?.startsWith('/v1/approvals/pending')) {
      setTimeout(() => res.end('{"requests":[],"timeoutSeconds":30}'), 1000);
    } else {
      res.writeHead(403).end('{}');
    }
  }).listen(Number(port), '127.0.0.1');
} else if (mode === 'delay') {
  const [port, upstreamPort, evidence] = args;
  // Half-open sockets let each FIN wait out the delay behind the data sent before it.
  net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ port: Number(upstreamPort), host: '127.0.0.1', allowHalfOpen: true });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    let prefix = Buffer.alloc(0);
    const inspect = (data) => {
      prefix = Buffer.concat([prefix, data]);
      if (prefix.length < 16) return;
      client.off('data', inspect);
      const v2 = prefix.subarray(0, 12).equals(Buffer.from('0d0a0d0a000d0a515549540a', 'hex'));
      fs.appendFileSync(evidence, JSON.stringify({ proxyV2: v2, plainHttpProbe: prefix.subarray(0, 12).toString() === 'GET / HTTP/1' }) + '\n');
      prefix = null;
    };
    client.on('data', inspect);
    // Delay each direction by DELAY_MS (54 ms RTT), including established connections.
    const relay = (source, dest) => {
      let queuedBytes = 0;
      let blocked = false;
      const resume = () => {
        if (!blocked && queuedBytes <= HIGH_WATER) source.resume();
      };
      dest.on('drain', () => {
        blocked = false;
        resume();
      });
      source.on('data', (data) => {
        queuedBytes += data.length;
        if (queuedBytes > HIGH_WATER) source.pause();
        setTimeout(() => {
          queuedBytes -= data.length;
          if (dest.destroyed) return;
          if (!dest.write(data)) {
            blocked = true;
            source.pause();
          }
          resume();
        }, DELAY_MS);
      });
      source.on('end', () => setTimeout(() => dest.end(), DELAY_MS));
      source.on('error', () => dest.destroy());
      source.on('close', (hadError) => {
        if (hadError) dest.destroy();
      });
    };
    relay(client, upstream);
    relay(upstream, client);
  }).listen(Number(port), '127.0.0.1');
}
