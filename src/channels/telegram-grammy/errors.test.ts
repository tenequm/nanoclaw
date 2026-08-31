/**
 * mapGrammyError classifier smoke tests.
 *
 * Every grammY API call is wrapped in `Effect.tryPromise` whose catch
 * handler routes the throw through `mapGrammyError`. If classification
 * drifts, tagged-error handling breaks silently — `catchTag('GrammyEntityError')`
 * stops firing, the parse-error retry goes dark, and we regress to the
 * original bug class. These tests pin the mapping.
 */
import { describe, expect, it } from 'vitest';
import { GrammyError } from 'grammy';

import { GrammyApiError, GrammyEntityError, GrammyNetworkError, mapGrammyError } from './errors.js';

/** Construct a GrammyError with minimal required fields for testing. */
function makeGrammyError(code: number, description: string, parameters?: { retry_after?: number }): GrammyError {
  const err = new GrammyError(
    `Call to ... failed! ${description}`,
    { ok: false, error_code: code, description, parameters: parameters ?? {} },
    'sendMessage',
    {},
  );
  return err;
}

describe('mapGrammyError', () => {
  it('classifies entity parse errors as GrammyEntityError', () => {
    const err = makeGrammyError(400, "Bad Request: can't parse entities: offset 611");
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyEntityError);
    expect((out as GrammyEntityError).description).toContain('parse entities');
  });

  it('maps flood waits to GrammyApiError with retry_after', () => {
    const err = makeGrammyError(429, 'Too Many Requests: retry after 7', { retry_after: 7 });
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyApiError);
    expect((out as GrammyApiError).retryAfter).toBe(7);
  });

  it('maps 403 to GrammyApiError', () => {
    const err = makeGrammyError(403, 'Forbidden: bot was blocked by the user');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyApiError);
    expect((out as GrammyApiError).errorCode).toBe(403);
  });

  it('maps a non-entity 400 to GrammyApiError', () => {
    const err = makeGrammyError(400, 'Bad Request: chat not found');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyApiError);
    expect((out as GrammyApiError).errorCode).toBe(400);
  });

  it('maps 5xx to GrammyApiError', () => {
    const err = makeGrammyError(502, 'Bad Gateway');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyApiError);
    expect(out).toMatchObject({ chatId: 'chat1', method: 'sendMessage', errorCode: 502, description: 'Bad Gateway' });
  });

  it('classifies a non-GrammyError (network) as GrammyNetworkError', () => {
    const err = new TypeError('fetch failed');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyNetworkError);
  });
});
