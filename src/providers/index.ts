import './claude.js';
// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import.
//
// Skills add a new provider by appending one import line below.

// The local stand-in is a test double (docs/local-stack.md) that exists only when the local stack opts in.
if (process.env.NANOCLAW_LOCAL_STAND_IN === '1') await import('./stand-in.js');
