import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url === '/voice') {
    fs.appendFileSync(process.env.LOCAL_ADDRESS_LOG, JSON.stringify({
      peer: args[0].socket.remoteAddress,
      forwarded: args[0].headers['x-forwarded-for'] ?? null,
    }) + '\n');
  }
  if (event === 'request' && args[0].socket.localPort === Number(process.env.LOCAL_MAILBOX_PORT)) {
    args[1].once('finish', () => fs.appendFileSync(process.env.LOCAL_MAILBOX_LOG, JSON.stringify({
      at: new Date().toISOString(), peer: args[0].socket.remoteAddress, status: args[1].statusCode,
    }) + '\n'));
  }
  return emit.call(this, event, ...args);
};

const request = https.request;
https.request = function (...args) {
  const req = request.apply(this, args);
  if (req.host === 'api.telegram.org' && req.path.endsWith('/getUpdates')) {
    req.once('response', (res) => fs.appendFileSync(process.env.LOCAL_MAILBOX_LOG,
      JSON.stringify({ at: new Date().toISOString(), telegramPoll: true, status: res.statusCode }) + '\n'));
  }
  return req;
};
