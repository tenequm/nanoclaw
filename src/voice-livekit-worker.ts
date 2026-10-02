/**
 * The LiveKit Agents worker for the voice channel's LiveKit path.
 *
 * A separate process (`pnpm run voice-worker`), because agents-js runs every
 * job in a forked child process of its worker and owns that process's signals
 * and logging; the host dispatches it to each call's room (explicit dispatch
 * by agent name) and the two talk over the host's webhook server, see
 * `src/channels/voice-livekit.ts` for the protocol. The host's address and the
 * call's secret come from the worker's own settings, never from the dispatch.
 *
 * Per job: join the room, wait for the caller named in the metadata, tell the
 * host (which starts the clock), then run Gemini Live through the google
 * plugin's RealtimeModel with one NON_BLOCKING tool, `ask_agent`.
 *
 * ask_agent hands the request to the host, which feeds it to the NanoClaw
 * agent, and waits for the reply that names its consult, which goes back to
 * Gemini as the function response (spoken WHEN_IDLE, after the current turn,
 * so it never talks over anyone). When an interruption hits the turn that made
 * the call, the execution moves to the background with RunContext.update():
 * Gemini gets a holding note as the function response and the answer is
 * spoken as a new turn when it arrives. An answer is never dropped: if the
 * execution was aborted anyway, if the framework never confirms its output, or
 * if a reply answers no waiting call (an interim "let me check" followed by
 * the answer, a proactive message), the text is spoken as a new turn with
 * generateReply once the session is idle.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AutoSubscribe,
  cli,
  defineAgent,
  llm,
  log as agentsLog,
  ServerOptions,
  voice,
  type JobContext,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { z } from 'zod';

import { ASK_AGENT_TOOL } from './channels/gemini-live.js';
import {
  ANSWER_PREFIX,
  DEFAULT_LIVEKIT_AGENT_NAME,
  HOST_SILENCE_MS,
  liveKitCallSecret,
  liveKitHostUrl,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
} from './channels/voice-livekit-protocol.js';
import { readEnvFile } from './env.js';

/** After the tool returned an answer, the framework must confirm it went to the model within this. */
const TOOL_OUTPUT_CONFIRM_MS = 10_000;
/** The tool's own wait outlasts the host's delegation timeout by this, so the host's timeout line wins. */
const ANSWER_WAIT_GRACE_MS = 15_000;
/** The worker's own duration cap outlasts the host's by this; it only fires when the host is gone. */
const WORKER_DEADLINE_GRACE_MS = 30_000;
const HOST_PROBE_INTERVAL_MS = 30_000;
const HOST_PROBE_TIMEOUT_MS = 3_000;
const BATCHED_LINE = 'Answered together with the previous request; nothing to add.';

/**
 * The google plugin's generateReply gives up after 5 s without a generation_created event, but a
 * generation that starts later is still spoken, so a retry after this error would say it twice.
 */
const isLateGenerationTimeout = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('waiting for generation_created');

const agentRoute = (hostUrl: string, path: string): string => `${hostUrl}/webhook/voice/livekit/agent/${path}`;

/** The worker's HTTP client for the host's /webhook/voice/livekit/agent routes. */
export class HostLink {
  constructor(
    private readonly link: { hostUrl: string; secret: string; callId: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return agentRoute(this.link.hostUrl, path);
  }

  post(path: 'joined' | 'ask' | 'ended', body: Record<string, unknown> = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.link.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: this.link.callId, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Read the host's event stream until it ends; rejects when it fails or goes silent. */
  async events(onEvent: (event: LiveKitHostEvent) => void, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let silence = setTimeout(abort, HOST_SILENCE_MS);
    try {
      const res = await this.fetchImpl(`${this.url('events')}?call=${encodeURIComponent(this.link.callId)}`, {
        headers: { Authorization: `Bearer ${this.link.secret}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`host event stream refused: ${res.status}`);
      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(silence);
        silence = setTimeout(abort, HOST_SILENCE_MS);
        buffered += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line) onEvent(JSON.parse(line) as LiveKitHostEvent);
        }
      }
    } finally {
      clearTimeout(silence);
      signal.removeEventListener('abort', abort);
    }
  }
}

/** The slice of AgentSession the bridge drives; a plain object in tests. */
export interface SpeechSession {
  generateReply(options: { instructions: string }): { waitForPlayout(): Promise<void>; exception?(): unknown };
  waitForIdle(): Promise<unknown>;
  readonly agentState: string;
  readonly userState: string;
}

/** The slice of agents-js's RunContext an ask_agent execution uses. */
export interface AskContext {
  readonly speechHandle: {
    readonly interrupted: boolean;
    waitIfNotInterrupted(aw: Promise<unknown>[]): Promise<void>;
  };
  update(message: string): Promise<void>;
}

/** One ask_agent consult the host accepted and whose reply has not come yet. */
interface Waiter {
  /** Answer it: as the tool result while its execution waits, otherwise as a new turn. */
  settle(instructions: string): void;
  /** Close it without an answer: a batched reply went to another consult, or the call ends. */
  cancel(text: string): void;
}

export interface CallBridgeOptions {
  agentName: string;
  /** Longest a tool execution waits for its answer; the host's own timeout fires first. */
  answerWaitMs: number;
  /** The host's line for an ask_agent that got no reply in time (DELEGATION_TIMEOUT_LINE). */
  timeoutLine: string;
  confirmMs?: number;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Routes between the realtime session and the host: ask_agent executions in,
 * agent replies and messages out. Owns the no-answer-is-dropped guarantee.
 */
export class CallBridge {
  /** By the host's consult id. Order does not matter: a reply lists the consults it answers itself. */
  private readonly waiting = new Map<string, Waiter>();
  private readonly unconfirmed = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
  private speaking: Promise<void> = Promise.resolve();
  private pendingSpeech = 0;
  private closed = false;

  constructor(
    private readonly session: SpeechSession,
    private readonly host: Pick<HostLink, 'post'>,
    private readonly options: CallBridgeOptions,
  ) {}

  answerInstructions(text: string): string {
    return `${ANSWER_PREFIX} (${this.options.agentName}): ${text}\nTell the caller this now, in your own words, briefly.`;
  }

  timeoutInstructions(line: string): string {
    return (
      `No answer from ${this.options.agentName} yet. Tell the caller, in their language: "${line}" ` +
      `Do not guess the answer; it still arrives later as an "${ANSWER_PREFIX}" instruction.`
    );
  }

  /** The function response of an execution moved to the background; the answer follows as a new turn. */
  backgroundNote(): string {
    return (
      `${this.options.agentName} is still working on this request. Its answer arrives later as an ` +
      `"${ANSWER_PREFIX}" instruction; until then do not guess it.`
    );
  }

  /** The ask_agent tool for the session's agent. */
  tool() {
    return llm.tool({
      name: ASK_AGENT_TOOL,
      description:
        `Ask ${this.options.agentName}, the backend assistant that holds the user's memory, files, calendar and ` +
        'tools and can take actions. Use it for anything that needs facts, memory, tools or actions. The answer ' +
        'can take a while; keep the caller company briefly meanwhile.',
      parameters: z.object({
        request: z.string().describe('What the caller wants, in full, with every detail they gave.'),
      }),
      execute: ({ request }, { ctx, toolCallId, abortSignal }) => this.ask(request, toolCallId, abortSignal, ctx),
    });
  }

  /**
   * One ask_agent execution: hand the request to the host, then wait for the reply naming its
   * consult. Resolves undefined once the execution is in the background or aborted: agents-js
   * would deliver a later return value as a synthetic `<id>_final` call output, which the google
   * plugin forwards as a FunctionResponse for an id Gemini never issued, so the answer is spoken
   * as a new turn instead.
   */
  ask(request: string, toolCallId: string, abortSignal?: AbortSignal, ctx?: AskContext): Promise<string | undefined> {
    const text = request.trim();
    if (!text) return Promise.resolve('The request was empty; ask the caller what they need.');
    let finished = false;
    let resolveResult!: (value: string | undefined) => void;
    const result = new Promise<string | undefined>((resolve) => (resolveResult = resolve));
    const finish = (value: string | undefined) => {
      if (finished) return;
      finished = true;
      abortSignal?.removeEventListener('abort', onAbort);
      resolveResult(value);
    };
    const onAbort = () => {
      this.options.log?.info('ask_agent: execution aborted; its answer will be spoken when it arrives');
      finish(undefined);
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
    // An interruption of the turn that called the tool aborts the execution 5 s later (agents-js
    // SpeechHandle's interrupt timeout). The first update() resolves the tool's output with the
    // note, so Gemini gets a FunctionResponse for this call, and unhooks that abort.
    void ctx?.speechHandle.waitIfNotInterrupted([result]).then(
      () => {
        if (finished || !ctx.speechHandle.interrupted) return;
        this.options.log?.info('ask_agent: turn interrupted; moving the execution to the background');
        void ctx
          .update(this.backgroundNote())
          .catch((err: unknown) => this.options.log?.warn('ask_agent: update failed', err));
        finish(undefined);
      },
      () => undefined,
    );
    void this.submit(text, toolCallId, {
      isWaiting: () => !finished,
      finish,
    });
    return result;
  }

  private async submit(
    text: string,
    toolCallId: string,
    execution: { isWaiting(): boolean; finish(value: string | undefined): void },
  ): Promise<void> {
    // Tells the model, or after the execution is gone, says it as a new turn.
    const outcome = (line: string) => {
      if (execution.isWaiting()) execution.finish(line);
      else void this.speak(line);
    };
    let res: Response;
    try {
      // Not tied to the abort: once sent, the request stands and its answer is delivered either way.
      res = await this.host.post('ask', { request: text });
    } catch (err) {
      this.options.log?.warn('ask_agent: host unreachable', err);
      return outcome(`${this.options.agentName} could not be reached right now. Tell the caller.`);
    }
    if (res.status !== 202) {
      void res.body?.cancel().catch(() => {});
      if (res.status === 429) {
        return outcome('Several requests are already open; wait for those answers before asking more.');
      }
      if (res.status === 413) return outcome('That request is too long; ask again in fewer words.');
      return outcome(`${this.options.agentName} cannot take requests on this call right now.`);
    }
    const consultId = await res
      .json()
      .then((body: unknown) => (body as { id?: unknown } | null)?.id)
      .catch(() => undefined);
    if (typeof consultId !== 'string' || !consultId || this.closed) {
      // The agent has the request; its reply names no waiter here and is spoken as a new turn.
      return outcome(`Asked ${this.options.agentName}. Its answer arrives later as an "${ANSWER_PREFIX}" instruction.`);
    }
    const done = () => {
      clearTimeout(backstop);
      if (this.waiting.get(consultId) === waiter) this.waiting.delete(consultId);
    };
    const waiter: Waiter = {
      settle: (instructions) => {
        done();
        if (!execution.isWaiting()) {
          void this.speak(instructions);
          return;
        }
        this.expectConfirmation(toolCallId, instructions);
        execution.finish(instructions);
      },
      cancel: (value) => {
        done();
        execution.finish(value);
      },
    };
    const backstop = setTimeout(() => {
      if (execution.isWaiting()) waiter.settle(this.timeoutInstructions(this.options.timeoutLine));
      else done();
    }, this.options.answerWaitMs);
    backstop.unref?.();
    this.waiting.set(consultId, waiter);
  }

  /** The framework confirms a tool output reached the model; if it never does, speak it anyway. */
  private expectConfirmation(toolCallId: string, instructions: string): void {
    const fallback = setTimeout(() => {
      this.unconfirmed.delete(toolCallId);
      this.options.log?.warn('ask_agent: tool output never reached the model; speaking it as a new turn');
      void this.speak(instructions);
    }, this.options.confirmMs ?? TOOL_OUTPUT_CONFIRM_MS);
    fallback.unref?.();
    this.unconfirmed.set(toolCallId, { text: instructions, timer: fallback });
  }

  /** FunctionToolsExecuted: these tool outputs reached the realtime session. */
  onToolsExecuted(callIds: readonly string[]): void {
    for (const id of callIds) {
      const pending = this.unconfirmed.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.unconfirmed.delete(id);
    }
  }

  onHostEvent(event: LiveKitHostEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'reply': {
        const instructions = event.timedOut
          ? this.timeoutInstructions(event.text)
          : this.answerInstructions(event.text);
        // The host lists the consults this reply answers, the targeted one first.
        const answered = (event.consultIds ?? []).flatMap((id) => this.waiting.get(id) ?? []);
        const [first, ...batched] = answered;
        if (!first) {
          void this.speak(instructions);
          return;
        }
        first.settle(instructions);
        for (const other of batched) other.cancel(BATCHED_LINE);
        return;
      }
      case 'say':
        void this.speak(
          `Message from ${this.options.agentName} for the caller (not an answer to a question): ${event.text}\n` +
            'Tell the caller now, briefly, in your own words.',
        );
        return;
      case 'thinking':
        // A short holding line, only into silence and never on top of other queued speech.
        if (this.waiting.size === 0 || this.pendingSpeech > 0) return;
        if (this.session.userState === 'speaking' || this.session.agentState === 'speaking') return;
        void this.speak(
          `${this.options.agentName} is still working on it. Say in one short sentence that it is taking a little ` +
            'longer and you will tell them as soon as it is done, then wait.',
          () => this.waiting.size > 0,
        );
        return;
      default:
        return;
    }
  }

  /**
   * Speak as a new turn once the session is idle; serialized so turns never supersede each other.
   * `stillWanted` is checked after the wait (a holding note is stale once the answer came), and a
   * turn that fails is tried once more, unless the model only started it late (still spoken).
   */
  speak(instructions: string, stillWanted: () => boolean = () => true): Promise<void> {
    this.pendingSpeech++;
    const next = this.speaking.then(async () => {
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (this.closed) return;
          try {
            await this.session.waitForIdle();
            if (this.closed || !stillWanted()) return;
            const handle = this.session.generateReply({ instructions });
            await handle.waitForPlayout();
            const error = handle.exception?.();
            if (error === undefined || error === null) return;
            throw error;
          } catch (err) {
            if (isLateGenerationTimeout(err)) {
              this.options.log?.warn('voice bridge: the model started a turn late; not repeating it', err);
              return;
            }
            this.options.log?.warn(
              attempt === 1 ? 'voice bridge: a turn failed; trying once more' : 'voice bridge: could not speak a turn',
              err,
            );
          }
        }
      } finally {
        this.pendingSpeech--;
      }
    });
    this.speaking = next;
    return next;
  }

  close(): void {
    this.closed = true;
    for (const waiter of [...this.waiting.values()]) waiter.cancel('The call is ending.');
    this.waiting.clear();
    for (const pending of this.unconfirmed.values()) clearTimeout(pending.timer);
    this.unconfirmed.clear();
  }
}

/**
 * Asks the host's agent events route without credentials: its 404 ("No such call") proves the
 * worker reaches a running voice host. Returns what is wrong, or null.
 */
export async function probeHost(hostUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(agentRoute(hostUrl, 'events'), { signal: AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS) });
  } catch (err) {
    return `is unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
  void res.body?.cancel().catch(() => {});
  if (res.status === 404) return null;
  if (res.status === 403) {
    return 'refuses this worker (403): voice routes serve loopback peers only unless GPT_LIVE_ALLOW_NON_LOOPBACK=1';
  }
  if (res.status === 503) return 'answers 503: its voice channel or LiveKit path is not running';
  return `answers ${res.status}, so it is not a NanoClaw voice host`;
}

/** Watches the worker's host URL: probed at startup, and every interval while it fails. */
export class HostMonitor {
  private problem: string | null = null;
  private inFlight?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly hostUrl: string,
    private readonly log: Pick<Console, 'info' | 'error'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly intervalMs = HOST_PROBE_INTERVAL_MS,
  ) {}

  /** The last probe failed. */
  get down(): boolean {
    return this.problem !== null;
  }

  start(): Promise<boolean> {
    this.log.info(`voice worker: host URL ${this.hostUrl}`);
    return this.check();
  }

  /** Probe now; resolves whether the host answered. Never rejects. */
  check(): Promise<boolean> {
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private async probe(): Promise<boolean> {
    clearTimeout(this.timer);
    const problem = await probeHost(this.hostUrl, this.fetchImpl);
    if (problem && problem !== this.problem) {
      this.log.error(
        `voice worker: the host at ${this.hostUrl} ${problem}; calls are refused until it answers. ` +
          "If that is not this NanoClaw's webhook server, set LIVEKIT_HOST_URL in .env",
      );
    } else if (!problem && this.problem) {
      this.log.info(`voice worker: the host at ${this.hostUrl} answers again`);
    }
    this.problem = problem;
    if (problem) {
      this.timer = setTimeout(() => void this.check(), this.intervalMs);
      this.timer.unref?.();
    }
    return !problem;
  }
}

export function parseJobMetadata(raw: string): LiveKitJobMetadata {
  const meta = JSON.parse(raw) as LiveKitJobMetadata;
  if (meta?.v !== 1 || !meta.callId || !meta.callerIdentity || !meta.agentName) {
    throw new Error('voice worker: job metadata is not a NanoClaw voice call');
  }
  return meta;
}

/** Gemini Live settings for a call; NON_BLOCKING so a pending ask_agent never freezes the conversation. */
export function realtimeModelOptions(
  meta: Pick<LiveKitJobMetadata, 'model' | 'voice' | 'instructions' | 'scheduling'>,
  apiKey: string,
): ConstructorParameters<typeof google.realtime.RealtimeModel>[0] {
  return {
    apiKey,
    model: meta.model,
    voice: meta.voice,
    instructions: meta.instructions,
    // No thinkingConfig: gemini-3.8-live closes the session (1007) on any.
    toolBehavior: google.realtime.Behavior.NON_BLOCKING,
    // WHEN_IDLE: a late answer is spoken after the current turn instead of barging in.
    ...(meta.scheduling ? { toolResponseScheduling: google.realtime.FunctionResponseScheduling.WHEN_IDLE } : {}),
    // No customVocabulary: Gemini documents it for its transcribe model only; the names are in the prompt.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

/** The slice of AgentSession runCall drives; a fake in tests. */
export interface CallSession extends SpeechSession {
  on(
    event: typeof voice.AgentSessionEventTypes.FunctionToolsExecuted,
    listener: (ev: { functionCallOutputs: ReadonlyArray<{ callId: string }> }) => void,
  ): unknown;
  on(event: typeof voice.AgentSessionEventTypes.Close, listener: (ev: { reason: unknown }) => void): unknown;
  start(options: {
    agent: voice.Agent;
    room: JobContext['room'];
    inputOptions: { participantIdentity: string; closeOnDisconnect: boolean };
    outputOptions: { transcriptionEnabled: boolean };
  }): Promise<unknown>;
  close(): Promise<unknown>;
}

/** The slice of JobContext runCall uses. */
export type CallJob = Pick<
  JobContext,
  'job' | 'room' | 'connect' | 'waitForParticipant' | 'deleteRoom' | 'shutdown' | 'addShutdownCallback'
>;

export interface RunCallDeps {
  /** The worker's settings; read from .env in the job process, so secrets stay out of argv and process.env. */
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  createSession(meta: LiveKitJobMetadata, geminiKey: string): CallSession;
  log: Pick<Console, 'info' | 'warn'>;
}

/** Settings from the working directory's .env; WEBHOOK_PORT from the environment wins, as on the host. */
function workerEnv(keys: string[]): Record<string, string | undefined> {
  return {
    ...readEnvFile([...keys, 'WEBHOOK_PORT']),
    ...(process.env.WEBHOOK_PORT ? { WEBHOOK_PORT: process.env.WEBHOOK_PORT } : {}),
  };
}

function defaultDeps(): RunCallDeps {
  const logger = agentsLog();
  return {
    env: workerEnv(['GEMINI_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_HOST_URL']),
    createSession: (meta, geminiKey) =>
      new voice.AgentSession({
        // Gemini's server VAD detects turns and barge-in; no local VAD process or turn detector.
        vad: null,
        turnHandling: { turnDetection: 'realtime_llm' },
        llm: new google.realtime.RealtimeModel(realtimeModelOptions(meta, geminiKey)),
      }) as unknown as CallSession,
    log: {
      info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
      warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
    } as Pick<Console, 'info' | 'warn'>,
  };
}

export async function runCall(ctx: CallJob, deps: RunCallDeps = defaultDeps()): Promise<void> {
  const { log } = deps;
  const meta = parseJobMetadata(ctx.job.metadata);
  const callFields = { callId: meta.callId };
  const hostUrl = liveKitHostUrl(deps.env);
  const host = new HostLink(
    {
      hostUrl,
      secret: liveKitCallSecret(deps.env.LIVEKIT_API_SECRET ?? '', meta.callId),
      callId: meta.callId,
    },
    deps.fetchImpl,
  );
  const abandon = async (reason: string, fields: Record<string, unknown> = {}) => {
    log.warn('voice worker: ending the call', { ...callFields, ...fields, reason });
    await host.post('ended', { reason }).catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  if (!deps.env.LIVEKIT_API_SECRET) return abandon('LIVEKIT_API_SECRET is not set for the worker');
  const geminiKey = deps.env.GEMINI_API_KEY;
  if (!geminiKey) return abandon('GEMINI_API_KEY is not set for the worker');

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  try {
    await withTimeout(ctx.waitForParticipant(meta.callerIdentity), meta.joinTimeoutMs, 'caller never joined');
  } catch (err) {
    return abandon((err as Error).message);
  }
  const joined = await host.post('joined').catch(() => null);
  void joined?.body?.cancel().catch(() => {});
  // The host starts billing here; without its yes, no Gemini session is opened.
  if (!joined?.ok) return abandon(`host refused the call (${joined?.status ?? 'unreachable'})`, { hostUrl });

  const session = deps.createSession(meta, geminiKey);
  const bridge = new CallBridge(session, host, {
    agentName: meta.agentName,
    // The host answers with the timeout line at delegationTimeoutMs; this is only a backstop.
    answerWaitMs: meta.delegationTimeoutMs + ANSWER_WAIT_GRACE_MS,
    timeoutLine: meta.timeoutLine,
    log: {
      info: (msg: string) => log.info(msg, callFields),
      warn: (msg: string, err?: unknown) => log.warn(msg, { ...callFields, err }),
    } as Pick<Console, 'info' | 'warn'>,
  });
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) =>
    bridge.onToolsExecuted(ev.functionCallOutputs.map((o) => o.callId)),
  );
  const hostLink = new AbortController();
  let ending = false;
  const end = async (reason: string, tellHost: boolean) => {
    if (ending) return;
    ending = true;
    bridge.close();
    hostLink.abort();
    if (tellHost) await host.post('ended', { reason }).catch(() => undefined);
    await session.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  session.on(voice.AgentSessionEventTypes.Close, (ev) => void end(`session closed: ${String(ev.reason)}`, true));
  // Defense in depth: the host ends the call on time; this stops a worker that lost the host.
  const deadline = setTimeout(
    () => void end('duration limit (worker)', true),
    meta.maxDurationMs + WORKER_DEADLINE_GRACE_MS,
  );
  deadline.unref?.();
  ctx.addShutdownCallback(async () => {
    clearTimeout(deadline);
    await end('job shutdown', true);
  });

  await session.start({
    agent: new voice.Agent({ instructions: meta.instructions, tools: [bridge.tool()] }),
    room: ctx.room,
    inputOptions: { participantIdentity: meta.callerIdentity, closeOnDisconnect: true },
    outputOptions: { transcriptionEnabled: true },
  });
  host
    .events((event) => {
      if (event.type === 'end') void end(`host: ${event.reason}`, false);
      else bridge.onHostEvent(event);
    }, hostLink.signal)
    .then(
      () => end('host link closed', true),
      (err: unknown) => {
        if (!ending) log.warn('voice worker: host link failed', { ...callFields, err });
        return end('host link failed', true);
      },
    )
    .catch(() => undefined);
  session.generateReply({ instructions: 'The call just connected. Greet the caller briefly.' });
}

export default defineAgent({ entry: (ctx) => runCall(ctx) });

// Imported by the job processes and by tests too; only the worker's own entrypoint runs the CLI.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = workerEnv([
    'LIVEKIT_URL',
    'LIVEKIT_WORKER_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_AGENT_NAME',
    'LIVEKIT_HOST_URL',
    'VOICE_WORKER_HEALTH_PORT',
  ]);
  // agents-js initializes its logger once the CLI runs a command; console until then.
  const mainLog = (level: 'info' | 'warn' | 'error') => (msg: string) => {
    try {
      agentsLog()[level](msg);
    } catch {
      console[level](msg);
    }
  };
  const monitor = new HostMonitor(liveKitHostUrl(env), { info: mainLog('info'), error: mainLog('error') });
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.LIVEKIT_AGENT_NAME || DEFAULT_LIVEKIT_AGENT_NAME,
      wsURL: env.LIVEKIT_WORKER_URL || env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      // Health endpoint on loopback only, off agents-js's default 8081.
      host: '127.0.0.1',
      port: Number(env.VOICE_WORKER_HEALTH_PORT || 8089),
      numIdleProcesses: 1,
      // On SIGTERM the worker takes no new calls and gives running ones this long before closing
      // them; a call can run up to GPT_LIVE_MAX_CALL_SECONDS, so a restart cuts longer ones short.
      drainTimeout: 60_000,
      // Never throws and always answers: agents-js logs the whole job, metadata included, when a
      // request function fails or leaves the request unanswered.
      requestFunc: async (req) => {
        let name: string;
        try {
          name = parseJobMetadata(req.job.metadata).agentName;
        } catch {
          return req.reject();
        }
        // Without the host the call could not start; another worker may take it.
        if (monitor.down && !(await monitor.check())) {
          mainLog('warn')(`voice worker: refused a call; the host at ${monitor.hostUrl} does not answer`);
          return req.reject().catch(() => undefined);
        }
        await req.accept(name).catch(() => req.reject().catch(() => undefined));
      },
    }),
  );
  void monitor.start();
}
