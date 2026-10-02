import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LIVE_PHASES, TURN_CUE_DELAY_MS, playCue, type Line, type Phase, type SendCue, type Speaker, type TurnMark, type VoiceCall } from "./voice-call"
import { INITIAL_REVIEW, type ReviewState, type TurnMode } from "./review"

/**
 * A scripted call with the same shape as the real one, for `?demo=1` (auto mode) and
 * `?demo=review` (review mode): the page can be tried without a microphone or a wired agent, and
 * every state can be looked at; `&step=<n>` stops the script at step n. Nothing here touches the
 * host; the words and the levels are made up. The sound cues play where a real call plays them
 * (`?cues=0` silences them); a browser that blocks autoplay keeps the self-started first run
 * silent until the Call button is tapped.
 */

type Step = {
  phase: Phase
  ms: number
  from?: Speaker
  text?: string
  /** The caller pauses at the end of this step and the send countdown runs. */
  pause?: boolean
  /** The agent's session has the caller's last line: its sent mark. */
  sent?: boolean
  /** What this agent line answers. */
  re?: string
  /** The call nears its limit. */
  limit?: boolean
  /** The call ends here, with this reason. */
  end?: string
  /** Review mode: the whole review state of this step (on top of review mode, nothing pending). */
  review?: Partial<ReviewState>
  /** A sent review draft enters the history with this mark. */
  sentDraft?: string
  /** The newest caller line's mark changes to this. */
  mark?: TurnMark
  muted?: boolean
  reconnecting?: boolean
}

const AGENT = "Casa"
// Walks through every cue: the listening, sent and your-turn sounds, the send countdown, sent
// marks, what each reply answers, the limit note and an end reason.
const SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 3600, from: "user", text: "Hey Casa, what did we decide about the launch date?", pause: true },
  { phase: "thinking", ms: 1700, sent: true },
  {
    phase: "talking",
    ms: 4800,
    from: "assistant",
    text: "We settled on the 24th, right after the beta feedback round closes. Want a reminder on Thursday so you can brief the team?",
    re: "re: turn 1",
  },
  { phase: "talking", ms: 3200, from: "assistant", text: "Also, the venue confirmed the booking for Friday.", re: "unprompted" },
  { phase: "listening", ms: 3000, from: "user", text: "Yes, and let Laura know.", pause: true },
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

const DRAFT_1 = "Book a table for two at eight, somewhere near the office."
const LONG =
  "Okay, so for the offsite: перший день - знайомство і план на квартал, другий - воркшоп по voice mode, а ввечері вечеря. ".repeat(24).trim()
// Every review state, in the order a caller can meet them.
const REVIEW_SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300, review: {} },
  { phase: "listening", ms: 2000, review: {} },
  { phase: "listening", ms: 700, review: { pending: { op: "talk" } } },
  { phase: "listening", ms: 3200, review: { draft: { id: 1, state: "recording", text: "" }, micOn: true, provisional: "Book a table for two at eight, somewhere near the" } },
  { phase: "listening", ms: 1200, review: { draft: { id: 1, state: "finishing", text: "" }, provisional: "Book a table for two at eight, somewhere near the office." } },
  { phase: "listening", ms: 3000, review: { draft: { id: 1, state: "ready", text: DRAFT_1 } } },
  { phase: "listening", ms: 600, review: { draft: { id: 1, state: "ready", text: DRAFT_1 }, pending: { op: "send" } } },
  { phase: "listening", ms: 900, review: { delivery: "sending" }, sentDraft: DRAFT_1 },
  { phase: "thinking", ms: 2400, review: { delivery: "sent" }, mark: { status: "sent" } },
  { phase: "talking", ms: 4000, from: "assistant", text: "Booked Tavola for eight. Want it on your calendar too?", re: "re: turn 1", review: { delivery: "sent" } },
  { phase: "listening", ms: 2000, review: { delivery: "sent" } },
  { phase: "listening", ms: 2600, review: { draft: { id: 2, state: "recording", text: "" }, micOn: true, provisional: "Yes, and also remind me to" } },
  {
    phase: "talking",
    ms: 1200,
    from: "assistant",
    text: "By the way, your nine o'clock moved to half past.",
    re: "unprompted",
    review: { draft: { id: 2, state: "finishing", text: "", reason: "agent" }, provisional: "Yes, and also remind me to" },
  },
  { phase: "talking", ms: 2600, review: { draft: { id: 2, state: "ready", text: "Yes, and also remind me to", reason: "agent" } } },
  { phase: "listening", ms: 1800, review: { draft: { id: 2, state: "ready", text: "Yes, and also remind me to", reason: "agent" } } },
  { phase: "listening", ms: 600, review: { draft: { id: 2, state: "ready", text: "Yes, and also remind me to", reason: "agent" }, pending: { op: "discard" } } },
  { phase: "listening", ms: 1500, review: {} },
  { phase: "listening", ms: 1500, review: { draft: { id: 3, state: "recording", text: "" }, micOn: true } },
  { phase: "listening", ms: 2200, review: { draft: { id: 3, state: "empty", text: "" } } },
  { phase: "listening", ms: 2200, review: { draft: { id: 4, state: "failed", text: "Send the slides to" } } },
  { phase: "listening", ms: 2600, review: { draft: { id: 5, state: "ready", text: LONG, tooLong: true } } },
  { phase: "listening", ms: 2200, review: { draft: { id: 6, state: "recording", text: "" }, micOn: true, provisional: "And one more thing", note: "Tap done, then send or discard." } },
  { phase: "listening", ms: 2000, review: { draft: { id: 6, state: "ready", text: "And one more thing." }, micError: "stop", micOn: true } },
  { phase: "listening", ms: 2000, review: { micError: "start" } },
  { phase: "listening", ms: 1600, review: {}, reconnecting: true },
  { phase: "listening", ms: 800, review: { pending: { op: "mode", to: "auto" } } },
  { phase: "listening", ms: 2200, review: { mode: "auto" }, muted: true },
  { phase: "listening", ms: 800, review: { mode: "auto", pending: { op: "mode", to: "review" } }, muted: true },
  { phase: "listening", ms: 2200, review: { note: "Previous turn already submitted." } },
  { phase: "listening", ms: 1500, review: { draft: { id: 7, state: "ready", text: "Thanks, that's all for now." } } },
  { phase: "ended", ms: 0, end: "Call ended.", review: { draft: { id: 7, state: "ready", text: "Thanks, that's all for now." }, ended: true } },
]
const DEMO_SILENCE_MS = 2500
/** How long after a turn closes the agent's session confirms it. */
const DEMO_STORED_MS = 500

export function useDemoCall(enabled: boolean, initialMode: TurnMode = "auto", stopAt: number | null = null): VoiceCall {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [endedText, setEndedText] = useState<string | null>(null)
  const [sendCue, setSendCue] = useState<SendCue | null>(null)
  const [limitNote, setLimitNote] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewState>({ ...INITIAL_REVIEW, mode: initialMode })
  const [reconnecting, setReconnecting] = useState(false)
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
  const script = useRef<Step[]>(initialMode === "review" ? REVIEW_SCRIPT : SCRIPT)
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

  const streamLine = useCallback(
    (from: Speaker, text: string, ms: number, re?: string, instant = false) => {
      const id = nextId.current++
      const at = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
      if (instant) {
        setLines((prev) => [...prev, { id, from, text, at, ...(re ? { re, group: id } : {}) }])
        return
      }
      const words = text.split(" ")
      const interval = Math.max(70, Math.min(160, (ms * 0.8) / words.length))
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

  /** A review step: its whole review state, and what it adds to the history. */
  const applyReview = useCallback(
    (step: Step, instant: boolean) => {
      const next: ReviewState = { ...INITIAL_REVIEW, mode: "review", ...step.review }
      setReconnecting(!!step.reconnecting)
      setMuted(step.muted ?? !next.micOn)
      const heard = next.provisional
      if (heard && next.draft?.state === "recording" && !instant) {
        // The words show up as the transcription hears them.
        const words = heard.split(" ")
        const interval = Math.max(90, (step.ms * 0.8) / words.length)
        streamingRef.current = true
        setReview({ ...next, provisional: "" })
        words.forEach((_, i) =>
          later(() => {
            setReview((r) => ({ ...r, provisional: words.slice(0, i + 1).join(" ") }))
            if (i === words.length - 1) streamingRef.current = false
          }, 200 + i * interval)
        )
      } else setReview(next)
      if (step.sentDraft) {
        const turn = ++turns.current
        const at = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
        setLines((prev) => [...prev, { id: nextId.current++, from: "user", text: step.sentDraft!, at, turn, mark: { status: "sending" } }])
        if (!instant) playCue(cueCtx.current, "sent")
      }
      if (step.mark) {
        const mark = step.mark
        setLines((prev) => {
          const last = prev.findLast((l) => l.from === "user")
          return last ? prev.map((l) => (l === last ? { ...l, mark } : l)) : prev
        })
      }
      if (!instant && next.draft?.state === "ready" && step.phase !== "talking" && !next.pending && !next.micError) playCue(cueCtx.current, "draft")
    },
    [later]
  )

  const runStep = useCallback(
    (i: number, instant = false) => {
      const steps = script.current
      const step = steps[i]
      if (!step) return
      if (step.end) {
        clearTimers()
        setLimitNote(null)
        setEndedText(step.end)
        setPhase("ended")
        if (step.review) applyReview(step, instant)
        return
      }
      // As on a real call: listening once connected, your turn once the agent is done.
      const was = phaseRef.current
      if (!instant && was === "connecting" && step.phase === "listening") playCue(cueCtx.current, "listening")
      if (!instant && was === "talking" && step.phase === "listening") {
        later(() => {
          if (phaseRef.current === "listening") playCue(cueCtx.current, "turn")
        }, TURN_CUE_DELAY_MS)
      }
      phaseRef.current = step.phase
      setPhase(step.phase)
      if (step.text && step.from) streamLine(step.from, step.text, step.ms, step.re, instant)
      if (step.review) applyReview(step, instant)
      if (step.pause && !instant) {
        // As the worker reports it: the caller stopped a moment ago, the rest of the silence is left.
        const left = 1600
        later(() => setSendCue({ id: `demo-${i}`, from: 1 - left / DEMO_SILENCE_MS, ms: left }), step.ms - left)
        later(() => {
          setSendCue(null)
          playCue(cueCtx.current, "sent")
        }, step.ms)
      }
      if (step.sent) {
        const turn = ++turns.current
        const mark = () =>
          setLines((prev) => {
            const last = prev.findLast((l) => l.from === "user")
            return last ? prev.map((l) => (l === last ? { ...l, mark: { status: "sent" }, turn } : l)) : prev
          })
        if (instant) mark()
        else later(mark, DEMO_STORED_MS)
      }
      if (step.limit) {
        if (instant) setLimitNote("Call ends in 1 min · daily voice limit.")
        else later(() => setLimitNote("Call ends in 1 min · daily voice limit."), step.ms / 2)
      }
      if (instant) return
      if (stopAt !== null && i >= stopAt) return
      later(() => runStep(i + 1), step.ms)
    },
    [later, streamLine, clearTimers, applyReview, stopAt]
  )

  const start = useCallback(() => {
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
    setReconnecting(false)
    setReview((r) => ({ ...INITIAL_REVIEW, mode: script.current === REVIEW_SCRIPT ? "review" : r.mode }))
    turns.current = 0
    startedAt.current = Date.now()
    setElapsed(0)
    // `&step=n`: the steps before it at once, then that one as it plays, and stop there.
    if (stopAt !== null) for (let i = 0; i < stopAt; i++) runStep(i, true)
    runStep(stopAt ?? 0)
  }, [clearTimers, runStep, stopAt])

  const end = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "ended") return
    clearTimers()
    setLimitNote(null)
    setEndedText("Call ended.")
    setPhase("ended")
  }, [clearTimers])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  // Picking the other mode plays that mode's script from the start.
  const setMode = useCallback(
    (mode: TurnMode) => {
      script.current = mode === "review" ? REVIEW_SCRIPT : SCRIPT
      setReview({ ...INITIAL_REVIEW, mode })
      if (LIVE_PHASES.has(phaseRef.current)) start()
    },
    [start]
  )
  const discard = useCallback(() => setReview((r) => ({ ...r, draft: null, ended: false })), [])

  useEffect(
    () => () => {
      void cueCtx.current?.close().catch(() => {})
      cueCtx.current = null
    },
    []
  )

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

  const reviewControls = useMemo(
    () => ({ state: review, setMode, talk: () => {}, done: () => {}, send: () => {}, discard }),
    [review, setMode, discard]
  )

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
      reconnecting,
      review: reviewControls,
    }),
    [phase, lines, streamingId, elapsed, muted, endedText, start, end, toggleMute, sendCue, limitNote, reconnecting, reviewControls]
  )
}
