// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';

// The local stand-in is a test double (docs/local-stack.md) that exists only when the local stack opts in.
if (process.env.NANOCLAW_LOCAL_STAND_IN === '1') await import('./stand-in.js');
