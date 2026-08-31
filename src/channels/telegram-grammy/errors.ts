/**
 * Tagged error surface for the telegram-grammy adapter.
 *
 * Every grammY call is wrapped in `Effect.tryPromise` whose catch handler
 * invokes `mapGrammyError`. Entity parse failures remain distinct for the
 * plain-text retry; other API responses share one tagged error, while
 * transport failures use `GrammyNetworkError`.
 */
import { Schema } from 'effect';
import { GrammyError } from 'grammy';

export class GrammyEntityError extends Schema.TaggedErrorClass<GrammyEntityError>()('GrammyEntityError', {
  chatId: Schema.String,
  method: Schema.String,
  description: Schema.String,
}) {}

export class GrammyApiError extends Schema.TaggedErrorClass<GrammyApiError>()('GrammyApiError', {
  chatId: Schema.String,
  method: Schema.String,
  errorCode: Schema.Number,
  description: Schema.String,
  retryAfter: Schema.optional(Schema.Number),
}) {}

export class GrammyNetworkError extends Schema.TaggedErrorClass<GrammyNetworkError>()('GrammyNetworkError', {
  method: Schema.String,
  cause: Schema.Defect,
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

export type GrammyDeliveryError = GrammyEntityError | GrammyApiError | GrammyNetworkError;

const ENTITY_RE = /(entity|entities|offset|parse|byte)/i;

/**
 * Classify an unknown throw from a grammY call into a tagged variant.
 *
 * chatId is passed as context because grammY's own error object carries the API
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
    const retryAfter = code === 429 ? err.parameters?.retry_after : undefined;
    return new GrammyApiError({ chatId, method, errorCode: code, description, retryAfter });
  }
  return new GrammyNetworkError({ method, cause: err });
}
