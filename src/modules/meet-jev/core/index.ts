import { decide, reduce } from './decide.js';
import type { CallCore } from './types.js';
import { initial, type CallState } from './window.js';

export type { CallState };

export const callCore: CallCore<CallState> = { initial, reduce, decide };
