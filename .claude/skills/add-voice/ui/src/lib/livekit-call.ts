import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createLocalAudioTrack, Room, RoomEvent, Track, type LocalAudioTrack, type RemoteParticipant, type RemoteTrack } from "livekit-client"
import { useAudioPlayback, useParticipantAttributes, useRemoteParticipants, useTextStream, useTranscriptions } from "@livekit/components-react"
import { LIVE_PHASES, errorText, levelsFromStats, micErrorText, type Line, type Phase, type TurnMark, type VoiceCall } from "./voice-call"
import { voiceEndpoint } from "./voice-endpoint"

/**
 * The browser side of a LiveKit walkie-talkie call, behind the same VoiceCall
 * shape as the GPT-Live hook so the page renders both alike.
 *
 * The host's routes next to the page mint the room token (`livekit/token`) and
 * end the call (`livekit/end`). In the room, the worker's AgentSession owns
 * `lk.agent.state` and the `lk.transcription` captions; the worker adds the
 * attributes and the per-turn topic named below.
 */

/** "1" while nanoclaw's agent works on a turn: the worker's session has no LLM, so it never thinks itself. */
const THINKING_ATTR = "nanoclaw.walkie.thinking"
/** "1" when the worker cannot serve this host's protocol version. */
const UPDATING_ATTR = "nanoclaw.walkie.updating"
/** One JSON WalkieTurnStatus per caller turn. */
const TURN_TOPIC = "nanoclaw.walkie.turn"
/** Without a worker in the room after this long, it is down or mid-update (host and worker restart together). */
const AGENT_JOIN_MS = 25_000
const UPDATING = "The voice service is updating. Try again in a minute."

interface TurnStatus extends TurnMark {
  turn: number
  text?: string
}

interface Attempt {
  callId: string | null
  endSent: boolean
}

function isTurnStatus(v: unknown): v is TurnStatus {
  const s = v as TurnStatus | null
  return !!s && typeof s.turn === "number" && (s.status === "sent" || s.status === "lost")
}

function tokenErrorText(status: number, body: string): string {
  const said = body.trim()
  // The host's own words say which limit: the hourly starts or the day's minutes.
  if (status === 429 && said) return said
  if (status === 409) return "This call attempt is no longer active. Try again."
  if (status === 502) return "Could not open the call room. Try again."
  return errorText(status, said)
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

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

/**
 * Put a turn's mark on the caller line it belongs to: the latest unmarked one its final text
 * contains, else the latest unmarked one. Earlier unmarked lines are the same turn's opening
 * segments. A turn with no caption at all (nothing transcribed) gets a line of its own.
 */
function applyTurn(lines: Line[], covered: Set<number>, status: TurnStatus, newLine: () => Line): Line[] {
  const mark: TurnMark = status.reason ? { status: status.status, reason: status.reason } : { status: status.status }
  const open = lines.filter((l) => l.from === "user" && !covered.has(l.id))
  const said = norm(status.text ?? "")
  const target =
    (said ? [...open].reverse().find((l) => norm(l.text) !== "" && said.includes(norm(l.text))) : undefined) ?? open[open.length - 1]
  if (!target) {
    const line = { ...newLine(), text: status.text?.trim() || "…", mark }
    covered.add(line.id)
    return [...lines, line]
  }
  for (const l of open) {
    covered.add(l.id)
    if (l.id === target.id) break
  }
  return lines.map((l) => (l.id === target.id ? { ...l, mark } : l))
}

export function useLiveKitCall(token: string, fallbackAgent = "your agent"): VoiceCall {
  const [phase, setPhaseState] = useState<Phase>(token ? "idle" : "error")
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token. Ask for the full call link.")
  const [endedText, setEndedText] = useState<string | null>(null)
  const [lines, setLinesState] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [agentName, setAgentName] = useState(fallbackAgent)
  const [chat, setChat] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMutedState] = useState(false)
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
  const { canPlayAudio } = useAudioPlayback(room)

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
    (message: string, reason?: string) => {
      teardown(true, reason)
      setError(message)
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
    const onLeft = (p: RemoteParticipant) => {
      if (active.current && p.isAgent) end(true, `${agentNameRef.current} left the call.`)
    }
    const onDisconnected = () => {
      // Before the caller is in, a failed connect() reports the error itself.
      if (active.current && joinedRef.current) end(true, "The call ended.")
    }
    room.on(RoomEvent.TrackSubscribed, onTrack)
    room.on(RoomEvent.TrackUnsubscribed, onUntrack)
    room.on(RoomEvent.ParticipantDisconnected, onLeft)
    room.on(RoomEvent.Disconnected, onDisconnected)
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrack)
      room.off(RoomEvent.TrackUnsubscribed, onUntrack)
      room.off(RoomEvent.ParticipantDisconnected, onLeft)
      room.off(RoomEvent.Disconnected, onDisconnected)
    }
  }, [room, end])

  // The agent's state drives the phase once the caller is in the room.
  useEffect(() => {
    if (!joined || !agent || !agentAttributes) return
    const p = phaseRef.current
    if (p !== "connecting" && !LIVE_PHASES.has(p)) return
    if (agentAttributes[UPDATING_ATTR] === "1") return fail(UPDATING, "updating")
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
  }, [joined, agent, agentAttributes, fail, setPhase])

  // Captions: one line per transcript segment, updated in place as interim text firms up.
  useEffect(() => {
    if (!active.current) return
    let next = linesRef.current
    let touched: number | null = null
    for (const t of transcriptions) {
      const attrs = t.streamInfo.attributes ?? {}
      const key = attrs["lk.segment_id"] || t.streamInfo.id
      const text = t.text.trim()
      if (!text || segmentText.current.get(key) === text) continue
      segmentText.current.set(key, text)
      const id = segmentLine.current.get(key)
      if (id === undefined) {
        // The worker transcribes the caller against the caller's own track.
        const mine =
          (localSid.current !== null && attrs["lk.transcribed_track_id"] === localSid.current) ||
          t.participantInfo.identity === room.localParticipant.identity
        const nid = nextId.current++
        segmentLine.current.set(key, nid)
        next = [...next, { id: nid, from: mine ? "user" : "assistant", text, at: secondsIn() }]
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
      next = applyTurn(next, coveredLines.current, status, () => ({ id: nextId.current++, from: "user", text: "", at: secondsIn() }))
    }
    if (next !== linesRef.current) commitLines(next)
  }, [turnStreams, commitLines])

  const start = useCallback(async () => {
    if (!token) return
    const p = phaseRef.current
    if (p === "connecting" || LIVE_PHASES.has(p)) return
    setError(null)
    setEndedText(null)
    commitLines([])
    segmentLine.current.clear()
    segmentText.current.clear()
    coveredLines.current.clear()
    doneTurns.current.clear()
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

      const res = await fetch(voiceEndpoint("livekit/token", token), { method: "POST" })
      const body = await res.text()
      if (!res.ok) throw new Error(tokenErrorText(res.status, body))
      const session = JSON.parse(body) as { url: string; token: string; callId: string; agent?: string; chat?: string }
      a.callId = session.callId
      // Cancelled while the host opened the room: it holds a call for us, so end it.
      if (cancelled()) return endOnServer(a, false)
      if (session.agent) setAgentName(session.agent)
      if (session.chat) setChat(session.chat)

      try {
        await room.connect(session.url, session.token, forceRelay() ? { autoSubscribe: true, rtcConfig: { iceTransportPolicy: "relay" } } : { autoSubscribe: true })
      } catch (err) {
        if (cancelled()) return
        throw new Error(`Could not connect to the call. ${err instanceof Error ? err.message : String(err)}`)
      }
      if (cancelled()) return
      // DTX off: the worker times the caller's turn by the silence it hears, so silence must keep arriving.
      const pub = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: false, red: false })
      if (cancelled()) return
      localSid.current = pub.trackSid
      setJoined(true)
      agentTimer.current = window.setTimeout(() => {
        agentTimer.current = null
        if (phaseRef.current === "connecting") fail(UPDATING, "no-agent")
      }, AGENT_JOIN_MS)
    } catch (err) {
      if (cancelled()) return
      fail(micErrorText(err) ?? (err instanceof Error ? err.message : String(err)))
    }
  }, [token, room, commitLines, endOnServer, fail, setPhase, setStreaming, setJoined])

  const endCall = useCallback(() => end(true, "Call ended."), [end])

  const toggleMute = useCallback(() => {
    const track = mic.current
    if (!track) return
    const next = !mutedRef.current
    mutedRef.current = next
    void (next ? track.mute() : track.unmute()).catch(() => {})
    setMutedState(next)
  }, [])

  const live = LIVE_PHASES.has(phase)

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

  // A browser that still holds the agent's audio plays it on the caller's next tap.
  const audioBlocked = live && !canPlayAudio
  useEffect(() => {
    if (!audioBlocked) return
    const unlock = () => {
      room.startAudio().catch(() => {})
    }
    window.addEventListener("pointerdown", unlock)
    return () => window.removeEventListener("pointerdown", unlock)
  }, [audioBlocked, room])

  // A closing tab still tells the host to hang up.
  useEffect(() => {
    const onHide = () => {
      if (active.current) teardown(true, undefined, true)
    }
    window.addEventListener("pagehide", onHide)
    return () => window.removeEventListener("pagehide", onHide)
  }, [teardown])

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
    }),
    [phase, lines, streamingId, agentName, elapsed, muted, error, endedText, micStream, remoteStream, startVoid, endCall, toggleMute, chat, audioBlocked]
  )
}
