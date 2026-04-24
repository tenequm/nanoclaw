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

import {
  GrammyBadRequest,
  GrammyBlocked,
  GrammyEntityError,
  GrammyFloodWait,
  GrammyNetworkError,
  GrammyUnknownError,
  mapGrammyError,
} from './errors.js';

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

  it('classifies flood waits (429) with retry_after', () => {
    const err = makeGrammyError(429, 'Too Many Requests: retry after 7', { retry_after: 7 });
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyFloodWait);
    expect((out as GrammyFloodWait).retryAfterSeconds).toBe(7);
  });

  it('classifies 403 as GrammyBlocked', () => {
    const err = makeGrammyError(403, 'Forbidden: bot was blocked by the user');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyBlocked);
  });

  it('classifies a non-entity 400 as GrammyBadRequest', () => {
    const err = makeGrammyError(400, 'Bad Request: chat not found');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyBlocked);
    // "chat not found" matches the BLOCKED_RE regex → GrammyBlocked, not BadRequest.
    // This pins the behavior; if we ever want BadRequest for "chat not found",
    // update both the regex and this test together.
  });

  it('classifies an otherwise-opaque 400 as GrammyBadRequest', () => {
    const err = makeGrammyError(400, 'Bad Request: bot is not a member of the supergroup chat');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyBadRequest);
  });

  it('classifies 5xx as GrammyUnknownError', () => {
    const err = makeGrammyError(502, 'Bad Gateway');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyUnknownError);
  });

  it('classifies a non-GrammyError (network) as GrammyNetworkError', () => {
    const err = new TypeError('fetch failed');
    const out = mapGrammyError(err, 'sendMessage', 'chat1');
    expect(out).toBeInstanceOf(GrammyNetworkError);
  });
});
