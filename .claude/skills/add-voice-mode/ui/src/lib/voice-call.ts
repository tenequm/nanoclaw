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
  /** What an agent line answers ("reply to turn 2", "unprompted"), on the first line of a message. */
  re?: string
  /** The spoken message an agent line belongs to; one message's lines read as one. */
  group?: number
  /** The worker heard the wake phrase as this caller line was spoken (or just before it). */
  wake?: boolean
  /**
   * The line is the wake phrase alone: the worker restarted its transcription right after it, so
   * the line is no part of any turn and never carries a turn's mark.
   */
  wakeOnly?: boolean
  /** The line opens with words said before the wake phrase, which the worker ignored. */
  preWake?: boolean
  /** A caller line the transcription may still revise: shown dimmed until its final text. */
  interim?: boolean
  /** An agent line the worker could not speak: its text, shown instead of heard. */
  unspoken?: boolean
  /** Not a caption: the page's own note, `unheard` when the caller spoke over the agent. */
  kind?: "unheard"
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
  /**
   * `sending`: a sent review draft the agent has not confirmed yet (auto turns show no mark until then).
   * `dropped`: words the worker will never send: a spoken discard, speech before the wake phrase, or
   * a spoken command said alone, with nothing open to act on (`command`), or words held by a turn the
   * wake phrase opened that heard nothing more for too long (`asleep`).
   */
  status: "sending" | "sent" | "lost" | "dropped"
  reason?: "stt" | "rejected" | "rate_limited" | "timeout" | "empty" | "discarded" | "unaddressed" | "command" | "asleep"
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
  /** Where the worker's sound cues play: their own track, apart from the agent's speech. */
  cueAudioRef?: React.RefObject<HTMLAudioElement | null>
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
  /** Auto mode's wake switch, and whether a pause sends after the wake phrase. */
  setWake: (on: boolean) => void
  setPauseSends: (on: boolean) => void
  /** The typing sound while the agent works. */
  setTyping: (on: boolean) => void
}

export const LIVE_PHASES: ReadonlySet<Phase> = new Set(["listening", "thinking", "talking"])

export const PAGE_CLOSED = "The call ended when the page was closed."

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
  if (name === "NotSupportedError" || name === "AbortError") return "This browser could not open the microphone."
  return null
}

export function micErrorKind(err: unknown): ErrorKind | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "mic"
  const name = err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-permission"
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError" || name === "NotSupportedError" || name === "AbortError") return "mic"
  return null
}
