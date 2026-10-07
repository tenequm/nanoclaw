import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  createLocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client"
import { useAudioPlayback, useParticipantAttributes, useRemoteParticipants, useTextStream, useTranscriptions } from "@livekit/components-react"
import {
  CallError,
  LIVE_PHASES,
  PAGE_CLOSED,
  errorText,
  levelsFromStats,
  matchesClientProtocol,
  micErrorKind,
  micErrorText,
  statusErrorKind,
  type ErrorKind,
  type Line,
  type Phase,
  type SendCue,
  type TurnMark,
  type VoiceModeCall,
} from "./voice-call"
import { COMMANDS_VERSIONS, DEFAULT_PREFS, INITIAL_REVIEW, MODE_NAME, autoBlock, captionCommand, reopensMic, infoWakePhrase, isLoneCommand, isReviewSnapshot, lineWords, norm, parseCommandWords, refusalNote, settingsNotTaken, storePrefs, storeWakePhrase, storedPrefs, storedWakePhrase, type Draft, type ReviewOp, type ReviewPrefs, type ReviewSnapshot, type ReviewState, type TurnMode } from "./review"
import { voiceEndpoint } from "./voice-endpoint"

/**
 * The browser side of a LiveKit voice call, behind the VoiceModeCall shape
 * the page renders (the `?demo=1` script has the same shape).
 *
 * The host's routes next to the page mint the room token (`livekit/token`) and
 * end the call (`livekit/end`). In the room, the worker's AgentSession owns
 * `lk.agent.state` and the `lk.transcription` captions; the worker adds the
 * attributes and the per-turn topic named below.
 */

/** "1" while nanoclaw's agent works on a turn: the worker's session has no LLM, so it never thinks itself. */
const THINKING_ATTR = "nanoclaw.voice-mode.thinking"
/** "1" when the worker cannot serve this host's protocol version. */
const UPDATING_ATTR = "nanoclaw.voice-mode.updating"
/** JSON CallTurnStatus messages per caller turn: "sending" as one goes to the host, then "sent" or "lost". */
const TURN_TOPIC = "nanoclaw.voice-mode.turn"
/** Without a worker in the room after this long, it is down or mid-update (host and worker restart together). */
const AGENT_JOIN_MS = 25_000
const UPDATING = "The voice service is updating. Try again in a minute."
const NO_AGENT = "The voice service did not answer the call."
/** How long a failed mute or unmute shows on the key. */
const MUTE_ERROR_MS = 4000
/** "<n>:<elapsedMs>:<silenceMs>" while a stopped caller's turn waits out the silence that sends it. */
const PENDING_ATTR = "nanoclaw.voice-mode.pending"
/** One JSON CallReplyInfo right before each line the worker speaks. */
const REPLY_TOPIC = "nanoclaw.voice-mode.reply"
/** "1" when the worker runs review mode; the page offers it only then. */
const REVIEW_ATTR = "nanoclaw.voice-mode.review"
/** JSON CallReviewState from the worker whenever its review state changes. */
const REVIEW_TOPIC = "nanoclaw.voice-mode.review"
/** The worker's review RPCs (REVIEW_RPC in the protocol), and its settings one. */
const REVIEW_RPC: Record<ReviewOp | "settings", string> = {
  mode: "nanoclaw.voice-mode.mode",
  talk: "nanoclaw.voice-mode.talk",
  done: "nanoclaw.voice-mode.done",
  send: "nanoclaw.voice-mode.send",
  discard: "nanoclaw.voice-mode.discard",
  settings: "nanoclaw.voice-mode.settings",
}
/** One of COMMANDS_VERSIONS when the worker understands spoken commands (send, discard, the wake phrase) and the settings RPC. */
const COMMANDS_ATTR = "nanoclaw.voice-mode.commands"
/** The worker's spoken commands as JSON (CallCommandWords): the words the hints quote. */
const COMMAND_WORDS_ATTR = "nanoclaw.voice-mode.command-words"
/** The worker's sound cues come on their own track (CALL_CUE_TRACK), never the speech track. */
const CUE_TRACK = "background_audio"
const REVIEW_RPC_TIMEOUT_MS = 10_000
/** A worker in review mode sets its attribute right after its session starts; this long, then the page runs auto. */
const AGENT_ATTR_GRACE_MS = 3000
/** How long a note under the mode row stays. */
const REVIEW_NOTE_MS = 5000
/** After the agent's line ends, the readout keeps "speaking" this long: back-to-back lines read as one reply. */
const SPEAK_GRACE_MS = 1200
/** While the worker said more lines of the reply follow, the gap before the next one can be longer. */
const SPEAK_MORE_MS = 4000
/** A wake heard this soon after the caller's newest line changed belongs to that line, not the next one. */
const WAKE_LINE_MS = 1500
/** A caller line whose final never came (the transcription was cut off) stops showing as interim after this long unchanged. */
const INTERIM_STALE_MS = 5000

interface ReviewReply {
  gen: number
  ok: boolean
  seq: number
  draft?: number
  turn?: number
  submitted?: number
  error?: string
}
/** What the page says for each CallRoomMetadata.end the host sets before it deletes the room. */
const END_TEXT: Record<string, string> = {
  limit_duration: "The call reached its time limit.",
  limit_daily: "Today's call minutes are used up.",
  newer_call: "A newer call on this line took over.",
  revoked: "Access to this line changed.",
  shutdown: "The voice service restarted.",
  worker_restart: "The voice service restarted. Call again.",
  worker_gone: "The voice service dropped the call.",
}
const LIMIT_NAME: Record<string, string> = { duration: "call time limit", daily: "daily voice limit" }
const LIMIT_WARN_MS = 60_000
/** Shown later than this before the limit, the warning says "under a minute", not "1 min". */
const LIMIT_WARN_LATE_MS = LIMIT_WARN_MS - 5_000

interface ReplyInfo {
  reply: number
  turn?: number
  unprompted?: boolean
  part?: number
  more?: boolean
  /** Sent after a line the worker could not synthesize, with what it would have said. */
  unspoken?: boolean
  text?: string
}

function isReplyInfo(v: unknown): v is ReplyInfo {
  return !!v && typeof (v as ReplyInfo).reply === "number"
}

/** The host's CallRoomMetadata, or null when the room carries none of ours. */
function readRoomMetadata(metadata: string | undefined): { chat?: unknown; end?: unknown } | null {
  if (!metadata) return null
  try {
    const m: unknown = JSON.parse(metadata)
    return m && typeof m === "object" ? m : null
  } catch {
    return null
  }
}

function endReasonText(metadata: string | undefined): string | null {
  const end = readRoomMetadata(metadata)?.end
  return typeof end === "string" ? (END_TEXT[end] ?? null) : null
}

/** What became of a caller turn, with its final text when there is one. */
type SettledTurn = { turn: number; status: "sent" | "lost"; reason?: TurnMark["reason"]; text?: string }
/**
 * Caller words the worker will never send (CallDroppedSpeech): a spoken discard, speech before the
 * wake phrase, a spoken command said alone, with nothing open to act on, or the words of a turn the
 * wake phrase opened that went back to waiting (`asleep`).
 */
type DroppedSpeech = {
  dropped: "discarded" | "unaddressed" | "command" | "asleep"
  text: string
  /** On `command`: which command, and its caption's `lk.segment_id`. */
  command?: "send" | "discard"
  segment?: string
}

function isDroppedSpeech(v: unknown): v is DroppedSpeech {
  const d = v as DroppedSpeech | null
  return !!d && (d.dropped === "discarded" || d.dropped === "unaddressed" || d.dropped === "command" || d.dropped === "asleep") && typeof d.text === "string"
}

/** The caller spoke while the agent's line played (CallUnheardSpeech): none of it was transcribed. */
function isUnheard(v: unknown): boolean {
  return !!v && (v as { unheard?: unknown }).unheard === "agent_speaking"
}
/** The worker says "sending" the moment a turn closes, before its outcome; a sent review draft's carries its text. */
type TurnStatus = SettledTurn | { turn: number; status: "sending"; text?: string; draft?: number }

interface Attempt {
  callId: string | null
  endSent: boolean
}

function isTurnStatus(v: unknown): v is TurnStatus {
  const s = v as { turn?: unknown; status?: unknown } | null
  return !!s && typeof s.turn === "number" && (s.status === "sending" || s.status === "sent" || s.status === "lost")
}

function tokenError(status: number, body: string): CallError {
  const said = body.trim()
  const kind = statusErrorKind(status)
  // The host's own words say which limit: the hourly starts or the day's minutes.
  if (status === 429 && said) return new CallError(said, kind)
  // 426: this page speaks another protocol than the host; a host from before 426 said so in a 409.
  if (status === 426 || (status === 409 && said.includes("protocol 6"))) return new CallError(UPDATING, "updating")
  if (status === 409) return new CallError("This call attempt is no longer active. Try again.", kind)
  if (status === 502) return new CallError("Could not open the call room. Try again.", kind)
  return new CallError(errorText(status, said), kind)
}

/**
 * iOS Safari binds WebRTC UDP to the Wi-Fi interface, so UDP to a VPN address stalls until
 * LiveKit's fallback timers fire; going straight to TURN/TLS connects at once.
 * `?relay=1` / `?relay=0` overrides the iOS default.
 */
function forceRelay(): boolean {
  const param = new URLSearchParams(location.search).get("relay")
  if (param !== null) return param === "1"
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

/** The worker's session state, with nanoclaw's thinking on top; null while the session is still starting. */
function agentPhase(attrs: Readonly<Record<string, string>>): Phase | null {
  const state = attrs["lk.agent.state"]
  if (state === "speaking") return "talking"
  if (attrs[THINKING_ATTR] === "1" || state === "thinking") return "thinking"
  if (state === "listening" || state === "idle") return "listening"
  return null
}

/**
 * The streaming transcription's interim text can run two of its segments together ("test.Please"); its
 * final text has the space. Restores it after a sentence end, where a letter or digit meets a capital.
 */
const spaceSentences = (s: string) => s.replace(/([\p{Ll}\p{N}][.!?…]+)(?=\p{Lu})/gu, "$1 ")

/** Whether a caption line belongs to the text the worker reports (a line of only a command does). */
const within = (said: string, line: Line) => norm(line.text) !== "" && said.includes(lineWords(line))

/**
 * Put a turn's mark on the caller lines it is made of: the latest unmarked one its final text
 * contains, else the latest unmarked one, and the unmarked ones before it (the same turn's opening
 * segments). A turn with no caption at all (nothing transcribed), or lost with no words, gets a line
 * of its own. With the transcript cut at the wake phrase (`wakeCut`), an earlier open line the text
 * does not contain is the phrase's own caption: marked as the wake phrase, not as the turn. A second
 * status for a turn (a timed-out one the agent got after all) replaces the mark on its lines.
 */
function applyTurn(lines: Line[], covered: Set<number>, status: SettledTurn, newLine: () => Line, turn: number, wakeCut = false): Line[] {
  const mark: TurnMark = status.reason ? { status: status.status, reason: status.reason } : { status: status.status }
  if (lines.some((l) => l.from === "user" && l.turn === turn)) return lines.map((l) => (l.from === "user" && l.turn === turn ? { ...l, mark } : l))
  const open = lines.filter((l) => l.from === "user" && !covered.has(l.id))
  const said = norm(status.text ?? "")
  // A turn lost with no words never claims a caption with words: those were transcribed after all
  // (late), and stay open for the next turn.
  const wordless = status.status === "lost" && !said
  const target = wordless
    ? undefined
    : ((said ? [...open].reverse().find((l) => within(said, l)) : undefined) ?? open[open.length - 1])
  if (!target) {
    const line = { ...newLine(), text: status.text?.trim() ?? "", mark, turn }
    covered.add(line.id)
    return [...lines, line]
  }
  const lineIds = new Set<number>()
  const phraseIds = new Set<number>()
  for (const l of open) {
    covered.add(l.id)
    // With the transcript cut at the wake phrase the turn's text is exactly its words: an earlier
    // line it does not contain is the phrase's own caption, no part of the turn.
    if (wakeCut && said && l.id !== target.id && !within(said, l)) phraseIds.add(l.id)
    else lineIds.add(l.id)
    if (l.id === target.id) break
  }
  return lines.map((l) =>
    lineIds.has(l.id) ? { ...l, mark, turn } : phraseIds.has(l.id) ? { ...l, wake: true, wakeOnly: true } : l,
  )
}

/**
 * Mark the caller lines of words the worker dropped. A discard, or a turn gone back to waiting, drops
 * the whole open turn: every open line. Speech before the wake phrase is one transcript: the latest open line it contains and the
 * open ones before it, else the oldest open line; the newest may already be the caller's next words.
 */
function applyDropped(lines: Line[], covered: Set<number>, d: DroppedSpeech, segmentLine?: number): Line[] {
  const open = lines.filter((l) => l.from === "user" && !covered.has(l.id))
  const said = norm(d.text)
  if (d.dropped === "command") {
    // A command with nothing open is one line of its own, its caption's: never the caller's next words.
    const target =
      open.find((l) => l.id === segmentLine) ?? [...open].reverse().find(isLoneCommand) ?? [...open].reverse().find((l) => norm(l.text) === said)
    if (!target) return lines
    covered.add(target.id)
    const command = d.command ?? target.command?.command
    return lines.map((l) => (l.id === target.id ? { ...l, mark: { status: "dropped", reason: "command", ...(command ? { command } : {}) } } : l))
  }
  const whole = d.dropped === "unaddressed" ? [...open].reverse().find((l) => within(said, l)) : undefined
  // Words before the wake phrase that share a caption with it: that line stays open for the turn it
  // starts, tagged for the part that was ignored; only the lines before it were wholly ignored.
  const part =
    d.dropped === "unaddressed" && !whole && said ? [...open].reverse().find((l) => lineWords(l).length > said.length && lineWords(l).includes(said)) : undefined
  if (part) {
    const before = new Set(open.slice(0, open.indexOf(part)).map((l) => l.id))
    for (const id of before) covered.add(id)
    return lines.map((l) => (l.id === part.id ? { ...l, preWake: true } : before.has(l.id) ? { ...l, mark: { status: "dropped", reason: "unaddressed" } } : l))
  }
  const target = d.dropped === "discarded" || d.dropped === "asleep" ? open[open.length - 1] : (whole ?? open[0])
  if (!target) return lines
  const marked = new Set<number>()
  for (const l of open) {
    covered.add(l.id)
    marked.add(l.id)
    if (l.id === target.id) break
  }
  const mark: TurnMark = { status: "dropped", reason: d.dropped }
  return lines.map((l) => (marked.has(l.id) ? { ...l, mark } : l))
}

export function useLiveKitCall(token: string, fallbackAgent = "your agent"): VoiceModeCall {
  const [phase, setPhaseState] = useState<Phase>(token ? "idle" : "error")
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token. Ask for the full call link.")
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(token ? null : "link")
  const [endedText, setEndedText] = useState<string | null>(null)
  const [lines, setLinesState] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [agentName, setAgentName] = useState(fallbackAgent)
  const [chat, setChat] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMutedState] = useState(false)
  const [muteError, setMuteError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  /** Room connected and the microphone published: from here the agent's state drives the phase. */
  const [joined, setJoinedState] = useState(false)
  const joinedRef = useRef(false)

  const [room] = useState(() => new Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false }))
  // Membership changes only: the agent's attributes come through useParticipantAttributes, and the
  // default event set (active speakers, quality, tracks) would re-render the whole page all call long.
  const agent = useRemoteParticipants({ room, updateOnlyOn: [] }).find((p) => p.isAgent)
  const { attributes: agentAttributes } = useParticipantAttributes({ participant: agent })
  const transcriptions = useTranscriptions({ room })
  const { textStreams: turnStreams } = useTextStream(TURN_TOPIC, { room })
  const { textStreams: replyStreams } = useTextStream(REPLY_TOPIC, { room })
  const { canPlayAudio } = useAudioPlayback(room)
  const [limitNote, setLimitNote] = useState<string | null>(null)

  const phaseRef = useRef<Phase>(phase)
  const agentNameRef = useRef(agentName)
  agentNameRef.current = agentName
  const active = useRef(false)
  const attempt = useRef<Attempt | null>(null)
  const mic = useRef<LocalAudioTrack | null>(null)
  const localSid = useRef<string | null>(null)
  const remote = useRef<RemoteTrack | null>(null)
  const cueTrack = useRef<RemoteTrack | null>(null)
  const unlockCtx = useRef<AudioContext | null>(null)
  const agentTimer = useRef<number | null>(null)
  const mutedRef = useRef(false)
  const micRaw = useRef(0)
  const agentRaw = useRef(0)
  const muteBusy = useRef(false)
  /** The caller muted with the mute key (not review mode's own muting): back in hands-free it stays muted. */
  const mutedByHand = useRef(false)
  const inputLevel = useRef(0)
  const outputLevel = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cueAudioRef = useRef<HTMLAudioElement | null>(null)
  const startedAt = useRef(0)
  const generation = useRef(0)
  const linesRef = useRef<Line[]>([])
  const nextId = useRef(1)
  const segmentLine = useRef(new Map<string, number>())
  const segmentText = useRef(new Map<string, string>())
  /** The caller's segments whose text is still interim, with when each last changed: the transcription may yet change it. */
  const interimSegments = useRef(new Map<string, number>())
  const coveredLines = useRef(new Set<number>())
  const doneTurns = useRef(new Set<string>())
  const lastDeltaAt = useRef(0)
  const streamingRef = useRef<number | null>(null)
  /** The worker's turn numbers count noises too; the page numbers the turns it shows. */
  const shownTurns = useRef(new Map<number, number>())
  const doneReplies = useRef(new Set<string>())
  /** The line the worker is about to speak or speaks: new agent captions belong to it. */
  const currentReply = useRef<{ group: number; re?: string; more: boolean } | null>(null)
  const labelledReplies = useRef(new Set<number>())
  /** What each reply answers, for a line of it the worker could not speak. */
  const replyLabels = useRef(new Map<number, string | undefined>())
  /** Replies the caller already got a "not heard" note for: one per reply. */
  const unheardReplies = useRef(new Set<number>())
  /** The agent's newest attributes, for the speaking hold's timer. */
  const attrsRef = useRef<Readonly<Record<string, string>> | undefined>(undefined)
  const speakHold = useRef<number | null>(null)
  /** The wake phrase was heard before its caption: the next caller line carries the mark. */
  const wakeNext = useRef(false)
  const wakeHeard = useRef(0)
  const wakeSlept = useRef(0)
  const lastUserAt = useRef(0)
  const limit = useRef<{ ms: number; kind: string } | null>(null)
  const joinedAt = useRef(0)

  /** The caller's picks as last made before a call or taken by the worker during one: where each call starts. */
  const prefs = useRef<ReviewPrefs | null>(null)
  prefs.current ??= storedPrefs()
  // Review mode. The worker owns the draft; the page shows its newest state and asks for changes.
  const [review, setReviewState] = useState<ReviewState>(() => ({ ...INITIAL_REVIEW, ...prefs.current, wakePhrase: storedWakePhrase() }))
  const reviewRef = useRef<ReviewState>(review)
  const { textStreams: reviewStreams } = useTextStream(REVIEW_TOPIC, { room })
  const doneReviewStreams = useRef(new Set<string>())
  const reviewSeq = useRef(0)
  /** The reply to the operation in flight named this state; it ends when that state is here. */
  const awaitSeq = useRef<number | null>(null)
  const opGen = useRef(0)
  /** The newest worker turn number seen, so a switch to review hears of a turn sent meanwhile. */
  const maxTurn = useRef(0)
  /** Caption segments of review recordings: never history, whatever arrives for them later. */
  const reviewSegments = useRef(new Set<string>())
  /** The open recording's segments, as the transcription has them so far. */
  const provisionalSegs = useRef(new Map<string, string>())
  /** The recording each review segment first showed up in: a late update to an older one never shows as heard now. */
  const segRecording = useRef(new Map<string, number>())
  const recordings = useRef(0)
  /** Worker turns that are sent review drafts, and the newest of them. */
  const reviewTurns = useRef(new Set<number>())
  const lastReviewTurn = useRef(0)
  /** This call already asked the worker for the review mode it was started in. */
  const reviewAsked = useRef(false)
  const agentId = useRef<string | null>(null)
  agentId.current = agent?.identity ?? null
  const reviewAvailable = agentAttributes?.[REVIEW_ATTR] === "1"
  const commandsAvailable = COMMANDS_VERSIONS.has(agentAttributes?.[COMMANDS_ATTR] ?? "")
  const announcedWords = agentAttributes?.[COMMAND_WORDS_ATTR]
  /** This call already gave the worker the page's settings. */
  const settingsSent = useRef(false)
  /** The wake switch as the worker last said it runs it. */
  const workerWake = useRef<ReviewSnapshot["wake"]>(undefined)

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const setJoined = useCallback((v: boolean) => {
    joinedRef.current = v
    setJoinedState(v)
  }, [])

  const setStreaming = useCallback((id: number | null) => {
    streamingRef.current = id
    setStreamingId(id)
  }, [])

  const commitLines = useCallback((next: Line[]) => {
    linesRef.current = next
    setLinesState(next)
  }, [])

  const updateReview = useCallback((fn: (r: ReviewState) => ReviewState) => {
    reviewRef.current = fn(reviewRef.current)
    setReviewState(reviewRef.current)
  }, [])

  const keepPrefs = useCallback((picked: Partial<ReviewPrefs>) => {
    prefs.current = { ...DEFAULT_PREFS, ...prefs.current, ...picked }
    storePrefs(prefs.current)
  }, [])

  const secondsIn = () => Math.max(0, Math.floor((Date.now() - (startedAt.current || Date.now())) / 1000))

  // Who answers this line and the wake phrase its worker listens for, so the page names both before the call.
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    fetch(voiceEndpoint("info", token), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { agent?: unknown } | null) => {
        if (j && typeof j.agent === "string" && j.agent.trim()) setAgentName(j.agent.trim())
        const wakePhrase = infoWakePhrase(j)
        // The worker's own phrase, once it has said one, is what this call runs.
        if (wakePhrase === undefined || workerWake.current) return
        storeWakePhrase(wakePhrase)
        updateReview((r) => ({ ...r, wakePhrase }))
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [token, updateReview])

  const endOnServer = useCallback(
    (a: Attempt | null, beacon: boolean, reason?: string) => {
      if (!token || !a?.callId || a.endSent) return
      a.endSent = true
      const url = voiceEndpoint("livekit/end", token).toString()
      const body = JSON.stringify(reason ? { callId: a.callId, reason } : { callId: a.callId })
      if (beacon && navigator.sendBeacon?.(url, body)) return
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {})
    },
    [token]
  )

  const teardown = useCallback(
    (tellHost: boolean, reason?: string, beacon = false) => {
      generation.current++
      active.current = false
      if (agentTimer.current !== null) {
        window.clearTimeout(agentTimer.current)
        agentTimer.current = null
      }
      if (speakHold.current !== null) {
        window.clearTimeout(speakHold.current)
        speakHold.current = null
      }
      if (tellHost) endOnServer(attempt.current, beacon, reason)
      attempt.current = null
      room.disconnect().catch(() => {})
      mic.current?.stop()
      mic.current = null
      localSid.current = null
      remote.current?.detach()
      remote.current = null
      cueTrack.current?.detach()
      cueTrack.current = null
      unlockCtx.current?.close().catch(() => {})
      unlockCtx.current = null
      if (audioRef.current) audioRef.current.srcObject = null
      micRaw.current = 0
      agentRaw.current = 0
      inputLevel.current = 0
      outputLevel.current = 0
      mutedRef.current = false
      mutedByHand.current = false
      setMutedState(false)
      setMuteError(null)
      setReconnecting(false)
      // No final comes after the call: its last interim captions stand as heard.
      interimSegments.current.clear()
      if (linesRef.current.some((l) => l.interim)) commitLines(linesRef.current.map((l) => (l.interim ? { ...l, interim: undefined } : l)))
      // An unsent draft stays readable after the call, never submitted into another one.
      awaitSeq.current = null
      updateReview((r) => {
        const d = r.draft
        const open = d && (d.state === "recording" || d.state === "finishing")
        const kept: Draft | null =
          d && (d.state === "ready" || d.state === "failed") ? d : open && r.provisional.trim() ? { ...d, state: "failed", text: r.provisional.trim() } : null
        // The next call starts from the caller's picks, not from a fallback this call's worker forced.
        return { ...INITIAL_REVIEW, ...prefs.current, available: r.available, wakePhrase: r.wakePhrase, words: r.words, draft: kept, ended: !!kept }
      })
      setMicStream(null)
      setRemoteStream(null)
      setStreaming(null)
      setJoined(false)
    },
    [room, endOnServer, setStreaming, setJoined, updateReview, commitLines]
  )

  const end = useCallback(
    (tellHost: boolean, text: string) => {
      const p = phaseRef.current
      if (p === "idle" || p === "ended" || p === "error") return
      teardown(tellHost)
      setEndedText(text)
      setPhase("ended")
    },
    [teardown, setPhase]
  )

  const fail = useCallback(
    (message: string, kind: ErrorKind, reason?: string) => {
      teardown(true, reason)
      setError(message)
      setErrorKind(kind)
      setPhase("error")
    },
    [teardown, setPhase]
  )

  const rpc = useCallback(
    /** The worker's reply; null when it did not answer, undefined when the call it was for is over. */
    async (
      op: ReviewOp | "settings",
      fields: { draft?: number; mode?: TurnMode; afterTurn?: number; wake?: boolean; pauseSends?: boolean; cues?: boolean; typing?: boolean } = {}
    ): Promise<ReviewReply | null | undefined> => {
      const id = agentId.current
      if (!id) return null
      const call = generation.current
      try {
        const raw = await room.localParticipant.performRpc({
          destinationIdentity: id,
          method: REVIEW_RPC[op],
          payload: JSON.stringify({ gen: ++opGen.current, ...fields }),
          responseTimeout: REVIEW_RPC_TIMEOUT_MS,
        })
        if (generation.current !== call) return undefined
        const reply = JSON.parse(raw) as ReviewReply
        return typeof reply?.ok === "boolean" && typeof reply.seq === "number" ? reply : null
      } catch {
        return generation.current === call ? null : undefined
      }
    },
    [room]
  )

  /** Ask the worker to send its review state again (a mode request naming no mode only re-reads it). */
  const resyncReview = useCallback(() => {
    if (active.current && reviewSeq.current > 0) void rpc("mode")
  }, [rpc])

  // Room events for the hook's lifetime; each handler acts only on a call in progress.
  useEffect(() => {
    const onTrack = (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (!active.current || track.kind !== Track.Kind.Audio) return
      // The cues play beside the speech; the speech track alone drives the agent's level.
      if (publication.trackName === CUE_TRACK) {
        cueTrack.current = track
        if (cueAudioRef.current) track.attach(cueAudioRef.current)
        return
      }
      remote.current = track
      if (audioRef.current) track.attach(audioRef.current)
      setRemoteStream(new MediaStream([track.mediaStreamTrack]))
    }
    const onUntrack = (track: RemoteTrack) => {
      if (cueTrack.current === track) {
        track.detach()
        cueTrack.current = null
        return
      }
      if (remote.current !== track) return
      track.detach()
      remote.current = null
      setRemoteStream(null)
    }
    const onReconnecting = () => {
      if (active.current) setReconnecting(true)
    }
    const onReconnected = () => {
      setReconnecting(false)
      // The worker's review state may have moved on meanwhile: read it again, never set it.
      resyncReview()
    }
    // The host rewrites the room metadata when a mid-call /voice moves the call (CallRoomMetadata).
    const onMetadata = (metadata: string | undefined) => {
      const m = readRoomMetadata(metadata)
      if (!active.current || !m) return
      if (typeof m.chat === "string") setChat(m.chat || null)
      else if (m.chat === null) setChat(null)
    }
    // The host names why it ended the call on the room before it deletes it.
    const onLeft = (p: RemoteParticipant) => {
      if (active.current && p.isAgent) end(true, endReasonText(room.metadata) ?? `${agentNameRef.current} left the call.`)
    }
    const onDisconnected = () => {
      setReconnecting(false)
      // Before the caller is in, a failed connect() reports the error itself.
      if (active.current && joinedRef.current) end(true, endReasonText(room.metadata) ?? "The call ended.")
    }
    room.on(RoomEvent.TrackSubscribed, onTrack)
    room.on(RoomEvent.TrackUnsubscribed, onUntrack)
    room.on(RoomEvent.ParticipantDisconnected, onLeft)
    room.on(RoomEvent.Disconnected, onDisconnected)
    room.on(RoomEvent.Reconnecting, onReconnecting)
    room.on(RoomEvent.Reconnected, onReconnected)
    room.on(RoomEvent.RoomMetadataChanged, onMetadata)
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrack)
      room.off(RoomEvent.TrackUnsubscribed, onUntrack)
      room.off(RoomEvent.ParticipantDisconnected, onLeft)
      room.off(RoomEvent.Disconnected, onDisconnected)
      room.off(RoomEvent.Reconnecting, onReconnecting)
      room.off(RoomEvent.Reconnected, onReconnected)
      room.off(RoomEvent.RoomMetadataChanged, onMetadata)
    }
  }, [room, end, resyncReview])

  const dropSpeakHold = useCallback(() => {
    if (speakHold.current === null) return
    window.clearTimeout(speakHold.current)
    speakHold.current = null
  }, [])

  // The agent's state drives the phase once the caller is in the room.
  attrsRef.current = agentAttributes
  useEffect(() => {
    if (!joined || !agent || !agentAttributes) return
    const p = phaseRef.current
    if (p !== "connecting" && !LIVE_PHASES.has(p)) return
    if (agentAttributes[UPDATING_ATTR] === "1") return fail(UPDATING, "updating", "updating")
    const next = agentPhase(agentAttributes)
    if (!next) return
    if (p === "connecting") {
      if (agentTimer.current !== null) {
        window.clearTimeout(agentTimer.current)
        agentTimer.current = null
      }
      startedAt.current = Date.now()
    }
    // Between two lines of a reply the session says "listening" for a moment: the readout keeps
    // "speaking" a little longer, and longer while the worker said more lines follow.
    if (p === "talking" && next === "listening") {
      if (speakHold.current === null) {
        speakHold.current = window.setTimeout(
          () => {
            speakHold.current = null
            const now = attrsRef.current ? agentPhase(attrsRef.current) : null
            if (phaseRef.current === "talking" && now && now !== "talking") setPhase(now)
          },
          currentReply.current?.more ? SPEAK_MORE_MS : SPEAK_GRACE_MS
        )
      }
      return
    }
    dropSpeakHold()
    if (next !== p) setPhase(next)
  }, [joined, agent, agentAttributes, fail, setPhase, dropSpeakHold])

  /**
   * A line the worker could not speak: its text joins the reply as an agent line marked unspoken (a
   * caption of the same text is marked instead). The readout stops claiming the agent speaks, and
   * the reply being spoken keeps labelling the lines that follow.
   */
  const showUnspoken = useCallback(
    (info: ReplyInfo) => {
      const text = info.text?.trim() ?? ""
      const lines = linesRef.current
      const caption = text ? lines.find((l) => l.from === "assistant" && l.group === info.reply && norm(l.text) === norm(text)) : undefined
      if (caption) commitLines(lines.map((l) => (l.id === caption.id ? { ...l, unspoken: true } : l)))
      else {
        const first = !labelledReplies.current.has(info.reply)
        labelledReplies.current.add(info.reply)
        const re = first ? replyLabels.current.get(info.reply) : undefined
        commitLines([...lines, { id: nextId.current++, from: "assistant", text, at: secondsIn(), group: info.reply, unspoken: true, ...(re ? { re } : {}) }])
      }
      if (currentReply.current?.group === info.reply) currentReply.current = { ...currentReply.current, more: false }
      dropSpeakHold()
      const now = attrsRef.current ? agentPhase(attrsRef.current) : null
      if (phaseRef.current === "talking" && now && now !== "talking") setPhase(now)
    },
    [commitLines, dropSpeakHold, setPhase]
  )

  // What the next spoken line answers. Runs before the captions below, which take it for new agent lines.
  useEffect(() => {
    if (!active.current) return
    for (const s of replyStreams) {
      if (doneReplies.current.has(s.streamInfo.id)) continue
      let info: unknown
      try {
        info = JSON.parse(s.text)
      } catch {
        continue // not all of it yet
      }
      doneReplies.current.add(s.streamInfo.id)
      if (!isReplyInfo(info)) continue
      if (info.unspoken) {
        showUnspoken(info)
        continue
      }
      const shown = typeof info.turn === "number" ? shownTurns.current.get(info.turn) : undefined
      const re =
        shown !== undefined ? `reply to turn ${shown}${info.part && info.part > 1 ? ` · part ${info.part}` : ""}` : info.unprompted ? "unprompted" : undefined
      currentReply.current = { group: info.reply, re, more: !!info.more }
      replyLabels.current.set(info.reply, re)
    }
  }, [replyStreams, showUnspoken])

  // Captions: one line per transcript segment, updated in place as interim text firms up.
  useEffect(() => {
    if (!active.current) return
    let next = linesRef.current
    let touched: number | null = null
    let heard = false
    for (const t of transcriptions) {
      const attrs = t.streamInfo.attributes ?? {}
      const key = attrs["lk.segment_id"] || t.streamInfo.id
      // The worker transcribes the caller against the caller's own track.
      const mine =
        (localSid.current !== null && attrs["lk.transcribed_track_id"] === localSid.current) ||
        t.participantInfo.identity === room.localParticipant.identity
      const text = mine ? spaceSentences(t.text.trim()) : t.text.trim()
      // The final often repeats the last interim text word for word; it still firms the line up.
      const interim = mine && attrs["lk.transcription_final"] !== "true"
      // The worker's mark on a caption that ends in a spoken command; each caption replaces the last one's.
      const command = mine ? captionCommand(attrs) : undefined
      const shown = command ? `${text}\0${command.command}\0${command.words}` : text
      const changed = segmentText.current.get(key) !== shown
      if (!text || (!changed && interimSegments.current.has(key) === interim)) continue
      segmentText.current.set(key, shown)
      if (interim) interimSegments.current.set(key, Date.now())
      else interimSegments.current.delete(key)
      const r = reviewRef.current
      if (mine && (reviewSegments.current.has(key) || (r.mode === "review" && !segmentLine.current.has(key)) || r.pending?.to === "review")) {
        reviewSegments.current.add(key)
        if (!segRecording.current.has(key)) segRecording.current.set(key, recordings.current)
        const state = r.draft?.state
        // Only an open recording shows what is heard; a frozen draft shows the worker's text.
        const open = state === "recording" || state === "finishing" || r.pending?.op === "talk" || r.pending?.to === "review"
        if (open && segRecording.current.get(key) === recordings.current) {
          provisionalSegs.current.set(key, text)
          heard = true
        }
        continue
      }
      const id = segmentLine.current.get(key)
      if (id === undefined) {
        const nid = nextId.current++
        segmentLine.current.set(key, nid)
        // An agent line joins the message being spoken; only its first line says what it answers.
        const reply = mine ? null : currentReply.current
        const first = !!reply && !labelledReplies.current.has(reply.group)
        if (reply) labelledReplies.current.add(reply.group)
        const about = reply ? { group: reply.group, ...(first && reply.re ? { re: reply.re } : {}) } : {}
        const woke = mine && wakeNext.current
        if (woke) wakeNext.current = false
        next = [...next, { id: nid, from: mine ? "user" : "assistant", text, at: secondsIn(), ...about, ...(woke ? { wake: true } : {}), ...(interim ? { interim } : {}), ...(command ? { command } : {}) }]
        touched = nid
      } else {
        next = next.map((l) => (l.id === id ? { ...l, text, interim: interim || undefined, command } : l))
        // A final that only firms the text up is no new words: no caret, and the wake timing stands.
        if (!changed) continue
        touched = id
      }
      if (mine) lastUserAt.current = Date.now()
    }
    if (heard) {
      const provisional = [...provisionalSegs.current.values()].join(" ")
      updateReview((r) => ({ ...r, provisional }))
    }
    if (next === linesRef.current) return
    commitLines(next)
    if (touched === null) return
    lastDeltaAt.current = Date.now()
    setStreaming(touched)
  }, [transcriptions, room, commitLines, setStreaming, updateReview])

  // Per-turn delivery marks from the worker, and words it dropped.
  useEffect(() => {
    if (!active.current) return
    let next = linesRef.current
    let delivery: ReviewState["delivery"] = null
    for (const s of turnStreams) {
      if (doneTurns.current.has(s.streamInfo.id)) continue
      let status: unknown
      try {
        status = JSON.parse(s.text)
      } catch {
        continue // not all of it yet
      }
      doneTurns.current.add(s.streamInfo.id)
      if (isUnheard(status)) {
        // One note per reply the caller spoke over, however many times they tried.
        const reply = currentReply.current?.group ?? -1
        if (!unheardReplies.current.has(reply)) {
          unheardReplies.current.add(reply)
          next = [...next, { id: nextId.current++, from: "assistant", text: "", at: secondsIn(), kind: "unheard" }]
        }
        continue
      }
      if (isDroppedSpeech(status)) {
        next = applyDropped(next, coveredLines.current, status, status.segment === undefined ? undefined : segmentLine.current.get(status.segment))
        continue
      }
      if (!isTurnStatus(status)) continue
      maxTurn.current = Math.max(maxTurn.current, status.turn)
      let shown = shownTurns.current.get(status.turn)
      if (shown === undefined) shownTurns.current.set(status.turn, (shown = shownTurns.current.size + 1))
      const fromDraft = status.status === "sending" ? typeof status.draft === "number" : reviewTurns.current.has(status.turn)
      // An auto turn shows no mark while it goes out; a sent draft enters the history here.
      if (status.status === "sending") {
        if (fromDraft && status.text) {
          // A sent draft enters the history once, with exactly the text the caller approved.
          reviewTurns.current.add(status.turn)
          lastReviewTurn.current = Math.max(lastReviewTurn.current, status.turn)
          const line: Line = { id: nextId.current++, from: "user", text: status.text, at: secondsIn(), turn: shown, mark: { status: "sending" } }
          coveredLines.current.add(line.id)
          next = [...next, line]
          delivery = "sending"
        }
        continue
      }
      next = applyTurn(next, coveredLines.current, status, () => ({ id: nextId.current++, from: "user", text: "", at: secondsIn() }), shown, !!workerWake.current?.cut)
      if (fromDraft && status.turn === lastReviewTurn.current) delivery = status.status
    }
    if (next !== linesRef.current) commitLines(next)
    if (delivery) {
      const d = delivery
      updateReview((r) => ({ ...r, delivery: d }))
    }
  }, [turnStreams, commitLines, updateReview])

  const start = useCallback(async () => {
    if (!token) return
    const p = phaseRef.current
    if (p === "connecting" || LIVE_PHASES.has(p)) return
    // A draft from the last call is discarded first, never carried into this one.
    if (reviewRef.current.ended && reviewRef.current.draft) return
    updateReview((r) => ({ ...INITIAL_REVIEW, mode: r.mode, wake: r.wake, pauseSends: r.pauseSends, typing: r.typing, wakePhrase: r.wakePhrase, words: r.words }))
    reviewSeq.current = 0
    reviewAsked.current = false
    settingsSent.current = false
    workerWake.current = undefined
    awaitSeq.current = null
    maxTurn.current = 0
    doneReviewStreams.current.clear()
    reviewSegments.current.clear()
    provisionalSegs.current.clear()
    segRecording.current.clear()
    reviewTurns.current.clear()
    lastReviewTurn.current = 0
    setError(null)
    setErrorKind(null)
    setEndedText(null)
    commitLines([])
    segmentLine.current.clear()
    segmentText.current.clear()
    interimSegments.current.clear()
    coveredLines.current.clear()
    doneTurns.current.clear()
    shownTurns.current.clear()
    doneReplies.current.clear()
    labelledReplies.current.clear()
    replyLabels.current.clear()
    unheardReplies.current.clear()
    wakeNext.current = false
    wakeHeard.current = 0
    wakeSlept.current = 0
    lastUserAt.current = 0
    currentReply.current = null
    limit.current = null
    startedAt.current = 0
    setStreaming(null)
    setElapsed(0)
    setChat(null)
    setPhase("connecting")
    const mine = ++generation.current
    const cancelled = () => generation.current !== mine
    const a: Attempt = { callId: null, endSent: false }
    attempt.current = a
    active.current = true
    // Inside the click, before any await: iOS unlocks audio output only on a user gesture.
    try {
      unlockCtx.current = new AudioContext()
      void unlockCtx.current.resume().catch(() => {})
    } catch {
      /* no Web Audio; the element below still unlocks */
    }
    audioRef.current?.play().catch(() => {})
    cueAudioRef.current?.play().catch(() => {})
    room.startAudio().catch(() => {})
    try {
      let track: LocalAudioTrack
      try {
        track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 })
      } catch (err) {
        // Whatever the browser said, it was the microphone that failed: a mic error in the caller's words.
        throw new CallError(micErrorText(err) ?? "The microphone could not be opened. Check it, then call again.", micErrorKind(err) ?? "mic")
      }
      if (cancelled()) {
        track.stop()
        return
      }
      // Review mode never opens the microphone before talk: the track is published muted.
      if (reviewRef.current.mode === "review") {
        await track.mute()
        mutedRef.current = true
        setMutedState(true)
        if (cancelled()) {
          track.stop()
          return
        }
      }
      mic.current = track
      setMicStream(new MediaStream([track.mediaStreamTrack]))
      // The SDK can mute the track itself (an interruption, a lost device): the key follows it.
      const follow = () => {
        if (mic.current !== track || muteBusy.current) return
        mutedRef.current = track.isMuted
        setMutedState(track.isMuted)
      }
      track.on(TrackEvent.Muted, follow)
      track.on(TrackEvent.Unmuted, follow)

      const res = await fetch(voiceEndpoint("livekit/token", token), { method: "POST" })
      const body = await res.text()
      if (!res.ok) throw tokenError(res.status, body)
      const session = JSON.parse(body) as {
        protocol?: number
        url: string
        token: string
        callId: string
        agent?: string
        chat?: string
        limit?: { ms: number; kind: string }
      }
      a.callId = session.callId
      if (!matchesClientProtocol(session.protocol)) throw new CallError(UPDATING, "updating")
      // Cancelled while the host opened the room: it holds a call for us, so end it.
      if (cancelled()) return endOnServer(a, false)
      if (session.agent) setAgentName(session.agent)
      if (session.chat) setChat(session.chat)
      if (session.limit && typeof session.limit.ms === "number") limit.current = session.limit
      // The host's clock (and the limit) starts once the worker sees the caller in, after this.
      joinedAt.current = Date.now()

      try {
        await room.connect(session.url, session.token, forceRelay() ? { autoSubscribe: true, rtcConfig: { iceTransportPolicy: "relay" } } : { autoSubscribe: true })
      } catch (err) {
        if (cancelled()) return
        throw new CallError("Could not connect to the call. Check the connection, then try again.", "other")
      }
      if (cancelled()) return
      // DTX off: the worker times the caller's turn by the silence it hears, so silence must keep arriving.
      const pub = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: false, red: false })
      if (cancelled()) return
      localSid.current = pub.trackSid
      setJoined(true)
      agentTimer.current = window.setTimeout(() => {
        agentTimer.current = null
        if (phaseRef.current === "connecting") fail(NO_AGENT, "offline", "no-agent")
      }, AGENT_JOIN_MS)
    } catch (err) {
      if (cancelled()) return
      // Only messages written for the caller are shown, never a library's own words.
      if (err instanceof CallError) fail(err.message, err.kind)
      else fail(micErrorText(err) ?? "The call could not start. Try again.", micErrorKind(err) ?? "other")
    }
  }, [token, room, commitLines, endOnServer, fail, setPhase, setStreaming, setJoined, updateReview])

  // The caller ending the call drops a review draft with it: nothing of it is kept to send later.
  const endCall = useCallback(() => {
    updateReview((r) => (r.draft ? { ...r, draft: null, provisional: "" } : r))
    end(true, "Call ended.")
  }, [end, updateReview])

  // The key shows what the track actually did, not what was asked of it.
  const toggleMute = useCallback(() => {
    const track = mic.current
    if (!track || muteBusy.current) return
    const next = !track.isMuted
    muteBusy.current = true
    setMuteError(null)
    void (next ? track.mute() : track.unmute())
      .catch(() => {
        if (mic.current === track) setMuteError(next ? "Mute failed" : "Unmute failed")
      })
      .finally(() => {
        muteBusy.current = false
        if (mic.current !== track) return
        mutedRef.current = track.isMuted
        mutedByHand.current = track.isMuted
        setMutedState(track.isMuted)
      })
  }, [])

  useEffect(() => {
    if (!muteError) return
    const t = window.setTimeout(() => setMuteError(null), MUTE_ERROR_MS)
    return () => window.clearTimeout(t)
  }, [muteError])

  /** Mute or unmute the microphone for review mode; true once the track did it. */
  const setMic = useCallback(
    async (on: boolean): Promise<boolean> => {
      const track = mic.current
      if (!track) return false
      muteBusy.current = true
      try {
        await (on ? track.unmute() : track.mute())
      } catch {
        /* the state below says what took */
      } finally {
        muteBusy.current = false
      }
      if (mic.current !== track) return false
      mutedRef.current = track.isMuted
      setMutedState(track.isMuted)
      return track.isMuted !== on
    },
    []
  )

  /** The operation is over once the state its reply named has arrived (it may already have). */
  const settleOp = useCallback(
    (reply: ReviewReply | null | undefined, extra: Partial<ReviewState> = {}) => {
      // An answer for a call that is over changes nothing in this one.
      if (reply === undefined) return
      if (reply && reply.ok && reply.seq > reviewSeq.current) {
        awaitSeq.current = reply.seq
        updateReview((r) => ({ ...r, ...extra }))
        return
      }
      awaitSeq.current = null
      // Unanswered: the worker may have done it anyway, so its state is read again.
      if (!reply) resyncReview()
      const refused = reply && !reply.ok ? refusalNote(reply.error, agentNameRef.current) : null
      updateReview((r) => ({ ...r, pending: null, ...(refused ? { note: refused } : {}), ...(!reply ? { note: "The voice service did not answer - try again." } : {}), ...extra }))
    },
    [updateReview, resyncReview]
  )

  // The worker's review state: the newest one wins.
  useEffect(() => {
    if (!active.current) return
    let newest: ReviewSnapshot | null = null
    for (const s of reviewStreams) {
      if (doneReviewStreams.current.has(s.streamInfo.id)) continue
      let state: unknown
      try {
        state = JSON.parse(s.text)
      } catch {
        continue // not all of it yet
      }
      doneReviewStreams.current.add(s.streamInfo.id)
      if (isReviewSnapshot(state) && state.seq > (newest?.seq ?? reviewSeq.current)) newest = state
    }
    if (!newest) return
    const snap = newest
    reviewSeq.current = snap.seq
    const prev = reviewRef.current
    const d = snap.draft
    let provisional = prev.provisional
    if (d && d.id !== prev.draft?.id && d.reason === "switch") {
      // The open auto turn's words move from the history into the draft; they were never sent.
      const moved = linesRef.current.filter((l) => l.from === "user" && !coveredLines.current.has(l.id) && !l.mark)
      const ids = new Set(moved.map((l) => l.id))
      // A segment that kept growing during the switch is already heard in full.
      const grown = new Set<number>()
      for (const [k, id] of segmentLine.current) {
        if (!ids.has(id)) continue
        reviewSegments.current.add(k)
        if (provisionalSegs.current.has(k)) grown.add(id)
      }
      if (moved.length) commitLines(linesRef.current.filter((l) => !ids.has(l.id)))
      provisional = [...moved.filter((l) => !grown.has(l.id)).map((l) => l.text), ...provisionalSegs.current.values()].join(" ")
    }
    const done = awaitSeq.current !== null && snap.seq >= awaitSeq.current
    if (done) awaitSeq.current = null
    if (snap.wake) {
      if (workerWake.current?.phrase !== snap.wake.phrase || !workerWake.current) storeWakePhrase(snap.wake.phrase ?? null)
      workerWake.current = snap.wake
    }
    const awaitingWake = !!snap.wake?.on && snap.wake.waiting
    const heard = snap.wake?.heard
    if (typeof heard === "number" && heard > wakeHeard.current) {
      wakeHeard.current = heard
      // The line being spoken as the phrase was heard carries the mark, else the next one.
      const lines = linesRef.current
      const last = lines.findLast((l) => l.from === "user")
      const current = !!last && !last.mark && !coveredLines.current.has(last.id) && Date.now() - lastUserAt.current < WAKE_LINE_MS
      if (snap.wake?.cut) {
        // The transcription restarted right after the phrase: the turn's words come on lines of their
        // own, and a caption of the phrase itself is found when the turn settles (applyTurn).
        wakeNext.current = false
      } else if (current && last) {
        commitLines(lines.map((l) => (l.id === last.id ? { ...l, wake: true } : l)))
        wakeNext.current = false
      } else wakeNext.current = true
    }
    const slept = snap.wake?.slept
    if (typeof slept === "number" && slept > wakeSlept.current) wakeSlept.current = slept
    if (awaitingWake) wakeNext.current = false
    updateReview((r) => ({
      ...r,
      mode: snap.mode,
      draft: d,
      provisional,
      preparing: !!snap.preparing,
      awaitingWake,
      wakeHeard: wakeHeard.current,
      wakeSlept: wakeSlept.current,
      ...(snap.wake ? { wakePhrase: snap.wake.phrase ?? null } : {}),
      ...(done ? { pending: null } : {}),
    }))
    // The worker stopped the recording (a reply took the channel): the microphone follows it.
    if (snap.mode === "review" && (!d || d.state !== "recording") && mic.current && !mic.current.isMuted && prev.pending?.op !== "talk") void setMic(false)
  }, [reviewStreams, commitLines, updateReview, setMic])

  const setTurnMode = useCallback(
    async (to: TurnMode) => {
      const r = reviewRef.current
      const p = phaseRef.current
      if (!LIVE_PHASES.has(p)) {
        // Before a call (or after one): only the pick, kept for the next call.
        if (p !== "connecting" && !r.ended) {
          keepPrefs({ mode: to })
          updateReview((x) => ({ ...x, mode: to, note: null }))
        }
        return
      }
      if (r.pending || r.mode === to || !joinedRef.current) return
      if (to === "auto") {
        const block = autoBlock(r)
        if (block) return updateReview((x) => ({ ...x, note: block }))
      } else if (!r.available) return
      updateReview((x) => ({ ...x, pending: { op: "mode", to }, note: null, micError: null }))
      // Review starts with the microphone off: it stops here, before the worker is asked.
      if (to === "review" && mic.current && !mic.current.isMuted) await setMic(false)
      const reply = await rpc("mode", { mode: to, afterTurn: maxTurn.current })
      if (reply?.ok) keepPrefs({ mode: to })
      // Hands-free listens: once the worker took the switch the microphone opens again, unless the
      // caller had muted it themselves.
      if (reopensMic({ to, taken: !!reply?.ok, muted: !!mic.current?.isMuted, mutedByHand: mutedByHand.current })) await setMic(true)
      settleOp(reply, reply?.ok && reply.submitted !== undefined ? { note: "Previous turn already submitted." } : {})
    },
    [updateReview, setMic, rpc, settleOp, keepPrefs]
  )

  const talk = useCallback(async () => {
    const r = reviewRef.current
    if (r.pending || r.mode !== "review" || phaseRef.current === "talking" || !LIVE_PHASES.has(phaseRef.current)) return
    if (r.draft && r.draft.state !== "empty") return
    recordings.current++
    provisionalSegs.current.clear()
    updateReview((x) => ({ ...x, pending: { op: "talk" }, note: null, micError: null, delivery: null, provisional: "" }))
    const reply = await rpc("talk")
    if (!reply?.ok || reply.draft === undefined) return settleOp(reply)
    // The worker hears now; the microphone opens, and only then the caller is told to speak.
    if (await setMic(true)) {
      // A reply may have stopped the recording meanwhile: the microphone follows the worker.
      const d = reviewRef.current.draft
      if (d && (d.id !== reply.draft || d.state !== "recording")) await setMic(false)
      return settleOp(reply)
    }
    updateReview((x) => ({ ...x, micError: "start" }))
    settleOp(await rpc("discard", { draft: reply.draft }))
  }, [updateReview, rpc, setMic, settleOp])

  const done = useCallback(async () => {
    const r = reviewRef.current
    const d = r.draft
    if (r.pending || !d || d.state !== "recording") return
    updateReview((x) => ({ ...x, pending: { op: "done" } }))
    const stopped = await setMic(false)
    if (!stopped) updateReview((x) => ({ ...x, micError: "stop" }))
    settleOp(await rpc("done", { draft: d.id }))
  }, [updateReview, setMic, rpc, settleOp])

  const send = useCallback(async () => {
    const r = reviewRef.current
    const d = r.draft
    if (r.pending || !d || d.state !== "ready" || d.tooLong || r.micError === "stop" || r.ended) return
    updateReview((x) => ({ ...x, pending: { op: "send" }, note: null }))
    const reply = await rpc("send", { draft: d.id })
    if (reply?.ok && reply.turn !== undefined) {
      reviewTurns.current.add(reply.turn)
      lastReviewTurn.current = Math.max(lastReviewTurn.current, reply.turn)
    }
    settleOp(reply, reply?.ok ? { delivery: "sending" } : {})
  }, [updateReview, rpc, settleOp])

  const discard = useCallback(async () => {
    const r = reviewRef.current
    const d = r.draft
    if (!d || r.pending) return
    // After the call only the page holds it.
    if (r.ended || !LIVE_PHASES.has(phaseRef.current)) return updateReview((x) => ({ ...x, draft: null, ended: false, provisional: "" }))
    updateReview((x) => ({ ...x, pending: { op: "discard" }, note: null }))
    if (mic.current && !mic.current.isMuted) await setMic(false)
    const reply = await rpc("discard", { draft: d.id })
    settleOp(reply, { provisional: "" })
  }, [updateReview, setMic, rpc, settleOp])

  // A call picked in review mode switches the worker once it is up. A worker without review runs auto.
  const reviewLive = joined && LIVE_PHASES.has(phase) && !!agent
  useEffect(() => {
    if (!reviewLive || review.mode !== "review" || reviewSeq.current > 0 || review.pending || reviewAsked.current) return
    if (reviewAvailable) {
      reviewAsked.current = true
      updateReview((x) => ({ ...x, pending: { op: "mode", to: "review" } }))
      void rpc("mode", { mode: "review", afterTurn: maxTurn.current }).then((reply) =>
        // The worker stays in auto: so does the page, with the microphone still muted.
        settleOp(reply, reply?.ok ? {} : { mode: "auto", note: `${MODE_NAME.review} didn't start - the call is ${MODE_NAME.auto}.` })
      )
      return
    }
    // The attribute can trail the session's first state by a moment.
    const t = window.setTimeout(() => {
      if (reviewSeq.current > 0) return
      updateReview((x) => ({ ...x, mode: "auto", available: false, note: `${MODE_NAME.review} isn't available on this line.` }))
    }, AGENT_ATTR_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [reviewLive, review.mode, review.pending, reviewAvailable, updateReview, rpc, settleOp])

  // The worker's attributes trail its joining: what the page assumed stays until they had their grace.
  useEffect(() => {
    if (!reviewLive) return
    if (reviewAvailable) return updateReview((x) => (x.available ? x : { ...x, available: true }))
    const t = window.setTimeout(() => updateReview((x) => (x.available ? { ...x, available: false } : x)), AGENT_ATTR_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [reviewLive, reviewAvailable, updateReview])

  /**
   * The page's settings to the worker: the wake switch, the typing sound, and `?cues=0` (the worker plays the cues).
   * Tried twice; if the worker never takes them, the switches go back to what it runs. Only switches
   * the worker took are kept for the next call, and only from the newest request.
   */
  const settingsGen = useRef(0)
  const sendSettings = useCallback(async () => {
    const gen = ++settingsGen.current
    const ask = async () => {
      const { wake, pauseSends, typing } = reviewRef.current
      const reply = await rpc("settings", { wake, pauseSends, typing, cues: new URLSearchParams(location.search).get("cues") !== "0" })
      if (reply?.ok && gen === settingsGen.current) keepPrefs({ wake, pauseSends, typing })
      return reply
    }
    let reply = await ask()
    if (reply === null) reply = await ask()
    if (reply === undefined || reply.ok || gen !== settingsGen.current) return
    const ran = workerWake.current
    updateReview((x) => ({ ...x, ...settingsNotTaken(ran) }))
  }, [rpc, updateReview, keepPrefs])

  // Once per call, as soon as the worker says it takes them. The worker holds its first cue until then.
  // The switches stay through the connect: a worker without commands loses them only after the grace.
  useEffect(() => {
    if (!reviewLive) return
    if (!commandsAvailable) {
      const t = window.setTimeout(() => updateReview((x) => (x.commands ? { ...x, commands: false } : x)), AGENT_ATTR_GRACE_MS)
      return () => window.clearTimeout(t)
    }
    updateReview((x) => (x.commands ? x : { ...x, commands: true }))
    if (settingsSent.current) return
    settingsSent.current = true
    void sendSettings()
  }, [reviewLive, commandsAvailable, updateReview, sendSettings])

  // The worker's own command words once it names them; they stay for later calls on this page too.
  useEffect(() => {
    const words = parseCommandWords(announcedWords)
    if (words) updateReview((x) => (JSON.stringify(x.words) === JSON.stringify(words) ? x : { ...x, words }))
  }, [announcedWords, updateReview])

  const setWakeOption = useCallback(
    (fields: { wake?: boolean; pauseSends?: boolean; typing?: boolean }) => {
      const r = reviewRef.current
      // Mid-call the worker has to take it; before a call it is the pick for the next one.
      const live = LIVE_PHASES.has(phaseRef.current)
      if (live && (!r.commands || r.pending)) return
      updateReview((x) => ({ ...x, ...fields, note: null }))
      if (!live) keepPrefs(fields)
      else if (settingsSent.current) void sendSettings()
    },
    [updateReview, sendSettings, keepPrefs]
  )

  useEffect(() => {
    if (!review.note) return
    const t = window.setTimeout(() => updateReview((x) => ({ ...x, note: null })), REVIEW_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [review.note, updateReview])

  const live = LIVE_PHASES.has(phase)

  // The worker's countdown to sending the caller's turn; never shown over the agent's speech.
  const pending = agentAttributes?.[PENDING_ATTR] ?? ""
  // Parsed apart from the phase, so a phase change mid-countdown keeps the same cue and its animation.
  const pendingCue = useMemo<SendCue | null>(() => {
    const [, elapsed, silence] = pending.split(":").map(Number)
    if (!(silence > 0) || !(elapsed >= 0)) return null
    return { id: pending, from: Math.min(1, elapsed / silence), ms: Math.max(0, silence - elapsed) }
  }, [pending])
  // A lone command has nothing to send: its line shows no countdown, whatever the attribute says.
  const loneCommand = useMemo(() => {
    const last = lines.findLast((l) => l.from === "user")
    return !!last && !last.mark && isLoneCommand(last)
  }, [lines])
  const sendCue = live && phase !== "talking" && !loneCommand ? pendingCue : null

  // A quiet note in the hint a minute before the host's limit ends the call.
  useEffect(() => {
    const l = limit.current
    if (!live || !l) {
      setLimitNote(null)
      return
    }
    const endsAt = joinedAt.current + l.ms
    const show = () => {
      const left = endsAt - Date.now()
      setLimitNote(`Call ends in ${left >= LIMIT_WARN_LATE_MS ? "1 min" : "under a minute"} · ${LIMIT_NAME[l.kind] ?? "call limit"}.`)
    }
    const wait = endsAt - LIMIT_WARN_MS - Date.now()
    if (wait <= 0) return show()
    const t = window.setTimeout(show, wait)
    return () => window.clearTimeout(t)
  }, [live])

  // A caller line whose final never comes stops reading as unsettled.
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => {
      const stale = new Set<number>()
      for (const [key, at] of interimSegments.current) {
        if (Date.now() - at < INTERIM_STALE_MS) continue
        interimSegments.current.delete(key)
        const id = segmentLine.current.get(key)
        if (id !== undefined) stale.add(id)
      }
      const lines = linesRef.current
      if (lines.some((l) => l.interim && stale.has(l.id))) commitLines(lines.map((l) => (l.interim && stale.has(l.id) ? { ...l, interim: undefined } : l)))
    }, 1000)
    return () => window.clearInterval(t)
  }, [live, commitLines])

  // Call timer.
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [live])

  // Levels from RTP stats, not Web Audio: an analyser on the captured microphone silences the
  // outgoing track on iOS Safari (see levelsFromStats), so neither track is tapped. The agent's
  // level also comes from its inbound report: the synchronization source carries one only when
  // the packets have the audio-level header extension, which the agent's audio through the SFU
  // can lack, and then the page went dark while the agent spoke.
  useEffect(() => {
    if (!live) return
    let raf = 0
    let stopped = false
    let polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const sender = mic.current?.sender
        const receiver = remote.current?.receiver
        const [sent, received] = await Promise.all([sender?.getStats(), receiver?.getStats()])
        if (stopped) return
        const level = sent && levelsFromStats(sent).mic
        if (level != null) micRaw.current = level
        agentRaw.current = (received && levelsFromStats(received).agent) ?? 0
      } catch {
        /* the connection closed under us; the next tick decays to zero */
      } finally {
        polling = false
      }
    }
    const step = () => {
      let out = 0
      try {
        const srcs = remote.current?.receiver?.getSynchronizationSources?.() ?? []
        if (srcs.length && typeof srcs[0].audioLevel === "number") out = srcs[0].audioLevel
      } catch {
        out = 0
      }
      out = Math.min(1, Math.max(out, agentRaw.current) * 3)
      outputLevel.current += (out - outputLevel.current) * 0.3
      const inp = mutedRef.current ? 0 : Math.min(1, micRaw.current * 5)
      inputLevel.current += (inp - inputLevel.current) * 0.35
      if (streamingRef.current !== null && Date.now() - lastDeltaAt.current > 700) setStreaming(null)
    }
    const tick = () => {
      step()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    // A wall-clock interval so the caption cursor still settles while the tab is in the background.
    const backstop = window.setInterval(step, 250)
    const stats = window.setInterval(() => void poll(), 100)
    void poll()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.clearInterval(backstop)
      window.clearInterval(stats)
      micRaw.current = 0
      agentRaw.current = 0
      inputLevel.current = 0
      outputLevel.current = 0
    }
  }, [live, setStreaming])

  // A browser that still holds the agent's audio plays it once the caller taps the page's own button.
  const audioBlocked = live && !canPlayAudio
  const unlockAudio = useCallback(() => {
    room.startAudio().catch(() => {})
  }, [room])

  // A closing tab still tells the host to hang up. A page the browser keeps and shows again
  // (back/forward cache) comes back with that call over, so "call" works again.
  useEffect(() => {
    const onHide = () => {
      if (!active.current) return
      teardown(true, undefined, true)
      setEndedText(PAGE_CLOSED)
      setPhase("ended")
    }
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [teardown, setPhase])

  const startVoid = useCallback(() => {
    void start()
  }, [start])

  const micOn = !!micStream && !muted
  const reviewState = useMemo(() => (review.micOn === micOn ? review : { ...review, micOn }), [review, micOn])
  const reviewControls = useMemo(
    () => ({
      state: reviewState,
      setMode: (m: TurnMode) => void setTurnMode(m),
      talk: () => void talk(),
      done: () => void done(),
      send: () => void send(),
      discard: () => void discard(),
      setWake: (on: boolean) => setWakeOption({ wake: on }),
      setPauseSends: (on: boolean) => setWakeOption({ pauseSends: on }),
      setTyping: (on: boolean) => setWakeOption({ typing: on }),
    }),
    [reviewState, setTurnMode, talk, done, send, discard, setWakeOption]
  )

  return useMemo(
    () => ({
      phase,
      lines,
      streamingId,
      agentName,
      elapsed,
      muted,
      error,
      errorKind,
      endedText,
      micStream,
      remoteStream,
      start: startVoid,
      end: endCall,
      toggleMute,
      inputLevel,
      outputLevel,
      audioRef,
      cueAudioRef,
      chat,
      audioBlocked,
      unlockAudio,
      reconnecting,
      muteError,
      sendCue,
      limitNote,
      review: reviewControls,
    }),
    [
      phase,
      lines,
      streamingId,
      agentName,
      elapsed,
      muted,
      error,
      errorKind,
      endedText,
      micStream,
      remoteStream,
      startVoid,
      endCall,
      toggleMute,
      chat,
      audioBlocked,
      unlockAudio,
      reconnecting,
      muteError,
      sendCue,
      limitNote,
      reviewControls,
    ]
  )
}
