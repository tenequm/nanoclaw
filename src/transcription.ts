import fs from 'fs';

import OpenAI from 'openai';

import { log } from './log.js';

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    log.warn('OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }
  client = new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 1 });
  return client;
}

export async function transcribeAudio(filePath: string): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const size = fs.statSync(filePath).size;
    if (size > 25 * 1024 * 1024) {
      log.warn('Audio file exceeds transcription size limit', { filePath, size });
      return null;
    }
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(filePath),
    });
    log.info('Transcribed voice message', { chars: response.text.length });
    return response.text;
  } catch (err) {
    log.error('OpenAI transcription failed', { err });
    return null;
  }
}
