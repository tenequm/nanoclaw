import type { IncomingMessage, ServerResponse } from 'node:http';
import { appPeerAllowed } from '../../modules/device-auth/gate.js';
import { AuthError, verifyRequest } from '../../modules/device-auth/verify.js';
import { log } from '../../log.js';
import type { DeviceIdentity } from '../../modules/device-auth/verify.js';
import { handlePair, handleRevoke } from '../../modules/device-auth/pairing.js';
import { appFeatures } from './config.js';
import type { HelloResponse } from './contract.js';
import { listConversations, history, markRead } from './conversations.js';
import { sendMessage } from './send.js';
import { answerQuestion } from './questions.js';
import { streamEvents } from './stream.js';
import { mintFile, renewFileTicket, uploadFile, downloadFile } from './files.js';
import { registerPushToken } from './push.js';
import { startCall, endCall, cancelCallAttempt } from './calls.js';
import { getVoice, patchVoice, listVoices } from './voice.js';

export interface AppRequest {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  identity?: DeviceIdentity;
}
export type AppHandler = (context: AppRequest) => Promise<void>;
export interface AppRoute {
  method: string;
  path: string;
  signed: boolean;
  lane: string;
  handler: AppHandler;
}
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function notImplemented(context: AppRequest, lane: string): Promise<void> {
  json(context.res, 501, { error: 'not_implemented', message: `This feature is awaiting ${lane}.` });
  return Promise.resolve();
}
export const hello: AppHandler = async ({ res }) => {
  const body: HelloResponse = {
    protocol: 1,
    minProtocol: 1,
    voiceProtocol: 6,
    features: appFeatures(),
    serverTime: Date.now(),
  };
  json(res, 200, body);
};
export const routes: readonly AppRoute[] = [
  { method: 'GET', path: '/app/hello', signed: false, lane: 'N0', handler: hello },
  { method: 'POST', path: '/app/pair', signed: false, lane: 'N1', handler: handlePair },
  { method: 'GET', path: '/app/conversations', signed: true, lane: 'N2a', handler: listConversations },
  { method: 'GET', path: '/app/conversations/:id/messages', signed: true, lane: 'N2a', handler: history },
  { method: 'POST', path: '/app/conversations/:id/messages', signed: true, lane: 'N2a', handler: sendMessage },
  { method: 'POST', path: '/app/conversations/:id/read', signed: true, lane: 'N2a', handler: markRead },
  { method: 'POST', path: '/app/questions/:id/answer', signed: true, lane: 'N2a', handler: answerQuestion },
  { method: 'GET', path: '/app/events', signed: true, lane: 'N2b', handler: streamEvents },
  { method: 'POST', path: '/app/files', signed: true, lane: 'N3', handler: mintFile },
  { method: 'POST', path: '/app/files/:id/ticket', signed: true, lane: 'N3', handler: renewFileTicket },
  { method: 'PUT', path: '/app/files/:id', signed: false, lane: 'N3', handler: uploadFile },
  { method: 'GET', path: '/app/files/:id', signed: true, lane: 'N3', handler: downloadFile },
  { method: 'POST', path: '/app/calls', signed: true, lane: 'N5', handler: startCall },
  { method: 'POST', path: '/app/calls/:callId/end', signed: true, lane: 'N5', handler: endCall },
  {
    method: 'POST',
    path: '/app/calls/attempts/:attemptId/cancel',
    signed: true,
    lane: 'N5',
    handler: cancelCallAttempt,
  },
  { method: 'GET', path: '/app/conversations/:id/voice', signed: true, lane: 'N5', handler: getVoice },
  { method: 'PATCH', path: '/app/conversations/:id/voice', signed: true, lane: 'N5', handler: patchVoice },
  { method: 'GET', path: '/app/conversations/:id/voices', signed: true, lane: 'N5', handler: listVoices },
  { method: 'PUT', path: '/app/devices/me/push-token', signed: true, lane: 'N4', handler: registerPushToken },
  { method: 'DELETE', path: '/app/devices/me', signed: true, lane: 'N1', handler: handleRevoke },
];
export const dispatchApp: AppHandler = async ({ req, res }) => {
  try {
    if (!appPeerAllowed(req)) {
      json(res, 403, { error: 'forbidden', message: 'This peer is not allowed.' });
      return;
    }
    const pathname = (req.url || '').split('?', 1)[0];
    for (const route of routes) {
      if (req.method !== route.method) continue;
      const names: string[] = [];
      const pattern = route.path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
        names.push(name);
        return '([^/]+)';
      });
      const match = new RegExp(`^${pattern}$`).exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
      const identity = route.signed ? await verifyRequest(req) : undefined;
      await route.handler({ req, res, params, identity });
      return;
    }
    json(res, 404, { error: 'not_found', message: 'Route not found.' });
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof AuthError) {
      if (error.status === 429 && error.body.retryAfter != null)
        res.setHeader('Retry-After', String(error.body.retryAfter));
      json(res, error.status, error.body);
    } else {
      log.error('App request failed', { kind: error instanceof Error ? error.name : typeof error });
      json(res, 500, { error: 'internal', message: 'The request could not be completed.' });
    }
  }
};
