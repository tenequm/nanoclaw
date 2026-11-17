import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

const mailboxPort = Number(process.env.LOCAL_MAILBOX_PORT);
// Evidence is best effort: a failed write must never reach the host's uncaught-exception exit.
const append = (file, row) => {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch {}
};

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url === '/voice') {
    append(process.env.LOCAL_ADDRESS_LOG, {
      peer: args[0].socket.remoteAddress,
      forwarded: args[0].headers['x-forwarded-for'] ?? null,
    });
  }
  if (event === 'request' && args[0].socket.localPort === mailboxPort) {
    args[1].once('finish', () => append(process.env.LOCAL_MAILBOX_LOG, {
      at: new Date().toISOString(), peer: args[0].socket.remoteAddress, status: args[1].statusCode,
    }));
  }
  return emit.call(this, event, ...args);
};

const request = https.request;
https.request = function (...args) {
  const req = request.apply(this, args);
  if (req.host === 'api.telegram.org' && req.path.endsWith('/getUpdates')) {
    req.once('response', (res) => append(process.env.LOCAL_MAILBOX_LOG,
      { at: new Date().toISOString(), telegramPoll: true, status: res.statusCode }));
  }
  return req;
};
