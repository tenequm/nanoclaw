import type { Phase } from "./voice-call"

/**
 * Review mode on the page: what the caller sees and may press, worked out from the separate
 * models it is made of: the turn mode, the operation in flight, the worker's draft, the delivery
 * of the last sent draft and the agent's activity. Pure, so every state can be tested and shown
 * by the demo. The worker owns the draft (see CallReviewState in the protocol); the page only
 * shows it and asks. Auto mode's spoken commands (`send it`, the discard phrases, the wake switch)
 * ride on the same state, see `autoListening`.
 */

export type TurnMode = "auto" | "review"
export type ReviewOp = "mode" | "talk" | "done" | "send" | "discard"

/** The worker's draft: `recording` from talk to done, `finishing` while the transcription is flushed, then frozen. */
export interface Draft {
  id: number
  state: "recording" | "finishing" | "ready" | "empty" | "failed"
  text: string
  tooLong?: boolean
  /** Stopped without done: a reply took the channel (`agent`), or an open auto turn was switched (`switch`). */
  reason?: "agent" | "switch"
}

/** The worker's review state as it sends it; `seq` orders them. */
export interface ReviewSnapshot {
  seq: number
  mode: TurnMode
  draft: Draft | null
  /** The worker's transcription restarted after a draft and takes no audio yet; talk waits for it. */
  preparing?: boolean
  /**
   * Auto mode's wake switch as the worker runs it: `waiting` until it hears `hey <agent>`, or its
   * acoustic wake word's `phrase` when it has one.
   */
  wake?: { on: boolean; pauseSends: boolean; waiting: boolean; phrase?: string; heard?: number; slept?: number; cut?: boolean }
}

export function isReviewSnapshot(v: unknown): v is ReviewSnapshot {
  const s = v as ReviewSnapshot | null
  return !!s && typeof s.seq === "number" && (s.mode === "auto" || s.mode === "review") && (s.draft === null || typeof s.draft?.id === "number")
}

/** Everything the page knows about review mode, beside the call itself. */
export interface ReviewState {
  /** The mode in force: the caller's pick before a call, the worker's acknowledged one during it. */
  mode: TurnMode
  /** The worker offers review mode (before a call: assumed). */
  available: boolean
  /** The operation waiting for the worker's answer. */
  pending: { op: ReviewOp; to?: TurnMode } | null
  draft: Draft | null
  /** What the transcription shows of the open recording, not sent. */
  provisional: string
  /** The microphone actually captures (the track is unmuted). */
  micOn: boolean
  /** A start or stop of the microphone that did not take. */
  micError: "start" | "stop" | null
  /** A one-off line under the mode row: why a switch did not happen, or what it found. */
  note: string | null
  /** The last sent draft's delivery: on its way, or confirmed (for the "sent" hint). */
  delivery: "sending" | "sent" | "lost" | null
  /** The call ended with this draft unsent: it stays readable until discarded. */
  ended?: boolean
  /** The worker's transcription is getting ready after a draft (ReviewSnapshot.preparing). */
  preparing?: boolean
  /** The worker understands spoken commands (before a call: assumed). */
  commands: boolean
  /** The caller's wake switch: in auto nothing is sent until `hey <agent>`. Kept for the next call. */
  wake: boolean
  /** With the wake switch: a pause sends too after the wake phrase, not only `send it`. */
  pauseSends: boolean
  /** The worker waits for the wake phrase right now. */
  awaitingWake: boolean
  /** The phrase the worker's wake word listens for (`hey livekit`); null: `hey <agent>`. Kept for the next call. */
  wakePhrase: string | null
  /** How many times this call the worker heard the wake phrase (CallWakeState.heard); each one flashes the readout. */
  wakeHeard: number
  /** How many times this call an open turn went back to waiting with nothing more said (CallWakeState.slept). */
  wakeSlept: number
}

const WAKE_PHRASE_KEY = "voice-wake-phrase"

/** The wake phrase the worker named last time, so the page names it before this call's worker does. */
export function storedWakePhrase(): string | null {
  try {
    return localStorage.getItem(WAKE_PHRASE_KEY) || null
  } catch {
    return null
  }
}

/** Remember the worker's wake phrase for the next page load; null: `hey <agent>`. */
export function storeWakePhrase(phrase: string | null): void {
  try {
    if (phrase) localStorage.setItem(WAKE_PHRASE_KEY, phrase)
    else localStorage.removeItem(WAKE_PHRASE_KEY)
  } catch {
    // Storage off (a private window): the next load names `hey <agent>` until the worker says.
  }
}

export const INITIAL_REVIEW: ReviewState = {
  mode: "auto",
  available: true,
  pending: null,
  draft: null,
  provisional: "",
  micOn: false,
  micError: null,
  note: null,
  delivery: null,
  commands: true,
  wake: false,
  pauseSends: false,
  awaitingWake: false,
  wakePhrase: null,
  wakeHeard: 0,
  wakeSlept: 0,
}

/** What a key does when pressed. */
export type KeyAction = "call" | "cancel" | "end" | "discard" | "talk" | "done" | "send"

export interface KeyView {
  label: string
  action: KeyAction
  disabled: boolean
}

/**
 * What a key does, for the page's re-arm guard (a key that just changed what it does ignores taps
 * for a moment): every hang-up is one thing, so the end key never fades when it keeps ending the
 * call (cancel becoming end as the call connects, auto's end becoming review's); any other key is
 * its action on its draft, so a double tap on discard cannot end the call.
 */
export function keyIdentity(action: KeyAction | null, draftId?: number): string {
  if (action === "cancel" || action === "end") return "hangup"
  return action === null ? "none" : `${action}:${draftId ?? ""}`
}

export type PanelTone = "hearing" | "finishing" | "draft" | "empty" | "failed" | "long"

export interface PanelView {
  /** The panel's header: the draft's lifecycle, announced once per change. */
  title: string
  text: string
  tone: PanelTone
  /** A second line under the header (why it stopped, or that the text is unverified). */
  note?: string
}

export interface ReviewView {
  left: KeyView
  right: KeyView
  chip: string
  /** `you`: the caller's words are being taken; `off`: the line waits on the caller (mic muted). */
  chipTone: "idle" | "you" | "off" | "think" | "ended" | "err" | ""
  hint: string
  /** The right key's label row: the microphone's actual state. */
  mic: string
  /** The microphone captures right now (its LED, and the level meter). */
  capturing: boolean
  panel: PanelView | null
  /** The switch is off while an operation settles, the line reconnects or a transcript finishes. */
  modeDisabled: boolean
}

export interface ReviewInput {
  phase: Phase
  agentName: string
  reconnecting: boolean
  /** Seconds the agent has been working, for the thinking hint. */
  waited: number
  review: ReviewState
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

/** The host takes a turn of at most this many UTF-8 bytes (MAX_TURN_TEXT_BYTES in the protocol). */
const MAX_TURN_BYTES = 8 * 1024

/** How many characters a draft has to lose to fit the host's limit (0 when it fits). */
export function charsOver(text: string): number {
  const enc = new TextEncoder()
  let bytes = enc.encode(text).length
  if (bytes <= MAX_TURN_BYTES) return 0
  const chars = [...text]
  let n = 0
  while (bytes > MAX_TURN_BYTES && n < chars.length) bytes -= enc.encode(chars[chars.length - 1 - n++]).length
  return n
}

/** The panel for a draft, or for the words being heard. */
export function panelView(review: ReviewState, agentName: string): PanelView | null {
  const d = review.draft
  if (!d) return null
  const why = d.reason === "agent" ? `${agentName} started speaking - review what was heard` : undefined
  if (d.state === "recording") return { title: "hearing - not sent", text: review.provisional, tone: "hearing" }
  if (d.state === "finishing") return { title: "finishing transcript", text: review.provisional, tone: "finishing", note: why }
  if (d.state === "empty") return { title: "nothing heard", text: "", tone: "empty", note: why }
  if (d.state === "failed") return { title: "couldn't finish transcript", text: d.text, tone: "failed", note: "unverified - not sendable" }
  if (d.tooLong) {
    const over = charsOver(d.text)
    return { title: "draft too long", text: d.text, tone: "long", note: over ? `about ${over} characters over the limit` : why }
  }
  return { title: "draft - not sent", text: d.text, tone: "draft", note: why }
}

const key = (label: string, action: KeyAction, disabled = false): KeyView => ({ label, action, disabled })

/** Why auto has to wait: what the caller does first. */
const BLOCKED = {
  recording: "Tap done, then send or discard.",
  finishing: "Finishing transcript.",
  sendable: "Send or discard before auto.",
  unsendable: "Discard before auto.",
} as const

/** Why the caller cannot leave review for auto right now, or null when they can. */
export function autoBlock(review: ReviewState): string | null {
  const d = review.draft
  if (!d) return null
  if (d.state === "recording") return BLOCKED.recording
  if (d.state === "finishing") return BLOCKED.finishing
  return d.state === "ready" && !d.tooLong ? BLOCKED.sendable : BLOCKED.unsendable
}

/**
 * Keys, readout and panel for a call in review mode (or switching to or from it): the caller's
 * state first, then the overlays (connection, agent speaking or working, a switch in flight,
 * microphone failures). SKILL.md's review mode section describes the flow.
 */
export function reviewView({ phase, agentName, reconnecting, waited, review }: ReviewInput): ReviewView {
  const d = review.draft
  const panel = panelView(review, agentName)
  const pending = review.pending
  const live = phase === "listening" || phase === "thinking" || phase === "talking"
  const sendable = !!d && d.state === "ready" && !d.tooLong && review.micError !== "stop"

  if (!live) {
    const kept = d && review.ended
    const left =
      phase === "connecting"
        ? key("Cancel", "cancel")
        : kept
          ? key("Discard", "discard")
          : key(phase === "ended" || phase === "error" ? "Call again" : "Call", "call")
    return {
      left,
      right: kept && d.state !== "empty" ? key("Send", "send", true) : key("Talk", "talk", true),
      chip: phase === "connecting" ? "Connecting…" : phase === "ended" ? "Call ended" : phase === "error" ? "" : "Ready",
      chipTone: phase === "ended" ? "ended" : phase === "error" ? "err" : phase === "idle" ? "idle" : "",
      hint: kept
        ? "Draft not sent. Copy it, or discard it to call again."
        : phase === "connecting"
          ? "Setting up the call."
          : phase === "idle"
            ? "Call first, then tap talk."
            : "",
      mic: "Mic off",
      capturing: false,
      panel: kept ? panel : null,
      modeDisabled: phase === "connecting" || !!kept,
    }
  }

  // The caller's own state.
  let left = key("End", "end")
  let right = key("Talk", "talk")
  let chip = "Mic muted"
  let tone: ReviewView["chipTone"] = "off"
  let hint = "Tap talk to start."
  let mic = review.micOn ? "Mic on" : "Mic off"
  const capturing = !!d && d.state === "recording" && review.micOn

  if (pending?.op === "talk") {
    right = key("Talk", "talk", true)
    chip = "Starting mic"
    hint = "Wait before speaking."
    mic = "Starting mic"
  } else if (pending?.op === "discard") {
    left = key("Discard", "discard", true)
    right = key("Talk", "talk", true)
    chip = "Discarding"
    hint = "Mic off - please wait."
  } else if (pending?.op === "send") {
    right = key("Talk", "talk", true)
    chip = "Sending"
    hint = "Mic off - waiting for confirmation."
  } else if (d?.state === "recording") {
    right = key("Done", "done", pending?.op === "done")
    chip = "Listening"
    tone = "you"
    hint = "Pausing won't send - tap done to read it."
    mic = review.micOn ? "Recording" : pending?.op === "done" ? "Stopping mic" : "Mic off"
  } else if (d?.state === "finishing") {
    left = key("Discard", "discard")
    right = key("Send", "send", true)
    chip = "Finishing transcript"
    hint = "Mic off - nothing sent."
  } else if (d?.state === "empty") {
    left = key("Discard", "discard")
    chip = "Nothing heard"
    hint = "Nothing heard - tap talk to retry."
  } else if (d?.state === "failed") {
    left = key("Discard", "discard")
    right = key("Send", "send", true)
    chip = "Transcript failed"
    tone = "err"
    hint = "Couldn't finish transcript - discard and try again."
  } else if (d?.tooLong) {
    left = key("Discard", "discard")
    right = key("Send", "send", true)
    chip = "Draft too long"
    tone = "err"
    hint = "Discard and try a shorter turn."
  } else if (d) {
    left = key("Discard", "discard")
    right = key("Send", "send", !sendable)
    chip = "Review draft"
    hint = "Check the words, then send."
  } else if (review.delivery === "sending") {
    chip = "Sending"
    hint = "Mic off - waiting for confirmation."
  } else if (review.delivery === "sent") {
    hint = "Sent - tap talk for another turn."
  }

  // The agent's activity: its own chip, and talk waits for its speech to end.
  if (phase === "talking") {
    chip = `${agentName} is speaking`
    tone = ""
    if (right.action === "talk") right = { ...right, disabled: true }
    if (!d || d.state === "empty") hint = `Tap talk when ${agentName} finishes.`
    else if (sendable) hint = `You can send it now; ${agentName} gets it next.`
  } else if (phase === "thinking") {
    chip = `${agentName} is working`
    tone = "think"
    if (!d && !pending) hint = `Tap talk to add more · waiting ${clock(waited)}`
    else if (d?.state === "recording") hint = "Recording - tap done to read it."
    else if (sendable) hint = `You can send it now; ${agentName} gets it next.`
  }

  // The worker restarts its transcription after a draft; talk opens once it takes audio again, so
  // the first words are not lost. The worker holds a talk until then too (at most a few seconds).
  if (review.preparing && right.action === "talk" && !pending) {
    right = { ...right, disabled: true }
    if (phase === "listening") {
      chip = "Getting ready"
      tone = ""
      hint = "Talk opens in a moment."
    } else if (phase === "thinking") hint = "Talk opens in a moment."
  }

  // A switch in flight: the last acknowledged mode stays, nothing else can start.
  if (pending?.op === "mode") {
    chip = pending.to === "review" ? "Switching to review" : "Switching to auto"
    tone = ""
    left = d ? key("Discard", "discard", true) : key("End", "end")
    right = { ...right, disabled: true }
    hint = review.micOn ? "Please wait." : "Mic off - please wait."
  }

  // The microphone did not do what was asked: say so, never claim it is off.
  if (review.micError === "start") {
    hint = "Mic didn't start - tap talk to retry."
    mic = "Mic off"
  } else if (review.micError === "stop") {
    hint = "Mic couldn't stop - end call to stop capture."
    mic = "Mic still on"
    if (right.action === "send") right = { ...right, disabled: true }
  }

  if (reconnecting) {
    chip = "Reconnecting…"
    tone = ""
    hint = "Wait before speaking."
    left = d ? key("Discard", "discard", true) : key("End", "end")
    right = { ...right, disabled: true }
  }

  return {
    left,
    right,
    chip,
    chipTone: tone,
    hint,
    mic,
    capturing,
    panel,
    modeDisabled: reconnecting || !!pending || d?.state === "finishing",
  }
}

/** The worker's error for a refused operation, as the caller's next step. */
export function refusalNote(error: string | undefined, agentName: string): string | null {
  if (error === "recording") return BLOCKED.recording
  if (error === "finishing") return BLOCKED.finishing
  if (error === "draft_open") return BLOCKED.sendable
  if (error === "agent_speaking") return `Tap talk when ${agentName} finishes.`
  return null
}

/** Turn modes as the page names them; the protocol keeps `auto` and `review`. */
export const MODE_NAME: Record<TurnMode, string> = { auto: "hands-free", review: "check first" }

/** What each mode does, in one line under the switch. */
export function modeCaption(mode: TurnMode, commands: boolean): string {
  if (mode === "review") return "Tap talk, read your words, then send."
  return commands ? `Stop for a moment, or say "send it", to send.` : "Stop for a moment to send."
}

/**
 * The `nanoclaw.voice.commands` value of the worker whose words these are (CALL_COMMANDS_VERSION):
 * "1" had `over` as the send word, so the page offers commands to this vocabulary's worker only.
 */
export const COMMANDS_VERSION = "2"

/**
 * The page's own copy of the worker's send words, then its discard phrases, as `norm` leaves them
 * (lowercase, letters and digits only, Cyrillic kept as is). A caption line that ends in one holds
 * that command. The channel tests check each one against the worker's own matching.
 */
export const SEND_WORDS = ["sendit", "sentit", "sendeat", "send", "сендіт", "сендит", "сендіп", "сендип", "сенд", "прийом", "приём"]
export const DISCARD_PHRASES = ["discardthisturn", "discardturn", "scratchthat"]
const COMMAND_END = new RegExp(`(${[...SEND_WORDS, ...DISCARD_PHRASES].join("|")})$`, "u")
const DISCARD_END = new RegExp(`(${DISCARD_PHRASES.join("|")})$`, "u")

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
/** A caption line as a sent turn's text holds it: a spoken command that ended the turn is not sent. */
export const lineKey = (s: string) => norm(s).replace(COMMAND_END, "")
/** A caption line that is only a spoken command ("Send it."), with nothing else said. */
export const isCommandOnly = (s: string) => norm(s) !== "" && lineKey(s) === ""
/** A caption line that ends in a discard phrase ("Scratch that."). */
export const endsInDiscard = (s: string) => DISCARD_END.test(norm(s))

export interface ListeningView {
  chip: string
  hint: string
  /** The transcript's line while it is empty. */
  empty: string
}

/** The phrase that opens a turn with the wake switch on. */
export function wakePhraseOf(review: ReviewState, agentName: string): string {
  return review.wakePhrase ?? `hey ${agentName}`
}

/**
 * Auto mode's readout while it listens with the microphone on: what sends a turn, and with the wake
 * switch on, the phrase that opens one. A worker without spoken commands keeps the plain pause copy.
 */
export function autoListening({ agentName, review }: { agentName: string; review: ReviewState }): ListeningView {
  // The send countdown shows how long the pause is; the copy never quotes seconds.
  if (!review.commands) return { chip: "Listening", hint: "Go ahead. Stop for a moment to send.", empty: "Speak when ready." }
  const wakePhrase = `"${wakePhraseOf(review, agentName)}"`
  if (!review.wake) return { chip: "Listening", hint: `Go ahead. Stop for a moment, or say "send it" to send now.`, empty: "Speak when ready." }
  if (review.awaitingWake) return { chip: `Say ${wakePhrase}`, hint: `Nothing is sent until you say ${wakePhrase}.`, empty: `Say ${wakePhrase} to start.` }
  return {
    chip: "Listening",
    hint: review.pauseSends ? `Say "send it", or stop for a moment, to send.` : `Say "send it" to send - stopping won't.`,
    empty: "Speak when ready.",
  }
}
