import type { Phase } from "./voice-call"

/**
 * Review mode on the page: what the caller sees and may press, worked out from the separate
 * models it is made of: the turn mode, the operation in flight, the worker's draft, the delivery
 * of the last sent draft and the agent's activity. Pure, so every state can be tested and shown
 * by the demo. The worker owns the draft (see CallReviewState in the protocol); the page only
 * shows it and asks. Auto mode's spoken commands (the worker's words, the wake switch) ride on the
 * same state, see `autoListening`.
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

/** One spoken command as the worker announces it (CallCommandWord): `hint` marks the words short hints quote. */
export interface CommandWord {
  say: string
  ownSentence?: boolean
  hint?: boolean
}
export interface CommandWords {
  send: CommandWord[]
  discard: CommandWord[]
}

/**
 * The worker's commands as of this page (CALL_COMMAND_WORDS), for the hints until a worker announces
 * its own (`nanoclaw.voice-mode.command-words`), as every worker this page drives commands for does. Never
 * matched against captions: the worker marks the lines that hold a command.
 */
export const FALLBACK_COMMAND_WORDS: CommandWords = {
  send: [{ say: "zulu", hint: true }, { say: "copy", ownSentence: true, hint: true }, { say: "copy that", ownSentence: true }, { say: "прийом" }],
  discard: [{ say: "scratch that", hint: true }, { say: "discard turn" }, { say: "discard this turn" }],
}

const commandWordList = (v: unknown): CommandWord[] | null => {
  if (!Array.isArray(v)) return null
  const list: CommandWord[] = []
  for (const w of v as unknown[]) {
    const { say, ownSentence, hint } = (w ?? {}) as Record<string, unknown>
    if (typeof say === "string" && say.trim()) list.push({ say: say.trim(), ...(ownSentence === true ? { ownSentence } : {}), ...(hint === true ? { hint } : {}) })
  }
  return list
}

/** The worker's announced commands (`nanoclaw.voice-mode.command-words`), or null when it has none this page reads (version 1, some send word). */
export function parseCommandWords(raw: string | undefined): CommandWords | null {
  if (!raw) return null
  let v: { v?: unknown; send?: unknown; discard?: unknown }
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || v.v !== 1) return null
  const send = commandWordList(v.send)
  if (!send?.length) return null
  return { send, discard: commandWordList(v.discard) ?? [] }
}

/** The words a hint quotes, joined for a sentence: `"zulu" or "copy"`. Short hints take the `hint` ones (else the first); `all` every one. */
export function quoteWords(list: CommandWord[], all = false): string {
  const picked = all ? list : list.some((w) => w.hint) ? list.filter((w) => w.hint) : list.slice(0, 1)
  const quoted = picked.map((w) => `"${w.say}"`)
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : (quoted[0] ?? "")
}

/** The worker's mark on a caption that ends in a spoken command (`nanoclaw.voice-mode.command`, `nanoclaw.voice-mode.words`). */
export interface CaptionCommand {
  command: "send" | "discard"
  /** The caption's words before the command; "" when it was said alone. */
  words: string
}

/** A caption's command mark from its stream attributes, or undefined: a caption without one clears the line's. */
export function captionCommand(attrs: Readonly<Record<string, string>>): CaptionCommand | undefined {
  const command = attrs["nanoclaw.voice-mode.command"]
  const words = attrs["nanoclaw.voice-mode.words"]
  return (command === "send" || command === "discard") && typeof words === "string" ? { command, words } : undefined
}

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
/** A caption line's words as a turn's text holds them: a spoken command the worker marked is not part of them. */
export const lineWords = (line: { text: string; command?: CaptionCommand }) => norm(line.command ? line.command.words : line.text)
/** A caption line the worker marked as a spoken command said alone ("Zulu."). */
export const isLoneCommand = (line: { text: string; command?: CaptionCommand }) => !!line.command && norm(line.command.words) === ""

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
  /** The caller's wake switch: in auto nothing is sent until the wake phrase. Kept for the next call (ReviewPrefs). */
  wake: boolean
  /** With the wake switch: a pause sends too after the wake phrase, not only a spoken send. */
  pauseSends: boolean
  /** The typing sound while the agent works. Kept for the next call (ReviewPrefs). */
  typing: boolean
  /** The worker waits for the wake phrase right now. */
  awaitingWake: boolean
  /** The phrase the worker's wake word listens for, as configured (`Hey LiveKit`); null: `Hey <agent>`. Kept for the next call. */
  wakePhrase: string | null
  /** How many times this call the worker heard the wake phrase (CallWakeState.heard); each one flashes the readout. */
  wakeHeard: number
  /** How many times this call an open turn went back to waiting with nothing more said (CallWakeState.slept). */
  wakeSlept: number
  /** The spoken commands' words the hints quote: the worker's announced ones, else the page's own. */
  words: CommandWords
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

/** Remember the worker's wake phrase for the next page load; null: `Hey <agent>`. */
export function storeWakePhrase(phrase: string | null): void {
  try {
    if (phrase) localStorage.setItem(WAKE_PHRASE_KEY, phrase)
    else localStorage.removeItem(WAKE_PHRASE_KEY)
  } catch {
    // Storage off (a private window): the next load names `Hey <agent>` until the worker says.
  }
}

/** The caller's own picks, kept for the next call and page load. */
export interface ReviewPrefs {
  mode: TurnMode
  wake: boolean
  pauseSends: boolean
  typing: boolean
}

/** A caller with nothing remembered: hands-free, with the wake switch and the typing sound on. */
export const DEFAULT_PREFS: ReviewPrefs = { mode: "auto", wake: true, pauseSends: false, typing: true }

const PREFS_KEY = "voice-review-prefs"

/**
 * The picks remembered in this browser, each one on its own: a value that is missing or not the
 * right kind takes its default, so a remembered `wake: false` stays off. Storage that is off or
 * holds something else reads as nothing remembered.
 */
export function storedPrefs(): ReviewPrefs {
  let saved: Partial<Record<keyof ReviewPrefs, unknown>> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null")
    if (parsed && typeof parsed === "object") saved = parsed
  } catch {
    // Unreadable or blocked: the defaults.
  }
  return {
    mode: saved.mode === "auto" || saved.mode === "review" ? saved.mode : DEFAULT_PREFS.mode,
    wake: typeof saved.wake === "boolean" ? saved.wake : DEFAULT_PREFS.wake,
    pauseSends: typeof saved.pauseSends === "boolean" ? saved.pauseSends : DEFAULT_PREFS.pauseSends,
    typing: typeof saved.typing === "boolean" ? saved.typing : DEFAULT_PREFS.typing,
  }
}

/**
 * The switches after the worker did not take the page's settings: what it runs, as it last said, or
 * what a worker starts with before it has said (waiting for the wake phrase). Never remembered.
 */
export function settingsNotTaken(ran: ReviewSnapshot["wake"]): Pick<ReviewState, "wake" | "pauseSends" | "note"> {
  return {
    wake: ran?.on ?? DEFAULT_PREFS.wake,
    pauseSends: ran?.pauseSends ?? DEFAULT_PREFS.pauseSends,
    note: "Settings didn't reach the call - try again.",
  }
}

/** Remember the caller's picks: one made before a call, or one the worker took during it. */
export function storePrefs(prefs: ReviewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: prefs.mode, wake: prefs.wake, pauseSends: prefs.pauseSends, typing: prefs.typing }))
  } catch {
    // Storage off: the picks last as long as the page.
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
  wake: DEFAULT_PREFS.wake,
  pauseSends: DEFAULT_PREFS.pauseSends,
  typing: DEFAULT_PREFS.typing,
  awaitingWake: false,
  wakePhrase: null,
  wakeHeard: 0,
  wakeSlept: 0,
  words: FALLBACK_COMMAND_WORDS,
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
  /** The call can end besides the two keys (the left one is Discard): ending drops the draft. */
  endable: boolean
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
  sendable: "Send or discard before hands-free.",
  unsendable: "Discard before hands-free.",
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
      endable: false,
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
    chip = `Switching to ${MODE_NAME[pending.to ?? "auto"]}`
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
    endable: left.action !== "end",
  }
}

/**
 * Whether a mode switch opens the microphone again: Manual keeps it off between recordings, so back
 * in hands-free it listens once the worker took the switch, unless the caller muted it themselves.
 */
export function reopensMic({ to, taken, muted, mutedByHand }: { to: TurnMode; taken: boolean; muted: boolean; mutedByHand: boolean }): boolean {
  return to === "auto" && taken && muted && !mutedByHand
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
export const MODE_NAME: Record<TurnMode, string> = { auto: "hands-free", review: "Manual" }

/**
 * What each mode does, in one line under the switch. With the wake switch on a pause sends only when
 * the pause switch says so, as the readout's hint says too.
 */
export function modeCaption(
  mode: TurnMode,
  commands: boolean,
  wake?: { on: boolean; pauseSends: boolean },
  words: CommandWords = FALLBACK_COMMAND_WORDS
): string {
  if (mode === "review") return "Tap talk, read your words, then send."
  if (!commands) return "Stop for a moment to send."
  const send = quoteWords(words.send)
  if (wake?.on && !wake.pauseSends) return `Say ${send} to send.`
  return `Stop for a moment, or say ${send}, to send.`
}

/**
 * The `nanoclaw.voice-mode.commands` value of a worker whose commands and settings RPC this page drives
 * (CALL_COMMANDS_VERSION); the words themselves come from the worker's announcement.
 */
export const COMMANDS_VERSION = "3"
/** Older vocabularies ("1": `over`, "2": `send it`): this page quotes none of their words, but their settings RPC turns the wake gate off. */
const LEGACY_COMMANDS_VERSIONS = new Set(["1", "2"])

/** What this page does with a worker's `nanoclaw.voice-mode.commands`: drive its commands, switch an older one to pauses, or neither. */
export function workerCommands(attr: string | undefined): "commands" | "legacy" | "none" {
  if (attr === COMMANDS_VERSION) return "commands"
  return attr !== undefined && LEGACY_COMMANDS_VERSIONS.has(attr) ? "legacy" : "none"
}

export interface ListeningView {
  chip: string
  hint: string
  /** The transcript's line while it is empty. */
  empty: string
}

/**
 * The wake phrase in the host's line info, which it knows before the call: a phrase, null for
 * `hey <agent>`, undefined when it does not say (an older host).
 */
export function infoWakePhrase(info: unknown): string | null | undefined {
  if (!info || typeof info !== "object" || !("wakePhrase" in info)) return undefined
  const phrase = info.wakePhrase
  if (phrase === null) return null
  return typeof phrase === "string" && phrase.trim() ? phrase.trim() : undefined
}

/**
 * The wake switch's phrase, or null while it is not known: before the line info names the agent the
 * page has only a placeholder name (`placeholder`), never shown as `Hey <placeholder>`.
 */
export function wakeSwitchPhrase(review: ReviewState, agentName: string, placeholder: string): string | null {
  return review.wakePhrase ?? (agentName === placeholder ? null : `Hey ${agentName}`)
}

/** The phrase that opens a turn with the wake switch on, shown exactly as configured. */
export function wakePhraseOf(review: ReviewState, agentName: string): string {
  return review.wakePhrase ?? `Hey ${agentName}`
}

/**
 * Auto mode's readout while it listens with the microphone on: what sends a turn, and with the wake
 * switch on, the phrase that opens one. A worker without spoken commands keeps the plain pause copy.
 */
export function autoListening({ agentName, review }: { agentName: string; review: ReviewState }): ListeningView {
  // The send countdown shows how long the pause is; the copy never quotes seconds.
  if (!review.commands) return { chip: "Listening", hint: "Go ahead. Stop for a moment to send.", empty: "Speak when ready." }
  const wakePhrase = `"${wakePhraseOf(review, agentName)}"`
  const send = quoteWords(review.words.send)
  if (!review.wake) return { chip: "Listening", hint: `Go ahead. Stop for a moment, or say ${send} to send now.`, empty: "Speak when ready." }
  if (review.awaitingWake) return { chip: `Say ${wakePhrase}`, hint: `Nothing is sent until you say ${wakePhrase}.`, empty: `Say ${wakePhrase} to start.` }
  return {
    chip: "Listening",
    hint: review.pauseSends ? `Say ${send}, or stop for a moment, to send.` : `Say ${send} to send - stopping won't.`,
    empty: "Speak when ready.",
  }
}
