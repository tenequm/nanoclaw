import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [mode, port, target, evidence] = process.argv.slice(2);
if (mode === 'supervise') {
  const child = spawn(port, process.argv.slice(4), { stdio: ['ignore', 'pipe', 'pipe'] });
  // Runtime logs may contain caller text and call links; retain only fixed lifecycle events.
  const events = ['registered worker', 'starting worker', 'starting server', 'server is listening',
    'CLI socket server', 'Host sweep started', 'Delivery polls started', 'Channel adapter started',
    'Gateway approval', 'error', 'Error', 'failed', 'Failed'];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      const event = events.find((item) => line.includes(item));
      if (event) console.log(JSON.stringify({ at: new Date().toISOString(), event }));
    });
  }
  child.on('error', () => { console.error('Child failed to start'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    console.log(JSON.stringify({ event: 'exit', code, signal }));
    process.exit(code ?? 1);
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} else if (mode === 'gateway') {
  http.createServer((req, res) => {
    if (target) fs.appendFileSync(target, JSON.stringify({ method: req.method, discovery: req.url === '/v1/gateway-url', poll: req.url?.startsWith('/v1/approvals/pending') }) + '\n');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') {
      res.writeHead(403).end('{}');
    } else if (req.url === '/v1/gateway-url') {
      res.end(JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    } else if (req.url === '/v1/health') {
      res.end('{}');
    } else if (req.url?.startsWith('/v1/approvals/pending')) {
      setTimeout(() => res.end('{"requests":[],"timeoutSeconds":30}'), 1000);
    } else {
      res.writeHead(403).end('{}');
    }
  }).listen(Number(port), '127.0.0.1');
} else if (mode === 'delay') {
  net.createServer((client) => {
    const upstream = net.connect(Number(target), '127.0.0.1');
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    let prefix = Buffer.alloc(0);
    let inspected = false;
    client.on('data', (data) => {
      if (!inspected) {
        prefix = Buffer.concat([prefix, data]);
        if (prefix.length >= 16) {
          inspected = true;
          const v2 = prefix.subarray(0, 12).equals(Buffer.from('0d0a0d0a000d0a515549540a', 'hex'));
          fs.appendFileSync(evidence, JSON.stringify({ proxyV2: v2, plainHttpProbe: prefix.subarray(0, 12).toString() === 'GET / HTTP/1' }) + '\n');
        }
      }
    });
    // Delay each direction by 27 ms: 54 ms RTT, including established connections.
    const relay = (source, dest) => {
      let queuedBytes = 0;
      source.on('data', (data) => {
        queuedBytes += data.length;
        if (queuedBytes > 4 * 1024 * 1024) source.pause();
        setTimeout(() => {
          queuedBytes -= data.length;
          if (dest.destroyed) return;
          if (dest.write(data) && queuedBytes <= 4 * 1024 * 1024) source.resume();
          else dest.once('drain', () => source.resume());
        }, 27);
      });
      source.on('end', () => setTimeout(() => dest.end(), 27));
      source.on('error', () => dest.destroy());
      source.on('close', () => dest.destroy());
    };
    relay(client, upstream);
    relay(upstream, client);
  }).listen(Number(port), '127.0.0.1');
}
