import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, CircleAlert, Copy, Mic, MicOff, Square } from "lucide-react"
import { BarVisualizer, type AgentState as BarState } from "@/components/ui/bar-visualizer"
import { Matrix, digits, loader, wave, type Frame } from "@/components/ui/matrix"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ui/conversation"
import { Message, MessageContent } from "@/components/ui/message"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { Button } from "@/components/ui/button"
import { StreamText } from "@/components/StreamText"
import { readConfig, type VoiceUiConfig } from "@/lib/config"
import { LIVE_PHASES, type ErrorKind, type Phase, type SendCue, type Speaker, type TurnMark, type VoiceCall } from "@/lib/voice-call"
import { MODE_NAME, autoListening, endsInDiscard, keyIdentity, modeCaption, reviewView, wakePhraseOf, type KeyAction, type PanelView, type TurnMode } from "@/lib/review"
import { useLiveKitCall } from "@/lib/livekit-call"
import { useDemoCall } from "@/lib/demo-call"
import logo from "@/assets/nanoclaw-logo.png"

type Colorway = NonNullable<VoiceUiConfig["colorway"]>
/** `auto` follows the device's light or dark setting. */
const COLORWAYS: Colorway[] = ["auto", "ivory", "field", "rabbit"]

const MATRIX_ROWS = 7
const MATRIX_COLS = 14
const BAR_COUNT = 12
const MATRIX_OFF: Frame = Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0))
const BARS_OFF: number[] = Array(BAR_COUNT).fill(0)
/** Waiting for the wake phrase: a dim flat line, the line is open but nothing is taken. */
const MATRIX_SLEEP: Frame = Array.from({ length: MATRIX_ROWS }, (_, r) => Array(MATRIX_COLS).fill(r === Math.floor(MATRIX_ROWS / 2) ? 0.55 : 0))

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
  error: "var(--err)",
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

type LostReason = Exclude<NonNullable<TurnMark["reason"]>, "discarded" | "unaddressed" | "command">

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

function markLabel(mark: TurnMark, text: string): string {
  if (mark.status === "sent" || mark.status === "sending") return mark.status
  if (mark.status === "dropped") {
    if (mark.reason === "command") return endsInDiscard(text) ? "nothing to discard" : "nothing to send"
    return mark.reason === "unaddressed" ? "ignored · no wake phrase" : "discarded"
  }
  if (mark.reason === "timeout") return LOST_REASON.timeout
  // A newer worker may send a reason this page does not know yet.
  const why = mark.reason && LOST_REASON[mark.reason as LostReason]
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
  sleeping = false,
}: {
  call: VoiceCall
  phase: Phase
  live: boolean
  presence: "matrix" | "bars"
  reduced: boolean
  /** A draft shares the screen: the dots shrink before the words do. */
  compact?: boolean
  /** The line waits for the wake phrase: a flat dim line instead of the level. */
  sleeping?: boolean
}) {
  const bars = presence === "bars"
  // Asleep, the stage draws a fixed line: no levels to meter, and nothing to re-render 20 times a second.
  const { levels, glow } = useLevelTicker(call, phase, !sleeping, reduced, bars ? BAR_COUNT : MATRIX_COLS)
  if (bars) {
    // The bars read the same metering as the matrix. Handing the component a
    // MediaStream instead would open an AudioContext on the call's own microphone,
    // which silences the outgoing track on iOS Safari.
    return (
      <div className={`bars-wrap${phase === "listening" && !sleeping ? " you" : ""}`}>
        <BarVisualizer state={BAR_STATE[phase]} volumeBands={sleeping ? BARS_OFF : levels} barCount={BAR_COUNT} centerAlign minHeight={12} className="h-full w-full gap-2 rounded-none bg-transparent p-0" />
      </div>
    )
  }
  const palette = { on: sleeping ? "var(--dot-sleep)" : MATRIX_ON[phase], off: "var(--dot-off)" }
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
      ) : sleeping ? (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_SLEEP} size={size} gap={gap} palette={palette} ariaLabel="Waiting for the wake phrase" />
      ) : live ? (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} mode="vu" levels={levels} size={size} gap={gap} palette={palette} ariaLabel="Voice level" />
      ) : (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_OFF} size={size} gap={gap} brightness={glow} palette={palette} ariaLabel="Idle" />
      )}
    </div>
  )
})

/** Runs a fill from where the worker's countdown stood to full, over what is left of the silence. */
function useCueFill(cue: SendCue, reduced: boolean) {
  const fill = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = fill.current
    if (!el || reduced || typeof el.animate !== "function") return
    const run = el.animate([{ transform: `scaleX(${cue.from})` }, { transform: "scaleX(1)" }], { duration: cue.ms, easing: "linear", fill: "forwards" })
    return () => run.cancel()
  }, [cue, reduced])
  return { fill, style: reduced ? { transform: "scaleX(0.6)" } : { transform: `scaleX(${cue.from})` } }
}

/** The send countdown: a bar along the readout's rule, on a visible track. */
function SendCueBar({ cue, reduced }: { cue: SendCue; reduced: boolean }) {
  const { fill, style } = useCueFill(cue, reduced)
  return (
    <span className="send-cue" aria-hidden="true">
      <i ref={fill} style={style} />
    </span>
  )
}

/** The same countdown filling the readout chip behind its "sending…". */
function ChipFill({ cue, reduced }: { cue: SendCue; reduced: boolean }) {
  const { fill, style } = useCueFill(cue, reduced)
  return <i ref={fill} className="chip-fill" style={style} aria-hidden="true" />
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
  wake,
  awake,
  unspoken,
  preWake,
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
  /** The wake phrase was heard on this line. */
  wake?: boolean
  /** The worker still takes the turn this line opened. */
  awake: boolean
  /** The worker could not speak this agent line. */
  unspoken?: boolean
  /** The line opens with words before the wake phrase, which were ignored. */
  preWake?: boolean
}) {
  const lost = mark?.status === "lost"
  const dropped = mark?.status === "dropped"
  const struck = dropped && mark.reason === "discarded"
  return (
    <Message
      from={from}
      className={`py-1.5 ${isLast ? "is-live" : "is-history"}${lost || unspoken ? " has-lost" : ""}${dropped ? " has-dropped" : ""}${struck ? " has-discarded" : ""}${wake ? " has-wake" : ""}`}
    >
      <MessageContent className={`min-w-0 ${from === "user" ? "bubble-you" : "bubble-agent"}${isStreaming ? " is-streaming" : ""}`}>
        <span className="speaker">
          {from === "user" ? "You" : agentName}
          {showTs && <span className="ts">{`${Math.floor(at / 60)}:${pad(at % 60)}`}</span>}
          {note && <span className="turn-ref">{note}</span>}
          {wake && <span className={`turn-mark wake${!mark && awake ? " awake" : ""}`}>{mark ? "heard" : awake ? "heard - listening" : "heard"}</span>}
          {mark && <span className={`turn-mark ${mark.status}${mark.reason ? ` ${mark.reason}` : ""}`}>{markLabel(mark, text)}</span>}
          {unspoken && <span className="turn-mark lost">reply not spoken</span>}
          {preWake && <span className="turn-mark dropped">words before the wake phrase ignored</span>}
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

/** One on/off switch: a label that wraps, and a track with a knob. Its description lives outside it. */
function Switch({ label, on, disabled, describedBy, onClick }: { label: string; on: boolean; disabled: boolean; describedBy: string; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-describedby={describedBy} className={`sw${on ? " on" : ""}`} disabled={disabled} onClick={onClick}>
      <span className="sw-label">{label}</span>
      <span className="sw-track" aria-hidden="true">
        <i />
      </span>
    </button>
  )
}

/** Auto mode's spoken commands: what they are, the wake switch, and with it the pause switch. */
function CommandsBlock({
  phrase,
  wake,
  pauseSends,
  disabled,
  onWake,
  onPauseSends,
}: {
  phrase: string
  wake: boolean
  pauseSends: boolean
  disabled: boolean
  onWake: (on: boolean) => void
  onPauseSends: (on: boolean) => void
}) {
  return (
    <section className="cmds" aria-labelledby="cmds-title">
      <p className="cmds-head">
        <span id="cmds-title" className="cmds-title">
          Voice commands
        </span>
        <span className="cmds-explain">Say "send it" or "прийом" to send now, "scratch that" to drop it.</span>
      </p>
      <div className={`cmds-switches${wake ? " two" : ""}`}>
        <Switch label={`Wait for "${phrase}"`} on={wake} disabled={disabled} describedBy="wake-desc" onClick={() => onWake(!wake)} />
        {wake && <Switch label="A pause also sends" on={pauseSends} disabled={disabled} describedBy="pause-sends-desc" onClick={() => onPauseSends(!pauseSends)} />}
      </div>
      <span id="wake-desc" className="sr-only">{`Nothing is sent until you say ${phrase}; then say send it to send.`}</span>
      <span id="pause-sends-desc" className="sr-only">
        After the wake phrase a pause sends too, not only send it.
      </span>
    </section>
  )
}

/** The turn mode switch with a line saying what the mode in force does. */
function ModeRow({
  mode,
  pendingTo,
  available,
  disabled,
  commands,
  note,
  onPick,
}: {
  mode: TurnMode
  pendingTo: TurnMode | null
  available: boolean
  disabled: boolean
  commands: boolean
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
              {MODE_NAME[m]}
            </button>
          )
        })}
      </div>
      {(["auto", "review"] as const).map((m) => (
        <span key={m} id={`mode-${m}-desc`} className="sr-only">
          {modeCaption(m, commands)}
        </span>
      ))}
      {/* The selected radio already carries this as its description. */}
      <p className="mode-caption" aria-hidden="true">
        {modeCaption(pendingTo ?? mode, commands)}
      </p>
      {note && (
        <p className="mode-note" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

/** The review draft, pinned under the readout: its own scroller, the header outside it. */
function DraftPanel({ panel, note, copyable }: { panel: PanelView; note: string | null; copyable: boolean }) {
  const body = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  // More text below the fold: the body fades out at its foot.
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = body.current
    if (el) setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2)
  }, [])
  useEffect(() => {
    measure()
    const el = body.current
    if (!el || typeof ResizeObserver !== "function") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, panel.text])
  const [copied, setCopied] = useState<"done" | "failed" | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(null), 2000)
    return () => window.clearTimeout(t)
  }, [copied])
  const copy = () => {
    const done = navigator.clipboard?.writeText(panel.text)
    if (!done) return setCopied("failed")
    done.then(
      () => setCopied("done"),
      () => setCopied("failed")
    )
  }
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
        {copyable && panel.text && (
          <button type="button" className="draft-copy" onClick={copy}>
            <Copy size={13} aria-hidden="true" />
            {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
          </button>
        )}
      </header>
      {note && (
        <p className="draft-refusal" role="status">
          {note}
        </p>
      )}
      <div
        ref={body}
        className={`draft-body${more ? " has-more" : ""}`}
        tabIndex={0}
        aria-label="Draft text"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 2
          measure()
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

/** True for a moment each time `count` grows: the readout flashes once per wake. */
function useFlash(count: number, ms: number): boolean {
  const seen = useRef(count)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (count <= seen.current) {
      seen.current = count
      return
    }
    seen.current = count
    setOn(true)
    const t = window.setTimeout(() => setOn(false), ms)
    return () => window.clearTimeout(t)
  }, [count, ms])
  return on
}

const REARM_MS = 500
const WAKE_FLASH_MS = 1200

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== "function") return false
  return !!el.closest("button, a, input, textarea, select, [contenteditable], [role='radio'], [role='button'], [role='switch']")
}

const clock = (s: number) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`

export default function App() {
  const cfg = useMemo(readConfig, [])
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const token = params.get("t") || ""
  // `?demo=1` plays an auto mode call, `?demo=wake` one with the wake switch, `?demo=review` a review
  // mode one, `?demo=cues` the call notes (wake heard, speech over a reply, a reply not spoken, a lone
  // send word, the countdown); `&step=<n>` stops at step n.
  const demoMode = params.get("demo")
  const demo = demoMode === "1" || demoMode === "review" || demoMode === "wake" || demoMode === "cues"
  const demoStep = Number.parseInt(params.get("step") ?? "", 10)
  const liveKitCall = useLiveKitCall(demo ? "" : token, "your agent")
  const demoCall = useDemoCall(demo, demoMode === "review" || demoMode === "wake" || demoMode === "cues" ? demoMode : "auto", Number.isInteger(demoStep) && demoStep >= 0 ? demoStep : null)
  const call = demo ? demoCall : liveKitCall
  const { phase, lines, streamingId, agentName, elapsed, muted, error, endedText } = call
  const errorKind = call.errorKind ?? "other"
  const live = LIVE_PHASES.has(phase)
  const inCall = live || phase === "connecting"
  const skin = cfg.skin
  const rail = skin === "te" && cfg.layout === "rail"
  const reduced = useReducedMotion()
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const [colorway, setColorway] = useState<Colorway>(() => {
    try {
      const v = localStorage.getItem("voice-colorway")
      if (v === "auto" || v === "ivory" || v === "field" || v === "rabbit") return v
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
  const keptDraft = !!rs?.ended && !!rs.draft
  const rv = reviewOn && rs ? reviewView({ phase, agentName, reconnecting, waited, review: rs }) : null
  const leftArmed = useRearm(keyIdentity(rv ? rv.left.action : live || phase === "connecting" ? "end" : null, rs?.draft?.id), REARM_MS)
  const rightArmed = useRearm(rv ? `${rv.right.action}:${rs?.draft?.id ?? ""}` : "auto", REARM_MS)
  const switchingToReview = !reviewOn && rs?.pending?.op === "mode" && rs.pending.to === "review"
  const wakeFlash = useFlash(rs?.wakeHeard ?? 0, WAKE_FLASH_MS)
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
  const reviewReadout = !!rv && phase !== "error" && (live || phase === "connecting" || phase === "idle" || keptDraft)
  // What sends a turn in auto, and the wake phrase while the worker waits for it.
  const listening = rs ? autoListening({ agentName, review: rs }) : null
  // Auto with the wake switch, before the phrase: the line is open but nothing is taken.
  const waitingWake = !reviewReadout && phase === "listening" && !muted && !reconnecting && !!rs?.wake && !!rs.awaitingWake && !!rs.commands
  // The worker's countdown to sending the caller's turn, shown on the readout itself.
  const counting = !reviewReadout && phase === "listening" && !reconnecting && !!call.sendCue
  const chipClass = reviewReadout
    ? rv.chipTone
    : phase === "idle"
      ? "idle"
      : phase === "ended"
        ? "ended"
        : phase === "error"
          ? "err"
          : reconnecting
            ? ""
            : phase === "listening"
              ? muted || waitingWake
                ? "off"
                : "you"
              : phase === "thinking"
                ? "think"
                : ""
  const endedSummary =
    endedText && endedText !== "Call ended." ? endedText.replace(/\.$/, "").toLowerCase() : "thanks for calling"
  // Lines are caption segments from both sides, not turns, so the summary leaves a count out.
  const endedHint = `${clock(elapsed)} · ${endedSummary}.`
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
                  : counting
                    ? "Keep talking to add more."
                    : phase === "listening" && listening
                      ? listening.hint
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
              : counting
                ? "Sending…"
                : (listening?.chip ?? "Listening")
            : phase === "talking"
              ? `${agentName} is speaking`
              : phase === "error"
                ? ERROR_TITLE[errorKind]
                : "Call ended"
  const chipText = reviewReadout ? rv.chip : switchingToReview ? "Switching to review" : autoChip
  const errChip = chipClass === "err"
  const readout = (
    <span className={`state-chip ${chipClass}${counting ? " counting" : ""}${wakeFlash && !reduced ? " flash" : ""}`} role="status" aria-live="polite">
      {counting && call.sendCue && <ChipFill key={call.sendCue.id} cue={call.sendCue} reduced={reduced} />}
      {errChip ? <CircleAlert className="chip-glyph" size={16} aria-hidden="true" /> : live && phase !== "connecting" && <span className="pulse" aria-hidden="true" />}
      <span className="chip-text">
        {phase === "thinking" && !reconnecting && !reduced && (reviewReadout ? rv.chipTone === "think" : !switchingToReview) ? (
          <ShimmeringText className="shimmer" text={chipText} duration={1.4} />
        ) : (
          chipText
        )}
      </span>
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
      commands={rc.state.commands}
      note={rv?.panel ? null : rc.state.note}
      onPick={rc.setMode}
    />
  )
  const commandsBlock = rc && rc.state.mode === "auto" && !rv && rc.state.commands && (
    <CommandsBlock
      phrase={wakePhraseOf(rc.state, agentName)}
      wake={rc.state.wake}
      pauseSends={rc.state.pauseSends}
      disabled={phase === "connecting" || reconnecting || !!rc.state.pending}
      onWake={rc.setWake}
      onPauseSends={rc.setPauseSends}
    />
  )
  // A refusal about the draft ("send or discard first") shows on the draft, not under the switch.
  const draftPanel = rv?.panel ? <DraftPanel panel={rv.panel} note={rs?.note ?? null} copyable={keptDraft} /> : null

  // The newest delivery mark decides: a lost turn stays on screen until a later one is sent.
  const lastMark = useMemo(() => lines.findLast((l) => l.mark && l.mark.status !== "dropped")?.mark, [lines])
  const deliveryNotice =
    lastMark?.status === "lost" ? (
      <p className="delivery-notice" role="status">
        {`Last turn: ${(lastMark.reason && LOST_NOTICE[lastMark.reason as LostReason]) || "not sent."}`}
      </p>
    ) : null
  const hearKey =
    call.audioBlocked && call.unlockAudio ? (
      <button type="button" className="hear-key" onClick={call.unlockAudio}>
        {`Tap to hear ${agentName}`}
      </button>
    ) : null
  const sendCueBar = counting && call.sendCue && <SendCueBar key={call.sendCue.id} cue={call.sendCue} reduced={reduced} />

  const showTs = skin === "te" && cfg.timestamps
  const awake = live && !!rs?.wake && !rs.awaitingWake
  // The lines of the message being spoken read as one; notes never count as the newest line.
  const lastLine = lines.findLast((l) => !l.kind)
  const transcript = (
    <Conversation className="transcript-box">
      <ConversationContent className="flex flex-col gap-1 px-1 pt-4 pb-1">
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        {lines.length === 0 && !error ? (
          // A draft on screen is the thing to read: no empty state competes with it.
          draftPanel ? null : (
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
                        : (listening?.empty ?? "Speak when ready.")
                      : phase === "ended"
                        ? "Call again to keep talking."
                        : `Press call to talk to ${agentName}.`
              }
            />
          )
        ) : (
          lines.map((l, i) =>
            l.kind === "unheard" ? (
              <p key={l.id} className="call-note">
                {`Not heard - ${agentName} was speaking.`}
              </p>
            ) : (
              <TranscriptLine
                key={l.id}
                from={l.from}
                text={l.text}
                at={l.at}
                isLast={l === lastLine || (l.group !== undefined && l.group === lastLine?.group)}
                isStreaming={l.id === streamingId}
                agentName={agentName}
                showTs={showTs}
                mark={l.mark}
                // A turn's number shows once, on its first line.
                note={l.from === "user" ? (l.turn && !(i > 0 && lines[i - 1].from === "user" && lines[i - 1].turn === l.turn) ? `turn ${l.turn}` : undefined) : l.re}
                wake={l.wake}
                awake={awake}
                unspoken={l.unspoken}
                preWake={l.preWake}
              />
            )
          )
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
  // The one LED: lit while the microphone actually feeds the call.
  const micCapturing = rv ? rv.capturing || rv.mic === "Mic still on" : live && !muted && !notListening

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
        // Discard is the quiet choice next to send; every other left key keeps the accent.
        neutral: rv.left.action === "discard",
      }
    : { label: primaryLabel, disabled: primaryDisabled, onClick: onPrimary, hangup: live, neutral: false }
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
  // The microphone key and the call clock belong to a call: none before it, after it or on an error.
  const showRight = inCall || keptDraft
  const callClock = clock(live || phase === "ended" ? elapsed : 0)

  const keys =
    skin === "te" ? (
      <>
        {inCall && (
          <div className="key key-time">
            <SegmentTimer seconds={live ? elapsed : 0} live={live} />
            <span className="label">Time</span>
          </div>
        )}
        {modeRow}
        {commandsBlock}
        <div className={`keys${showRight ? "" : " one"}`}>
          <div className="key key-end">
            <button type="button" className={`cap${primary.neutral ? "" : " orange"}`} onClick={primary.onClick} aria-disabled={primary.disabled} disabled={primary.disabled}>
              {primary.label}
            </button>
            <span className="label">
              {live ? "On call" : phase === "connecting" ? "Connecting" : phase === "error" ? "Not connected" : keptDraft ? "Draft kept" : "Ready"}
              {cfg.shortcuts && (live || phase === "connecting") && !(rv && rs?.draft) && <kbd>esc</kbd>}
            </span>
          </div>
          {showRight && (
            <div className="key key-mute">
              {rightKey && rv ? (
                <>
                  <button
                    type="button"
                    className={`cap${rv.right.action === "send" && !rightKey.disabled ? " orange" : rv.right.action === "talk" ? " dark" : ""}`}
                    disabled={rightKey.disabled}
                    onClick={rightKey.onClick}
                  >
                    {rightKey.icon}
                    {rightKey.label}
                  </button>
                  <span className="label wrap">
                    <i className={`led${micCapturing ? " on" : ""}`} aria-hidden="true" />
                    <span>{rv.mic}</span>
                    {cfg.shortcuts && live && (rv.right.action === "talk" || rv.right.action === "done") && <kbd>space</kbd>}
                  </span>
                </>
              ) : (
                <>
                  <button type="button" className={`cap${muted ? " dark" : ""}`} disabled={!live || switchingToReview} onClick={toggleMute}>
                    {muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <span className={`label${notListening ? " wrap" : ""}`}>
                    <i className={`led${micCapturing ? " on" : ""}`} aria-hidden="true" />
                    <span>{live ? micLabel : "Mic off"}</span>
                    {cfg.shortcuts && live && !notListening && <kbd>space</kbd>}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </>
    ) : (
      <>
        <span className="timer" role="timer" aria-label="Call duration">
          {live ? callClock : ""}
        </span>
        <Button
          size="lg"
          className={`${primary.neutral ? "btn-mute" : live || phase === "connecting" ? "btn-hangup" : "btn-call"} h-12 w-full rounded-full text-[15px] font-semibold`}
          onClick={primary.onClick}
          disabled={primary.disabled}
        >
          {primary.hangup ? "Hang up" : primary.label}
        </Button>
        {!showRight ? null : rightKey ? (
          <Button size="lg" variant="secondary" className={`${rv?.right.action === "send" && !rightKey.disabled ? "btn-call" : "btn-mute"} h-12 rounded-full`} disabled={rightKey.disabled} onClick={rightKey.onClick}>
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
      className={`voice-page${inCall ? " in-call" : ""}${draftPanel ? " has-draft" : ""}`}
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
          <div className="min-w-0">
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
          {/* Where the dot timer has no room (phones, landscape), the clock sits in the header. */}
          {skin === "te" && inCall && (
            <span className="head-time" role="timer" aria-label="Call duration">
              {callClock}
            </span>
          )}
        </header>

        {rail ? (
          <div className="device">
            <section className="screen" aria-label="Screen">
              <div className="screen-top">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} compact={!!draftPanel} sleeping={waitingWake} />
              </div>
              <div className="screen-readout">
                {readout}
                <span className="screen-hint">{hintText}</span>
                {hearKey}
                {sendCueBar}
              </div>
              {deliveryNotice}
              {limitLine}
              {draftPanel}
              <div className="console" aria-label="Live transcript">
                {transcript}
              </div>
            </section>
            <aside className="rail" aria-label="Controls">
              {keys}
            </aside>
          </div>
        ) : (
          <>
            <section className="stage" aria-label="Agent presence">
              <div className="presence-stage">
                <Stage call={call} phase={phase} live={live} presence={cfg.presence} reduced={reduced} sleeping={waitingWake} />
              </div>
              {readout}
              <p className="hint">{hintText}</p>
              {sendCueBar}
              {hearKey}
              {deliveryNotice}
              {limitLine}
            </section>
            {draftPanel}
            <section aria-label="Live transcript">
              <div className="transcript-head">
                <p className="eyebrow">Live transcript</p>
              </div>
              {transcript}
            </section>
            {skin !== "te" && modeRow}
            {skin !== "te" && commandsBlock}
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
                    title={c === "auto" ? "auto: follows the device's light or dark setting" : c}
                    tabIndex={checked ? 0 : -1}
                    className={`swatch ${c}${checked ? " on" : ""}`}
                    onClick={() => setColorway(c)}
                    onKeyDown={(e) => onColorwayKey(e, c)}
                  >
                    <i aria-hidden="true" />
                    <span>{c}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </main>
      <audio ref={call.audioRef} autoPlay playsInline className="sr-only" />
      {call.cueAudioRef && <audio ref={call.cueAudioRef} autoPlay playsInline className="sr-only" />}
    </div>
  )
}
