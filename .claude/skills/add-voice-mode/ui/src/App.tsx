import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, Mic, MicOff, Square } from "lucide-react"
import { BarVisualizer, type AgentState as BarState } from "@/components/ui/bar-visualizer"
import { Matrix, digits, loader, wave, type Frame } from "@/components/ui/matrix"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ui/conversation"
import { Message, MessageContent } from "@/components/ui/message"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Button } from "@/components/ui/button"
import { StreamText } from "@/components/StreamText"
import { readConfig, type VoiceUiConfig } from "@/lib/config"
import { LIVE_PHASES, type ErrorKind, type Phase, type SendCue, type Speaker, type TurnMark, type VoiceCall } from "@/lib/voice-call"
import { reviewView, type KeyAction, type PanelView, type TurnMode } from "@/lib/review"
import { useLiveKitCall } from "@/lib/livekit-call"
import { useDemoCall } from "@/lib/demo-call"
import logo from "@/assets/nanoclaw-logo.png"

type Colorway = NonNullable<VoiceUiConfig["colorway"]>
const COLORWAYS: Colorway[] = ["ivory", "field", "rabbit"]

const MATRIX_ROWS = 7
const MATRIX_COLS = 14
const BAR_COUNT = 12
const MATRIX_OFF: Frame = Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0))

// The mascot as a pincer drawn in dots: a disc with a notch that opens while the call is live.
function clawFrame(open: boolean): Frame {
  const n = 9
  const c = 4
  const r = 3.45
  const f: Frame = Array.from({ length: n }, () => Array(n).fill(0))
  const spread = open ? 0.62 : 0.16
  const dir = -Math.PI / 4
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c
      const dy = y - c
      const d = Math.hypot(dx, dy)
      if (d > r) continue
      const a = Math.atan2(dy, dx)
      const diff = Math.atan2(Math.sin(a - dir), Math.cos(a - dir))
      if (Math.abs(diff) < spread && d > 0.9) continue
      f[y][x] = d < 1.2 ? 0.5 : 1
    }
  }
  return f
}
const CLAW_OPEN = clawFrame(true)
const CLAW_CLOSED = clawFrame(false)

const MATRIX_ON: Record<Phase, string> = {
  idle: "var(--muted-foreground)",
  connecting: "var(--muted-foreground)",
  listening: "var(--dot-you)",
  thinking: "var(--think)",
  talking: "var(--teal)",
  ended: "var(--muted-foreground)",
  error: "var(--coral)",
}

const BAR_STATE: Record<Phase, BarState> = {
  idle: "listening",
  connecting: "connecting",
  listening: "listening",
  thinking: "thinking",
  talking: "speaking",
  ended: "listening",
  error: "listening",
}

// A turn goes out when the caller pauses, and each reply plays to the end.
const HINT: Record<Phase, string> = {
  idle: "Allow the microphone when asked.",
  connecting: "Setting up the call.",
  listening: "Go ahead. A pause sends what you said.",
  thinking: "Your agent is working on it.",
  talking: "You can interrupt at any time.",
  ended: "Thanks for calling.",
  error: "Try again, or ask for a fresh link.",
}

// The readout names the problem; the hint says what to do about it.
const ERROR_TITLE: Record<ErrorKind, string> = {
  "mic-permission": "Microphone blocked",
  mic: "Microphone problem",
  link: "Link not valid",
  limit: "Limit reached",
  offline: "Voice service unavailable",
  updating: "Voice service updating",
  other: "Something went wrong",
}

const ERROR_HINT: Record<ErrorKind, string> = {
  "mic-permission": "Allow microphone access for this site, then call again.",
  mic: "Check the microphone, then call again.",
  link: "Reopen the full call link from your agent’s chat.",
  limit: "Try again once the limit resets.",
  offline: "Try again shortly.",
  updating: "Try again in a minute.",
  other: "Try again.",
}

type LostReason = NonNullable<TurnMark["reason"]>

const LOST_REASON: Record<LostReason, string> = {
  stt: "couldn’t transcribe",
  empty: "no words heard",
  rejected: "not accepted",
  rate_limited: "too many turns",
  timeout: "not confirmed",
}

// A timeout means the host never confirmed the turn, not that it was dropped: repeating it blindly could ask twice.
const LOST_NOTICE: Record<LostReason, string> = {
  stt: "couldn’t transcribe that - please repeat.",
  empty: "no words heard - please repeat.",
  rejected: "turn not accepted.",
  rate_limited: "too many turns - wait before repeating.",
  timeout: "delivery not confirmed - check the chat before repeating.",
}

function markLabel(mark: TurnMark): string {
  if (mark.status === "sent" || mark.status === "sending") return mark.status
  if (mark.reason === "timeout") return LOST_REASON.timeout
  // A newer worker may send a reason this page does not know yet.
  const why = mark.reason && LOST_REASON[mark.reason]
  return why ? `not sent · ${why}` : "not sent"
}

/** Seconds since `active` last turned on: a local clock for the current wait, not a sign of progress. */
function useWaitSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) return
    const from = Date.now()
    const t = window.setInterval(() => setSeconds(Math.floor((Date.now() - from) / 1000)), 1000)
    // Reset as the wait ends, so the next one does not open on this one's last value.
    return () => {
      window.clearInterval(t)
      setSeconds(0)
    }
  }, [active])
  return seconds
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n)
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false))
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const mq = matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}

// Level and glow samples ~20 times a second, read from the call's refs. Only the
// component that calls this re-renders, so the transcript and keys stay still.
function useLevelTicker(call: VoiceCall, phase: Phase, wantLevels: boolean, reduced: boolean, count = MATRIX_COLS) {
  const [levels, setLevels] = useState<number[]>(() => Array(count).fill(0))
  const [glow, setGlow] = useState(1)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastAt = useRef(0)
  const wasZero = useRef(true)
  // Nothing moves on the ended and error screens, so the loop stops there.
  const running = phase !== "ended" && phase !== "error"
  useEffect(() => {
    if (!running) return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      if (now - lastAt.current > 50) {
        lastAt.current = now
        const t = now / 1000
        const p = phaseRef.current
        if (wantLevels) {
          const base = p === "talking" ? call.outputLevel.current : p === "listening" ? call.inputLevel.current : 0
          // A silent stage is already drawn: re-publishing an all-zero array every
          // tick would re-render the whole dot grid for no visible change.
          if (base > 0.001 || !wasZero.current) {
            wasZero.current = base <= 0.001
            setLevels(
              Array.from({ length: count }, (_, i) => {
                const shape = 0.5 + 0.5 * Math.abs(Math.sin(t * 5.2 + i * 0.9)) * (0.6 + 0.4 * Math.abs(Math.cos(t * 2.3 - i * 0.4)))
                return Math.max(0, Math.min(1, base * 1.35 * shape))
              })
            )
          }
        }
        setGlow(
          reduced
            ? 1
            : p === "connecting" || p === "idle"
              ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2))
              : p === "talking"
                ? 0.6 + 0.4 * Math.min(1, call.outputLevel.current * 1.4)
                : 1
        )
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [call.inputLevel, call.outputLevel, wantLevels, reduced, running, count])
  return { levels, glow }
}

// Call timer as four segment digits on tiny Matrix grids; the text version is for assistive tech.
function SegmentTimer({ seconds, live }: { seconds: number; live: boolean }) {
  const m = Math.floor(seconds / 60)
  const sec = seconds % 60
  const ds = [Math.floor(m / 10) % 10, m % 10, Math.floor(sec / 10), sec % 10]
  return (
    <span className="segment" role="timer" aria-label="Call duration">
      <span className="sr-only">{`${pad(m)}:${pad(sec)}`}</span>
      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        {ds.map((d, i) => (
          <Fragment key={i}>
            {i === 2 && (
              <span className="colon">
                <i />
                <i />
              </span>
            )}
            <Matrix rows={7} cols={5} pattern={digits[d]} size={4} gap={1} brightness={live ? 1 : 0.3} palette={{ on: "var(--te-orange)", off: "var(--dot-off)" }} ariaLabel="" />
          </Fragment>
        ))}
      </span>
    </span>
  )
}

const Badge = memo(function Badge({ call, phase, live, reduced }: { call: VoiceCall; phase: Phase; live: boolean; reduced: boolean }) {
  const { glow } = useLevelTicker(call, phase, false, reduced)
  return (
    <div className="badge" aria-hidden="true">
      <Matrix rows={9} cols={9} pattern={live ? CLAW_OPEN : CLAW_CLOSED} size={3} gap={1} brightness={glow} palette={{ on: "var(--te-orange)", off: "#1d1d1d" }} ariaLabel="" />
      <span className={`presence${live ? " live" : ""}`} />
    </div>
  )
})

const Stage = memo(function Stage({
  call,
  phase,
  live,
  presence,
  reduced,
  compact = false,
}: {
  call: VoiceCall
  phase: Phase
  live: boolean
  presence: "matrix" | "bars"
  reduced: boolean
  /** A draft shares the screen: the dots shrink before the words do. */
  compact?: boolean
}) {
  const bars = presence === "bars"
  const { levels, glow } = useLevelTicker(call, phase, true, reduced, bars ? BAR_COUNT : MATRIX_COLS)
  if (bars) {
    // The bars read the same metering as the matrix. Handing the component a
    // MediaStream instead would open an AudioContext on the call's own microphone,
    // which silences the outgoing track on iOS Safari.
    return (
      <div className={`bars-wrap${phase === "listening" ? " you" : ""}`}>
        <BarVisualizer state={BAR_STATE[phase]} volumeBands={levels} barCount={BAR_COUNT} centerAlign minHeight={12} className="h-full w-full gap-2 rounded-none bg-transparent p-0" />
      </div>
    )
  }
  const palette = { on: MATRIX_ON[phase], off: "var(--dot-off)" }
  const size = compact ? 6 : 12
  const gap = compact ? 2 : 3
  return (
    <div className="matrix-wrap">
      {phase === "thinking" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={loader[0]} size={size} gap={gap} palette={palette} ariaLabel="Agent is thinking" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={loader} fps={12} size={size} gap={gap} palette={palette} ariaLabel="Agent is thinking" />
        )
      ) : phase === "connecting" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={wave[0]} size={size} gap={gap} brightness={glow} palette={palette} ariaLabel="Connecting" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={wave} fps={20} size={size} gap={gap} brightness={glow} palette={palette} ariaLabel="Connecting" />
        )
      ) : live ? (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} mode="vu" levels={levels} size={size} gap={gap} palette={palette} ariaLabel="Voice level" />
      ) : (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_OFF} size={size} gap={gap} brightness={glow} palette={palette} ariaLabel="Idle" />
      )}
    </div>
  )
})

/** The send countdown: a thin line under the readout filling over what is left of the silence. */
function SendCueBar({ cue, reduced }: { cue: SendCue; reduced: boolean }) {
  const fill = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = fill.current
    if (!el || reduced || typeof el.animate !== "function") return
    const run = el.animate([{ transform: `scaleX(${cue.from})` }, { transform: "scaleX(1)" }], { duration: cue.ms, easing: "linear", fill: "forwards" })
    return () => run.cancel()
  }, [cue, reduced])
  return (
    <span className="send-cue" aria-hidden="true">
      <i ref={fill} style={reduced ? { opacity: 0.6 } : { transform: `scaleX(${cue.from})` }} />
    </span>
  )
}

const TranscriptLine = memo(function TranscriptLine({
  from,
  text,
  at,
  isLast,
  isStreaming,
  agentName,
  showTs,
  mark,
  note,
}: {
  from: Speaker
  text: string
  at: number
  isLast: boolean
  isStreaming: boolean
  agentName: string
  showTs: boolean
  mark?: TurnMark
  /** The caller turn's number, or what an agent line answers. */
  note?: string
}) {
  const lost = mark?.status === "lost"
  return (
    <Message from={from} className={`py-1.5 ${isLast ? "is-live" : "is-history"}${lost ? " has-lost" : ""}`}>
      <MessageContent className={`min-w-0 ${from === "user" ? "bubble-you" : "bubble-agent"}${isStreaming ? " is-streaming" : ""}`}>
        <span className="speaker">
          {from === "user" ? "You" : agentName}
          {showTs && <span className="ts">{`${Math.floor(at / 60)}:${pad(at % 60)}`}</span>}
          {note && <span className="turn-ref">{note}</span>}
          {mark && <span className={`turn-mark ${mark.status}`}>{markLabel(mark)}</span>}
        </span>
        <p>
          {text ? (
            <StreamText text={text} />
          ) : (
            <span className="ellipsis">{mark?.reason === "stt" || mark?.reason === "empty" ? "Speech could not be transcribed." : "No transcript."}</span>
          )}
        </p>
      </MessageContent>
    </Message>
  )
})

/** The turn mode switch: always there, above the keys. */
function ModeRow({
  mode,
  pendingTo,
  available,
  disabled,
  note,
  onPick,
}: {
  mode: TurnMode
  pendingTo: TurnMode | null
  available: boolean
  disabled: boolean
  note: string | null
  onPick: (mode: TurnMode) => void
}) {
  return (
    <div className="mode-wrap">
      <div className="mode-row" role="radiogroup" aria-label="Turn mode">
        {(["auto", "review"] as const).map((m) => {
          const on = mode === m
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              className={`mode-seg${on ? " on" : ""}${pendingTo === m ? " pending" : ""}`}
              disabled={disabled || (m === "review" && !available && !on)}
              aria-describedby={`mode-${m}-desc`}
              onClick={() => onPick(m)}
            >
              <i className={`led${on ? " on" : ""}`} aria-hidden="true" />
              {m}
              <span id={`mode-${m}-desc`} className="sr-only">
                {m === "auto" ? "A pause sends what you said." : "Tap talk, then read the words before you send them."}
              </span>
            </button>
          )
        })}
      </div>
      {note && (
        <p className="mode-note" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

/** The review draft, pinned above the keys: its own scroller, the header outside it. */
function DraftPanel({ panel }: { panel: PanelView }) {
  const body = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const hearing = panel.tone === "hearing" || panel.tone === "finishing"
  // A frozen draft opens at its first word; heard words follow the tail only while the reader is there.
  useEffect(() => {
    const el = body.current
    if (!el) return
    if (!hearing) el.scrollTop = 0
  }, [hearing, panel.title])
  useEffect(() => {
    const el = body.current
    if (el && hearing && atBottom.current) el.scrollTop = el.scrollHeight
  }, [hearing, panel.text])
  return (
    <section className={`draft-panel tone-${panel.tone}`} aria-label="Review draft">
      <header className="draft-head">
        <span className="draft-title" role="status" aria-live="polite">
          {panel.title}
        </span>
        {panel.note && <span className="draft-note">{panel.note}</span>}
      </header>
      <div
        ref={body}
        className="draft-body"
        tabIndex={0}
        aria-label="Draft text"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 2
        }}
      >
        {panel.text ? <p>{panel.text}</p> : <p className="ellipsis">{panel.tone === "hearing" ? "Speak now…" : panel.tone === "finishing" ? "…" : "No words."}</p>}
      </div>
    </section>
  )
}

/** False for a moment after a key's action changes, so a second tap cannot hit what it turned into. */
function useRearm(action: string, ms: number): boolean {
  const [armed, setArmed] = useState(action)
  useEffect(() => {
    if (armed === action) return
    const t = window.setTimeout(() => setArmed(action), ms)
    return () => window.clearTimeout(t)
  }, [action, armed, ms])
  return armed === action
}

const REARM_MS = 500

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== "function") return false
  return !!el.closest("button, a, input, textarea, select, [contenteditable], [role='radio'], [role='button']")
}

export default function App() {
  const cfg = useMemo(readConfig, [])
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const token = params.get("t") || ""
  // `?demo=1` plays an auto mode call, `?demo=review` a review mode one; `&step=<n>` stops at step n.
  const demoMode = params.get("demo")
  const demo = demoMode === "1" || demoMode === "review"
  const demoStep = Number.parseInt(params.get("step") ?? "", 10)
  const liveKitCall = useLiveKitCall(demo ? "" : token, "your agent")
  const demoCall = useDemoCall(demo, demoMode === "review" ? "review" : "auto", Number.isInteger(demoStep) && demoStep >= 0 ? demoStep : null)
  const call = demo ? demoCall : liveKitCall
  const { phase, lines, streamingId, agentName, elapsed, muted, error, endedText } = call
  const errorKind = call.errorKind ?? "other"
  const live = LIVE_PHASES.has(phase)
  const skin = cfg.skin
  const rail = skin === "te" && cfg.layout === "rail"
  const reduced = useReducedMotion()
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const [colorway, setColorway] = useState<Colorway>(() => {
    try {
      const v = localStorage.getItem("voice-colorway")
      if (v === "ivory" || v === "field" || v === "rabbit") return v
    } catch {
      /* storage may be unavailable */
    }
    return cfg.colorway
  })
  useEffect(() => {
    try {
      if (colorway === cfg.colorway) localStorage.removeItem("voice-colorway")
      else localStorage.setItem("voice-colorway", colorway)
    } catch {
      /* storage may be unavailable */
    }
  }, [colorway, cfg.colorway])
  const onColorwayKey = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, current: Colorway) => {
      const i = COLORWAYS.indexOf(current)
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault()
        setColorway(COLORWAYS[(i + 1) % COLORWAYS.length])
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault()
        setColorway(COLORWAYS[(i - 1 + COLORWAYS.length) % COLORWAYS.length])
      }
    },
    []
  )

  // Right after "call" the same key would read "end"; ignore taps for a moment so a double tap cannot cancel.
  const [cancelArmed, setCancelArmed] = useState(false)
  useEffect(() => {
    if (phase !== "connecting") {
      setCancelArmed(false)
      return
    }
    const t = window.setTimeout(() => setCancelArmed(true), 700)
    return () => window.clearTimeout(t)
  }, [phase])

  const waited = useWaitSeconds(phase === "thinking")
  const reconnecting = live && !!call.reconnecting

  // Review mode: its keys, readout and draft panel come from the review view.
  const rc = call.review
  const rs = rc?.state
  const reviewOn = !!rs && (rs.mode === "review" || (!!rs.ended && !!rs.draft))
  const rv = reviewOn && rs ? reviewView({ phase, agentName, reconnecting, waited, review: rs }) : null
  const leftArmed = useRearm(rv ? `${rv.left.action}:${rs?.draft?.id ?? ""}` : "auto", REARM_MS)
  const rightArmed = useRearm(rv ? `${rv.right.action}:${rs?.draft?.id ?? ""}` : "auto", REARM_MS)
  const switchingToReview = !reviewOn && rs?.pending?.op === "mode" && rs.pending.to === "review"
  const runKey = (action: KeyAction) => {
    if (action === "call") call.start()
    else if (action === "cancel" || action === "end") call.end()
    else if (action === "discard") rc?.discard()
    else if (action === "talk") rc?.talk()
    else if (action === "done") rc?.done()
    else if (action === "send") rc?.send()
  }
  const keysRef = useRef({ rv, rc, rightArmed, draftOpen: false, switching: false })
  keysRef.current = { rv, rc, rightArmed, draftOpen: !!rs?.draft, switching: switchingToReview }

  // Keyboard: space toggles the microphone (in review: talk and done, never send), escape ends the
  // call (never while a review draft is open). Never while a control has focus.
  const { toggleMute, end: endCall, start: startCall } = call
  useEffect(() => {
    if (!cfg.shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return
      const p = phaseRef.current
      const keys = keysRef.current
      if (e.code === "Space" && LIVE_PHASES.has(p)) {
        e.preventDefault()
        // Mid-switch the microphone stays as the switch left it, like the disabled key.
        if (keys.switching) return
        if (!keys.rv) return toggleMute()
        const right = keys.rv.right
        if (right.disabled || !keys.rightArmed) return
        if (right.action === "talk") keys.rc?.talk()
        else if (right.action === "done") keys.rc?.done()
      } else if (e.key === "Escape" && (LIVE_PHASES.has(p) || p === "connecting") && !keys.draftOpen) {
        endCall()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cfg.shortcuts, toggleMute, endCall])
  // The review view speaks for the call while it runs, and for a draft kept after it.
  const reviewReadout = !!rv && phase !== "error" && (live || phase === "connecting" || phase === "idle" || (!!rs?.ended && !!rs.draft))
  const chipClass = reviewReadout
    ? rv.chipTone
    : phase === "idle"
      ? "idle"
      : phase === "ended"
        ? "ended"
        : phase === "error"
          ? "err"
          : phase === "listening"
            ? "you"
            : phase === "thinking"
              ? "think"
              : ""
  const endedSummary =
    endedText && endedText !== "Call ended." ? endedText.replace(/\.$/, "").toLowerCase() : "thanks for calling"
  // Lines are caption segments from both sides, not turns, so the summary leaves a count out.
  const endedHint = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)} · ${endedSummary}.`
  const autoHint =
    phase === "error"
      ? ERROR_HINT[errorKind]
      : reconnecting
        ? "Wait before speaking."
        : live && call.limitNote
          ? call.limitNote
          : phase === "talking"
            ? `Speech is ignored until ${agentName} finishes.`
            : phase === "thinking"
              ? `${muted ? "Unmute to keep talking" : "You can keep talking"} · waiting ${Math.floor(waited / 60)}:${pad(waited % 60)}`
              : muted && live
                ? "Your microphone is muted."
                : phase === "ended"
                  ? endedHint
                  : phase === "listening" && call.silenceMs
                    ? `Go ahead. Pause about ${+(call.silenceMs / 1000).toFixed(1)} s to send.`
                    : HINT[phase]
  const hintText = reviewReadout ? rv.hint : autoHint

  const autoChip = reconnecting
    ? "Reconnecting…"
    : phase === "thinking"
      ? `${agentName} is working`
      : phase === "idle"
        ? "Ready"
        : phase === "connecting"
          ? "Connecting…"
          : phase === "listening"
            ? muted
              ? "Mic muted"
              : "Listening"
            : phase === "talking"
              ? `${agentName} is speaking`
              : phase === "error"
                ? ERROR_TITLE[errorKind]
                : "Call ended"
  const chipText = reviewReadout ? rv.chip : switchingToReview ? "Switching to review" : autoChip
  const readout = (
    <span className={`state-chip ${chipClass}`} role="status" aria-live="polite">
      {live && phase !== "connecting" && <span className="pulse" aria-hidden="true" />}
      {phase === "thinking" && !reconnecting && !reduced && (reviewReadout ? rv.chipTone === "think" : !switchingToReview) ? (
        <ShimmeringText className="shimmer" text={chipText} duration={1.4} />
      ) : (
        chipText
      )}
    </span>
  )
  // In review the limit warning keeps its own line: it must not hide why a key is off.
  const limitLine = reviewReadout && live && call.limitNote ? <p className="limit-note">{call.limitNote}</p> : null
  const modeRow = rc && (
    <ModeRow
      mode={rc.state.mode}
      pendingTo={rc.state.pending?.op === "mode" ? (rc.state.pending.to ?? null) : null}
      available={rc.state.available}
      disabled={phase === "connecting" || (rv ? rv.modeDisabled : !!rc.state.pending || reconnecting)}
      note={rc.state.note}
      onPick={rc.setMode}
    />
  )
  const draftPanel = rv?.panel ? <DraftPanel panel={rv.panel} /> : null

  // The newest delivery mark decides: a lost turn stays on screen until a later one is sent.
  const lastMark = useMemo(() => lines.findLast((l) => l.mark)?.mark, [lines])
  const deliveryNotice =
    lastMark?.status === "lost" ? (
      <p className="delivery-notice" role="status">
        {`Last turn: ${(lastMark.reason && LOST_NOTICE[lastMark.reason]) || "not sent."}`}
      </p>
    ) : null
  const hearKey =
    call.audioBlocked && call.unlockAudio ? (
      <button type="button" className="hear-key" onClick={call.unlockAudio}>
        {`Tap to hear ${agentName}`}
      </button>
    ) : null
  const sendCueBar = call.sendCue && <SendCueBar key={call.sendCue.id} cue={call.sendCue} reduced={reduced} />

  const showTs = skin === "te" && cfg.timestamps
  const transcript = (
    <Conversation className="transcript-box">
      <ConversationContent className="flex flex-col gap-1 p-1">
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        {lines.length === 0 && !error ? (
          <ConversationEmptyState
            title="Nothing said yet"
            description={
              phase === "connecting"
                ? `Connecting to ${agentName}.`
                : live && reviewOn
                  ? "Sent turns show here."
                  : live
                  ? muted
                    ? "Unmute to speak."
                    : "Speak when ready."
                  : phase === "ended"
                    ? "Call again to keep talking."
                    : `Press call to talk to ${agentName}.`
            }
          />
        ) : (
          lines.map((l, i) => (
            <TranscriptLine
              key={l.id}
              from={l.from}
              text={l.text}
              at={l.at}
              // The lines of the message being spoken read as one: none of them dims yet.
              isLast={i === lines.length - 1 || (l.group !== undefined && l.group === lines[lines.length - 1].group)}
              isStreaming={l.id === streamingId}
              agentName={agentName}
              showTs={showTs}
              mark={l.mark}
              note={l.from === "user" ? (l.turn ? `turn ${l.turn}` : undefined) : l.re}
            />
          ))
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )

  // Whether the line hears the caller, apart from the caller's own mute choice: a reply is never listened over.
  const notListening = live && phase === "talking" && !muted && !call.muteError
  const micLabel = call.muteError
    ? call.muteError
    : muted
      ? "Mic muted"
      : notListening
        ? "Not listening during reply"
        : "Mic on"

  const primaryLabel = live ? "End" : phase === "connecting" ? "Cancel" : phase === "ended" || phase === "error" ? "Call again" : "Call"
  const primaryDisabled = (!token && !demo) || (phase === "connecting" && !cancelArmed)
  const onPrimary = live || phase === "connecting" ? endCall : startCall

  // Review relabels the same two caps; a cap that just changed what it does waits a moment.
  const primary = rv
    ? {
        label: rv.left.label,
        disabled: rv.left.disabled || !leftArmed || ((rv.left.action === "call" || rv.left.action === "cancel") && primaryDisabled),
        onClick: () => runKey(rv.left.action),
        hangup: rv.left.action === "end",
      }
    : { label: primaryLabel, disabled: primaryDisabled, onClick: onPrimary, hangup: live }
  const rightKey = rv && {
    label: rv.right.label,
    disabled: rv.right.disabled || !rightArmed,
    onClick: () => runKey(rv.right.action),
    icon:
      rv.right.action === "done" ? (
        <Square size={13} aria-hidden="true" />
      ) : rv.right.action === "send" ? (
        <ArrowUp size={15} aria-hidden="true" />
      ) : (
        <Mic size={15} aria-hidden="true" />
      ),
  }

  const keys =
    skin === "te" ? (
      <>
        <div className="key key-time">
          <SegmentTimer seconds={live || phase === "ended" ? elapsed : 0} live={live} />
          <span className="label">
            <i className={`led${live ? " on" : ""}`} aria-hidden="true" />
            Time
          </span>
        </div>
        {modeRow}
        <div className="key key-end">
          <button type="button" className="cap orange" onClick={primary.onClick} aria-disabled={primary.disabled} disabled={primary.disabled}>
            {primary.label}
          </button>
          <span className="label">
            <i className={`led${live ? " green" : ""}`} aria-hidden="true" />
            {live ? "On call" : phase === "connecting" ? "Connecting" : phase === "error" ? "Not connected" : "Ready"}
            {cfg.shortcuts && (live || phase === "connecting") && !(rv && rs?.draft) && <kbd>esc</kbd>}
          </span>
        </div>
        <div className="key key-mute">
          {rightKey && rv ? (
            <>
              <button type="button" className={`cap${rv.right.action === "talk" ? " dark" : ""}`} disabled={rightKey.disabled} onClick={rightKey.onClick}>
                {rightKey.icon}
                {rightKey.label}
              </button>
              <span className="label wrap">
                <i className={`led${rv.capturing ? " on" : ""}`} aria-hidden="true" />
                <span>{rv.mic}</span>
                {cfg.shortcuts && (rv.right.action === "talk" || rv.right.action === "done") && <kbd>space</kbd>}
              </span>
            </>
          ) : (
            <>
              <button type="button" className={`cap${muted ? " dark" : ""}`} disabled={!live || switchingToReview} onClick={toggleMute}>
                {muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <span className={`label${notListening ? " wrap" : ""}`}>
                <i className={`led${muted ? " on" : ""}`} aria-hidden="true" />
                <span>{micLabel}</span>
                {cfg.shortcuts && !notListening && <kbd>space</kbd>}
              </span>
            </>
          )}
        </div>
      </>
    ) : (
      <>
        <span className="timer" role="timer" aria-label="Call duration">
          {live ? `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}` : ""}
        </span>
        <Button size="lg" className={`${live || phase === "connecting" ? "btn-hangup" : "btn-call"} h-12 w-full rounded-full text-[15px] font-semibold`} onClick={primary.onClick} disabled={primary.disabled}>
          {primary.hangup ? "Hang up" : primary.label}
        </Button>
        {rightKey ? (
          <Button size="lg" variant="secondary" className="btn-mute h-12 rounded-full" disabled={rightKey.disabled} onClick={rightKey.onClick}>
            {rightKey.icon}
            {rightKey.label}
          </Button>
        ) : (
          <Button size="lg" variant="secondary" className={`btn-mute h-12 rounded-full ${muted ? "on" : ""}`} disabled={!live || switchingToReview} onClick={toggleMute}>
            {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            {muted ? "Unmute" : "Mute"}
          </Button>
        )}
      </>
    )

  const footer = cfg.footer.split("{agent}").join(agentName)

  return (
    <div
      className={`voice-page${reviewOn && rail ? " review-fit" : ""}`}
      data-skin={skin}
      data-layout={rail ? "rail" : "stack"}
      data-colorway={skin === "te" && colorway !== "auto" ? colorway : undefined}
    >
      <main className={`call-card${rail ? " layout-rail" : ""}`} aria-label="Voice call">
        <header className="brand-row">
          {skin === "te" ? (
            <Badge call={call} phase={phase} live={live} reduced={reduced} />
          ) : (
            <div className="tile">
              <img src={logo} alt="" />
              <span className={`presence${live ? " live" : ""}`} aria-hidden="true" />
            </div>
          )}
          <div>
            <h1 className="product-name">{cfg.brand}</h1>
            <p className="agent-line">
              {live
                ? "On a call with "
                : phase === "connecting"
                  ? "Calling "
                  : phase === "ended"
                    ? "Call ended with "
                    : phase === "error"
                      ? "Could not call "
                      : "Ready to call "}
              <strong>{agentName}</strong>
              {call.chat && (live || phase === "connecting" || phase === "ended") && <span>{` → ${call.chat}`}</span>}
            </p>
          </div>
        </header>

        {rail ? (
          <div className="device">
            <section className={`screen${draftPanel ? " has-draft" : ""}`} aria-label="Screen">
              <div className="screen-top">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} compact={!!draftPanel} />
              </div>
              <div className="screen-readout">
                {readout}
                <span className="screen-hint">{hintText}</span>
                {hearKey}
                {sendCueBar}
              </div>
              {deliveryNotice}
              {limitLine}
              <div className="console" aria-label="Live transcript">
                {transcript}
              </div>
              {draftPanel}
            </section>
            <aside className="rail" aria-label="Controls">
              {keys}
            </aside>
          </div>
        ) : (
          <>
            <section className="stage" aria-label="Agent presence">
              <div className="presence-stage">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} />
              </div>
              {readout}
              <p className="hint">{hintText}</p>
              {sendCueBar}
              {hearKey}
              {deliveryNotice}
              {limitLine}
            </section>
            <section aria-label="Live transcript">
              <div className="transcript-head">
                <p className="eyebrow">Live transcript</p>
              </div>
              {transcript}
            </section>
            {draftPanel}
            {skin !== "te" && modeRow}
            <div className="control-bar">{keys}</div>
          </>
        )}

        <div className="foot">
          <p className="footer-line">{demo ? "Demo call. Nothing is connected." : footer}</p>
          {skin === "te" && cfg.colorwayPicker && (
            <div className="colorways" role="radiogroup" aria-label="Colorway">
              {COLORWAYS.map((c) => {
                const checked = colorway === c
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={c}
                    title={c}
                    tabIndex={checked || (colorway === "auto" && c === COLORWAYS[0]) ? 0 : -1}
                    className={`swatch ${c}${checked ? " on" : ""}`}
                    onClick={() => setColorway(c)}
                    onKeyDown={(e) => onColorwayKey(e, checked ? c : COLORWAYS[0])}
                  />
                )
              })}
            </div>
          )}
        </div>
      </main>
      <audio ref={call.audioRef} autoPlay playsInline className="sr-only" />
    </div>
  )
}
