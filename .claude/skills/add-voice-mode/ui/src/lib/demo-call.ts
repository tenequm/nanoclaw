import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LIVE_PHASES, cuesEnabled, playCue, type Cue, type Line, type Phase, type SendCue, type Speaker, type VoiceCall } from "./voice-call"

/**
 * A scripted call with the same shape as the real one, for `?demo=1`: the page can be
 * tried without a microphone or a wired agent, and every state can be looked at.
 * Nothing here touches the host; the words and the levels are made up. The sound cues play
 * where a real call plays them, once the Call button has unlocked audio (`?cues=0` silences them).
 */

type Step = {
  phase: Phase
  ms: number
  from?: Speaker
  text?: string
  /** The caller pauses at the end of this step and the send countdown runs. */
  cue?: boolean
  /** The agent's session has the caller's last line: its sent mark. */
  sent?: boolean
  /** What this agent line answers. */
  re?: string
  /** The call nears its limit. */
  limit?: boolean
  /** The call ends here, with this reason. */
  end?: string
}

const AGENT = "Casa"
// Walks through every cue: the listening, sent and your-turn sounds, the send countdown, sent
// marks, what each reply answers, the limit note and an end reason.
const SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 3600, from: "user", text: "Hey Casa, what did we decide about the launch date?", cue: true },
  { phase: "thinking", ms: 1700, sent: true },
  {
    phase: "talking",
    ms: 4800,
    from: "assistant",
    text: "We settled on the 24th, right after the beta feedback round closes. Want a reminder on Thursday so you can brief the team?",
    re: "re: turn 1",
  },
  { phase: "talking", ms: 3200, from: "assistant", text: "Also, the venue confirmed the booking for Friday.", re: "unprompted" },
  { phase: "listening", ms: 3000, from: "user", text: "Yes, and let Laura know.", cue: true },
  { phase: "thinking", ms: 2400, sent: true, limit: true },
  {
    phase: "talking",
    ms: 3800,
    from: "assistant",
    text: "Done. Thursday at nine is on your calendar, and Laura has a note in the family group.",
    re: "re: turn 2",
  },
  { phase: "listening", ms: 2200 },
  { phase: "ended", ms: 0, end: "Today's call minutes are used up." },
]
const DEMO_SILENCE_MS = 2500
/** How long after a turn closes the agent's session confirms it. */
const DEMO_STORED_MS = 500

export function useDemoCall(enabled: boolean): VoiceCall {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [endedText, setEndedText] = useState<string | null>(null)
  const [sendCue, setSendCue] = useState<SendCue | null>(null)
  const [limitNote, setLimitNote] = useState<string | null>(null)
  const turns = useRef(0)

  const phaseRef = useRef<Phase>("idle")
  const mutedRef = useRef(false)
  const streamingRef = useRef(false)
  const timers = useRef<number[]>([])
  const startedAt = useRef(0)
  const nextId = useRef(1)
  const inputLevel = useRef(0)
  const outputLevel = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cueCtx = useRef<AudioContext | null>(null)
  phaseRef.current = phase
  mutedRef.current = muted

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
    streamingRef.current = false
    setStreamingId(null)
    setSendCue(null)
  }, [])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const cue = useCallback((kind: Cue) => {
    if (cuesEnabled()) playCue(cueCtx.current, kind)
  }, [])

  const streamLine = useCallback(
    (from: Speaker, text: string, ms: number, re?: string) => {
      const id = nextId.current++
      const words = text.split(" ")
      const interval = Math.max(70, Math.min(160, (ms * 0.8) / words.length))
      const at = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
      setLines((prev) => [...prev, { id, from, text: "", at, ...(re ? { re, group: id } : {}) }])
      streamingRef.current = true
      setStreamingId(id)
      words.forEach((word, i) => {
        later(() => {
          setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text: l.text ? `${l.text} ${word}` : word } : l)))
          if (i === words.length - 1) {
            streamingRef.current = false
            later(() => setStreamingId((cur) => (cur === id ? null : cur)), 350)
          }
        }, 300 + i * interval)
      })
    },
    [later]
  )

  const runStep = useCallback(
    (i: number) => {
      const step = SCRIPT[i]
      if (!step) return
      if (step.end) {
        clearTimers()
        setLimitNote(null)
        setEndedText(step.end)
        setPhase("ended")
        return
      }
      // As on a real call: listening once connected, your turn once the agent is done.
      const was = phaseRef.current
      if (was === "connecting" && step.phase === "listening") cue("listening")
      if (was === "talking" && step.phase === "listening") cue("turn")
      phaseRef.current = step.phase
      setPhase(step.phase)
      if (step.text && step.from) streamLine(step.from, step.text, step.ms, step.re)
      if (step.cue) {
        // As the worker reports it: the caller stopped a moment ago, the rest of the silence is left.
        const left = 1600
        later(() => setSendCue({ id: `demo-${i}`, from: 1 - left / DEMO_SILENCE_MS, ms: left }), step.ms - left)
        later(() => {
          setSendCue(null)
          cue("sent")
        }, step.ms)
      }
      if (step.sent) {
        const turn = ++turns.current
        later(
          () =>
            setLines((prev) => {
              const last = prev.findLast((l) => l.from === "user")
              return last ? prev.map((l) => (l === last ? { ...l, mark: { status: "sent" }, turn } : l)) : prev
            }),
          DEMO_STORED_MS
        )
      }
      if (step.limit) later(() => setLimitNote("Call ends in 1 min · daily voice limit."), step.ms / 2)
      later(() => runStep(i + 1), step.ms)
    },
    [later, streamLine, clearTimers, cue]
  )

  const start = useCallback(() => {
    // Unlocked only when this runs inside a tap: the scripted first run plays no sound.
    try {
      cueCtx.current ??= new AudioContext()
      void cueCtx.current.resume().catch(() => {})
    } catch {
      /* no Web Audio: a silent demo */
    }
    clearTimers()
    setLines([])
    setMuted(false)
    setEndedText(null)
    setLimitNote(null)
    turns.current = 0
    startedAt.current = Date.now()
    setElapsed(0)
    runStep(0)
  }, [clearTimers, runStep])

  const end = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "ended") return
    clearTimers()
    setLimitNote(null)
    setEndedText("Call ended.")
    setPhase("ended")
  }, [clearTimers])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  useEffect(() => {
    if (!enabled) return
    const t = window.setTimeout(start, 500)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(() => {
    if (!LIVE_PHASES.has(phase)) return
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [phase])

  // Fake levels shaped like speech.
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const tick = () => {
      const t = performance.now() / 1000
      const p = phaseRef.current
      const outTarget = p === "talking" ? 0.3 + 0.45 * Math.abs(Math.sin(t * 7.3)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.1))) : 0
      const inTarget =
        p === "listening" && streamingRef.current && !mutedRef.current
          ? 0.28 + 0.38 * Math.abs(Math.sin(t * 9.1)) * (0.5 + 0.5 * Math.abs(Math.sin(t * 1.7)))
          : mutedRef.current
            ? 0
            : 0.03
      outputLevel.current += (outTarget - outputLevel.current) * 0.25
      inputLevel.current += (inTarget - inputLevel.current) * 0.3
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  return useMemo(
    () => ({
      phase,
      lines,
      streamingId,
      agentName: AGENT,
      elapsed,
      muted,
      error: null,
      endedText,
      micStream: null,
      remoteStream: null,
      start,
      end,
      toggleMute,
      inputLevel,
      outputLevel,
      audioRef,
      silenceMs: DEMO_SILENCE_MS,
      sendCue,
      limitNote,
    }),
    [phase, lines, streamingId, elapsed, muted, endedText, start, end, toggleMute, sendCue, limitNote]
  )
}
