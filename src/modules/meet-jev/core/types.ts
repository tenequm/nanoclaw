/**
 * The contract of the jev call loop (`/voice jev`, `/meet <link> jev`): what the audio part
 * reports (`CallEvent`) and what the decisioning core asks for (`Command`). Pure types; `core/`
 * imports nothing outside itself (ESLint fences it), so every decision is a function of the
 * call's event log, which is also the test fixture and the replay input.
 *
 * Times (`at`) are host epoch milliseconds; an ingress converts its source's clock (Recall's
 * frame timestamps, the worker's marks) on arrival.
 */

export type CallKind = 'voice' | 'meet';

/** A person in the call. `id` is stable for one participant session (a Meet rejoin is a new id). */
export interface Speaker {
  id: string;
  name: string;
}

export type Action = 'answer' | 'stay_silent' | 'stop' | 'continue';
export const ACTIONS: readonly Action[] = ['answer', 'stay_silent', 'stop', 'continue'];

/** Jev's answer to the `action` Choice; null when the call failed or timed out (fail-silent). */
export interface Verdict {
  action: Action;
  /** Probability of every option; sums to 1. */
  probabilities: Record<Action, number>;
  /** How concentrated `probabilities` is (Jev's `confidence`), not how likely it is right. */
  confidence: number;
}

export type CallEvent =
  /** A participant's words: partials update the utterance, the final replaces it. */
  | { kind: 'utterance'; speaker: Speaker; uttId: string; text: string; final: boolean; at: number }
  /** A participant started or stopped speaking (the worker's VAD, or a meeting participant's own). */
  | { kind: 'speech'; speaker: Speaker; on: boolean; at: number }
  /** A typed chat line (Meet chat): context only, never a boundary. */
  | { kind: 'chat'; speaker: Speaker; text: string; at: number }
  /** The answer to a `judge` command, for the window version it was asked on. */
  | { kind: 'verdict'; windowVersion: number; verdict: Verdict | null; ms: number; at: number }
  /** A `wait` command's timer fired. */
  | { kind: 'timer'; key: string; at: number }
  /** A `turn` command reached the agent's session; `turnId` is the host's utterance id for it. */
  | { kind: 'turn'; key: string; turnId: string; at: number }
  /** A `turn` command was refused (limits, access) or replaced before delivery. */
  | { kind: 'turn_failed'; key: string; reason: string; at: number }
  /** An agent message for this call; `turnId` is the turn it answers, null when unprompted. */
  | { kind: 'reply'; replyId: string; turnId: string | null; text: string; at: number }
  /**
   * What became of a `speak` command in the room. `delivered` on `cut_off` is the approximate
   * text that got out before the abort.
   */
  | {
      kind: 'playback';
      replyId: string;
      state: 'started' | 'completed' | 'cut_off' | 'failed';
      delivered?: string;
      at: number;
    };

export type Command =
  /** Ask Jev about the window as of `windowVersion`; the answer comes back as a `verdict`. */
  | { kind: 'judge'; windowVersion: number; state: JevState }
  /** Fire a `timer` event with `key` after `ms`; a new `wait` with the same key replaces it. */
  | { kind: 'wait'; key: string; ms: number }
  | { kind: 'cancel_wait'; key: string }
  /**
   * Submit a turn to the agent: `message` is the trigger utterance (what the call chat shows),
   * `note` the window and the speaking rules. `supersedes`: the key of an earlier turn not yet
   * delivered, which is dropped instead of queued.
   */
  | { kind: 'turn'; key: string; message: string; note: string; supersedes?: string }
  /** Speak a reply into the room. */
  | { kind: 'speak'; replyId: string; text: string }
  /** Show a reply in the call chat without speaking it (a replaced turn, after a stop). */
  | { kind: 'show'; replyId: string; text: string }
  /** Drop a reply: the agent answered `[silent]`. */
  | { kind: 'drop'; replyId: string }
  /**
   * Take back a `speak` whose line has not started: a newer wake replaced its turn. The worker drops
   * it from its queue (reported `cut_off`, nothing delivered); a line already playing plays on.
   */
  | { kind: 'revoke'; replyId: string }
  /** Stop the line playing now and every line queued behind it. */
  | { kind: 'stop_playback' }
  /** One structured log line: every decision and every playback outcome. */
  | { kind: 'log'; event: string; fields: Record<string, unknown> };

/** One line of the window as Jev sees it. `t` is seconds before the newest event. */
export interface JevLine {
  t: number;
  speaker: string;
  text: string;
  /** Said by the agent (from playback reports, not from the reply text). */
  agent?: true;
  /** The agent was cut off here; `text` is what got out. */
  cut_off?: true;
  /** Still being spoken (a partial). */
  partial?: true;
}

/**
 * The JSON `state` of the Jev request: the utterance to decide on, the window, the facts and the
 * policy paragraph. `latest` is named apart from the window: with the window alone, Jev 1.14 judges a
 * question after earlier lines as if those lines were what it decides on.
 */
export interface JevState {
  policy: string;
  agent_name: string;
  participants: string[];
  latest: { speaker: string; text: string } | null;
  window: JevLine[];
  facts: {
    agent_speaking: boolean;
    pending_answer: boolean;
    /** What the agent had said when it was last cut off, while that is the latest thing it did. */
    cut_off_after: string | null;
    agent_last_spoke_s_ago: number | null;
    /** `latest` opens or ends with the agent's name as a vocative ("Dan, ...", "..., Dan?"): addressed, not proof a reply is wanted. */
    addressed_by_name: boolean;
  };
}

/** Thresholds for acting on a verdict's chosen action. */
export interface ActionThreshold {
  p: number;
  confidence: number;
}

/** Everything that differs between the two kinds; the core knows nothing else about them. */
export interface CallPolicy {
  kind: CallKind;
  /** The agent's name as people say it, for the vocative fact, the stop rule and the state. */
  agentName: string;
  /** Other spellings or scripts of the name (voice.vocabulary.txt). */
  agentAliases: string[];
  /** Who the agent is and when it speaks, spliced into the Jev state. */
  paragraph: string;
  /** After a speaker's VAD end with no STT final, the partial is decided on after this long (plus the final's margin). */
  boundaryFallbackMs: number;
  /** The window keeps this much history and at most `windowBytes` of text. */
  windowMs: number;
  windowBytes: number;
  thresholds: Record<Exclude<Action, 'stay_silent'>, ActionThreshold>;
}

/**
 * The pure core as the runtime drives it: per event, `reduce` then `decide` on the new state.
 * `core/window.ts` and `core/decide.ts` implement it; the runtime is generic over `S`.
 */
export interface CallCore<S> {
  initial(policy: CallPolicy, at: number): S;
  reduce(state: S, event: CallEvent): S;
  decide(state: S, event: CallEvent): Command[];
}
