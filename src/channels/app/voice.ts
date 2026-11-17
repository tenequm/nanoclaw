import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { linePlatformId } from '../voice-mode-line.js';
import { callDeps, conversationFor, guarded, ownLine, runningVoice, signedObject, type CallDeps } from './calls.js';
import type { AppHandler } from './routes.js';

export function createVoiceHandlers(deps: CallDeps) {
  const handle = (catalog: boolean, patch = false): AppHandler =>
    guarded(async (ctx) => {
      const c = await conversationFor(ctx, ctx.params.id, deps, true);
      const voice = runningVoice();
      const body = patch ? await signedObject(ctx) : undefined;
      const line = await ownLine(c, patch);
      // The signed body has already been consumed and authenticated; the shared picker reads this copy.
      const req = body
        ? (Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
            method: ctx.req.method,
            url: ctx.req.url,
            headers: ctx.req.headers,
          }) as IncomingMessage)
        : ctx.req;
      await voice.lineVoiceHttp(req, ctx.res, line ? linePlatformId(line.line_id) : null, catalog);
    });
  return { getVoice: handle(false), patchVoice: handle(false, true), listVoices: handle(true) };
}
export const getVoice: AppHandler = (ctx) => createVoiceHandlers(callDeps).getVoice(ctx);
export const patchVoice: AppHandler = (ctx) => createVoiceHandlers(callDeps).patchVoice(ctx);
export const listVoices: AppHandler = (ctx) => createVoiceHandlers(callDeps).listVoices(ctx);
