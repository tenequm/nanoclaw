/**
 * Host command service public surface. Later phases (router fallback,
 * telegram-grammy adapter) import from here.
 */
export * from './types.js';
export {
  resolveTargets,
  getStatus,
  getModelPicker,
  getConfigView,
  setModel,
  setConfigValue,
  setActivation,
  restartAgent,
} from './service.js';
export { statusAccess, type StatusAccessDecision } from './auth.js';
export { formatTokens, formatDateRel } from './format.js';
export { readTranscriptStats, type TranscriptStats } from './transcript.js';
export {
  activationSummary,
  activationChangeConfirmation,
  agentPickerPrompt,
  configChangeConfirmation,
  configRootLines,
  failureMessage,
  modelChangeConfirmation,
  modelPickerPrompt,
  restartConfirmation,
  restartPrompt,
  statusCardLines,
  submenuPrompt,
  MD_FMT,
  PLAIN_FMT,
  type CardFmt,
} from './cards.js';
