/**
 * Tagged error surface for the telegram-grammy adapter.
 *
 * Every grammY call is wrapped in `Effect.tryPromise` whose catch handler
 * invokes `mapGrammyError` — converting an unknown throw into one of these
 * tagged variants. Downstream effects catch by _tag (GrammyEntityError for
 * the semantic-400 fallback, GrammyBlocked to mark a recipient dormant,
 * etc.). Nothing reaches `unknown` inside this module.
 */
import { Schema } from 'effect';
import { GrammyError, HttpError } from 'grammy';

export class GrammyEntityError extends Schema.TaggedErrorClass<GrammyEntityError>()('GrammyEntityError', {
  chatId: Schema.String,
  method: Schema.String,
  description: Schema.String,
  byteOffset: Schema.optional(Schema.Number),
}) {}

export class GrammyFloodWait extends Schema.TaggedErrorClass<GrammyFloodWait>()('GrammyFloodWait', {
  chatId: Schema.String,
  method: Schema.String,
  retryAfterSeconds: Schema.Number,
  description: Schema.String,
}) {}

export class GrammyBlocked extends Schema.TaggedErrorClass<GrammyBlocked>()('GrammyBlocked', {
  chatId: Schema.String,
  method: Schema.String,
  description: Schema.String,
}) {}

export class GrammyBadRequest extends Schema.TaggedErrorClass<GrammyBadRequest>()('GrammyBadRequest', {
  chatId: Schema.String,
  method: Schema.String,
  description: Schema.String,
}) {}

export class GrammyNetworkError extends Schema.TaggedErrorClass<GrammyNetworkError>()('GrammyNetworkError', {
  method: Schema.String,
  cause: Schema.Defect,
}) {}

export class GrammyUnknownError extends Schema.TaggedErrorClass<GrammyUnknownError>()('GrammyUnknownError', {
  chatId: Schema.String,
  method: Schema.String,
  errorCode: Schema.optional(Schema.Number),
  description: Schema.String,
}) {}

export class AttachmentTooLarge extends Schema.TaggedErrorClass<AttachmentTooLarge>()('AttachmentTooLarge', {
  fileId: Schema.String,
  size: Schema.Number,
  maxBytes: Schema.Number,
}) {}

export class AttachmentFetchFailed extends Schema.TaggedErrorClass<AttachmentFetchFailed>()('AttachmentFetchFailed', {
  fileId: Schema.String,
  cause: Schema.Defect,
}) {}

export class TelegramConfigInvalid extends Schema.TaggedErrorClass<TelegramConfigInvalid>()('TelegramConfigInvalid', {
  field: Schema.String,
  value: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Self-hosted Bot API server in `--local` mode returned an absolute
 * `file_path` that doesn't fall under the trusted container root. Either
 * the server is misconfigured or someone is attempting a path-traversal
 * attack. Defense-in-depth on top of the bot-api server's own filesystem
 * boundary.
 */
export class LocalFileUntrusted extends Schema.TaggedErrorClass<LocalFileUntrusted>()('LocalFileUntrusted', {
  filePath: Schema.String,
  trustedRoot: Schema.String,
}) {}

export class PairingFailed extends Schema.TaggedErrorClass<PairingFailed>()('PairingFailed', {
  platformId: Schema.String,
  cause: Schema.Defect,
}) {}

export type GrammyDeliveryError =
  | GrammyEntityError
  | GrammyFloodWait
  | GrammyBlocked
  | GrammyBadRequest
  | GrammyNetworkError
  | GrammyUnknownError;

const ENTITY_RE = /(entity|entities|offset|parse|byte)/i;
const FLOOD_RE = /Too Many Requests: retry after (\d+)/i;
const BLOCKED_RE = /(blocked|deactivated|kicked|CHAT_WRITE_FORBIDDEN|not found)/i;

/**
 * Classify an unknown throw from a grammY call into a tagged variant.
 *
 * chatId is passed as context — grammY's own error object carries the API
 * payload but not the chat we were targeting. Callers already know the chat
 * they're writing to, so threading it in keeps the tagged variants useful
 * for logging without the error wrapper having to guess.
 */
export function mapGrammyError(err: unknown, method: string, chatId: string): GrammyDeliveryError {
  if (err instanceof GrammyError) {
    const code = err.error_code;
    const description = err.description;
    if (code === 400 && ENTITY_RE.test(description)) {
      return new GrammyEntityError({ chatId, method, description });
    }
    if (code === 429) {
      const retry = err.parameters?.retry_after;
      const m = FLOOD_RE.exec(description);
      const secs = typeof retry === 'number' ? retry : m ? Number(m[1]) : 1;
      return new GrammyFloodWait({ chatId, method, retryAfterSeconds: secs, description });
    }
    if (code === 403 || (code === 400 && BLOCKED_RE.test(description))) {
      return new GrammyBlocked({ chatId, method, description });
    }
    if (code === 400) {
      return new GrammyBadRequest({ chatId, method, description });
    }
    return new GrammyUnknownError({ chatId, method, errorCode: code, description });
  }
  if (err instanceof HttpError) {
    return new GrammyNetworkError({ method, cause: err });
  }
  return new GrammyNetworkError({ method, cause: err });
}
