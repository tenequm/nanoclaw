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
 *   bun tts.ts --text "Hello there" [--voice Kore] [--out voice.ogg] [--model <id>]
 *   echo "long narration…" | bun tts.ts --out story.ogg
 */

const HOST = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Alnilam';
const MAX_ATTEMPTS = 3; // Gemini 3.1 randomly returns text instead of audio (→500); Google advises retrying.

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
const out = args.out ?? 'voice.ogg';

const body = JSON.stringify({
  contents: [{ parts: [{ text }] }],
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
  },
});
const url = `${HOST}/v1beta/models/${model}:generateContent`;

/**
 * One synthesis attempt. Returns the PCM buffer (+ rate/channels) on success,
 * `null` if the model returned no audio (the text-token case — retryable), or
 * throws on a non-retryable error (bad request / auth / quota).
 */
function attempt(): { pcm: Buffer; rate: string; channels: string } | null {
  // curl honors HTTPS_PROXY + the gateway CA exactly as the onecli-gateway skill
  // documents; the gateway injects the API key for the matching host.
  const curl = Bun.spawnSync(
    ['curl', '-sS', '-X', 'POST', url, '-H', 'Content-Type: application/json', '--data-binary', '@-'],
    { stdin: Buffer.from(body) },
  );
  if (curl.exitCode !== 0) return null; // transport hiccup — retry
  const resp = JSON.parse(curl.stdout.toString());
  if (resp.error) {
    const code = Number(resp.error.code) || 0;
    if (code >= 500) return null; // server-side glitch — retry
    throw new Error(`API error ${code}: ${resp.error.message}`); // 4xx — surface it
  }
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  const audio = parts.map((p: any) => p.inlineData ?? p.inline_data).filter((d: any) => d?.data);
  if (audio.length === 0) return null; // returned text instead of audio — retry
  // Gemini returns signed 16-bit little-endian PCM; parse rate/channels from the
  // mimeType (e.g. "audio/l16; rate=24000; channels=1") and concat all parts.
  const mime: string = audio[0].mimeType ?? audio[0].mime_type ?? '';
  return {
    pcm: Buffer.concat(audio.map((d: any) => Buffer.from(d.data, 'base64'))),
    rate: /rate=(\d+)/.exec(mime)?.[1] ?? '24000',
    channels: /channels=(\d+)/.exec(mime)?.[1] ?? '1',
  };
}

let result: { pcm: Buffer; rate: string; channels: string } | null = null;
for (let i = 1; i <= MAX_ATTEMPTS && !result; i++) {
  result = attempt();
  if (!result && i < MAX_ATTEMPTS) await Bun.sleep(500 * i);
}
if (!result) {
  console.error(`tts: no audio after ${MAX_ATTEMPTS} attempts (model kept returning text — try again or rephrase)`);
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
