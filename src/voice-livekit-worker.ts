/**
 * The LiveKit Agents worker for the voice channel's LiveKit path.
 *
 * A separate process (`pnpm run voice-worker`), because agents-js runs every
 * job in a forked child process of its worker and owns that process's signals
 * and logging; the host dispatches it to each call's room (explicit dispatch
 * by agent name) and the two talk over the host's webhook server, see
 * `src/channels/voice-livekit.ts` for the protocol.
 *
 * Per job: join the room, wait for the caller named in the metadata, tell the
 * host (which starts the clock), then run Gemini Live through the google
 * plugin's RealtimeModel with one NON_BLOCKING tool, `ask_agent`.
 *
 * ask_agent hands the request to the host, which feeds it to the NanoClaw
 * agent, and waits for the first answer, which goes back to Gemini as the
 * function response (spoken WHEN_IDLE, after the current turn, so it never
 * talks over anyone). An answer is never dropped: if the tool execution is
 * aborted by an interruption, if the framework never confirms its output, or
 * if more replies arrive than calls are waiting (an interim "let me check"
 * followed by the answer, a proactive message), the text is spoken as a new
 * turn with generateReply once the session is idle.
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

import type { LiveKitHostEvent, LiveKitJobMetadata } from './channels/voice-livekit.js';
import { readEnvFile } from './env.js';

/** Host link considered dead after this long without a line (it pings every 15 s). */
const HOST_SILENCE_MS = 45_000;
/** After the tool returned an answer, the framework must confirm it went to the model within this. */
const TOOL_OUTPUT_CONFIRM_MS = 10_000;
const ASK_REQUEST_MAX_CHARS = 4000;

export const ANSWER_PREFIX = 'Answer from the backend';

/** The worker's HTTP client for the host's /webhook/voice/livekit/agent routes. */
export class HostLink {
  constructor(
    private readonly meta: Pick<LiveKitJobMetadata, 'hostUrl' | 'secret' | 'callId'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.meta.hostUrl}/webhook/voice/livekit/agent/${path}`;
  }

  post(path: 'joined' | 'ask' | 'ended', body: Record<string, unknown> = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.meta.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: this.meta.callId, ...body }),
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
      const res = await this.fetchImpl(`${this.url('events')}?call=${encodeURIComponent(this.meta.callId)}`, {
        headers: { Authorization: `Bearer ${this.meta.secret}` },
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
  generateReply(options: { instructions: string }): { waitForPlayout(): Promise<void> };
  waitForIdle(): Promise<unknown>;
  readonly agentState: string;
  readonly userState: string;
}

interface WaitingCall {
  toolCallId: string;
  /** Answer the execution with the agent's reply. */
  settle(text: string): void;
  /** End the execution without an answer. */
  cancel(text: string): void;
}

export interface CallBridgeOptions {
  agentName: string;
  /** Longest a tool execution waits for its answer; the host's own timeout fires first. */
  answerWaitMs: number;
  confirmMs?: number;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Routes between the realtime session and the host: ask_agent executions in,
 * agent replies and messages out. Owns the no-answer-is-dropped guarantee.
 */
export class CallBridge {
  private readonly waiting: WaitingCall[] = [];
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

  /** The ask_agent tool for the session's agent. */
  tool() {
    return llm.tool({
      name: 'ask_agent',
      description:
        `Ask ${this.options.agentName}, the backend assistant that holds the user's memory, files, calendar and ` +
        'tools and can take actions. Use it for anything that needs facts, memory, tools or actions. The answer ' +
        'can take a while; keep the caller company briefly meanwhile.',
      parameters: z.object({
        request: z.string().describe('What the caller wants, in full, with every detail they gave.'),
      }),
      execute: ({ request }, { toolCallId, abortSignal }) => this.ask(request, toolCallId, abortSignal),
    });
  }

  /** One ask_agent execution: hand the request to the host, then wait for its first answer. */
  async ask(request: string, toolCallId: string, abortSignal?: AbortSignal): Promise<string> {
    const text = request.trim();
    if (!text) return 'The request was empty; ask the caller what they need.';
    if (text.length > ASK_REQUEST_MAX_CHARS) return 'That request is too long; ask again in fewer words.';
    let res: Response;
    try {
      // Not tied to abortSignal: once sent, the request stands and its answer is delivered either way.
      res = await this.host.post('ask', { request: text });
    } catch (err) {
      this.options.log?.warn('ask_agent: host unreachable', err);
      return `${this.options.agentName} could not be reached right now. Tell the caller.`;
    }
    void res.body?.cancel();
    if (res.status === 429) return 'Several requests are already open; wait for those answers before asking more.';
    if (res.status === 413) return 'That request is too long; ask again in fewer words.';
    if (res.status !== 202) return `${this.options.agentName} cannot take requests on this call right now.`;
    return new Promise<string>((resolve) => {
      let done = false;
      const finish = (value: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(value);
      };
      const entry: WaitingCall = {
        toolCallId,
        settle: (answer) => {
          // The framework confirms the output reached the model; if it never does, speak it anyway.
          const fallback = setTimeout(() => {
            this.unconfirmed.delete(toolCallId);
            this.options.log?.warn('ask_agent: tool output never reached the model; speaking it as a new turn');
            void this.speak(this.answerInstructions(answer));
          }, this.options.confirmMs ?? TOOL_OUTPUT_CONFIRM_MS);
          fallback.unref?.();
          this.unconfirmed.set(toolCallId, { text: answer, timer: fallback });
          finish(this.answerInstructions(answer));
        },
        cancel: (value) => finish(value),
      };
      const onAbort = () => {
        // The execution is being cancelled (an interruption); the answer arrives later as a new turn.
        this.options.log?.info('ask_agent: execution aborted; its answer will be spoken when it arrives');
        finish('');
      };
      const timer = setTimeout(
        () => finish(`${this.options.agentName} has not answered yet. Tell the caller it is taking longer.`),
        this.options.answerWaitMs,
      );
      timer.unref?.();
      if (abortSignal?.aborted) return onAbort();
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
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
        const first = this.waiting.shift();
        if (!first) {
          void this.speak(this.answerInstructions(event.text));
          return;
        }
        first.settle(event.text);
        // A batched agent turn answers every open request at once; a timeout answers its own.
        if (!event.timedOut) {
          for (const other of this.waiting.splice(0)) {
            other.settle('(answered together with the previous request; nothing to add)');
          }
        }
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
        if (this.waiting.length === 0 || this.pendingSpeech > 0) return;
        if (this.session.userState === 'speaking' || this.session.agentState === 'speaking') return;
        void this.speak(
          `${this.options.agentName} is still working on it. Say one very short holding line such as "still on it", then wait.`,
        );
        return;
      default:
        return;
    }
  }

  /** Speak as a new turn once the session is idle; serialized so turns never supersede each other. */
  speak(instructions: string): Promise<void> {
    this.pendingSpeech++;
    const next = this.speaking.then(async () => {
      if (this.closed) return;
      try {
        await this.session.waitForIdle();
        if (this.closed) return;
        await this.session.generateReply({ instructions }).waitForPlayout();
      } catch (err) {
        this.options.log?.warn('voice bridge: could not speak a turn', err);
      } finally {
        this.pendingSpeech--;
      }
    });
    this.speaking = next;
    return next;
  }

  close(): void {
    this.closed = true;
    for (const waiting of this.waiting.splice(0)) waiting.cancel('The call is ending.');
    for (const pending of this.unconfirmed.values()) clearTimeout(pending.timer);
    this.unconfirmed.clear();
  }
}

export function parseJobMetadata(raw: string): LiveKitJobMetadata {
  const meta = JSON.parse(raw) as LiveKitJobMetadata;
  if (meta?.v !== 1 || !meta.callId || !meta.secret || !meta.hostUrl || !meta.callerIdentity) {
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

async function runCall(ctx: JobContext): Promise<void> {
  const logger = agentsLog();
  const meta = parseJobMetadata(ctx.job.metadata);
  const host = new HostLink(meta);
  // Read in the job process itself: secrets stay out of process.env and the worker's argv.
  const geminiKey = readEnvFile(['GEMINI_API_KEY']).GEMINI_API_KEY;
  const abandon = async (reason: string) => {
    logger.warn({ callId: meta.callId, reason }, 'voice worker: ending the call');
    await host.post('ended', { reason }).catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  if (!geminiKey) return abandon('GEMINI_API_KEY is not set for the worker');

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  try {
    await withTimeout(ctx.waitForParticipant(meta.callerIdentity), meta.joinTimeoutMs, 'caller never joined');
  } catch (err) {
    return abandon((err as Error).message);
  }
  const joined = await host.post('joined').catch(() => null);
  void joined?.body?.cancel();
  // The host starts billing here; without its yes, no Gemini session is opened.
  if (!joined?.ok) return abandon(`host refused the call (${joined?.status ?? 'unreachable'})`);

  const session = new voice.AgentSession({
    // Gemini's server VAD detects turns and barge-in; no local VAD process or turn detector.
    vad: null,
    turnHandling: { turnDetection: 'realtime_llm' },
    llm: new google.realtime.RealtimeModel(realtimeModelOptions(meta, geminiKey)),
  });
  const bridge = new CallBridge(session, host, {
    agentName: meta.agentName,
    // The host answers with the timeout line at delegationTimeoutMs; this is only a backstop.
    answerWaitMs: meta.delegationTimeoutMs + 15_000,
    log: {
      info: (msg: string) => logger.info({ callId: meta.callId }, msg),
      warn: (msg: string, err?: unknown) => logger.warn({ callId: meta.callId, err }, msg),
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
  const deadline = setTimeout(() => void end('duration limit (worker)', true), meta.maxDurationMs + 30_000);
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
        if (!ending) logger.warn({ callId: meta.callId, err }, 'voice worker: host link failed');
        return end('host link failed', true);
      },
    )
    .catch(() => undefined);
  session.generateReply({ instructions: 'The call just connected. Greet the caller briefly.' });
}

export default defineAgent({ entry: runCall });

// Imported by the job processes and by tests too; only the worker's own entrypoint runs the CLI.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = readEnvFile([
    'LIVEKIT_URL',
    'LIVEKIT_WORKER_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_AGENT_NAME',
  ]);
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.LIVEKIT_AGENT_NAME || 'nanoclaw-voice',
      wsURL: env.LIVEKIT_WORKER_URL || env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      // Health endpoint on loopback only; bl's 8081 is not reserved for this.
      host: '127.0.0.1',
      port: Number(process.env.VOICE_WORKER_HEALTH_PORT || 8089),
      numIdleProcesses: 1,
      // A restart waits this long for calls in progress (calls are capped at 15 minutes anyway).
      drainTimeout: 60_000,
      requestFunc: async (req) => {
        let name = '';
        try {
          name = parseJobMetadata(req.job.metadata).agentName;
        } catch {
          return req.reject();
        }
        await req.accept(name);
      },
    }),
  );
}
