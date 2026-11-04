import { beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ stop: vi.fn(async () => {}), start: vi.fn() }));
vi.mock('../../mailbox/index.js', () => ({ getAgentMailbox: () => ({}), registerAgentMailbox: vi.fn() }));
vi.mock('./runtime.js', () => ({ startPortalRuntime: runtime.start }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.start.mockReturnValue({ stop: runtime.stop });
});

it('the real modules barrel registers the portal connection with host start and shutdown', async () => {
  const lifecycle = await import('../../host-lifecycle.js');
  await import('../index.js');
  expect(runtime.start).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  for (const start of lifecycle.getHostStartCallbacks()) {
    await start({ signal, db: {} as never, deliveryAdapter: {} as never });
  }
  expect(runtime.start).toHaveBeenCalledWith({ signal, log: expect.any(Function) });
  for (const stop of lifecycle.getHostShutdownCallbacks()) await stop();
  expect(runtime.stop).toHaveBeenCalledOnce();
});
