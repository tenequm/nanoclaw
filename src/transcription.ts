import fs from 'fs';

import OpenAI, { toFile } from 'openai';

import { envValue } from './env.js';
import { log } from './log.js';

let client: OpenAI | null = null;

export function transcriptionKey(read = envValue): string | undefined {
  return process.env.OPENAI_API_KEY || read('OPENAI_API_KEY');
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

export async function transcribeAudio(filePath: string, filename?: string): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const size = fs.statSync(filePath).size;
    if (size > 25 * 1024 * 1024) {
      log.warn('Audio file exceeds transcription size limit', { size });
      return null;
    }
    const stream = fs.createReadStream(filePath);
    const response = await openai.audio.transcriptions.create({
      model: 'gpt-transcribe',
      file: filename ? await toFile(stream, filename) : stream,
    });
    log.info('Transcribed voice message', { chars: response.text.length });
    return response.text;
  } catch {
    log.error('OpenAI transcription failed');
    return null;
  }
}
