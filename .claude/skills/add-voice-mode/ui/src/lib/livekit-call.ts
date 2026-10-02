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
} from "livekit-client"
import { useAudioPlayback, useParticipantAttributes, useRemoteParticipants, useTextStream, useTranscriptions } from "@livekit/components-react"
import {
  CallError,
  LIVE_PHASES,
  PAGE_CLOSED,
  TURN_CUE_DELAY_MS,
  errorText,
  levelsFromStats,
  micErrorKind,
  micErrorText,
  playCue,
  statusErrorKind,
  type Cue,
  type ErrorKind,
  type Line,
  type Phase,
  type SendCue,
  type TurnMark,
  type VoiceCall,
} from "./voice-call"
import { voiceEndpoint } from "./voice-endpoint"

/**
 * The browser side of a LiveKit voice call, behind the VoiceCall shape
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
type SettledTurn = TurnMark & { turn: number; text?: string }
/** The worker says "sending" the moment a turn closes, before its outcome. */
type TurnStatus = SettledTurn | { turn: number; status: "sending" }

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

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

/**
 * Put a turn's mark on the caller line it belongs to: the latest unmarked one its final text
 * contains, else the latest unmarked one. Earlier unmarked lines are the same turn's opening
 * segments. A turn with no caption at all (nothing transcribed) gets a line of its own. A second
 * status for a turn (a timed-out one the agent got after all) replaces the mark on its line.
 */
function applyTurn(lines: Line[], covered: Set<number>, status: SettledTurn, newLine: () => Line, turn: number): Line[] {
  const mark: TurnMark = status.reason ? { status: status.status, reason: status.reason } : { status: status.status }
  const marked = lines.find((l) => l.from === "user" && l.turn === turn)
  if (marked) return lines.map((l) => (l.id === marked.id ? { ...l, mark } : l))
  const open = lines.filter((l) => l.from === "user" && !covered.has(l.id))
  const said = norm(status.text ?? "")
  const target =
    (said ? [...open].reverse().find((l) => norm(l.text) !== "" && said.includes(norm(l.text))) : undefined) ?? open[open.length - 1]
  if (!target) {
    const line = { ...newLine(), text: status.text?.trim() ?? "", mark, turn }
    covered.add(line.id)
    return [...lines, line]
  }
  for (const l of open) {
    covered.add(l.id)
    if (l.id === target.id) break
  }
  return lines.map((l) => (l.id === target.id ? { ...l, mark, turn } : l))
}

export function useLiveKitCall(token: string, fallbackAgent = "your agent"): VoiceCall {
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
  const [silenceMs, setSilenceMs] = useState<number | null>(null)
  const [limitNote, setLimitNote] = useState<string | null>(null)

  const phaseRef = useRef<Phase>(phase)
  const agentNameRef = useRef(agentName)
  agentNameRef.current = agentName
  const active = useRef(false)
  const attempt = useRef<Attempt | null>(null)
  const mic = useRef<LocalAudioTrack | null>(null)
  const localSid = useRef<string | null>(null)
  const remote = useRef<RemoteTrack | null>(null)
  const unlockCtx = useRef<AudioContext | null>(null)
  const agentTimer = useRef<number | null>(null)
  const mutedRef = useRef(false)
  const micRaw = useRef(0)
  const agentRaw = useRef(0)
  const muteBusy = useRef(false)
  const inputLevel = useRef(0)
  const outputLevel = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const startedAt = useRef(0)
  const generation = useRef(0)
  const linesRef = useRef<Line[]>([])
  const nextId = useRef(1)
  const segmentLine = useRef(new Map<string, number>())
  const segmentText = useRef(new Map<string, string>())
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
  const limit = useRef<{ ms: number; kind: string } | null>(null)
  const joinedAt = useRef(0)

  // Never over the agent's own speech.
  const cue = useCallback((kind: Cue) => {
    if (phaseRef.current !== "talking") playCue(unlockCtx.current, kind)
  }, [])

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

  const secondsIn = () => Math.max(0, Math.floor((Date.now() - (startedAt.current || Date.now())) / 1000))

  // Who answers this line, so the page can greet by name before the call.
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    fetch(voiceEndpoint("info", token), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { agent?: unknown } | null) => {
        if (j && typeof j.agent === "string" && j.agent.trim()) setAgentName(j.agent.trim())
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [token])

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
      if (tellHost) endOnServer(attempt.current, beacon, reason)
      attempt.current = null
      room.disconnect().catch(() => {})
      mic.current?.stop()
      mic.current = null
      localSid.current = null
      remote.current?.detach()
      remote.current = null
      unlockCtx.current?.close().catch(() => {})
      unlockCtx.current = null
      if (audioRef.current) audioRef.current.srcObject = null
      micRaw.current = 0
      agentRaw.current = 0
      inputLevel.current = 0
      outputLevel.current = 0
      mutedRef.current = false
      setMutedState(false)
      setMuteError(null)
      setReconnecting(false)
      setMicStream(null)
      setRemoteStream(null)
      setStreaming(null)
      setJoined(false)
    },
    [room, endOnServer, setStreaming, setJoined]
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

  // Room events for the hook's lifetime; each handler acts only on a call in progress.
  useEffect(() => {
    const onTrack = (track: RemoteTrack) => {
      if (!active.current || track.kind !== Track.Kind.Audio) return
      remote.current = track
      if (audioRef.current) track.attach(audioRef.current)
      setRemoteStream(new MediaStream([track.mediaStreamTrack]))
    }
    const onUntrack = (track: RemoteTrack) => {
      if (remote.current !== track) return
      track.detach()
      remote.current = null
      setRemoteStream(null)
    }
    const onReconnecting = () => {
      if (active.current) setReconnecting(true)
    }
    const onReconnected = () => setReconnecting(false)
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
  }, [room, end])

  // The agent's state drives the phase once the caller is in the room.
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
    if (next !== p) setPhase(next)
    // The worker's session is up and hears the published microphone: the caller can start.
    if (p === "connecting" && next === "listening") cue("listening")
  }, [joined, agent, agentAttributes, fail, setPhase, cue])

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
      const shown = typeof info.turn === "number" ? shownTurns.current.get(info.turn) : undefined
      const re =
        shown !== undefined ? `re: turn ${shown}${info.part && info.part > 1 ? ` · part ${info.part}` : ""}` : info.unprompted ? "unprompted" : undefined
      currentReply.current = { group: info.reply, re, more: !!info.more }
    }
  }, [replyStreams])

  // Captions: one line per transcript segment, updated in place as interim text firms up.
  useEffect(() => {
    if (!active.current) return
    let next = linesRef.current
    let touched: number | null = null
    for (const t of transcriptions) {
      const attrs = t.streamInfo.attributes ?? {}
      const key = attrs["lk.segment_id"] || t.streamInfo.id
      // The worker transcribes the caller against the caller's own track.
      const mine =
        (localSid.current !== null && attrs["lk.transcribed_track_id"] === localSid.current) ||
        t.participantInfo.identity === room.localParticipant.identity
      const text = mine ? spaceSentences(t.text.trim()) : t.text.trim()
      if (!text || segmentText.current.get(key) === text) continue
      segmentText.current.set(key, text)
      const id = segmentLine.current.get(key)
      if (id === undefined) {
        const nid = nextId.current++
        segmentLine.current.set(key, nid)
        // An agent line joins the message being spoken; only its first line says what it answers.
        const reply = mine ? null : currentReply.current
        const first = !!reply && !labelledReplies.current.has(reply.group)
        if (reply) labelledReplies.current.add(reply.group)
        const about = reply ? { group: reply.group, ...(first && reply.re ? { re: reply.re } : {}) } : {}
        next = [...next, { id: nid, from: mine ? "user" : "assistant", text, at: secondsIn(), ...about }]
        touched = nid
      } else {
        next = next.map((l) => (l.id === id ? { ...l, text } : l))
        touched = id
      }
    }
    if (touched === null) return
    commitLines(next)
    lastDeltaAt.current = Date.now()
    setStreaming(touched)
  }, [transcriptions, room, commitLines, setStreaming])

  // Per-turn delivery marks from the worker.
  useEffect(() => {
    if (!active.current) return
    let next = linesRef.current
    let closed = false
    for (const s of turnStreams) {
      if (doneTurns.current.has(s.streamInfo.id)) continue
      let status: unknown
      try {
        status = JSON.parse(s.text)
      } catch {
        continue // not all of it yet
      }
      doneTurns.current.add(s.streamInfo.id)
      if (!isTurnStatus(status)) continue
      let shown = shownTurns.current.get(status.turn)
      if (shown === undefined) shownTurns.current.set(status.turn, (shown = shownTurns.current.size + 1))
      // The sent cue sounds as the turn closes; the agent's "sent" later is the mark alone.
      if (status.status === "sending") {
        closed = true
        continue
      }
      next = applyTurn(next, coveredLines.current, status, () => ({ id: nextId.current++, from: "user", text: "", at: secondsIn() }), shown)
    }
    if (next !== linesRef.current) commitLines(next)
    if (closed) cue("sent")
  }, [turnStreams, commitLines, cue])

  const start = useCallback(async () => {
    if (!token) return
    const p = phaseRef.current
    if (p === "connecting" || LIVE_PHASES.has(p)) return
    setError(null)
    setErrorKind(null)
    setEndedText(null)
    commitLines([])
    segmentLine.current.clear()
    segmentText.current.clear()
    coveredLines.current.clear()
    doneTurns.current.clear()
    shownTurns.current.clear()
    doneReplies.current.clear()
    labelledReplies.current.clear()
    currentReply.current = null
    limit.current = null
    setSilenceMs(null)
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
    room.startAudio().catch(() => {})
    try {
      const track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 })
      if (cancelled()) {
        track.stop()
        return
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
        url: string
        token: string
        callId: string
        agent?: string
        chat?: string
        silenceMs?: number
        limit?: { ms: number; kind: string }
      }
      a.callId = session.callId
      // Cancelled while the host opened the room: it holds a call for us, so end it.
      if (cancelled()) return endOnServer(a, false)
      if (session.agent) setAgentName(session.agent)
      if (session.chat) setChat(session.chat)
      if (typeof session.silenceMs === "number" && session.silenceMs > 0) setSilenceMs(session.silenceMs)
      if (session.limit && typeof session.limit.ms === "number") limit.current = session.limit
      // The host's clock (and the limit) starts once the worker sees the caller in, after this.
      joinedAt.current = Date.now()

      try {
        await room.connect(session.url, session.token, forceRelay() ? { autoSubscribe: true, rtcConfig: { iceTransportPolicy: "relay" } } : { autoSubscribe: true })
      } catch (err) {
        if (cancelled()) return
        throw new CallError(`Could not connect to the call. ${err instanceof Error ? err.message : String(err)}`, "other")
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
      fail(micErrorText(err) ?? (err instanceof Error ? err.message : String(err)), micErrorKind(err) ?? (err instanceof CallError ? err.kind : "other"))
    }
  }, [token, room, commitLines, endOnServer, fail, setPhase, setStreaming, setJoined])

  const endCall = useCallback(() => end(true, "Call ended."), [end])

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
        setMutedState(track.isMuted)
      })
  }, [])

  useEffect(() => {
    if (!muteError) return
    const t = window.setTimeout(() => setMuteError(null), MUTE_ERROR_MS)
    return () => window.clearTimeout(t)
  }, [muteError])

  const live = LIVE_PHASES.has(phase)

  // The worker's countdown to sending the caller's turn; never shown over the agent's speech.
  const pending = agentAttributes?.[PENDING_ATTR] ?? ""
  // Parsed apart from the phase, so a phase change mid-countdown keeps the same cue and its animation.
  const pendingCue = useMemo<SendCue | null>(() => {
    const [, elapsed, silence] = pending.split(":").map(Number)
    if (!(silence > 0) || !(elapsed >= 0)) return null
    return { id: pending, from: Math.min(1, elapsed / silence), ms: Math.max(0, silence - elapsed) }
  }, [pending])
  const sendCue = live && phase !== "talking" ? pendingCue : null
  const sendCueRef = useRef(sendCue)
  sendCueRef.current = sendCue

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

  // A reply finished and nothing else is queued: the caller's turn, with its cue.
  const lastPhase = useRef<Phase>(phase)
  useEffect(() => {
    const was = lastPhase.current
    lastPhase.current = phase
    if (was !== "talking" || phase !== "listening" || currentReply.current?.more) return
    const group = currentReply.current?.group
    const t = window.setTimeout(() => {
      // A next line announced (before the phase change or since) and not spoken yet: still the agent's turn.
      const next = currentReply.current
      const unspoken = !!next && !labelledReplies.current.has(next.group)
      if (phaseRef.current === "listening" && !sendCueRef.current && next?.group === group && !unspoken) cue("turn")
    }, TURN_CUE_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [phase, cue])

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
      chat,
      audioBlocked,
      unlockAudio,
      reconnecting,
      muteError,
      silenceMs,
      sendCue,
      limitNote,
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
      silenceMs,
      sendCue,
      limitNote,
    ]
  )
}
