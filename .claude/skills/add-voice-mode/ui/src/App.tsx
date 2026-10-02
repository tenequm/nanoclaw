import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff } from "lucide-react"
import { Matrix, digits, loader, wave, type Frame } from "@/components/ui/matrix"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ui/conversation"
import { Message, MessageContent } from "@/components/ui/message"
import { ShimmeringText } from "@/components/ui/shimmering-text"
import { StreamText } from "@/components/StreamText"
import { LIVE_PHASES, type ErrorKind, type Phase, type SendCue, type Speaker, type TurnMark, type VoiceCall } from "@/lib/voice-call"
import { useLiveKitCall } from "@/lib/livekit-call"
import { useDemoCall } from "@/lib/demo-call"

const MATRIX_ROWS = 7
const MATRIX_COLS = 14
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

const FOOTER = "Voice mode · answers by {agent}"

// What the readout says when nothing more specific applies; the other phases have their own lines below.
const HINT: Record<"idle" | "connecting" | "listening", string> = {
  idle: "Allow the microphone when asked.",
  connecting: "Setting up the call.",
  listening: "Go ahead. A pause sends what you said.",
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
  if (mark.status === "sent") return "sent"
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

const Stage = memo(function Stage({ call, phase, live, reduced }: { call: VoiceCall; phase: Phase; live: boolean; reduced: boolean }) {
  const { levels, glow } = useLevelTicker(call, phase, true, reduced)
  const palette = { on: MATRIX_ON[phase], off: "var(--dot-off)" }
  return (
    <div className="matrix-wrap">
      {phase === "thinking" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={loader[0]} size={12} gap={3} palette={palette} ariaLabel="Agent is thinking" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={loader} fps={12} size={12} gap={3} palette={palette} ariaLabel="Agent is thinking" />
        )
      ) : phase === "connecting" ? (
        reduced ? (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={wave[0]} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Connecting" />
        ) : (
          <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} frames={wave} fps={20} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Connecting" />
        )
      ) : live ? (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} mode="vu" levels={levels} size={12} gap={3} palette={palette} ariaLabel="Voice level" />
      ) : (
        <Matrix rows={MATRIX_ROWS} cols={MATRIX_COLS} pattern={MATRIX_OFF} size={12} gap={3} brightness={glow} palette={palette} ariaLabel="Idle" />
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
  mark,
  note,
}: {
  from: Speaker
  text: string
  at: number
  isLast: boolean
  isStreaming: boolean
  agentName: string
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
          <span className="ts">{`${Math.floor(at / 60)}:${pad(at % 60)}`}</span>
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

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== "function") return false
  return !!el.closest("button, a, input, textarea, select, [contenteditable], [role='radio'], [role='button']")
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const token = params.get("t") || ""
  const demo = params.get("demo") === "1"
  const liveKitCall = useLiveKitCall(demo ? "" : token, "your agent")
  const demoCall = useDemoCall(demo)
  const call = demo ? demoCall : liveKitCall
  const { phase, lines, streamingId, agentName, elapsed, muted, error, endedText } = call
  const errorKind = call.errorKind ?? "other"
  const live = LIVE_PHASES.has(phase)
  const reduced = useReducedMotion()
  const phaseRef = useRef(phase)
  phaseRef.current = phase

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

  // Keyboard: space toggles the microphone, escape ends the call. Never while a control has focus.
  const { toggleMute, end: endCall, start: startCall } = call
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return
      const p = phaseRef.current
      if (e.code === "Space" && LIVE_PHASES.has(p)) {
        e.preventDefault()
        toggleMute()
      } else if (e.key === "Escape" && (LIVE_PHASES.has(p) || p === "connecting")) {
        endCall()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggleMute, endCall])

  const waited = useWaitSeconds(phase === "thinking")
  const reconnecting = live && !!call.reconnecting
  const chipClass =
    phase === "idle" ? "idle" : phase === "ended" ? "ended" : phase === "error" ? "err" : phase === "listening" ? "you" : phase === "thinking" ? "think" : ""
  const endedSummary =
    endedText && endedText !== "Call ended." ? endedText.replace(/\.$/, "").toLowerCase() : "thanks for calling"
  // Lines are caption segments from both sides, not turns, so the summary leaves a count out.
  const endedHint = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)} · ${endedSummary}.`
  const hintText =
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
                    : HINT[phase as keyof typeof HINT]

  const chipText = reconnecting
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
  const readout = (
    <span className={`state-chip ${chipClass}`} role="status" aria-live="polite">
      {live && phase !== "connecting" && <span className="pulse" aria-hidden="true" />}
      {phase === "thinking" && !reconnecting && !reduced ? <ShimmeringText className="shimmer" text={chipText} duration={1.4} /> : chipText}
    </span>
  )

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

  const keys = (
    <>
      <div className="key key-time">
        <SegmentTimer seconds={live || phase === "ended" ? elapsed : 0} live={live} />
        <span className="label">
          <i className={`led${live ? " on" : ""}`} aria-hidden="true" />
          Time
        </span>
      </div>
      <div className="key key-end">
        <button type="button" className="cap orange" onClick={onPrimary} aria-disabled={primaryDisabled} disabled={primaryDisabled}>
          {primaryLabel}
        </button>
        <span className="label">
          <i className={`led${live ? " green" : ""}`} aria-hidden="true" />
          {live ? "On call" : phase === "connecting" ? "Connecting" : phase === "error" ? "Not connected" : "Ready"}
          {(live || phase === "connecting") && <kbd>esc</kbd>}
        </span>
      </div>
      <div className="key key-mute">
        <button type="button" className={`cap${muted ? " dark" : ""}`} disabled={!live} onClick={toggleMute}>
          {muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
          {muted ? "Unmute" : "Mute"}
        </button>
        <span className={`label${notListening ? " wrap" : ""}`}>
          <i className={`led${muted ? " on" : ""}`} aria-hidden="true" />
          <span>{micLabel}</span>
          {!notListening && <kbd>space</kbd>}
        </span>
      </div>
    </>
  )

  const footer = FOOTER.split("{agent}").join(agentName)

  return (
    <div className="voice-page">
      <main className="call-card" aria-label="Voice call">
        <header className="brand-row">
          <Badge call={call} phase={phase} live={live} reduced={reduced} />
          <div>
            <h1 className="product-name">NanoClaw Voice</h1>
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

        <div className="device">
          <section className="screen" aria-label="Screen">
            <div className="screen-top">
              <Stage call={call} phase={phase} live={live} reduced={reduced} />
            </div>
            <div className="screen-readout">
              {readout}
              <span className="screen-hint">{hintText}</span>
              {hearKey}
              {sendCueBar}
            </div>
            {deliveryNotice}
            <div className="console" aria-label="Live transcript">
              {transcript}
            </div>
          </section>
          <aside className="rail" aria-label="Controls">
            {keys}
          </aside>
        </div>

        <div className="foot">
          <p className="footer-line">{demo ? "Demo call. Nothing is connected." : footer}</p>
        </div>
      </main>
      <audio ref={call.audioRef} autoPlay playsInline className="sr-only" />
    </div>
  )
}
