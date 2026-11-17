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
  return emit.call(this, event, ...args);
};
