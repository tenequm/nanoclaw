/**
 * Review mode on the page: what the caller sees and may press, worked out from the separate
 * models it is made of: the turn mode, the operation in flight, the worker's draft, the delivery
 * of the last sent draft and the agent's activity. Pure, so every state can be tested and shown
 * by the demo. The worker owns the draft (see CallReviewState in the protocol); the page only
 * shows it and asks.
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
}

/** What a key does when pressed. */
export type KeyAction = "call" | "cancel" | "end" | "discard" | "talk" | "done" | "send" | "none"

export interface KeyView {
  label: string
  action: KeyAction
  disabled: boolean
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
  chipTone: "idle" | "you" | "think" | "ended" | "err" | ""
  hint: string
  /** The right key's label row: the microphone's actual state. */
  mic: string
  /** The microphone captures right now (its LED, and the level meter). */
  capturing: boolean
  panel: PanelView | null
  /** Whether the caller may pick the other mode now; a pick refused by `modeBlock` shows that reason. */
  modeDisabled: boolean
  modeBlock: string | null
}

export interface ReviewInput {
  phase: "idle" | "connecting" | "listening" | "thinking" | "talking" | "ended" | "error"
  agentName: string
  reconnecting: boolean
  /** Seconds the agent has been working, for the thinking hint. */
  waited: number
  review: ReviewState
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

/** The panel for a draft, or for the words being heard. */
export function panelView(review: ReviewState, agentName: string): PanelView | null {
  const d = review.draft
  if (!d) return null
  const why = d.reason === "agent" ? `${agentName} started speaking - review what was heard` : undefined
  if (d.state === "recording") return { title: "hearing - not sent", text: review.provisional, tone: "hearing" }
  if (d.state === "finishing") return { title: "finishing transcript", text: review.provisional, tone: "finishing", note: why }
  if (d.state === "empty") return { title: "nothing heard", text: "", tone: "empty", note: why }
  if (d.state === "failed") return { title: "couldn't finish transcript", text: d.text, tone: "failed", note: "unverified - not sendable" }
  if (d.tooLong) return { title: "draft too long", text: d.text, tone: "long", note: why }
  return { title: "draft - not sent", text: d.text, tone: "draft", note: why }
}

const key = (label: string, action: KeyAction, disabled = false): KeyView => ({ label, action, disabled })

/** Why the caller cannot leave review for auto right now, or null when they can. */
export function autoBlock(review: ReviewState): string | null {
  const d = review.draft
  if (!d) return null
  if (d.state === "recording") return "Tap done, then send or discard."
  if (d.state === "finishing") return "Finishing transcript."
  if (d.state === "ready" && !d.tooLong) return "Send or discard before auto."
  return "Discard before auto."
}

/**
 * Keys, readout and panel for a call in review mode (or switching to or from it), by the state
 * tables of the review mode design: the caller's state first, then the overlays (connection,
 * agent speaking or working, a switch in flight, microphone failures).
 */
export function reviewView({ phase, agentName, reconnecting, waited, review }: ReviewInput): ReviewView {
  const d = review.draft
  const panel = panelView(review, agentName)
  const pending = review.pending
  const live = phase === "listening" || phase === "thinking" || phase === "talking"
  const frozen = d && d.state !== "recording" && d.state !== "finishing"
  const sendable = !!d && d.state === "ready" && !d.tooLong && review.micError !== "stop"
  const block = autoBlock(review)

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
      right: key(kept && d.state !== "empty" ? "Send" : "Talk", "none", true),
      chip: phase === "connecting" ? "Connecting…" : phase === "ended" ? "Call ended" : phase === "error" ? "" : "Ready",
      chipTone: phase === "ended" ? "ended" : phase === "error" ? "err" : phase === "idle" ? "idle" : "",
      hint: kept
        ? "Call ended - draft not sent. Discard it to call again."
        : phase === "connecting"
          ? "Setting up the call."
          : phase === "idle"
            ? "Call first, then tap talk."
            : "",
      mic: "Mic off",
      capturing: false,
      panel: kept ? panel : null,
      modeDisabled: phase === "connecting" || !!kept,
      modeBlock: null,
    }
  }

  // The caller's own state.
  let left = key("End", "end")
  let right = key("Talk", "talk")
  let chip = "Mic muted"
  let tone: ReviewView["chipTone"] = "you"
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
    hint = "Pauses stay here - tap done to review."
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
    else if (sendable) hint = "Send adds a follow-up."
  } else if (phase === "thinking") {
    chip = `${agentName} is working`
    tone = "think"
    if (!d && !pending) hint = `Tap talk to add a follow-up · waiting ${clock(waited)}`
    else if (d?.state === "recording") hint = "Recording - tap done to review."
    else if (sendable) hint = "Send adds a follow-up."
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
    modeBlock: frozen || d?.state === "recording" ? block : null,
  }
}

/** The worker's error for a refused operation, as the caller's next step. */
export function refusalNote(error: string | undefined, agentName: string): string | null {
  if (error === "recording") return "Tap done, then send or discard."
  if (error === "finishing") return "Finishing transcript."
  if (error === "draft_open") return "Send or discard before auto."
  if (error === "agent_speaking") return `Tap talk when ${agentName} finishes.`
  return null
}
