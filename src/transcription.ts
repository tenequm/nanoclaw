import fs from 'fs';

import OpenAI from 'openai';

import { logger } from './logger.js';

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    logger.warn('OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }
  client = new OpenAI({ apiKey: key });
  return client;
}

export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(filePath),
    });
    logger.info(
      { chars: response.text.length },
      'Transcribed voice message',
    );
    return response.text;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}
