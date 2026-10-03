/**
 * What the voice host (`voice-livekit.ts`) and the LiveKit worker
 * (`../voice-livekit-worker.ts`) share. Dependency-free on purpose: the worker
 * imports it, and must not load the host's database and channel modules.
 */
import { createHmac } from 'node:crypto';

export const DEFAULT_LIVEKIT_AGENT_NAME = 'nanoclaw-voice';

/** The host pings the worker's event stream this often, so silence means a dead link. */
export const PING_INTERVAL_MS = 15_000;
/** The worker drops the host link after this long without a line: three missed pings. */
export const HOST_SILENCE_MS = 3 * PING_INTERVAL_MS;
/** How long the worker waits for the host to answer one of its POSTs (a turn included). */
export const WORKER_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Wire version of the job metadata and the worker's attribute and topic names; host and worker
 * must agree, so they ship and restart together.
 */
export const LIVEKIT_PROTOCOL_VERSION = 4;

/** Streaming transcription over the Gemini Live API, verbatim. */
export const DEFAULT_VOICE_STT_MODEL = 'gemini-3.5-transcribe-live';
/** Unary transcription, used only while the streaming model fails: its quota is small. */
export const DEFAULT_VOICE_STT_FALLBACK_MODEL = 'gemini-3.5-transcribe';
export const DEFAULT_VOICE_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_VOICE_TTS_FALLBACK_MODEL = 'gemini-3.8-flash-lite-tts';
export const DEFAULT_VOICE_TTS_VOICE = 'Alnilam';
/** Silence that ends the caller's turn; shorter pauses mid-thought keep it open. */
export const DEFAULT_VOICE_SILENCE_MS = 2500;
/** Channel type of the default call chat when `/voice` has not set one (VOICE_MIRROR). */
export const DEFAULT_VOICE_MIRROR = 'telegram';

/** What the worker receives as job metadata. Nothing secret: agents-js logs the whole job on some paths. */
export interface LiveKitJobMetadata {
  /** LIVEKIT_PROTOCOL_VERSION; a worker of another version tells the page it is updating and leaves. */
  v: number;
  callId: string;
  lineId: string;
  agentName: string;
  callerName: string;
  callerIdentity: string;
  /** Spelling hints for the transcription: VOICE_VOCABULARY plus the agent's voice.vocabulary.txt. */
  vocabulary: string[];
  /**
   * The agent's own voice.vocabulary.txt entries: besides `agentName`, the names the wake phrase
   * `hey <agent>` takes (another script or spelling of it, say). Absent when the file has none.
   */
  wakeNames?: string[];
  sttModel: string;
  /** Takes over while `sttModel` fails; empty for none. */
  sttFallbackModel: string;
  ttsModel: string;
  /** Takes over while `ttsModel` fails; empty for none. */
  ttsFallbackModel: string;
  ttsVoice: string;
  silenceMs: number;
  /** Upper bound the worker enforces on itself if the host never ends the call. */
  maxDurationMs: number;
  joinTimeoutMs: number;
}

/**
 * The worker's participant attribute for what `lk.agent.state` cannot say (its session has no
 * LLM, so it never thinks): "1" while the host says the agent works on a turn, "" otherwise.
 */
export const CALL_THINKING_ATTRIBUTE = 'nanoclaw.voice.thinking';
/** The worker's participant attribute: "1" when it cannot serve this host's protocol version. */
export const CALL_UPDATING_ATTRIBUTE = 'nanoclaw.voice.updating';
/**
 * Text stream topic the worker sends JSON `CallTurnStatus` messages on, per caller turn, and a
 * `CallDroppedSpeech` for caller words it will never send.
 */
export const CALL_TURN_TOPIC = 'nanoclaw.voice.turn';

/**
 * The room metadata the host sets when a mid-call `/voice` moves the call to another chat, so the
 * page's header follows it (the new call chat's label, or null once the call talks on the voice
 * line), and again right before it deletes the room, with why the call ended.
 */
export interface CallRoomMetadata {
  chat: string | null;
  end?: CallEndReason;
}

/**
 * What became of a caller turn: closed and on its way to the host (`sending`, once the closing
 * silence and the final transcript are in, before the host answers), sent to the agent, picked up
 * by it (`working`: after `sent`, at most once per turn, when the host's `working` event says the
 * agent's runner works on what reached it after that turn, and no reply to it came first), or lost
 * because the transcription failed (`stt`) or heard no words (`empty`), or the host refused it
 * (`rejected`, `rate_limited`) or did not answer (`timeout`). Every turn handed to the host says
 * `sending` first; one lost to the transcription does not. A page that does not know `sending`
 * ignores it (and `working`), so neither needs a version bump.
 */
export interface CallTurnStatus {
  turn: number;
  status: 'sending' | 'sent' | 'working' | 'lost';
  reason?: 'stt' | 'rejected' | 'rate_limited' | 'timeout' | 'empty';
  /** The final transcript, when there is one; on `sending` only for a sent review draft. */
  text?: string;
  /** On a sent review draft's `sending`: its `CallDraft.id`, so the page shows that text as the turn. */
  draft?: number;
}

/**
 * Caller words that will never be sent, on the turn topic: dropped by a spoken discard
 * (`discarded`), or heard while auto mode waits for the wake phrase (`unaddressed`). `text` is what
 * was heard, for the page to mark those caption lines. It carries no turn number, so a page that
 * does not know it ignores it.
 */
export interface CallDroppedSpeech {
  dropped: 'discarded' | 'unaddressed';
  text: string;
}

/** The host takes a caller turn of at most this many UTF-8 bytes; a longer review draft cannot be sent. */
export const MAX_TURN_TEXT_BYTES = 8 * 1024;

/**
 * Review mode: the caller taps talk, speaks, taps done, reads the draft and sends or discards it;
 * nothing goes out on a pause. The worker's participant attribute is "1" when it runs review mode,
 * and the page offers it only then. The page drives it with the RPCs below on the worker, and the
 * worker sends every change of its `CallReviewState` on the topic. All of it is additive to v4: an
 * old page never calls the RPCs, and an old worker sets no attribute.
 */
export const CALL_REVIEW_ATTRIBUTE = 'nanoclaw.voice.review';
/** Text stream topic the worker sends one JSON `CallReviewState` on whenever it changes. */
export const CALL_REVIEW_TOPIC = 'nanoclaw.voice.review';
/** The RPC methods the worker registers for the page; each takes a `ReviewRequest` and answers a `ReviewReply`. */
export const REVIEW_RPC = {
  mode: 'nanoclaw.voice.mode',
  talk: 'nanoclaw.voice.talk',
  done: 'nanoclaw.voice.done',
  send: 'nanoclaw.voice.send',
  discard: 'nanoclaw.voice.discard',
  /** Auto mode's spoken-command settings and the cue switch (`ReviewRequest.wake`, `.pauseSends`, `.cues`). */
  settings: 'nanoclaw.voice.settings',
} as const;
export type ReviewOp = keyof typeof REVIEW_RPC;

export type TurnMode = 'auto' | 'review';

/**
 * One review turn: `recording` from talk to done (the caller's audio reaches the transcription),
 * `finishing` while the transcription is flushed, then the frozen text: `ready` to send, `empty`
 * (nothing heard) or `failed` (the transcription did not finish; `text` is unverified). `tooLong`:
 * over MAX_TURN_TEXT_BYTES. `reason`: it stopped without done, because a reply took the channel
 * (`agent`), or it is an open auto turn the caller switched to review (`switch`).
 */
export interface CallDraft {
  id: number;
  state: 'recording' | 'finishing' | 'ready' | 'empty' | 'failed';
  text: string;
  tooLong?: boolean;
  reason?: 'agent' | 'switch';
}

/**
 * Auto mode's spoken commands: `over` at the end of an utterance sends the turn now, `discard turn`,
 * `discard this turn` or `scratch that` there drops it, and with the wake switch `on` nothing is kept
 * or sent until `hey <agent>`, or the worker's acoustic wake word (`CallWakeState.phrase`), is heard
 * (`waiting` until then). After the wake phrase only `over` sends, unless
 * `pauseSends` lets the closing silence send too. The worker's participant attribute is "1" when it
 * understands them and the `settings` RPC; an older worker sets none, and its auto mode has no
 * commands.
 */
export const CALL_COMMANDS_ATTRIBUTE = 'nanoclaw.voice.commands';
export interface CallWakeState {
  on: boolean;
  pauseSends: boolean;
  waiting: boolean;
  /**
   * The phrase that opens a turn when the worker spots a wake word in the audio (`hey livekit`);
   * absent when it matches `hey <agent>` in the transcript instead.
   */
  phrase?: string;
}

/**
 * The worker's review state; `seq` grows with every change, so the page keeps the newest.
 * `preparing`: a draft froze or was discarded, which restarts the transcription, and the restarted
 * stream takes no audio yet; talk answers once it does (at most a few seconds), so the page keeps
 * talk off meanwhile. Absent from an older worker, whose talk never waits.
 */
export interface CallReviewState {
  seq: number;
  mode: TurnMode;
  draft: CallDraft | null;
  preparing?: true;
  /** Auto mode's wake switch, from a worker that understands spoken commands. */
  wake?: CallWakeState;
}

/** `gen` is the page's own operation counter, echoed back; `draft` names the draft an operation is for. */
export interface ReviewRequest {
  gen: number;
  draft?: number;
  /** For `mode`: the mode to switch to; absent, the worker only sends its state again. */
  mode?: TurnMode;
  /** With `mode`: the newest worker turn number the page had seen, to hear of a turn sent meanwhile. */
  afterTurn?: number;
  /** For `settings`: the wake switch, whether a pause sends after the wake phrase, and the sound cues. */
  wake?: boolean;
  pauseSends?: boolean;
  cues?: boolean;
}

/**
 * What the worker did. `seq`: the state that shows it, which the page waits for on the topic.
 * `draft`: the draft talk opened. `turn`: the turn number a sent draft got. `submitted`: on a switch
 * to review, a turn auto mode had already sent after `afterTurn`. `error`: why nothing happened.
 */
export interface ReviewReply {
  gen: number;
  ok: boolean;
  seq: number;
  draft?: number;
  turn?: number;
  submitted?: number;
  error?:
    | 'stale'
    | 'recording'
    | 'finishing'
    | 'draft_open'
    | 'agent_speaking'
    | 'not_review'
    | 'unsendable'
    | 'closed';
}

/**
 * The worker's participant attribute while a finished stretch of caller speech waits out the
 * closing silence before it is sent: `"<n>:<elapsedMs>:<silenceMs>"`, where n tells one wait from
 * the next and elapsedMs is how much of the silence had passed when it was set. "" otherwise:
 * speech resumed, the turn went out or was dropped, or the agent speaks.
 */
export const CALL_PENDING_ATTRIBUTE = 'nanoclaw.voice.pending';
/**
 * The worker's sound cues go out on a second audio track of this name (agents-js's
 * BackgroundAudioPlayer), apart from the agent's speech track: a page plays it like the speech, and a
 * cue never counts as the agent speaking. None plays while the agent speaks.
 */
export const CALL_CUE_TRACK = 'background_audio';
/** Text stream topic the worker sends one JSON `CallReplyInfo` on right before each line it speaks. */
export const CALL_REPLY_TOPIC = 'nanoclaw.voice.reply';

/**
 * What the next spoken line is: an agent message answering the caller's turn `turn` (the
 * `CallTurnStatus` number), one answering no turn of this call (`unprompted`), or the worker's
 * own notice (a lost turn, an unspeakable reply). `part` counts the messages answering that turn
 * so far; `more` is set when another line is already queued behind this one.
 */
export interface CallReplyInfo {
  reply: number;
  turn?: number;
  unprompted?: boolean;
  notice?: boolean;
  part?: number;
  more?: boolean;
}

/**
 * Why the host ended a call, in the room metadata (`CallRoomMetadata.end`) right before it deletes the room.
 * `worker_restart`: the worker ended the call while it shut down (its `ended` POST carries `restart: true`);
 * `worker_gone`: it ended the call for any other reason, or its link to the host dropped.
 */
export const CALL_END_REASONS = [
  'limit_duration',
  'limit_daily',
  'newer_call',
  'revoked',
  'shutdown',
  'worker_restart',
  'worker_gone',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * One line of the host-to-worker event stream: a complete agent message to
 * speak (`turn`: the host's utterance id of the caller turn it answers, null
 * when it answers none of this call's turns), the agent still working (from the
 * host's typing refresh), the agent's runner working on what reached it since
 * the call's latest turn (`working`, from the same refresh: the runner's own
 * turn report, stamped after that turn landed), whether the call now talks in a chat (`chat`; none
 * until it does), a turn answered 504 that the agent's session stored after all
 * (`turn-stored`: its `turnKey` and the host's utterance id), the end of the
 * call, or a keepalive. A worker ignores a type it does not know, so new types
 * need no version bump.
 */
export type LiveKitHostEvent =
  | { type: 'reply'; text: string; turn?: string | null }
  | { type: 'thinking' }
  | { type: 'working' }
  | { type: 'chat'; chat: boolean }
  | { type: 'turn-stored'; turnKey: string; id: string }
  | { type: 'end'; reason: string }
  | { type: 'ping' };

/**
 * The bearer secret for one call's worker routes, derived from the LiveKit API
 * secret both processes already hold, so it never travels in the dispatch.
 */
export function liveKitCallSecret(apiSecret: string, callId: string): string {
  return createHmac('sha256', apiSecret).update(`nanoclaw-voice-call:${callId}`).digest('base64url');
}

/** Where the worker reaches the host's webhook server; only ever from the worker's own settings. */
export function liveKitHostUrl(env: { LIVEKIT_HOST_URL?: string; WEBHOOK_PORT?: string }): string {
  return (env.LIVEKIT_HOST_URL || `http://127.0.0.1:${env.WEBHOOK_PORT || '3000'}`).replace(/\/+$/, '');
}
