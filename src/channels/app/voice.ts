import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { linePlatformId } from '../voice-mode-line.js';
import { AppCallError, callDeps, conversationFor, guarded, ownLine, runningVoice, type CallDeps } from './calls.js';
import { requestBody } from './conversations.js';
import type { AppHandler } from './routes.js';

export function createVoiceHandlers(deps: CallDeps) {
  const handle = (catalog: boolean, patch = false): AppHandler =>
    guarded(async (ctx) => {
      const c = await conversationFor(ctx, ctx.params.id, deps, true);
      const voice = runningVoice();
      const body = patch ? await requestBody(ctx, 4096) : undefined;
      const line = await ownLine(c, false);
      // The signed body has already been consumed and authenticated; the shared picker reads this copy.
      const req = body
        ? (Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
            method: ctx.req.method,
            url: ctx.req.url,
            headers: ctx.req.headers,
          }) as IncomingMessage)
        : ctx.req;
      await voice.lineVoiceHttp(
        req,
        ctx.res,
        line ? linePlatformId(line.line_id) : null,
        catalog,
        patch
          ? async () => {
              const created = await ownLine(c, true);
              if (!created) throw new AppCallError(403, 'no_line');
              return linePlatformId(created.line_id);
            }
          : undefined,
      );
    });
  return { getVoice: handle(false), patchVoice: handle(false, true), listVoices: handle(true) };
}
export const getVoice: AppHandler = (ctx) => createVoiceHandlers(callDeps).getVoice(ctx);
export const patchVoice: AppHandler = (ctx) => createVoiceHandlers(callDeps).patchVoice(ctx);
export const listVoices: AppHandler = (ctx) => createVoiceHandlers(callDeps).listVoices(ctx);
