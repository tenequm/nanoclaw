#!/usr/bin/env bun
/**
 * tts.ts — turn text into a Telegram-ready voice note using Google Gemini TTS.
 *
 * The request goes to the real Google endpoint; the OneCLI gateway injects the
 * `x-goog-api-key` header at the proxy boundary, so this script never sees the
 * key. Output is OGG/Opus (Telegram voice-bubble format) — pass the printed
 * path to the `send_file` MCP tool and the host routes `.ogg` to sendVoice.
 *
 * Usage:
 *   bun tts.ts --text "Hello there" [--voice Kore] [--out voice.ogg] [--model <id>] [--fallback-model <id>]
 *   echo "long narration…" | bun tts.ts --out story.ogg
 */

const HOST = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.8-flash-lite-tts';
const DEFAULT_VOICE = 'Alnilam';
const MAX_ATTEMPTS = 3; // Gemini TTS sometimes returns text instead of audio (→500); Google advises retrying.

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const text = (args.text ?? (await Bun.stdin.text())).trim();
if (!text) {
  console.error('tts: no text provided (pass --text or pipe via stdin)');
  process.exit(2);
}
const voice = args.voice ?? DEFAULT_VOICE;
const model = args.model ?? DEFAULT_MODEL;
const fallbackModel = args['fallback-model'] ?? DEFAULT_FALLBACK_MODEL;
const out = args.out ?? 'voice.ogg';

const body = JSON.stringify({
  contents: [{ parts: [{ text }] }],
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
  },
});

type Audio = { pcm: Buffer; rate: string; channels: string };

/**
 * Raw PCM from one audio part. The 3.1 TTS models answer headerless
 * `audio/l16`; 3.8 answers `audio/wav`, whose RIFF header would otherwise be
 * played as a click, so only its `data` chunk is kept.
 */
function partPcm(data: Buffer): { pcm: Buffer; rate?: string; channels?: string } {
  if (data.subarray(0, 4).toString('ascii') !== 'RIFF') return { pcm: data };
  let rate: string | undefined;
  let channels: string | undefined;
  for (let offset = 12; offset + 8 <= data.length; ) {
    const id = data.subarray(offset, offset + 4).toString('ascii');
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = String(data.readUInt16LE(offset + 10));
      rate = String(data.readUInt32LE(offset + 12));
    }
    if (id === 'data') return { pcm: data.subarray(offset + 8, offset + 8 + size), rate, channels };
    offset += 8 + size + (size % 2);
  }
  return { pcm: Buffer.alloc(0), rate, channels };
}

/**
 * One synthesis attempt. Returns the PCM buffer (+ rate/channels) on success,
 * `'busy'` on 429/503 (model overloaded), `'missing'` on 404 (a preview model
 * withdrawn or renamed), `null` on any other retryable miss
 * (transport, 5xx, or text instead of audio), or throws on a non-retryable
 * error (bad request / auth).
 */
function attempt(model: string): Audio | 'busy' | 'missing' | null {
  const url = `${HOST}/v1beta/models/${model}:generateContent`;
  // curl honors HTTPS_PROXY + the gateway CA exactly as the onecli-gateway skill
  // documents; the gateway injects the API key for the matching host.
  const curl = Bun.spawnSync(
    [
      'curl',
      '-sS',
      '--max-time',
      '120',
      '--connect-timeout',
      '10',
      '-X',
      'POST',
      url,
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
    ],
    { stdin: Buffer.from(body) },
  );
  if (curl.exitCode !== 0) return null; // transport hiccup — retry
  let resp: any;
  try {
    resp = JSON.parse(curl.stdout.toString());
  } catch {
    return null;
  }
  if (resp.error) {
    const code = Number(resp.error.code) || 0;
    if (code === 429 || code === 503) return 'busy'; // "high demand" — retry once, then fall back
    if (code === 404) return 'missing'; // no such model — fall back at once
    if (code >= 500) return null; // server-side glitch — retry
    throw new Error(`API error ${code}: ${resp.error.message}`); // 4xx — surface it
  }
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  const audio = parts.map((p: any) => p.inlineData ?? p.inline_data).filter((d: any) => d?.data);
  if (audio.length === 0) return null; // returned text instead of audio — retry
  // Signed 16-bit little-endian PCM, raw or in WAV; rate/channels come from the
  // WAV header or the mimeType (e.g. "audio/l16; rate=24000; channels=1").
  const mime: string = audio[0].mimeType ?? audio[0].mime_type ?? '';
  const decoded = audio.map((d: any) => partPcm(Buffer.from(d.data, 'base64')));
  return {
    pcm: Buffer.concat(decoded.map((d) => d.pcm)),
    rate: decoded[0].rate ?? /rate=(\d+)/.exec(mime)?.[1] ?? '24000',
    channels: decoded[0].channels ?? /channels=(\d+)/.exec(mime)?.[1] ?? '1',
  };
}

let result: Audio | null = null;
const models = fallbackModel && fallbackModel !== model ? [model, fallbackModel] : [model];
for (const m of models) {
  let busy = 0;
  for (let i = 1; i <= MAX_ATTEMPTS && !result; i++) {
    const r = attempt(m);
    if (r === 'missing') break;
    if (r && r !== 'busy') result = r;
    else if (r === 'busy' && ++busy > 1) break; // still overloaded after one retry — fall back
    else if (i < MAX_ATTEMPTS) await Bun.sleep(500 * i);
  }
  if (result) break;
  if (m !== models[models.length - 1]) console.error(`tts: ${m} gave no audio, falling back to ${fallbackModel}`);
}
if (!result) {
  console.error(`tts: no audio from ${models.join(' or ')} (overloaded or kept returning text — try again or rephrase)`);
  process.exit(1);
}

// PCM -> OGG/Opus (Telegram voice format), PCM piped on stdin.
const ff = Bun.spawnSync(
  ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', result.rate, '-ac', result.channels, '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', out],
  { stdin: result.pcm },
);
if (ff.exitCode !== 0) {
  console.error('tts: ffmpeg failed:', ff.stderr.toString());
  process.exit(1);
}

console.log(out.startsWith('/') ? out : `${process.cwd()}/${out}`);
