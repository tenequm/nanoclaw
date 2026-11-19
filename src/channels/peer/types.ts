/**
 * Milliseconds since the Unix epoch.
 */
export type Ms = number;
/**
 * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
 */
export type Uuid = string;
/**
 * "pm_" + base64url (no padding) of the first 16 bytes of SHA-256(SPKI DER of the machine key) (*proposed*, contract.md section 4).
 */
export type MachineId = string;
/**
 * <pid> + "-" + first 8 hex of SHA-256(procStart as the registry stores it) (*proposed*, contract.md section 6).
 */
export type SessionKey = string;
/**
 * Minted by the hub; also the envelope's from-session, so it fits that grammar.
 */
export type EndpointId = string;
/**
 * A session or project label of an address (D13).
 */
export type Label = string;
/**
 * The enrolled machine name.
 */
export type MachineName = string;
/**
 * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
 */
export type Address = string;
/**
 * An address as a sender wrote it; the hub resolves it or refuses with bad_address, not_found or ambiguous.
 */
export type AddressInput = string;
/**
 * The sending session's real permission class (R13).
 */
export type FromMode = 'bypass' | 'prompting';
export type PeerStatus = 'idle' | 'busy' | 'offline';
export type Kind = 'agent' | 'session';
/**
 * A connection epoch (contract.md section 5).
 */
export type Epoch = number;
/**
 * Claude Code's hop-chain tokens, carried unchanged end to end; never minted or read by amesh or the hub.
 *
 * @maxItems 32
 */
export type HopChain = string[];
/**
 * Stable error codes; an open set, so an unknown code is handled by its status class (contract.md section 14).
 */
export type ErrorCode =
  | 'bad_request'
  | 'bad_body'
  | 'empty_text'
  | 'slash_command'
  | 'bad_address'
  | 'bad_cursor'
  | 'bad_signature'
  | 'unknown_machine'
  | 'stale_timestamp'
  | 'replayed'
  | 'machine_revoked'
  | 'not_member'
  | 'not_a_party'
  | 'not_found'
  | 'not_running'
  | 'unknown_session'
  | 'unknown_endpoint'
  | 'ambiguous'
  | 'id_conflict'
  | 'hop_limit'
  | 'queue_full'
  | 'machine_in_use'
  | 'superseded'
  | 'too_large'
  | 'protocol'
  | 'upgrade_required'
  | 'rate_limited'
  | 'internal'
  | 'unavailable';
/**
 * queued (stored at the hub); sent (the receiving daemon's heartbeat cursor passed it, or any later report for it arrived, D39);
 * accepted (written to the inbox, no negative receipt within acceptWindowMs; final);
 * held (Claude Code holds it for approval); delivered, denied, expired (final, from a
 * hold); refused (the session refuses peers; final); dropped (with a reason; final);
 * unknown (open when the daemon restarted; final, never told, D25). Open set: an unknown
 * state is logged and treated as not final.
 */
export type DeliveryState =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'held'
  | 'delivered'
  | 'denied'
  | 'expired'
  | 'refused'
  | 'dropped'
  | 'unknown';
/**
 * Claude Code's guard (rate-limited, queue-full: retried after pacing, then dropped;
 * duplicate, hop-loop, hop-runaway: never retried); oversized (over the native line
 * limit, refused before writing); session_gone (the inbox no longer accepts);
 * unknown_session (the daemon does not host that key, L18); queue_expired (past
 * queueTtlMs, D19); ended (the target ended with it queued). Open set.
 */
export type DropReason =
  | 'rate-limited'
  | 'queue-full'
  | 'duplicate'
  | 'hop-loop'
  | 'hop-runaway'
  | 'oversized'
  | 'session_gone'
  | 'unknown_session'
  | 'queue_expired'
  | 'ended';
export type Report = StateReport | IdleReport;
/**
 * Every event kind, discriminated by `kind`, which equals the SSE `event` field. Open
 * set: an event of an unknown kind is logged and ignored, and still advances the cursor
 * when it has an SSE id.
 */
export type PeerEvent =
  | EndpointEvent
  | MessageEvent
  | DeliveryEvent
  | LimitEvent
  | IdleEvent
  | StatusEvent
  | SynchronizedEvent
  | RevokedEvent
  | SupersededEvent;
/**
 * One SSE event of `GET /peer/events`. `data` is one line of JSON, a `PeerEvent` whose
 * `kind` equals `event`. Log events (endpoint, message, delivery, limit, idle) carry `id`
 * equal to their `seq` and move the cursor; status, synchronized, revoked and superseded
 * carry no `id`.
 */
export type EventStreamItem = {
  event: string;
  data: string;
  id?: string;
  retry?: number;
} & EventStreamItem1;
export type EventStreamItem1 =
  | {
      event: 'endpoint' | 'message' | 'delivery' | 'limit' | 'idle';
    }
  | {
      event: 'status' | 'synchronized' | 'revoked' | 'superseded';
      id?: never;
    };
/**
 * "uds:" + a socket path, characters outside [A-Za-z0-9:_/.-] percent-encoded, at most 300 characters.
 */
export type NativeAddress = string;
export type HookInput = HookInputUserPromptSubmit | HookInputPreToolUse;
/**
 * A UserPromptSubmit prompt starting with any of these was not typed by a human (s-edge Q1); the daemon answers 204.
 */
export type NotHumanPromptPrefixes = string[];
/**
 * "ln_" + first 16 hex of SHA-256("amesh-ln-id" LF parent argument LF child sessionId) (*proposed*, contract.md section 18); also the lane frames' from-session.
 */
export type LaneId = string;
/**
 * send_message result. A refusal is an answer, not an error (isError false).
 */
export type McpSendResult =
  | {
      accepted: true;
      to: Address;
      id: Uuid;
      note: string;
    }
  | {
      accepted: false;
      reason: string;
      /**
       * Candidates, or the directory's addresses for not_found.
       */
      known: Address[];
    };
/**
 * send_to_parent result.
 */
export type McpSendToParentResult =
  | {
      accepted: true;
      to: 'parent';
      id: Uuid;
    }
  | {
      accepted: false;
      reason: string;
    };

export interface PeerSchemas {
  Ms: Ms;
  Uuid: Uuid;
  MachineId: MachineId;
  SessionKey: SessionKey;
  EndpointId: EndpointId;
  Label: Label;
  MachineName: MachineName;
  Address: Address;
  AddressInput: AddressInput;
  FromMode: FromMode;
  PeerStatus: PeerStatus;
  Kind: Kind;
  Epoch: Epoch;
  Hop: Hop;
  HopChain: HopChain;
  ErrorCode: ErrorCode;
  ErrorBody: ErrorBody;
  HelloInfo: HelloInfo;
  HelloRequest: HelloRequest;
  Settings: Settings;
  Limits: Limits;
  HelloResponse: HelloResponse;
  SessionRegisterRequest: SessionRegisterRequest;
  SessionInfo: SessionInfo;
  SessionRegisterResponse: SessionRegisterResponse;
  HeartbeatRequest: HeartbeatRequest;
  HeartbeatResponse: HeartbeatResponse;
  HumanTurnRequest: HumanTurnRequest;
  HumanTurnResponse: HumanTurnResponse;
  SessionEndRequest: SessionEndRequest;
  SessionEndResponse: SessionEndResponse;
  Peer: Peer;
  PeersResponse: PeersResponse;
  SendRequest: SendRequest;
  EndpointRef: EndpointRef;
  SendResponse: SendResponse;
  DeliveryState: DeliveryState;
  DropReason: DropReason;
  StateReport: StateReport;
  IdleReport: IdleReport;
  Report: Report;
  ReportsRequest: ReportsRequest;
  ReportsResponse: ReportsResponse;
  EndpointEvent: EndpointEvent;
  MessageEvent: MessageEvent;
  DeliveryEvent: DeliveryEvent;
  LimitEvent: LimitEvent;
  IdleEvent: IdleEvent;
  StatusEvent: StatusEvent;
  SynchronizedEvent: SynchronizedEvent;
  RevokedEvent: RevokedEvent;
  SupersededEvent: SupersededEvent;
  PeerEvent: PeerEvent;
  EventStreamItem: EventStreamItem;
  NativeUserFrame: NativeUserFrame;
  NativeAddress: NativeAddress;
  NativeNotifyWhenIdle: NativeNotifyWhenIdle;
  NativeReceipt: NativeReceipt;
  NativeIdleNotice: NativeIdleNotice;
  HookInputUserPromptSubmit: HookInputUserPromptSubmit;
  HookInputPreToolUse: HookInputPreToolUse;
  HookInput: HookInput;
  HookOutputPreToolUse: HookOutputPreToolUse;
  NotHumanPromptPrefixes: NotHumanPromptPrefixes;
  LocalError: LocalError;
  DaemonStatus: DaemonStatus;
  LaneId: LaneId;
  McpListPeersArguments: McpListPeersArguments;
  McpSendMessageArguments: McpSendMessageArguments;
  McpSendToParentArguments: McpSendToParentArguments;
  McpListPeersResult: McpListPeersResult;
  McpSendResult: McpSendResult;
  McpSendToParentResult: McpSendToParentResult;
  McpCallToolResult: McpCallToolResult;
  TestKey: TestKey;
  MachineIdVector: MachineIdVector;
  SessionKeyVector: SessionKeyVector;
  RelaySocketVector: RelaySocketVector;
  LaneSocketVector: LaneSocketVector;
  SignatureVector: SignatureVector;
  EnvelopeInput: EnvelopeInput;
  EnvelopeVector: EnvelopeVector;
}
export interface Hop {
  /**
   * Messages in this conversation since a human last took part, this one included.
   */
  count: number;
  limit: number;
}
/**
 * Every hub error. `message` is written to be shown to Claude as it is; the daemon branches only on `error`.
 */
export interface ErrorBody {
  error: ErrorCode;
  message: string;
  protocol?: number;
  minProtocol?: number;
  minAmesh?: string;
  serverTime?: Ms;
  /**
   * Seconds.
   */
  retryAfter?: number;
  maxBytes?: number;
  candidates?: Address[];
  hop?: Hop;
  epoch?: Epoch;
  seq?: number;
}
export interface HelloInfo {
  protocol: number;
  minProtocol: number;
  /**
   * What the hub serves (open set) - agents, sessions, hop-limit, idle, later ones.
   */
  features: string[];
  serverTime: Ms;
}
export interface HelloRequest {
  /**
   * The epoch this process held before; null at process start.
   */
  resumeEpoch: Epoch | null;
  /**
   * True only on the first hello after the daemon process started.
   */
  takeover: boolean;
  amesh: {
    version: string;
    os: string;
    arch: string;
  };
  claudeCode: {
    /**
     * Claude Code versions seen in the registry of registered sessions.
     */
    versions: string[];
    /**
     * The registry's peerProtocol the daemon checked (R24).
     */
    peerProtocol: number;
    /**
     * The daemon never connects with a failed startup check.
     */
    nativeCheck: 'ok';
  };
  /**
   * What the daemon does (open set) - receipts, idle, human-turn, later ones.
   */
  capabilities: string[];
}
/**
 * Timing pushed by the hub (L13). The daemon validates the whole object against these
 * bounds; on any violation or missing field it uses the defaults for all of them and logs
 * one warning (*proposed* bounds).
 */
export interface Settings {
  /**
   * Heartbeat period (L10).
   */
  heartbeatMs: number;
  /**
   * Reconnect after this long without stream bytes.
   */
  streamSilenceMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  /**
   * Connected time that resets the backoff.
   */
  backoffResetAfterMs: number;
  /**
   * Silence after an inbox write that means accepted (D25).
   */
  acceptWindowMs: number;
  requestTimeoutMs: number;
  /**
   * How long send_message waits for the hub's answer.
   */
  sendWaitMs: number;
}
/**
 * The hub's limits; informational for the daemon, which checks maxTextBytes before sending.
 */
export interface Limits {
  /**
   * R10 (spec, proposed).
   */
  maxTextBytes: number;
  /**
   * D20.
   */
  hopLimit: number;
  /**
   * D19.
   */
  queueTtlMs: number;
  /**
   * Per target session (*proposed*).
   */
  offlineQueueMax: number;
  /**
   * R21 (spec, proposed); messages only.
   */
  machineRate: {
    limit: number;
    windowMs: number;
  };
  /**
   * L10.
   */
  keepaliveMs: number;
  /**
   * L10.
   */
  offlineAfterMs: number;
}
export interface HelloResponse {
  protocol: number;
  minProtocol: number;
  machine: {
    id: MachineId;
    /**
     * The enrolled machine name.
     */
    name: string;
  };
  epoch: Epoch;
  features: string[];
  settings: Settings;
  limits: Limits;
  serverTime: Ms;
}
export interface SessionRegisterRequest {
  epoch: Epoch;
  /**
   * Claude Code's session id, an attribute (it changes on /clear).
   */
  sessionId: string;
  /**
   * The registry's name, before address normalisation.
   */
  name: string;
  /**
   * user or derived (open set).
   */
  nameSource: string;
  /**
   * The project name (contract.md section 7).
   */
  project: string;
  /**
   * The registry's status; waiting and others map to busy.
   */
  status: 'idle' | 'busy';
  /**
   * cli or sdk-cli (open set).
   */
  entrypoint: string;
  /**
   * The session's Claude Code version.
   */
  claudeCode: string;
  startedAt: Ms;
}
export interface SessionInfo {
  key: SessionKey;
  /**
   * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
   */
  address: string;
  name: string;
  project: string;
  machine: MachineName;
  status: 'idle' | 'busy' | 'offline' | 'ended';
  registeredAt: Ms;
}
export interface SessionRegisterResponse {
  session: SessionInfo;
}
export interface HeartbeatRequest {
  epoch: Epoch;
  /**
   * The persisted low-water mark (D39): every log event at or below it is fully handled; events above it may be too. Sets sent up to it.
   */
  cursor: number;
  /**
   * Every registered session of this machine, complete.
   */
  sessions: {
    key: SessionKey;
    status: 'idle' | 'busy';
  }[];
}
export interface HeartbeatResponse {
  /**
   * Listed but not registered at the hub; the daemon registers them again.
   */
  unknown: SessionKey[];
  /**
   * Registered at the hub but missing from the list; the hub ended them (reason missing).
   */
  ended: SessionKey[];
  serverTime: Ms;
}
export interface HumanTurnRequest {
  epoch: Epoch;
  at: Ms;
  /**
   * prompt; later sources are additive.
   */
  source: string;
}
export interface HumanTurnResponse {
  /**
   * Conversations whose counter went to 0.
   */
  reset: number;
}
export interface SessionEndRequest {
  epoch: Epoch;
  reason: 'exited' | 'excluded' | 'not_hosted';
}
export interface SessionEndResponse {
  session: {
    key: SessionKey;
    status: 'ended';
  };
  /**
   * Messages queued for it, now dropped with reason ended.
   */
  dropped: number;
}
export interface Peer {
  /**
   * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
   */
  address: string;
  kind: Kind;
  /**
   * The agent's name, or the session part of the address.
   */
  name: string;
  /**
   * Null for agents.
   */
  machine: MachineName | null;
  /**
   * Null for agents.
   */
  project: string | null;
  /**
   * An agent is busy while any of its containers runs a turn, else idle; never offline while the hub answers (*proposed*).
   */
  status: 'idle' | 'busy' | 'offline';
  lastSeen: Ms | null;
}
export interface PeersResponse {
  peers: Peer[];
  serverTime: Ms;
}
export interface SendRequest {
  epoch: Epoch;
  /**
   * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
   */
  id: string;
  from: {
    session: SessionKey;
  };
  /**
   * A start names an address; a native reply names the endpoint it answers.
   */
  to:
    | {
        address: AddressInput;
      }
    | {
        endpoint: EndpointId;
      };
  /**
   * At least one non-whitespace character, at most maxTextBytes UTF-8 bytes, never starting with "/" after leading whitespace (R10, R11).
   */
  text: string;
  hopChain: HopChain;
  fromMode: FromMode;
  /**
   * human resets the conversation's hop counter before counting (contract.md section 9).
   */
  origin: 'human' | 'peer' | 'unknown';
  /**
   * Tell the sender when the target finishes the turn this message starts.
   */
  notifyWhenIdle: boolean;
  /**
   * Carried both ways so error chains stop after one (r-nanoclaw).
   */
  failureNotice: boolean;
}
export interface EndpointRef {
  id: EndpointId;
  /**
   * What the receiving session sees as from-name.
   */
  name: string;
  /**
   * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
   */
  peer: string;
}
export interface SendResponse {
  message: {
    id: Uuid;
    /**
     * queued on first acceptance; the current state on a replay.
     */
    state:
      | 'queued'
      | 'sent'
      | 'accepted'
      | 'held'
      | 'delivered'
      | 'denied'
      | 'expired'
      | 'refused'
      | 'dropped'
      | 'unknown';
    to: {
      address: Address;
      kind: Kind;
      status: PeerStatus;
    };
    endpoint: EndpointRef1;
    hop: Hop;
    createdAt: Ms;
    /**
     * Milliseconds since the Unix epoch.
     */
    expiresAt: number;
  };
}
/**
 * Where replies to this conversation come from, on this machine.
 */
export interface EndpointRef1 {
  id: EndpointId;
  /**
   * What the receiving session sees as from-name.
   */
  name: string;
  /**
   * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
   */
  peer: string;
}
export interface StateReport {
  kind: 'state';
  id: Uuid;
  /**
   * <pid> + "-" + first 8 hex of SHA-256(procStart as the registry stores it) (*proposed*, contract.md section 6).
   */
  session: string;
  state: 'accepted' | 'held' | 'delivered' | 'denied' | 'expired' | 'refused' | 'dropped' | 'unknown';
  reason: DropReason | null;
  at: Ms;
}
/**
 * The turn the message started has ended.
 */
export interface IdleReport {
  kind: 'idle';
  id: Uuid;
  session: SessionKey;
  at: Ms;
}
export interface ReportsRequest {
  epoch: Epoch;
  /**
   * @minItems 1
   * @maxItems 100
   */
  reports: [Report, ...Report[]];
}
export interface ReportsResponse {
  /**
   * One per report, in order.
   */
  results: {
    id: Uuid;
    state: DeliveryState;
    /**
     * False when the message was already final or the id is unknown.
     */
    applied: boolean;
  }[];
}
/**
 * An endpoint this machine's sessions see messages from; announced before the first message that uses it.
 */
export interface EndpointEvent {
  kind: 'endpoint';
  seq: number;
  id: EndpointId;
  name: string;
  peer: {
    address: Address;
    kind: Kind;
  };
  /**
   * The hub session's channel for an agent (peer, telegram, app); null for a session.
   */
  context: string | null;
  /**
   * This machine's sessions that are party to it.
   */
  sessions: SessionKey[];
  state: 'open' | 'closed';
  createdAt: Ms;
  closedAt: Ms | null;
}
export interface MessageEvent {
  kind: 'message';
  seq: number;
  /**
   * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
   */
  id: string;
  /**
   * <pid> + "-" + first 8 hex of SHA-256(procStart as the registry stores it) (*proposed*, contract.md section 6).
   */
  session: string;
  endpoint: EndpointRef2;
  text: string;
  hopChain: HopChain;
  /**
   * The sender's real class; null asserts none. Agents: bypass if nanoclaw's runner runs without prompts, else null (a build check in container/agent-runner).
   */
  fromMode: FromMode | null;
  hop: Hop;
  notifyWhenIdle: boolean;
  failureNotice: boolean;
  createdAt: Ms;
  expiresAt: Ms;
}
/**
 * from-session, from-name and the relay socket.
 */
export interface EndpointRef2 {
  id: EndpointId;
  /**
   * What the receiving session sees as from-name.
   */
  name: string;
  /**
   * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
   */
  peer: string;
}
/**
 * A state change of a message this machine sent.
 */
export interface DeliveryEvent {
  kind: 'delivery';
  seq: number;
  id: Uuid;
  /**
   * <pid> + "-" + first 8 hex of SHA-256(procStart as the registry stores it) (*proposed*, contract.md section 6).
   */
  session: string;
  to: {
    address: Address;
    endpoint: EndpointId;
  };
  state: DeliveryState;
  /**
   * A DropReason or a refusal code.
   */
  reason: string | null;
  /**
   * Display text for the notice.
   */
  message: string;
  at: Ms;
}
/**
 * A conversation reached the hop limit (D20).
 */
export interface LimitEvent {
  kind: 'limit';
  seq: number;
  session: SessionKey;
  endpoint: EndpointRef;
  hop: Hop;
  /**
   * The message that was not delivered.
   */
  stopped: {
    id: Uuid;
    direction: 'in' | 'out';
  };
  message: string;
  at: Ms;
}
/**
 * The turn a notifyWhenIdle message started has ended.
 */
export interface IdleEvent {
  kind: 'idle';
  seq: number;
  /**
   * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
   */
  id: string;
  /**
   * <pid> + "-" + first 8 hex of SHA-256(procStart as the registry stores it) (*proposed*, contract.md section 6).
   */
  session: string;
  peer: Address;
  at: Ms;
}
/**
 * A directory entry changed; listed false means it left. Not a log event.
 */
export interface StatusEvent {
  kind: 'status';
  peer: Peer;
  listed: boolean;
}
/**
 * The replay is complete up to the log head seq; moves the cursor through its seq field.
 */
export interface SynchronizedEvent {
  kind: 'synchronized';
  seq: number;
}
/**
 * Sent, then the stream closes; every later request is 403 machine_revoked.
 */
export interface RevokedEvent {
  kind: 'revoked';
  machine: MachineId;
  message: string;
  at: Ms;
}
/**
 * Sent, then the stream closes; every later request is 409 superseded.
 */
export interface SupersededEvent {
  kind: 'superseded';
  epoch: Epoch;
  by: Epoch;
  message: string;
  at: Ms;
}
/**
 * A message into a session's inbox socket, one NDJSON line per connection: a delivery
 * (from a message event), a daemon notice, a lane frame, or a native reply read on a relay
 * socket. `content` is the canonical envelope (contract.md section 15).
 */
export interface NativeUserFrame {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
  priority: 'next';
  /**
   * Equal to the envelope's from.
   */
  from: string;
  msgV: 1;
  /**
   * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
   */
  msg_id: string;
}
/**
 * Asks the receiving session to answer with peer_idle_notice when the turn ends; sent from the same relay socket after the message.
 */
export interface NativeNotifyWhenIdle {
  type: 'control';
  action: 'notify_when_idle';
  /**
   * "uds:" + a socket path, characters outside [A-Za-z0-9:_/.-] percent-encoded, at most 300 characters.
   */
  from: string;
  /**
   * A message or frame id, RFC 4122 text form, lower case (it becomes the native msg_id).
   */
  msg_id: string;
  msgV: 1;
  from_mode: FromMode;
}
/**
 * A receipt for a frame the daemon wrote, correlated by orig_msg_id; read on the relay socket that posted.
 */
export interface NativeReceipt {
  type: 'control';
  action: 'peer_message_status';
  status: 'held' | 'delivered' | 'denied' | 'expired' | 'dropped';
  status_detail?: 'refused';
  /**
   * Claude Code's sentence; logged, never parsed.
   */
  reason: string;
  /**
   * "uds:" + a socket path, characters outside [A-Za-z0-9:_/.-] percent-encoded, at most 300 characters.
   */
  from: string;
  orig_msg_id: Uuid;
  drop_reason?: 'rate-limited' | 'queue-full' | 'duplicate' | 'hop-loop' | 'hop-runaway';
  /**
   * More ids a coalesced drop covers.
   */
  dropped_msg_ids?: Uuid[];
  msgV: 1;
  msg_id: Uuid;
}
/**
 * The answer to notify_when_idle, correlated by orig_msg_id to the subscription.
 */
export interface NativeIdleNotice {
  type: 'control';
  action: 'peer_idle_notice';
  orig_msg_id: Uuid;
  state: 'idle';
  finished_at: Ms;
  from: NativeAddress;
  from_mode: FromMode;
  msgV: 1;
  msg_id: Uuid;
}
/**
 * Claude Code's UserPromptSubmit hook input, as amesh hook forwards it (fields beyond these are ignored).
 */
export interface HookInputUserPromptSubmit {
  hook_event_name: 'UserPromptSubmit';
  /**
   * A cross-check only; identity is the kernel peer pid.
   */
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  prompt: string;
  session_title?: string;
}
/**
 * Claude Code's PreToolUse hook input. agent_id is present only inside a subagent (s-edge Q2).
 */
export interface HookInputPreToolUse {
  hook_event_name: 'PreToolUse';
  session_id: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name: string;
  tool_input?: {
    [k: string]: unknown;
  };
  tool_use_id?: string;
}
/**
 * The R15 deny, printed by amesh hook for a subagent's amesh tool call.
 */
export interface HookOutputPreToolUse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}
export interface LocalError {
  /**
   * not_in_session: the walk found no live registry entry; excluded: a mesh pipe under AMESH_EXCLUDE; bad_request.
   */
  error: 'not_in_session' | 'excluded' | 'bad_request';
  message: string;
}
export interface DaemonStatus {
  daemon: {
    version: string;
    pid: number;
    startedAt: Ms;
  };
  /**
   * Null before enrollment.
   */
  machine: {
    id: MachineId;
    name: MachineName;
  } | null;
  hub: {
    state: 'connected' | 'connecting' | 'halted';
    since: Ms;
    epoch: Epoch | null;
    cursor: number;
    /**
     * Why it halted (contract.md section 14).
     */
    halt: ErrorBody | null;
  };
  /**
   * The Claude config dirs the daemon scans (AMESH_CLAUDE_CONFIG_DIRS) and the live registry entries in each.
   */
  configDirs: {
    path: string;
    sessions: number;
  }[];
  sessions: {
    key: SessionKey;
    address: Address;
    status: PeerStatus;
    role: 'member';
  }[];
  lanes: {
    id: LaneId;
    relay: NativeAddress;
    parent: {
      name: string;
      /**
       * The --parent argument the lane is keyed on.
       */
      sessionId: string;
    };
    child: {
      name: string;
      sessionId: string;
      configDir: string;
    };
  }[];
  outbox: {
    count: number;
    oldestAt: Ms | null;
  };
  /**
   * Messages written whose final state is not known yet.
   */
  open: {
    count: number;
  };
}
export interface McpListPeersArguments {
  /**
   * Optional: "@project" or "@project:machine" to list only that project's sessions.
   */
  filter?: string;
}
export interface McpSendMessageArguments {
  /**
   * Peer address from list_peers, for example "stan" or "review@pond:bl".
   */
  to: string;
  /**
   * Plain text, at most 32 KiB.
   */
  message: string;
  /**
   * Also tell me when the peer finishes the turn this message starts.
   */
  notify_when_idle?: boolean;
}
export interface McpSendToParentArguments {
  /**
   * Plain text, at most 32 KiB.
   */
  message: string;
}
/**
 * list_peers result, without this machine's own sessions (spec 4.6).
 */
export interface McpListPeersResult {
  you: {
    name: Address;
    project: string;
    machine: MachineName;
  };
  peers: {
    /**
     * A peer address as the hub assigns it (D13): an agent "stan", or a session "name@project" or "name@project:machine".
     */
    name: string;
    kind: Kind;
    machine: string | null;
    project: string | null;
    status: PeerStatus;
    /**
     * RFC 3339 UTC, readable for Claude (*proposed*).
     */
    last_seen: string | null;
  }[];
  /**
   * Present when the hub is unreachable or the daemon halted; peers then come from the cache.
   */
  stale?: string;
}
/**
 * The MCP CallToolResult the daemon returns: one text content holding the result's JSON, the same object as structuredContent, isError false (mirrored from the MCP spec).
 */
export interface McpCallToolResult {
  /**
   * @minItems 1
   * @maxItems 1
   */
  content: [
    {
      type: 'text';
      text: string;
    },
    ...{
      type: 'text';
      text: string;
    }[],
  ];
  structuredContent: {
    [k: string]: unknown;
  };
  isError: false;
}
/**
 * A throwaway P-256 key for contract tests only (the app contract's). It protects nothing.
 */
export interface TestKey {
  note?: string;
  privateKeyPkcs8Pem: string;
  publicKeySpki: string;
}
export interface MachineIdVector {
  rule: string;
  publicKeySpki: string;
  machineId: MachineId;
}
export interface SessionKeyVector {
  rule: string;
  pid: number;
  procStart: string;
  sessionKey: SessionKey;
}
export interface RelaySocketVector {
  rule: string;
  machineId: MachineId;
  endpointId: EndpointId;
  path: string;
  address: NativeAddress;
}
export interface LaneSocketVector {
  rule: string;
  parentArgument: string;
  childSessionId: string;
  machineId: MachineId;
  laneId: LaneId;
  path: string;
}
/**
 * A signed request; signatureValid says whether s verifies against testKey over canonical.
 */
export interface SignatureVector {
  name: string;
  protocol: number;
  method: 'GET' | 'POST' | 'PUT';
  target: string;
  /**
   * The exact body bytes (UTF-8); empty for a GET.
   */
  body: string;
  /**
   * Unix seconds.
   */
  ts: number;
  nonce: string;
  machineId: MachineId;
  bodyHash: string;
  canonical: string;
  signature: string;
  authorization: string;
  signatureValid: boolean;
  note?: string;
}
export interface EnvelopeInput {
  body: string;
  from?: NativeAddress;
  fromSession?: string;
  hopChain?: HopChain;
  fromName?: string;
  fromMode?: FromMode;
}
/**
 * Renderer input and the canonical envelope it must produce byte for byte (the Go renderer and the startup check test both).
 */
export interface EnvelopeVector {
  name: string;
  input: EnvelopeInput;
  content: string;
  attributed: boolean;
  note?: string;
}
