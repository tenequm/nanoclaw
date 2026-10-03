import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LIVE_PHASES, type Line, type Phase, type SendCue, type Speaker, type TurnMark, type VoiceCall } from "./voice-call"
import { INITIAL_REVIEW, type ReviewState, type TurnMode } from "./review"

/**
 * A scripted call with the same shape as the real one, for `?demo=1` (auto mode), `?demo=wake`
 * (auto mode with the wake switch and spoken commands), `?demo=review` (review mode) and
 * `?demo=cues` (the call's notes: wake heard, the send countdown, speech over a reply, a reply not
 * spoken, a lone send word): the page can be tried without a microphone or a wired agent, and every
 * state can be looked at; `&step=<n>` stops the script at step n. Nothing here touches the host; the words and the levels
 * are made up. The worker plays the sound cues, so the demo is silent.
 */
export type DemoScript = TurnMode | "wake" | "cues"

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
  /** Auto with the wake switch on: whether the worker waits for the wake phrase in this step. */
  awaitingWake?: boolean
  /** The worker dropped the newest caller line: a spoken discard, or words before the wake phrase. */
  drop?: "discarded" | "unaddressed"
  /** The worker heard the wake phrase on this step's caller line. */
  wakeHeard?: boolean
  /** The caller spoke over this step's agent line: the page's "not heard" note. */
  unheard?: boolean
  /** An agent line the worker could not speak, with its text. */
  unspoken?: string
  /** This step's caller line is a lone send word: nothing to send. */
  command?: boolean
  /** This step's caller line opens with words before the wake phrase, which were ignored. */
  preWake?: boolean
}

const AGENT = "Casa"
// Walks through the send countdown, sent marks, what each reply answers, the limit note and an end reason.
const SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 3600, from: "user", text: "Hey Casa, what did we decide about the launch date?", pause: true },
  { phase: "thinking", ms: 1700, sent: true },
  {
    phase: "talking",
    ms: 4800,
    from: "assistant",
    text: "We settled on the 24th, right after the beta feedback round closes. Want a reminder on Thursday so you can brief the team?",
    re: "reply to turn 1",
  },
  { phase: "talking", ms: 3200, from: "assistant", text: "Also, the venue confirmed the booking for Friday.", re: "unprompted" },
  { phase: "listening", ms: 3000, from: "user", text: "Yes, and let Laura know.", pause: true },
  { phase: "thinking", ms: 2400, sent: true, limit: true },
  {
    phase: "talking",
    ms: 3800,
    from: "assistant",
    text: "Done. Thursday at nine is on your calendar, and Laura has a note in the family group.",
    re: "reply to turn 2",
  },
  { phase: "listening", ms: 2200 },
  { phase: "ended", ms: 0, end: "Today's call minutes are used up." },
]

// The wake switch: words before "hey Casa" go nowhere, "send it" sends, "scratch that" drops the turn.
const WAKE_SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 2400, awaitingWake: true },
  { phase: "listening", ms: 2600, awaitingWake: true, from: "user", text: "So that's settled for the weekend then." },
  { phase: "listening", ms: 1400, awaitingWake: true, drop: "unaddressed" },
  { phase: "listening", ms: 3400, awaitingWake: false, wakeHeard: true, from: "user", text: "Hey Casa, book a table for two at eight." },
  { phase: "listening", ms: 2400, awaitingWake: false, from: "user", text: "Somewhere near the office. Send it." },
  { phase: "thinking", ms: 1900, awaitingWake: true, sent: true },
  { phase: "talking", ms: 3600, from: "assistant", text: "Booked Tavola for eight. Want it on your calendar too?", re: "reply to turn 1", awaitingWake: true },
  { phase: "listening", ms: 2000, awaitingWake: true },
  { phase: "listening", ms: 3000, awaitingWake: false, wakeHeard: true, from: "user", text: "Hey Casa, cancel the dentist on Friday." },
  { phase: "listening", ms: 1600, awaitingWake: false, from: "user", text: "No wait, scratch that." },
  { phase: "listening", ms: 2600, awaitingWake: true, drop: "discarded" },
  { phase: "ended", ms: 0, end: "Call ended." },
]

// The call's notes, with the wake switch on: 1 waiting, 2 wake heard (after ignored words), 3 the send countdown, 5 speech
// over a reply, 6 a reply that could not be spoken, 7 a lone send word.
const CUES_SCRIPT: Step[] = [
  { phase: "connecting", ms: 1300 },
  { phase: "listening", ms: 2400, awaitingWake: true },
  { phase: "listening", ms: 2600, awaitingWake: false, wakeHeard: true, preWake: true, from: "user", text: "Right, anyway. Hey Casa, what's on tomorrow morning?" },
  { phase: "listening", ms: 3600, awaitingWake: false, pause: true },
  { phase: "thinking", ms: 1900, awaitingWake: true, sent: true },
  { phase: "talking", ms: 3600, from: "assistant", text: "You have the dentist at ten, then lunch with Laura.", re: "reply to turn 1", awaitingWake: true, unheard: true },
  { phase: "listening", ms: 2400, awaitingWake: true, unspoken: "Also, the venue moved the booking to Friday." },
  { phase: "listening", ms: 2400, awaitingWake: true, from: "user", text: "Send it.", command: true },
  { phase: "ended", ms: 0, end: "Call ended." },
]

const DRAFT_1 = "Book a table for two at eight, somewhere near the office."
const LONG =
  "Okay, so for the offsite: перший день - знайомство і план на квартал, другий - воркшоп по voice mode, а ввечері вечеря. ".repeat(48).trim()
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
  { phase: "talking", ms: 4000, from: "assistant", text: "Booked Tavola for eight. Want it on your calendar too?", re: "reply to turn 1", review: { delivery: "sent" } },
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
  { phase: "listening", ms: 900, review: { preparing: true } },
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

const scriptFor = (which: DemoScript): Step[] => (which === "review" ? REVIEW_SCRIPT : which === "wake" ? WAKE_SCRIPT : which === "cues" ? CUES_SCRIPT : SCRIPT)
const wakeScript = (steps: Step[]) => steps === WAKE_SCRIPT || steps === CUES_SCRIPT

export function useDemoCall(enabled: boolean, initial: DemoScript = "auto", stopAt: number | null = null): VoiceCall {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [streamingId, setStreamingId] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [endedText, setEndedText] = useState<string | null>(null)
  const [sendCue, setSendCue] = useState<SendCue | null>(null)
  const [limitNote, setLimitNote] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewState>({ ...INITIAL_REVIEW, mode: initial === "review" ? "review" : "auto", wake: initial === "wake" || initial === "cues" })
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
  const script = useRef<Step[]>(scriptFor(initial))
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

  const secondsIn = () => Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
  /** The open turn's caller lines (the unmarked ones since the last marked one) get this mark and turn number. */
  const markLastUser = useCallback((mark: TurnMark, turn?: number) => {
    setLines((prev) => {
      const last = prev.findLastIndex((l) => l.from === "user")
      if (last < 0) return prev
      // A review draft's line is already marked "sending": it alone takes the update.
      if (prev[last].mark) return prev.map((l, i) => (i === last ? { ...l, mark } : l))
      const from = prev.findLastIndex((l) => l.from === "user" && l.mark)
      return prev.map((l, i) => (i > from && i <= last && l.from === "user" ? { ...l, mark, ...(turn !== undefined ? { turn } : {}) } : l))
    })
  }, [])
  /** The worker dropped the caller's unmarked lines since the last marked one. */
  const dropOpen = useCallback((reason: "discarded" | "unaddressed") => {
    setLines((prev) => {
      const from = prev.findLastIndex((l) => l.from === "user" && l.mark)
      return prev.map((l, i) => (i > from && l.from === "user" && !l.mark ? { ...l, mark: { status: "dropped", reason } } : l))
    })
  }, [])

  const streamLine = useCallback(
    (from: Speaker, text: string, ms: number, re?: string, instant = false, extra: Partial<Line> = {}) => {
      const id = nextId.current++
      const at = secondsIn()
      if (instant) {
        setLines((prev) => [...prev, { id, from, text, at, ...(re ? { re, group: id } : {}), ...extra }])
        return
      }
      const words = text.split(" ")
      const interval = Math.max(70, Math.min(160, (ms * 0.8) / words.length))
      setLines((prev) => [...prev, { id, from, text: "", at, ...(re ? { re, group: id } : {}), ...extra }])
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
        setLines((prev) => [...prev, { id: nextId.current++, from: "user", text: step.sentDraft!, at: secondsIn(), turn, mark: { status: "sending" } }])
      }
      if (step.mark) markLastUser(step.mark)
    },
    [later, markLastUser]
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
      phaseRef.current = step.phase
      setPhase(step.phase)
      if (step.text && step.from) {
        const extra: Partial<Line> = step.command ? { mark: { status: "dropped", reason: "command" } } : { ...(step.wakeHeard ? { wake: true } : {}), ...(step.preWake ? { preWake: true } : {}) }
        streamLine(step.from, step.text, step.ms, step.re, instant || !!step.command, extra)
      }
      if (step.wakeHeard) setReview((r) => ({ ...r, wakeHeard: r.wakeHeard + 1 }))
      if (step.unheard) {
        const note = () => setLines((prev) => [...prev, { id: nextId.current++, from: "assistant", text: "", at: secondsIn(), kind: "unheard" }])
        if (instant) note()
        else later(note, step.ms / 2)
      }
      if (step.unspoken) {
        const reply = nextId.current++
        setLines((prev) => [...prev, { id: reply, from: "assistant", text: step.unspoken!, at: secondsIn(), group: reply, unspoken: true }])
      }
      if (step.review) applyReview(step, instant)
      if (step.awaitingWake !== undefined) {
        const awaitingWake = step.awaitingWake
        setReview((r) => ({ ...r, wake: true, awaitingWake }))
      }
      if (step.drop) dropOpen(step.drop)
      if (step.pause && !instant) {
        // As the worker reports it: the caller stopped a moment ago, the rest of the silence is left.
        // A script stopped on this step keeps the countdown on screen.
        const left = 1600
        const held = stopAt === i
        later(() => setSendCue({ id: `demo-${i}`, from: 1 - left / DEMO_SILENCE_MS, ms: held ? left * 4 : left }), held ? 300 : step.ms - left)
        if (!held) later(() => setSendCue(null), step.ms)
      }
      if (step.sent) {
        const turn = ++turns.current
        const mark = () => markLastUser({ status: "sent" }, turn)
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
    [later, streamLine, clearTimers, applyReview, dropOpen, stopAt]
  )

  const start = useCallback(() => {
    clearTimers()
    setLines([])
    setMuted(false)
    setEndedText(null)
    setLimitNote(null)
    setReconnecting(false)
    setReview((r) => ({ ...INITIAL_REVIEW, mode: script.current === REVIEW_SCRIPT ? "review" : r.mode, wake: wakeScript(script.current) }))
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

  // Picking the other mode, or the wake switch, plays that script from the start.
  const pick = useCallback(
    (which: DemoScript) => {
      script.current = scriptFor(which)
      setReview({ ...INITIAL_REVIEW, mode: which === "review" ? "review" : "auto", wake: which === "wake" })
      if (LIVE_PHASES.has(phaseRef.current)) start()
    },
    [start]
  )
  const setMode = useCallback((mode: TurnMode) => pick(mode), [pick])
  const setWake = useCallback((on: boolean) => pick(on ? "wake" : "auto"), [pick])
  const setPauseSends = useCallback((on: boolean) => setReview((r) => ({ ...r, pauseSends: on })), [])
  const discard = useCallback(() => setReview((r) => ({ ...r, draft: null, ended: false })), [])

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
    () => ({ state: review, setMode, talk: () => {}, done: () => {}, send: () => {}, discard, setWake, setPauseSends }),
    [review, setMode, discard, setWake, setPauseSends]
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
      sendCue,
      limitNote,
      reconnecting,
      review: reviewControls,
    }),
    [phase, lines, streamingId, elapsed, muted, endedText, start, end, toggleMute, sendCue, limitNote, reconnecting, reviewControls]
  )
}
