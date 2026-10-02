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
  status: "sent" | "lost"
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
}

export const LIVE_PHASES: ReadonlySet<Phase> = new Set(["listening", "thinking", "talking"])

export const PAGE_CLOSED = "The call ended when the page was closed."

/**
 * The call's sound cues, for a caller who is not looking at the screen: `listening` once the
 * worker hears the caller, `sent` the moment a turn closes, `turn` when the agent is done and the
 * microphone is open again.
 */
export type Cue = "listening" | "sent" | "turn"

/** Each cue's notes as [Hz, start s, length s], and their peak gain. */
const CUES: Record<Cue, { notes: ReadonlyArray<readonly [hz: number, at: number, len: number]>; peak: number }> = {
  // A rising fifth: the line is open.
  listening: { notes: [[784, 0, 0.09], [1175, 0.1, 0.11]], peak: 0.22 },
  // One short high tick: the turn is on its way.
  sent: { notes: [[1760, 0, 0.06]], peak: 0.3 },
  // A falling third, like a doorbell: over to the caller.
  turn: { notes: [[1319, 0, 0.09], [1047, 0.11, 0.12]], peak: 0.22 },
}

/** After a reply, the "your turn" cue waits this long for the next queued line to show up. */
export const TURN_CUE_DELAY_MS = 600

/**
 * Plays a cue on the gesture-unlocked context; nothing without one that runs, or when the link
 * says `?cues=0`. Short pure sine notes, mid-to-high so a phone speaker carries them.
 */
export function playCue(ctx: AudioContext | null, cue: Cue) {
  if (!ctx || ctx.state !== "running" || new URLSearchParams(location.search).get("cues") === "0") return
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
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + len + 0.01)
  }
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
