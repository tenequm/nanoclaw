import { appPeerAllowed } from '../../modules/device-auth/gate.js';
import { AuthError, verifyRequest } from '../../modules/device-auth/verify.js';
import { log } from '../../log.js';
import { handlePair, handleRevoke } from '../../modules/device-auth/pairing.js';
import { json, type AppHandler } from './http.js';
import { appFeatures } from './config.js';
import { APP_PROTOCOL, type HelloResponse } from './contract.js';
import { LIVEKIT_PROTOCOL_VERSION } from '../voice-mode-protocol.js';
import { listConversations, history, markRead, markUnread, listAgents, setAgentShown } from './conversations.js';
import { sendMessage } from './send.js';
import { answerQuestion } from './questions.js';
import { streamEvents } from './stream.js';
import { mintFile, renewFileTicket, uploadFile, downloadFile } from './files.js';
import { registerPushToken } from './push.js';
import { startCall, endCall, cancelCallAttempt } from './calls.js';
import { getVoice, patchVoice, listVoices } from './voice.js';

export { json, type AppHandler, type AppRequest } from './http.js';
export interface AppRoute {
  method: string;
  path: string;
  signed: boolean;
  handler: AppHandler;
}
export const hello: AppHandler = async ({ res }) => {
  const body: HelloResponse = {
    protocol: APP_PROTOCOL,
    minProtocol: APP_PROTOCOL,
    voiceProtocol: LIVEKIT_PROTOCOL_VERSION,
    features: appFeatures(),
    serverTime: Date.now(),
  };
  json(res, 200, body);
};
export const routes: readonly AppRoute[] = [
  { method: 'GET', path: '/app/hello', signed: false, handler: hello },
  { method: 'POST', path: '/app/pair', signed: false, handler: handlePair },
  { method: 'GET', path: '/app/agents', signed: true, handler: listAgents },
  { method: 'PUT', path: '/app/agents/:id', signed: true, handler: setAgentShown },
  { method: 'POST', path: '/app/conversations/:id/unread', signed: true, handler: markUnread },
  { method: 'GET', path: '/app/conversations', signed: true, handler: listConversations },
  { method: 'GET', path: '/app/conversations/:id/messages', signed: true, handler: history },
  { method: 'POST', path: '/app/conversations/:id/messages', signed: true, handler: sendMessage },
  { method: 'POST', path: '/app/conversations/:id/read', signed: true, handler: markRead },
  { method: 'POST', path: '/app/questions/:id/answer', signed: true, handler: answerQuestion },
  { method: 'GET', path: '/app/events', signed: true, handler: streamEvents },
  { method: 'POST', path: '/app/files', signed: true, handler: mintFile },
  { method: 'POST', path: '/app/files/:id/ticket', signed: true, handler: renewFileTicket },
  { method: 'PUT', path: '/app/files/:id', signed: false, handler: uploadFile },
  { method: 'GET', path: '/app/files/:id', signed: true, handler: downloadFile },
  { method: 'POST', path: '/app/calls', signed: true, handler: startCall },
  { method: 'POST', path: '/app/calls/:callId/end', signed: true, handler: endCall },
  {
    method: 'POST',
    path: '/app/calls/attempts/:attemptId/cancel',
    signed: true,
    handler: cancelCallAttempt,
  },
  { method: 'GET', path: '/app/conversations/:id/voice', signed: true, handler: getVoice },
  { method: 'PATCH', path: '/app/conversations/:id/voice', signed: true, handler: patchVoice },
  { method: 'GET', path: '/app/conversations/:id/voices', signed: true, handler: listVoices },
  { method: 'PUT', path: '/app/devices/me/push-token', signed: true, handler: registerPushToken },
  { method: 'DELETE', path: '/app/devices/me', signed: true, handler: handleRevoke },
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
