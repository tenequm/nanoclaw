// Session drivers other than docker self-register on import: the in-tree
// kubernetes driver, and any overlay's. docker registers in `index.ts`.
//
// Skills add a driver by appending one import line below — the same shape as
// the provider container-config barrel (`src/providers/index.ts`). Append-only
// on purpose: an overlay that instead rewrote the construction expression in
// `index.ts` would own a patch of this tree's internals, and every later edit
// to selection would silently invalidate it.

import './kubernetes-driver.js';
