import type { ReviewState, TurnMode } from "./review"

/**
 * The shape of a call as the page renders it, shared by the LiveKit hook and the
 * `?demo=1` script, plus the LiveKit hook's error and level helpers.
 */

export type Phase = "idle" | "connecting" | "listening" | "thinking" | "talking" | "ended" | "error"
export type Speaker = "user" | "assistant"
export interface Line {
  id: number
  from: Speaker
  text: string
  /** Seconds into the call when the turn started. */
  at: number
  /** Whether this caller turn reached the agent. */
  mark?: TurnMark
  /** The caller turn's number on this page, counted from when the turn closed. */
  turn?: number
  /** What an agent line answers ("re: turn 2", "unprompted"), on the first line of a message. */
  re?: string
  /** The spoken message an agent line belongs to; one message's lines read as one. */
  group?: number
}

/** The caller stopped and the turn goes out once this runs full, unless they speak again. */
export interface SendCue {
  id: string
  /** How much of the silence had passed when the worker said so, 0..1. */
  from: number
  /** What is left of it. */
  ms: number
}

export interface TurnMark {
  /** `sending`: a sent review draft the agent has not confirmed yet (auto turns show no mark until then). */
  status: "sending" | "sent" | "lost"
  reason?: "stt" | "rejected" | "rate_limited" | "timeout" | "empty"
}

/** What kind of problem ended a call, so the page can say what to do about it. */
export type ErrorKind = "mic-permission" | "mic" | "link" | "limit" | "offline" | "updating" | "other"

/** An error whose message is already in a caller's words, with its kind. */
export class CallError extends Error {
  readonly kind: ErrorKind
  constructor(message: string, kind: ErrorKind) {
    super(message)
    this.kind = kind
  }
}

export interface VoiceCall {
  phase: Phase
  lines: Line[]
  /** Id of the line still receiving transcript, if any. */
  streamingId: number | null
  agentName: string
  elapsed: number
  muted: boolean
  /** Human-readable problem when phase is "error". */
  error: string | null
  /** What kind of problem `error` is. */
  errorKind?: ErrorKind | null
  /** Why the last call ended, for the readout. */
  endedText: string | null
  /** The caller's microphone and the agent's audio, for visualisers that analyse a stream. */
  micStream: MediaStream | null
  remoteStream: MediaStream | null
  start: () => void
  end: () => void
  toggleMute: () => void
  /** Smoothed 0..1 levels, updated every frame; read them from a rAF loop, they never re-render. */
  inputLevel: React.RefObject<number>
  outputLevel: React.RefObject<number>
  audioRef: React.RefObject<HTMLAudioElement | null>
  /** The chat the call talks in, as the host names it. */
  chat?: string | null
  /** The browser holds the agent's audio until the caller allows it. */
  audioBlocked?: boolean
  /** Lets the held audio play; call it from a tap. */
  unlockAudio?: () => void
  /** The room lost its connection and is trying to get it back. */
  reconnecting?: boolean
  /** The last mute or unmute did not take, in a few words. */
  muteError?: string | null
  /** The silence that sends a turn, from the host. */
  silenceMs?: number | null
  /** A caller turn counting down to being sent. */
  sendCue?: SendCue | null
  /** The call is about to hit its time limit. */
  limitNote?: string | null
  /** Review mode: its state and the caller's operations on it. */
  review?: ReviewControls
}

export interface ReviewControls {
  state: ReviewState
  setMode: (mode: TurnMode) => void
  talk: () => void
  done: () => void
  send: () => void
  discard: () => void
}

export const LIVE_PHASES: ReadonlySet<Phase> = new Set(["listening", "thinking", "talking"])

export const PAGE_CLOSED = "The call ended when the page was closed."

/**
 * The call's sound cues, for a caller who is not looking at the screen: `listening` once the
 * worker hears the caller (in review: once talk opened the microphone), `sent` the moment a turn
 * closes, `working` once the agent has picked that turn up, `turn` when the agent is done and the
 * microphone is open again, `draft` when a review draft is ready to read.
 */
export type Cue = "listening" | "sent" | "working" | "turn" | "draft"

/** Each cue's notes as [Hz, start s, length s], and their peak gain. */
const CUES: Record<Cue, { notes: ReadonlyArray<readonly [hz: number, at: number, len: number]>; peak: number }> = {
  // A rising fifth: the line is open.
  listening: { notes: [[784, 0, 0.09], [1175, 0.1, 0.11]], peak: 0.22 },
  // One short high tick: the turn is on its way.
  sent: { notes: [[1760, 0, 0.06]], peak: 0.3 },
  // Two soft taps on one note, quieter than the tick: the agent has it and is working.
  working: { notes: [[698, 0, 0.05], [698, 0.14, 0.05]], peak: 0.13 },
  // A falling third, like a doorbell: over to the caller.
  turn: { notes: [[1319, 0, 0.09], [1047, 0.11, 0.12]], peak: 0.22 },
  // Two soft low notes, quieter than the rest: words to read, nothing sent.
  draft: { notes: [[523, 0, 0.08], [659, 0.1, 0.1]], peak: 0.14 },
}

/** After a reply, the "your turn" cue waits this long for the next queued line to show up. */
export const TURN_CUE_DELAY_MS = 600

/** How long a cue waits for a suspended or interrupted context to run again; past it the cue is stale. */
const CUE_RESUME_MS = 800

type ContextState = "running" | "suspended" | "interrupted" | "closed" | "none"

/**
 * What became of one cue (`cue` set), or (`cue` absent) the audio context changing state; the
 * page sends each to the worker's log (`CueReport` in the protocol). Fixed values only.
 */
export interface CueReport {
  cue?: Cue
  result?: "played" | "skipped"
  reason?: "talking" | "off" | "no-context" | "suspended" | "interrupted" | "closed" | "resume-failed"
  ctx: ContextState
  out?: "element" | "direct"
  resumed?: "suspended" | "interrupted"
  hidden?: true
}

/** An iPhone or iPad: an iPad's Safari says MacIntel, with touch. */
export function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

const stateOf = (ctx: AudioContext | null): ContextState => (ctx ? (ctx.state as ContextState) : "none")

/**
 * The cues' sound, on one context unlocked by the tap that starts the call. Short pure sine notes,
 * mid-to-high so a phone speaker carries them; nothing with `?cues=0`.
 *
 * On iOS the cues go out as a media stream through their own audio element, not straight to the
 * context's speaker output: while the microphone is captured, iOS Safari turns down Web Audio and
 * other non-MediaStream audio, and only MediaStreamTrack audio (the agent's voice) keeps its level
 * (WebKit bug 236219). `?cueout=element` or `?cueout=direct` picks the path anywhere; when the
 * element is not playing, a cue goes straight out.
 *
 * iOS also suspends or interrupts a running context on its own (a call, Siri, the screen): a cue
 * then asks it to resume and plays only if it runs again within CUE_RESUME_MS, since notes
 * scheduled on a frozen context would all sound at once when it thaws. Any tap on the page and the
 * page coming back into view resume it too. `report` hears every cue and every state change.
 */
export class CuePlayer {
  private ctx: AudioContext | null = null
  private sink: MediaStreamAudioDestinationNode | null = null
  private el: HTMLAudioElement | null = null
  private state: ContextState = "none"
  private readonly report: (r: CueReport) => void

  constructor(report: (r: CueReport) => void = () => {}) {
    this.report = report
  }

  /** In the tap that starts the call, before any await: iOS unlocks audio output only on a gesture. */
  unlock(): void {
    if (!this.ctx || this.ctx.state === "closed") {
      this.close()
      try {
        this.ctx = new AudioContext()
      } catch {
        this.ctx = null
        return
      }
      this.ctx.addEventListener("statechange", this.onStateChange)
      document.addEventListener("visibilitychange", this.wake)
      document.addEventListener("pointerdown", this.wake, true)
      if (cueOutput() === "element") this.openElement(this.ctx)
    }
    const ctx = this.ctx
    void ctx.resume().catch(() => {})
    // Older iOS only unlocks output once a source has started inside the gesture.
    try {
      const src = ctx.createBufferSource()
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
      src.connect(ctx.destination)
      src.start()
    } catch {
      /* the resume above is the unlock */
    }
    void this.el?.play().catch(() => {})
    // The context's first state, for the log: whether the unlock took.
    this.onStateChange()
  }

  /**
   * Play a cue now, or say why not. `blocked` is the caller's own reason not to (the agent is
   * speaking), asked again before a cue that waited for its context.
   */
  play(cue: Cue, blocked: () => "talking" | undefined = () => undefined): void {
    const ctx = this.ctx
    const done = (r: Pick<CueReport, "result" | "reason" | "resumed">) => this.report(this.describe({ cue, ...r }))
    const skip = blocked()
    if (skip) return done({ result: "skipped", reason: skip })
    if (new URLSearchParams(location.search).get("cues") === "0") return done({ result: "skipped", reason: "off" })
    if (!ctx) return done({ result: "skipped", reason: "no-context" })
    if (ctx.state === "running") {
      this.sound(ctx, cue)
      return done({ result: "played" })
    }
    if (ctx.state === "closed") return done({ result: "skipped", reason: "closed" })
    const from = ctx.state === "interrupted" ? "interrupted" : "suspended"
    const resumed = ctx.resume().then(
      () => true,
      () => false
    )
    const late = new Promise<null>((r) => window.setTimeout(() => r(null), CUE_RESUME_MS))
    void Promise.race([resumed, late]).then((ok) => {
      if (ok === false) return done({ result: "skipped", reason: "resume-failed" })
      if (this.ctx !== ctx || ctx.state !== "running") return done({ result: "skipped", reason: ctx.state === "closed" ? "closed" : from })
      const now = blocked()
      if (now) return done({ result: "skipped", reason: now })
      this.sound(ctx, cue)
      done({ result: "played", resumed: from })
    })
  }

  close(): void {
    document.removeEventListener("visibilitychange", this.wake)
    document.removeEventListener("pointerdown", this.wake, true)
    if (this.el) {
      this.el.pause()
      this.el.srcObject = null
      this.el.remove()
      this.el = null
    }
    this.sink = null
    this.state = "none"
    const ctx = this.ctx
    this.ctx = null
    if (ctx) {
      ctx.removeEventListener("statechange", this.onStateChange)
      void ctx.close().catch(() => {})
    }
  }

  private openElement(ctx: AudioContext) {
    try {
      const sink = ctx.createMediaStreamDestination()
      const el = document.createElement("audio")
      el.setAttribute("playsinline", "")
      el.className = "sr-only"
      el.srcObject = sink.stream
      document.body.append(el)
      this.sink = sink
      this.el = el
    } catch {
      this.sink = null
      this.el = null
    }
  }

  private output(): "element" | "direct" {
    return this.sink && this.el && !this.el.paused ? "element" : "direct"
  }

  private describe(r: Omit<CueReport, "ctx">): CueReport {
    return {
      ...r,
      ctx: stateOf(this.ctx),
      ...(this.ctx ? { out: this.output() } : {}),
      ...(document.visibilityState === "hidden" ? { hidden: true as const } : {}),
    }
  }

  private sound(ctx: AudioContext, cue: Cue) {
    const out: AudioNode = this.output() === "element" && this.sink ? this.sink : ctx.destination
    const { notes, peak } = CUES[cue]
    for (const [hz, at, len] of notes) {
      const t = ctx.currentTime + at
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(peak, t + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len)
      osc.connect(gain).connect(out)
      osc.start(t)
      osc.stop(t + len + 0.01)
    }
  }

  // iOS can stop the context (or the element) on its own; a tap or the page coming back starts them again.
  private readonly wake = () => {
    if (document.visibilityState === "hidden") return
    const ctx = this.ctx
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => {})
    if (this.el?.paused) void this.el.play().catch(() => {})
  }

  private readonly onStateChange = () => {
    const ctx = this.ctx
    const now = stateOf(ctx)
    if (now === this.state) return
    this.state = now
    this.report(this.describe({}))
    // A hidden page is left alone; `wake` resumes it once it shows again.
    if (ctx && (now === "suspended" || now === "interrupted") && document.visibilityState !== "hidden") void ctx.resume().catch(() => {})
  }
}

/** Where cues play: `?cueout=element|direct`, else through an element on iOS (see CuePlayer). */
function cueOutput(): "element" | "direct" {
  const param = new URLSearchParams(location.search).get("cueout")
  if (param === "element" || param === "direct") return param
  return isAppleMobile() ? "element" : "direct"
}

export function statusErrorKind(status: number): ErrorKind {
  if (status === 403) return "link"
  if (status === 429) return "limit"
  if (status === 503) return "offline"
  return "other"
}

export function errorText(status: number, body: string): string {
  if (status === 403) return "This call link is not valid."
  if (status === 429) return "This line has reached its hourly call limit. Try again later."
  if (status === 503) return "The voice line is offline right now."
  if (status === 502) return `Could not start the call. ${body}`
  return `Could not start the call (HTTP ${status}).`
}

/**
 * Why the caller's own level comes from `getStats()` and not from a Web Audio
 * analyser: on iOS Safari, tapping a captured microphone stream with
 * `createMediaStreamSource` starves the same track on the peer connection, so
 * the agent receives silence while the page still looks connected. The sender's
 * `media-source` report gives the same number with nothing attached to the track.
 */
export function levelsFromStats(report: RTCStatsReport): { mic: number | null; agent: number | null } {
  let mic: number | null = null
  let agent: number | null = null
  report.forEach((entry) => {
    const s = entry as { type?: string; audioLevel?: unknown }
    // Only audio reports carry audioLevel, so its presence is the test. Safari
    // omits `kind` on media-source, and requiring it left the caller's own
    // meter reading zero for the whole call on iOS.
    if (typeof s.audioLevel !== "number") return
    if (s.type === "media-source" || s.type === "outbound-rtp") mic = s.audioLevel
    else if (s.type === "inbound-rtp" || s.type === "remote-outbound-rtp") agent = s.audioLevel
  })
  return { mic, agent }
}

/** What went wrong reaching the microphone, in words a caller can act on. */
export function micErrorText(err: unknown): string | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return location.protocol === "https:" || location.hostname === "localhost"
      ? "This browser will not give a page access to the microphone."
      : "A browser only shares the microphone over a secure connection. This link needs to start with https."
  }
  const name = err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was refused."
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone is available on this device."
  if (name === "NotReadableError") return "The microphone is busy in another app. Close it and try again."
  return null
}

export function micErrorKind(err: unknown): ErrorKind | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "mic"
  const name = err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-permission"
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "mic"
  return null
}
