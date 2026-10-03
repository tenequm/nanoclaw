/**
 * The caller's speech to text over Gemini Live (`gemini-3.5-transcribe-live`) with manual activity:
 * the worker says where a turn starts and ends (`activityStart`, `activityEnd`), so a turn with
 * thinking pauses is transcribed as one piece with its context, never as segments cut at the
 * server's own ~800 ms pauses and joined afterwards.
 *
 * Every activity gets a fresh WebSocket, retired once its final came: the server does not order
 * transcriptions against other messages, so one socket per activity keeps one turn's text out of
 * the next. Audio goes out only inside an activity. A socket that closes, says it goes away, or gets
 * old inside an activity hands the activity to a fresh one, keeping the words heard so far.
 *
 * Wire protocol per https://ai.google.dev/gemini-api/docs/live-api/live-transcribe and
 * https://ai.google.dev/api/live: setup first and nothing else before setupComplete, 16 kHz s16le
 * PCM in ~100 ms chunks, never audioStreamEnd with manual activity.
 */
const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
/** A socket hands its activity to a fresh one at this age: Live connections last about ten minutes. */
export const SOCKET_MAX_AGE_MS = 8 * 60_000;
/** A goAway's deadline is met this early. */
const GO_AWAY_MARGIN_MS = 2_000;
/** How long a new socket may take to say its setup is complete. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Tries per socket, this far apart. */
const CONNECT_TRIES = 3;
const RECONNECT_DELAY_MS = 1_000;
/** After a final, further finals of the activity are taken this long. */
export const FINAL_GRACE_MS = 300;
/** The longest wait for a final after activityEnd; then the interim text stands. */
export const FINAL_TIMEOUT_MS = 3_000;
/** Audio goes out in chunks of this many milliseconds (the docs' recommended size). */
const CHUNK_MS = 100;
/** Audio waiting for a socket's setup is bounded: past it the activity loses audio, and says so. */
const MAX_PENDING_MS = 20_000;
/** A socket that cannot take audio (its send buffer stays over this) for STALL_MS is replaced. */
const SEND_HIGH_WATER = 256 * 1024;
const STALL_MS = 5_000;
/** While the send buffer is full, the queued audio is tried again this often. */
const DRAIN_RETRY_MS = 50;

/** The slice of a WebSocket the transcriber uses: the global one, or a test's. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
  /** The server sends its JSON as binary frames: they come as ArrayBuffers, not Blobs, with this set. */
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** What an activity heard. */
export interface Heard {
  /** The authoritative finals joined in arrival order; absent when none came by the cap. */
  final?: string;
  /** The whole text as the last interim showed it. */
  interim: string;
  /** How many finals came. */
  finals: number;
  /** Some of its audio never reached the transcription: no socket could be set up, or it fell behind. */
  failed: boolean;
  /** From activityEnd to the result, ms. */
  finalizeMs: number;
}

export interface TranscriberOptions {
  apiKey: string;
  model: string;
  /** Spelling hints: the agent names and the spoken command phrases. */
  vocabulary: readonly string[];
  languageCodes: readonly string[];
  sampleRate: number;
  /** The open activity's whole text so far, as it grows. */
  onInterim(text: string): void;
  log: Pick<Console, 'info' | 'warn'>;
  socket?: (url: string) => LiveSocket;
  now?: () => number;
}

interface Socket {
  ws: LiveSocket;
  ready: boolean;
  closed: boolean;
  /** Hand the activity over by this time: the age cap, or a goAway's deadline. */
  retireAt: number;
  /** It closed under its activity. */
  onLost?: () => void;
  /** Messages for it. */
  onContent?: (content: ServerContent) => void;
}

/** A socket's part of an activity: its finals and its interim text. */
interface Part {
  finals: string[];
  interim: string;
}

interface Activity {
  /** Text of sockets this activity outlived, in order (a slot fills when a handed-over socket drained). */
  kept: string[];
  part: Part;
  /**
   * The whole text as the last interim showed it. A final inside the activity does not replace it:
   * the final can collapse to the last short phrase, and the turn text then needs this.
   */
  heard: string;
  socket?: Socket;
  /** activityStart went out on `socket`; `endSent`: activityEnd too. */
  started: boolean;
  endSent: boolean;
  /** Audio waiting for `socket` to take it: before its setup, or while its send buffer is full. */
  queued: Int16Array[];
  queuedSamples: number;
  chunk: Int16Array[];
  chunkSamples: number;
  ending: boolean;
  endedAt: number;
  failed: boolean;
  /** Handed-over sockets still draining. */
  draining: number;
  stallSince: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  resolve?: (heard: Heard) => void;
  timer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const words = (s: string): string => s.replace(/\s+/g, ' ').trim();
const partText = (part: Part): string => words([...part.finals, part.interim].join(' '));

export class GeminiLiveTranscriber {
  private activity?: Activity;
  /** A socket set up ahead of the next activity (review talk waits for it). */
  private prepared?: Promise<Socket | undefined>;
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private readonly now: () => number;
  private readonly chunkMax: number;

  constructor(private readonly opts: TranscriberOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.chunkMax = Math.round((opts.sampleRate * CHUNK_MS) / 1000);
  }

  /** Set a socket up for the next activity; resolves whether it is ready. */
  async prepare(): Promise<boolean> {
    if (this.closed) return false;
    const pending = (this.prepared ??= this.connect());
    const socket = await pending;
    // A failed setup is not kept: the next talk tries again.
    if (!socket && this.prepared === pending) this.prepared = undefined;
    return !!socket;
  }

  /** Open an activity; `preRoll` is the audio from just before it (manual activity has no padding). */
  begin(preRoll: Int16Array): void {
    if (this.closed || this.activity) return;
    const activity: Activity = {
      kept: [],
      part: { finals: [], interim: '' },
      heard: '',
      started: false,
      endSent: false,
      queued: [],
      queuedSamples: 0,
      chunk: [],
      chunkSamples: 0,
      ending: false,
      endedAt: 0,
      failed: false,
      draining: 0,
      stallSince: 0,
    };
    this.activity = activity;
    if (preRoll.length) this.queue(activity, preRoll);
    const socket = this.prepared ?? this.connect();
    this.prepared = undefined;
    void this.attach(activity, socket);
  }

  /** Caller audio; it goes out only inside an activity. */
  push(pcm: Int16Array): void {
    const activity = this.activity;
    if (!activity || activity.failed) return;
    if (activity.socket && this.now() >= activity.socket.retireAt) this.handOver(activity, 'age');
    this.queue(activity, pcm);
    this.pump(activity);
  }

  /** Close the open activity; resolves with what it heard: at its final (plus a short grace), or FINAL_TIMEOUT_MS after. */
  end(): Promise<Heard> {
    const activity = this.activity;
    if (!activity) return Promise.resolve({ interim: '', finals: 0, failed: false, finalizeMs: 0 });
    this.activity = undefined;
    activity.ending = true;
    activity.endedAt = this.now();
    const heard = new Promise<Heard>((resolve) => (activity.resolve = resolve));
    if (activity.failed && !activity.socket) this.settle(activity);
    else this.pump(activity);
    return heard;
  }

  close(): void {
    this.closed = true;
    const activity = this.activity;
    this.activity = undefined;
    if (activity) {
      activity.ending = true;
      this.settle(activity);
    }
    for (const socket of [...this.sockets]) this.retire(socket);
    this.prepared = undefined;
  }

  private queue(activity: Activity, pcm: Int16Array): void {
    if (activity.queuedSamples + pcm.length > (this.opts.sampleRate * MAX_PENDING_MS) / 1000) {
      if (!activity.failed) this.opts.log.warn('voice worker: the transcription fell behind; the turn lost audio');
      activity.failed = true;
      return;
    }
    // Native frame storage may be reused: the queue keeps its own copy.
    activity.queued.push(pcm.slice());
    activity.queuedSamples += pcm.length;
  }

  /** The activity's whole text so far. */
  private text(activity: Activity): string {
    return words([...activity.kept, partText(activity.part)].join(' '));
  }

  /** Start the activity on a socket once it is set up: activityStart, the queued audio, and its end if it came. */
  private async attach(activity: Activity, pending: Promise<Socket | undefined>): Promise<void> {
    let socket = await pending;
    // A socket set up ahead that closed before it was used: a fresh one.
    if (socket?.closed && !this.closed) socket = await this.connect();
    if (this.closed || (!activity.resolve && activity.ending)) return this.retire(socket);
    if (!socket) {
      activity.failed = true;
      activity.queued = [];
      activity.queuedSamples = 0;
      this.opts.log.warn('voice worker: the transcription is unavailable; the turn has no text from here');
      if (activity.ending) this.settle(activity);
      return;
    }
    activity.socket = socket;
    activity.started = true;
    socket.onLost = () => this.lost(activity, socket);
    socket.onContent = (content) => this.onContent(activity, content);
    this.send(socket, { realtimeInput: { activityStart: {} } });
    this.pump(activity);
  }

  /**
   * The queued audio to the socket in ~100 ms chunks while its send buffer takes it; when the buffer
   * is full, it is tried again shortly, and a socket that takes nothing for STALL_MS is replaced.
   * The activity's end goes out once all its audio did.
   */
  private pump(activity: Activity): void {
    clearTimeout(activity.drainTimer);
    const socket = activity.socket;
    if (!socket || !activity.started || socket.closed || activity.endSent) return;
    while (activity.queued.length) {
      if ((socket.ws.bufferedAmount ?? 0) > SEND_HIGH_WATER) {
        activity.stallSince ||= this.now();
        if (this.now() - activity.stallSince > STALL_MS) return this.handOver(activity, 'stall');
        activity.drainTimer = setTimeout(() => this.pump(activity), DRAIN_RETRY_MS);
        return;
      }
      const pcm = activity.queued.shift()!;
      activity.queuedSamples -= pcm.length;
      this.write(activity, pcm);
    }
    activity.stallSince = 0;
    if (activity.ending) this.sendEnd(activity);
  }

  /** Audio into ~100 ms chunks: a burst (the pre-roll, audio queued during setup) goes out paced the same. */
  private write(activity: Activity, pcm: Int16Array): void {
    for (let at = 0; at < pcm.length; ) {
      const take = Math.min(pcm.length - at, this.chunkMax - activity.chunkSamples);
      activity.chunk.push(pcm.subarray(at, at + take));
      activity.chunkSamples += take;
      at += take;
      if (activity.chunkSamples >= this.chunkMax) this.flush(activity);
    }
  }

  /** The chunk built so far, out now. */
  private flush(activity: Activity): void {
    const socket = activity.socket;
    if (!activity.chunkSamples || !socket) return;
    const pcm = new Int16Array(activity.chunkSamples);
    let offset = 0;
    for (const part of activity.chunk) {
      pcm.set(part, offset);
      offset += part.length;
    }
    activity.chunk = [];
    activity.chunkSamples = 0;
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    this.send(socket, { realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${this.opts.sampleRate}` } } });
  }

  /**
   * activityEnd, after all the activity's audio; then the final is waited for at most FINAL_TIMEOUT_MS,
   * and a final that already came inside the activity only gets the grace for any more.
   */
  private sendEnd(activity: Activity): void {
    const socket = activity.socket;
    if (!socket || activity.endSent) return;
    this.flush(activity);
    activity.endSent = true;
    this.send(socket, { realtimeInput: { activityEnd: {} } });
    clearTimeout(activity.timer);
    activity.timer = setTimeout(() => {
      this.opts.log.warn('voice worker: no final transcript in time; the turn keeps its interim text');
      this.settle(activity);
    }, FINAL_TIMEOUT_MS);
    if (activity.part.finals.length) this.graceThenSettle(activity);
  }

  private graceThenSettle(activity: Activity): void {
    clearTimeout(activity.graceTimer);
    activity.graceTimer = setTimeout(() => this.settleWhenDrained(activity), FINAL_GRACE_MS);
  }

  /**
   * The activity goes on in a fresh socket (the old one got old, was told to go away, or stalled):
   * the old one ends its part with activityEnd, and its text keeps its place before what follows.
   */
  private handOver(activity: Activity, why: string): void {
    const old = activity.socket;
    if (!old) return;
    this.opts.log.info('voice worker: the transcription moves to a fresh socket mid-turn', { why });
    clearTimeout(activity.drainTimer);
    this.requeueChunk(activity);
    activity.socket = undefined;
    activity.started = false;
    activity.endSent = false;
    activity.stallSince = 0;
    const part = activity.part;
    activity.part = { finals: [], interim: '' };
    const slot = activity.kept.push(partText(part)) - 1;
    activity.draining++;
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(grace);
      clearTimeout(cap);
      activity.kept[slot] = partText(part);
      activity.draining--;
      this.retire(old);
      if (activity.ending && activity.part.finals.length) this.settle(activity);
    };
    old.onLost = finish;
    old.onContent = (content) => {
      if (typeof content.interimInputTranscription?.text === 'string')
        part.interim = content.interimInputTranscription.text;
      const final = content.inputTranscription?.text;
      if (typeof final === 'string' && final.trim()) {
        part.finals.push(final.trim());
        part.interim = '';
        clearTimeout(grace);
        grace = setTimeout(finish, FINAL_GRACE_MS);
      }
    };
    const cap = setTimeout(finish, FINAL_TIMEOUT_MS);
    this.send(old, { realtimeInput: { activityEnd: {} } });
    void this.attach(activity, this.connect());
  }

  /** The chunk not sent yet goes back to the front of the queue, for the next socket. */
  private requeueChunk(activity: Activity): void {
    activity.queued.unshift(...activity.chunk);
    activity.queuedSamples += activity.chunkSamples;
    activity.chunk = [];
    activity.chunkSamples = 0;
  }

  /** The activity's socket closed under it: keep its words, and go on in a fresh one. */
  private lost(activity: Activity, socket: Socket): void {
    if (activity.socket !== socket) return;
    activity.socket = undefined;
    activity.started = false;
    activity.endSent = false;
    clearTimeout(activity.drainTimer);
    this.requeueChunk(activity);
    activity.kept.push(partText(activity.part));
    activity.part = { finals: [], interim: '' };
    if (activity.ending) return this.settle(activity);
    this.opts.log.warn('voice worker: the transcription socket closed mid-turn; the turn goes on in a fresh one');
    void this.attach(activity, this.connect());
  }

  private onContent(activity: Activity, content: ServerContent): void {
    const interim = content.interimInputTranscription?.text;
    if (typeof interim === 'string' && !activity.ending) {
      activity.part.interim = interim;
      activity.heard = this.text(activity);
      this.opts.onInterim(activity.heard);
    }
    const final = content.inputTranscription?.text;
    if (typeof final === 'string' && final.trim()) {
      activity.part.finals.push(final.trim());
      activity.part.interim = '';
      // The interim text after a final starts over; `heard` keeps the last interim's whole text.
      if (!activity.ending) this.opts.onInterim(this.text(activity));
      if (activity.endSent) this.graceThenSettle(activity);
    }
    if ((content.turnComplete || content.generationComplete) && activity.endSent && activity.part.finals.length) {
      this.settleWhenDrained(activity);
    }
  }

  private settleWhenDrained(activity: Activity): void {
    if (activity.draining === 0) this.settle(activity);
  }

  private settle(activity: Activity): void {
    clearTimeout(activity.timer);
    clearTimeout(activity.graceTimer);
    clearTimeout(activity.drainTimer);
    const resolve = activity.resolve;
    activity.resolve = undefined;
    this.retire(activity.socket);
    if (!resolve) return;
    const finals = activity.part.finals;
    const final = finals.length ? words([...activity.kept, ...finals].join(' ')) : undefined;
    resolve({
      ...(final !== undefined ? { final } : {}),
      interim: activity.heard || this.text(activity),
      finals: finals.length,
      failed: activity.failed,
      finalizeMs: activity.endedAt ? this.now() - activity.endedAt : 0,
    });
  }

  private connect(): Promise<Socket | undefined> {
    return (async () => {
      for (let attempt = 0; attempt < CONNECT_TRIES && !this.closed; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        const socket = await this.open();
        if (socket) return socket;
      }
      return undefined;
    })();
  }

  private open(): Promise<Socket | undefined> {
    const factory = this.opts.socket ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);
    let ws: LiveSocket;
    try {
      ws = factory(`${LIVE_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    } catch (err) {
      this.opts.log.warn('voice worker: could not open a transcription socket', { err: this.redact(String(err)) });
      return Promise.resolve(undefined);
    }
    ws.binaryType = 'arraybuffer';
    const socket: Socket = { ws, ready: false, closed: false, retireAt: this.now() + SOCKET_MAX_AGE_MS };
    this.sockets.add(socket);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.opts.log.warn('voice worker: a transcription socket did not set up in time');
        this.retire(socket);
        resolve(undefined);
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => this.send(socket, { setup: this.setup() });
      ws.onerror = () => undefined;
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const fields = { code: ev.code, reason: this.redact(ev.reason).slice(0, 200) };
        if (!socket.ready) {
          socket.closed = true;
          this.sockets.delete(socket);
          this.opts.log.warn('voice worker: a transcription socket closed before its setup', fields);
          return resolve(undefined);
        }
        if (socket.closed) return;
        socket.closed = true;
        this.sockets.delete(socket);
        this.opts.log.warn('voice worker: a transcription socket closed', fields);
        socket.onLost?.();
      };
      ws.onmessage = (ev) => {
        if (socket.closed) return;
        const msg = this.parse(ev.data);
        if (!msg) return;
        if (msg.setupComplete !== undefined && !socket.ready) {
          clearTimeout(timer);
          socket.ready = true;
          return resolve(socket);
        }
        if (msg.goAway !== undefined) {
          const left = parseDuration(msg.goAway?.timeLeft);
          socket.retireAt = Math.min(socket.retireAt, this.now() + Math.max(0, left - GO_AWAY_MARGIN_MS));
        }
        if (msg.serverContent) socket.onContent?.(msg.serverContent);
      };
    });
  }

  private setup(): Record<string, unknown> {
    return {
      model: `models/${this.opts.model}`,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: {
        languageCodes: [...this.opts.languageCodes],
        ...(this.opts.vocabulary.length ? { customVocabulary: [...this.opts.vocabulary] } : {}),
        mode: 'VERBATIM',
      },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    };
  }

  private send(socket: Socket, message: unknown): void {
    if (socket.closed) return;
    try {
      socket.ws.send(JSON.stringify(message));
    } catch (err) {
      this.opts.log.warn('voice worker: could not send to a transcription socket', { err: this.redact(String(err)) });
    }
  }

  private retire(socket: Socket | undefined): void {
    if (!socket || socket.closed) return;
    socket.closed = true;
    this.sockets.delete(socket);
    try {
      socket.ws.close(1000);
    } catch {
      // Already closed.
    }
  }

  private parse(data: unknown): LiveMessage | null {
    try {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.from(ArrayBuffer.isView(data) ? data.buffer : (data as ArrayBuffer)).toString('utf8');
      return JSON.parse(text) as LiveMessage;
    } catch {
      return null;
    }
  }

  /** An error or close reason may echo the request URL, which carries the key. */
  private redact(text: string): string {
    return String(text ?? '')
      .split(this.opts.apiKey)
      .join('***')
      .replace(/([?&]key=)[^&\s"']+/g, '$1***');
  }
}

/** A protobuf Duration as JSON ("12.5s"); unknown: 0. */
function parseDuration(value: unknown): number {
  const seconds = typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

interface ServerContent {
  interimInputTranscription?: { text?: string };
  inputTranscription?: { text?: string };
  turnComplete?: boolean;
  generationComplete?: boolean;
}

interface LiveMessage {
  setupComplete?: unknown;
  goAway?: { timeLeft?: unknown };
  serverContent?: ServerContent;
}
