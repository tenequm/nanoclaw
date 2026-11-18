import { registerMigration } from '../../db/migrations/index.js';

export const schemaTables = [
  'app_conversations',
  'app_events',
  'app_messages',
  'app_questions',
  'app_routing_jobs',
  'app_read_state',
  'app_statuses',
  'app_badge_revisions',
  'app_files',
  'app_file_tickets',
  'app_push_tokens',
  'app_call_attempts',
  'app_applied_sources',
] as const;

export interface ConversationRow {
  id: string;
  user_id: string;
  agent_group_id: string;
  messaging_group_id: string;
  seq: number;
  last_message_json: string | null;
  created_at: number;
}
export interface EventRow {
  seq: number;
  user_id: string;
  agent_group_id: string;
  conversation_id: string;
  entity_id: string;
  kind: string;
  entity_json: string;
  created_at: number;
}
export interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  item_order: number;
  seq: number;
  role: string;
  text: string;
  files_json: string;
  reactions_json: string;
  voice: string | null;
  reply_to: string | null;
  client_id: string | null;
  request_hash: string | null;
  source_id: string | null;
  delivery: string | null;
  delivery_error_json: string | null;
  created_at: number;
  edited_at: number | null;
}
export interface QuestionRow {
  id: string;
  conversation_id: string;
  item_order: number;
  seq: number;
  source_id: string | null;
  session_id: string;
  question_id: string;
  title: string;
  text: string;
  options_json: string;
  state: string;
  answer_json: string | null;
  answer_user_id: string | null;
  handoff_state: string | null;
  created_at: number;
  expires_at: number | null;
}
export interface RoutingJobRow {
  message_id: string;
  state: string;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_json: string | null;
}
export interface ReadStateRow {
  user_id: string;
  conversation_id: string;
  read_order: number;
}
export interface StatusRow {
  conversation_id: string;
  rev: number;
  state: string;
  label: string | null;
  at: number;
}
export interface BadgeRevisionRow {
  user_id: string;
  rev: number;
}
export interface FileRow {
  id: string;
  user_id: string;
  device_id: string | null;
  upload_key: string | null;
  name: string;
  mime_type: string;
  size: number;
  kind: string;
  width: number | null;
  height: number | null;
  storage_path: string | null;
  uploaded_at: number | null;
  message_id: string | null;
  conversation_id: string | null;
  created_at: number;
}
export interface FileTicketRow {
  id: string;
  file_id: string;
  device_id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}
export interface PushTokenRow {
  device_id: string;
  token: string;
  environment: string;
  updated_at: number;
}
export interface CallAttemptRow {
  user_id: string;
  attempt_id: string;
  device_id: string;
  conversation_id: string | null;
  call_id: string | null;
  state: string;
  jev: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

registerMigration({
  version: 1,
  name: 'module:app:initial',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS app_conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, messaging_group_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, last_message_json TEXT, created_at INTEGER NOT NULL, UNIQUE (user_id, agent_group_id));
      CREATE TABLE IF NOT EXISTS app_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL, entity_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, item_order INTEGER NOT NULL UNIQUE, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, files_json TEXT NOT NULL, reactions_json TEXT NOT NULL, voice TEXT, reply_to TEXT, client_id TEXT, request_hash TEXT, source_id TEXT, delivery TEXT, delivery_error_json TEXT, created_at INTEGER NOT NULL, edited_at INTEGER, UNIQUE (user_id, conversation_id, client_id), UNIQUE (conversation_id, source_id));
      CREATE TABLE IF NOT EXISTS app_questions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, item_order INTEGER NOT NULL UNIQUE, seq INTEGER NOT NULL, source_id TEXT, session_id TEXT NOT NULL, question_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, options_json TEXT NOT NULL, state TEXT NOT NULL, answer_json TEXT, answer_user_id TEXT, handoff_state TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, UNIQUE (conversation_id, source_id));
      CREATE TABLE IF NOT EXISTS app_routing_jobs (message_id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error_json TEXT);
      CREATE TABLE IF NOT EXISTS app_read_state (user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, read_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, conversation_id));
      CREATE TABLE IF NOT EXISTS app_statuses (conversation_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, state TEXT NOT NULL, label TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_badge_revisions (user_id TEXT PRIMARY KEY, rev INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT, upload_key TEXT, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, kind TEXT NOT NULL, width INTEGER, height INTEGER, storage_path TEXT, uploaded_at INTEGER, message_id TEXT, conversation_id TEXT, created_at INTEGER NOT NULL, UNIQUE (user_id, upload_key));
      CREATE TABLE IF NOT EXISTS app_file_tickets (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, device_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_push_tokens (device_id TEXT PRIMARY KEY, token TEXT NOT NULL, environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')), updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_call_attempts (user_id TEXT NOT NULL, attempt_id TEXT NOT NULL, device_id TEXT NOT NULL, conversation_id TEXT, call_id TEXT UNIQUE, state TEXT NOT NULL, jev INTEGER, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, attempt_id));
      CREATE TABLE IF NOT EXISTS app_applied_sources (conversation_id TEXT NOT NULL, source_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (conversation_id, source_id));
      CREATE INDEX IF NOT EXISTS app_events_idx_0 ON app_events (user_id, seq);
      CREATE INDEX IF NOT EXISTS app_messages_idx_1 ON app_messages (conversation_id, item_order);
      CREATE INDEX IF NOT EXISTS app_questions_idx_2 ON app_questions (conversation_id, item_order);
      CREATE INDEX IF NOT EXISTS app_routing_jobs_idx_3 ON app_routing_jobs (state);
      CREATE INDEX IF NOT EXISTS app_files_idx_4 ON app_files (created_at);
      CREATE INDEX IF NOT EXISTS app_questions_idx_5 ON app_questions (state, expires_at);
      CREATE INDEX IF NOT EXISTS app_files_idx_6 ON app_files (message_id);
    `);
  },
});
