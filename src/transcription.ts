import fs from 'fs';

import OpenAI, { toFile } from 'openai';

import { envValue } from './env.js';
import { log } from './log.js';

let client: OpenAI | null = null;

export function transcriptionKey(): string | undefined {
  return process.env.OPENAI_API_KEY || envValue('OPENAI_API_KEY');
}

function getClient(): OpenAI | null {
  if (client) return client;
  const key = transcriptionKey();
  if (!key) {
    log.warn('OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }
  client = new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 1 });
  return client;
}

export async function transcribeAudio(
  filePath: string,
  filename?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const size = fs.statSync(filePath).size;
    if (size > 25 * 1024 * 1024) {
      log.warn('Audio file exceeds transcription size limit', { size });
      return null;
    }
    const stream = fs.createReadStream(filePath, { signal });
    const response = await openai.audio.transcriptions.create(
      {
        model: 'gpt-transcribe',
        file: filename ? await toFile(stream, filename) : stream,
      },
      { signal },
    );
    log.info('Transcribed voice message', { chars: response.text.length });
    return response.text;
  } catch (error) {
    if (signal?.aborted) return null;
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    let reason = 'unknown';
    if (error instanceof OpenAI.APIConnectionTimeoutError || status === 408) reason = 'timeout';
    else if (status === 401 || status === 403) reason = 'auth';
    else if (error instanceof OpenAI.APIError && error.code === 'insufficient_quota') reason = 'quota';
    else if (status === 429) reason = 'rate_limit';
    else if (status) reason = 'http';
    else if (error instanceof OpenAI.APIConnectionError) reason = 'connection';
    log.error('OpenAI transcription failed', { reason, status });
    return null;
  }
}
