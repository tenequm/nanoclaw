// Adapted from OpenClaw (MIT, github.com/openclaw/openclaw)
/**
 * Gemini Live as a second voice engine for the voice channel (test path).
 *
 * Browser-direct: the host mints a one-use, constrained ephemeral token
 * (`v1alpha/auth_tokens`) that locks the model, the system instruction, the
 * voice and the single `ask_agent` function, and the call page opens the
 * constrained Live WebSocket with it. The API key never leaves the host.
 * Each `ask_agent` call goes back to the host as an HTTP long-poll that feeds
 * the request to the agent and returns its reply (see voice.ts).
 *
 * Model contract for `gemini-3.8-live` (verified by OpenClaw on the wire,
 * 2026-09-19): any thinkingConfig closes the session with 1007, so none is
 * sent; NON_BLOCKING function calling and WHEN_IDLE response scheduling work;
 * the server VAD only ends a turn while audio keeps arriving, so the page
 * streams every microphone frame, silence included.
 */
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
export const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';
/** The token must open its session this soon after minting. */
export const GEMINI_NEW_SESSION_WINDOW_MS = 60_000;
export const ASK_AGENT_TOOL = 'ask_agent';

const ASK_AGENT_DECLARATION = {
  name: ASK_AGENT_TOOL,
  description:
    'Ask the backend assistant, which holds the user’s memory, files, calendar and tools and can take actions. ' +
    'Use it for anything that needs facts, memory, tools or actions. The answer arrives later; keep the caller company meanwhile.',
  parameters: {
    type: 'OBJECT',
    properties: {
      request: {
        type: 'STRING',
        description: 'What the caller wants, in full, with every detail they gave.',
      },
    },
    required: ['request'],
  },
  behavior: 'NON_BLOCKING',
};

/** Extended Thinking variants close the session on response scheduling. */
export function geminiToolScheduling(model: string): 'WHEN_IDLE' | null {
  return model.includes('extended-thinking') ? null : 'WHEN_IDLE';
}

function modelResource(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

/** The session setup the token locks; deliberately without thinkingConfig (see the header). */
export function geminiLiveSetup(model: string, voice: string, instructions: string): Record<string, unknown> {
  return {
    model: modelResource(model),
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { parts: [{ text: instructions }] },
    tools: [{ functionDeclarations: [ASK_AGENT_DECLARATION] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

/** What the page sends first on the constrained socket; the token's constraints override it. */
export function geminiBrowserSetup(model: string): Record<string, unknown> {
  return {
    model: modelResource(model),
    generationConfig: { responseModalities: ['AUDIO'] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

export class GeminiTokenError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GeminiTokenError';
  }
}

export interface MintGeminiTokenOptions {
  apiKey: string;
  apiBase: string;
  setup: Record<string, unknown>;
  /** The token, and the session it opened, stop working here (epoch ms). */
  expiresAt: number;
  now: number;
  timeoutMs: number;
}

/**
 * Mint a one-use ephemeral token whose constraints are the full session setup.
 * The body is what `@google/genai`'s `authTokens.create` sends without
 * `lockAdditionalFields`: the setup under `bidiGenerateContentSetup`, no field mask.
 */
export async function mintGeminiToken(opts: MintGeminiTokenOptions): Promise<string> {
  const res = await fetch(`${opts.apiBase}/v1alpha/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(opts.expiresAt).toISOString(),
      newSessionExpireTime: new Date(Math.min(opts.expiresAt, opts.now + GEMINI_NEW_SESSION_WINDOW_MS)).toISOString(),
      bidiGenerateContentSetup: opts.setup,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  }).catch((err) => {
    throw new GeminiTokenError(502, 'token request timed out or could not connect', { cause: err });
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new GeminiTokenError(res.status, `token request failed: ${res.status} ${detail}`);
  }
  const body = (await res.json()) as { name?: unknown };
  const token = typeof body.name === 'string' ? body.name.trim() : '';
  if (!token) throw new GeminiTokenError(502, 'token response carried no token');
  return token;
}

/**
 * The inbound message id for an ask_agent call. The agent's reply carries it
 * back as `in_reply_to`, which is how deliver() finds the waiting consult.
 */
const CONSULT_ID_PREFIX = 'gemini:';

export function geminiConsultMessageId(callId: string, functionCallId: string): string {
  return `${CONSULT_ID_PREFIX}${callId}:${functionCallId}`;
}

export function parseGeminiConsultMessageId(id: string): { callId: string; functionCallId: string } | null {
  if (!id.startsWith(CONSULT_ID_PREFIX)) return null;
  const rest = id.slice(CONSULT_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { callId: rest.slice(0, sep), functionCallId: rest.slice(sep + 1) };
}

/** The microphone worklet: resample to 16 kHz mono PCM16 and post 40 ms frames, silence included. */
const MIC_WORKLET = [
  'class MicPcm16k extends AudioWorkletProcessor {',
  '  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.acc = 0; this.cnt = 0; this.out = new Int16Array(640); this.n = 0; }',
  '  push(v) {',
  '    v = Math.max(-1, Math.min(1, v));',
  '    this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;',
  '    if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(640); this.n = 0; }',
  '  }',
  '  process(inputs) {',
  '    const ch = inputs[0] && inputs[0][0];',
  '    const len = ch ? ch.length : 128;',
  '    for (let i = 0; i < len; i++) {',
  '      this.acc += ch ? ch[i] : 0; this.cnt++; this.pos += 1;',
  '      if (this.pos >= this.ratio) { this.pos -= this.ratio; this.push(this.acc / this.cnt); this.acc = 0; this.cnt = 0; }',
  '    }',
  '    return true;',
  '  }',
  '}',
  "registerProcessor('mic-pcm16k', MicPcm16k);",
].join('\n');

// String.raw keeps the page script's escapes intact; the script avoids backticks and ${.
const PAGE_SCRIPT = String.raw`
const linkToken = new URLSearchParams(location.search).get('t') || '';
const base = location.pathname.replace(/\/gemini\/?$/, '');
const q = '?t=' + encodeURIComponent(linkToken);
const btn = document.getElementById('btn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const names = { agent: 'the agent' };
let call = null;

function setStatus(text) { statusEl.textContent = text; }
function line(role, label) {
  const p = document.createElement('p');
  p.className = 't ' + role;
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  p.append(b, span);
  logEl.append(p);
  while (logEl.childElementCount > 200) logEl.firstElementChild.remove();
  return { span, text: '' };
}
function append(current, role, label, text) {
  const l = current || line(role, label);
  l.text += text;
  l.span.textContent = l.text.trim();
  logEl.scrollTop = logEl.scrollHeight;
  return l;
}
function note(text) { append(null, 'sys', '', text); }
function b64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function send(c, msg) {
  if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function play(c, data, mimeType) {
  const m = /rate=(\d+)/.exec(mimeType || '');
  const rate = m ? Number(m[1]) : 24000;
  const bin = atob(data);
  const n = Math.floor(bin.length / 2);
  if (!n) return;
  const buf = c.ctx.createBuffer(1, n, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    ch[i] = v / 0x8000;
  }
  const now = c.ctx.currentTime;
  // After an underrun, start slightly ahead so the next chunks' network jitter does not click.
  const at = c.playhead > now ? c.playhead : now + 0.08;
  const src = c.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(c.ctx.destination);
  src.onended = () => c.sources.delete(src);
  c.sources.add(src);
  src.start(at);
  c.playhead = at + buf.duration;
}
function flush(c) {
  for (const s of c.sources) { try { s.stop(); } catch {} }
  c.sources.clear();
  c.playhead = 0;
}

function startMic(c) {
  const src = c.ctx.createMediaStreamSource(c.stream);
  const node = new AudioWorkletNode(c.ctx, 'mic-pcm16k');
  const mute = c.ctx.createGain();
  mute.gain.value = 0;
  node.port.onmessage = (ev) =>
    send(c, { realtimeInput: { audio: { data: b64(ev.data), mimeType: 'audio/pcm;rate=16000' } } });
  src.connect(node);
  node.connect(mute);
  mute.connect(c.ctx.destination);
  c.node = node;
}

function respond(c, fc, response) {
  const fr = { id: fc.id, name: fc.name, response };
  if (c.scheduling) fr.scheduling = c.scheduling;
  send(c, { toolResponse: { functionResponses: [fr] } });
}
function consult(c, fc) {
  if (!fc || !fc.id || c.consults.has(fc.id)) return;
  if (fc.name !== 'ask_agent') return respond(c, fc, { error: 'Unknown function ' + fc.name });
  const request = fc.args && typeof fc.args.request === 'string' ? fc.args.request : '';
  const ctl = new AbortController();
  c.consults.set(fc.id, ctl);
  note('Asking ' + names.agent + ': ' + request);
  fetch(base + '/gemini/consult' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId: c.callId, functionCallId: fc.id, request }),
    signal: ctl.signal,
  })
    .then(async (res) => (res.ok ? (await res.json()).answer : "I couldn't reach the assistant (" + res.status + ').'))
    .catch(() => (ctl.signal.aborted ? null : "I couldn't reach the assistant."))
    .then((answer) => {
      if (c.consults.get(fc.id) !== ctl) return;
      c.consults.delete(fc.id);
      if (typeof answer === 'string') respond(c, fc, { answer });
    });
}

async function onMessage(c, data) {
  if (c.ended) return;
  const text = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data);
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (c.ended) return;
  if (m.setupComplete && !c.ready) {
    c.ready = true;
    startMic(c);
    setStatus('Live: talk to ' + names.agent + '.');
    send(c, { clientContent: { turns: [{ role: 'user', parts: [{ text: '(The call just connected. Greet the caller.)' }] }], turnComplete: true } });
  }
  const sc = m.serverContent;
  if (sc) {
    if (sc.interrupted) flush(c);
    if (sc.inputTranscription && sc.inputTranscription.text) {
      c.outLine = null;
      c.inLine = append(c.inLine, 'caller', 'You', sc.inputTranscription.text);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      c.inLine = null;
      c.outLine = append(c.outLine, 'agent', names.agent, sc.outputTranscription.text);
    }
    for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
      if (p.inlineData && p.inlineData.data) play(c, p.inlineData.data, p.inlineData.mimeType);
    }
    if (sc.turnComplete || sc.interrupted || sc.generationComplete) c.outLine = null;
    if (sc.turnComplete) c.inLine = null;
  }
  if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) consult(c, fc);
  if (m.toolCallCancellation) {
    for (const id of m.toolCallCancellation.ids || []) {
      const ctl = c.consults.get(id);
      c.consults.delete(id);
      if (ctl) ctl.abort();
    }
  }
  if (m.goAway) setStatus('The voice service is ending this call soon.');
}

function endOnServer(c, beacon) {
  if (!c.callId || c.endSent) return;
  c.endSent = true;
  const url = base + '/gemini/end' + q;
  const body = JSON.stringify({ callId: c.callId });
  if (beacon && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function hangup(c, message, beacon) {
  if (c.ended) return;
  c.ended = true;
  clearTimeout(c.deadline);
  for (const ctl of c.consults.values()) ctl.abort();
  c.consults.clear();
  if (c.ctx) flush(c);
  try { if (c.node) c.node.disconnect(); } catch {}
  if (c.stream) for (const track of c.stream.getTracks()) track.stop();
  if (c.ws && c.ws.readyState < 2) c.ws.close(1000);
  if (c.ctx) c.ctx.close().catch(() => {});
  endOnServer(c, beacon);
  if (call === c) call = null;
  setStatus(message);
  btn.textContent = 'Call';
  btn.className = '';
}

async function start() {
  // Created inside the click so browsers that gate audio on a gesture let it run.
  const c = { ctx: new AudioContext(), ws: null, stream: null, node: null, callId: null, ready: false, ended: false,
    endSent: false, consults: new Map(), sources: new Set(), playhead: 0, deadline: null, inLine: null, outLine: null,
    scheduling: null };
  call = c;
  btn.textContent = 'Hang up';
  btn.className = 'hang';
  try {
    setStatus('Starting the microphone...');
    c.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (c.ended) return c.stream.getTracks().forEach((track) => track.stop());
    await c.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await c.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (c.ended) return;
    setStatus('Connecting...');
    const res = await fetch(base + '/gemini/token' + q, { method: 'POST' });
    if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
    const s = await res.json();
    c.callId = s.callId;
    c.scheduling = s.scheduling;
    if (c.ended) return endOnServer(c, false);
    c.deadline = setTimeout(() => hangup(c, 'Time limit reached.'), Math.max(1000, s.expiresAt - Date.now()));
    const ws = new WebSocket(s.websocketUrl + '?access_token=' + encodeURIComponent(s.token));
    c.ws = ws;
    ws.onopen = () => send(c, { setup: s.setup });
    ws.onmessage = (ev) => { onMessage(c, ev.data).catch((err) => console.error(err)); };
    ws.onclose = (ev) => {
      const why = ev.code && ev.code !== 1000 ? ' (' + ev.code + (ev.reason ? ': ' + ev.reason : '') + ')' : '';
      hangup(c, 'Call closed' + why + '.');
    };
  } catch (err) {
    hangup(c, 'Could not start: ' + ((err && err.message) || err));
  }
}

btn.addEventListener('click', () => (call ? hangup(call, 'Call ended.') : void start()));
addEventListener('pagehide', () => { if (call) hangup(call, 'Call ended.', true); });
fetch(base + '/info' + q)
  .then((res) => (res.ok ? res.json() : null))
  .then((info) => {
    if (!info) return setStatus('This call link is not active.');
    names.agent = info.agent;
    document.getElementById('title').textContent = 'Call ' + info.agent;
  })
  .catch(() => {});
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Live Voice (Gemini)</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e3e2de;--accent:#1a73e8;--danger:#c5221f}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2c2c31;--accent:#3b78e7;--danger:#d93025}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:560px;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px;margin:0}
#status{color:var(--muted);min-height:1.45em}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:14px 28px;background:var(--accent);color:#fff;cursor:pointer}
button.hang{background:var(--danger)}
#log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:200px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.t{margin:0}.t b{color:var(--muted);font-weight:600;margin-right:6px}.t.sys{color:var(--muted);font-style:italic}
</style>
</head>
<body>
<main>
<h1 id="title">Live Voice</h1>
<div id="status">Press Call to start.</div>
<div><button id="btn" type="button">Call</button></div>
<div id="log" aria-live="polite"></div>
</main>
<script type="module">
const WORKLET = ${JSON.stringify(MIC_WORKLET)};
${PAGE_SCRIPT}
</script>
</body>
</html>
`;

/** The Gemini call page: one self-contained document, no external resources. */
export function geminiCallPageHtml(): string {
  return PAGE;
}
