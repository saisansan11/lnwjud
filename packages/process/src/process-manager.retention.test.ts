import { describe, expect, it } from 'vitest';
import { ProcessManager } from './process-manager.js';

async function waitForState(manager: ProcessManager, processId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = manager.status(processId);
    if (result.ok && result.value.state === state) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process did not reach state ${state}`);
}

describe('ProcessManager terminal retention', () => {
  it('evicts only old verified terminal records while preserving active processes and recent logs', async () => {
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, 2);
    const active = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(active.ok).toBe(true);
    if (!active.ok) return;

    try {
      const completedIds: string[] = [];
      for (const marker of ['one', 'two', 'three']) {
        const started = await manager.start({
          executable: process.execPath,
          args: ['-e', `process.stdout.write('${marker}\\n')`],
          cwd: process.cwd(),
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        completedIds.push(started.value.processId);
        await waitForState(manager, started.value.processId, 'exited');
      }

      expect(manager.status(active.value.processId)).toMatchObject({ ok: true, value: { state: 'running' } });
      expect(manager.status(completedIds[0]!)).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
      expect(manager.status(completedIds[1]!)).toMatchObject({ ok: true, value: { state: 'exited' } });
      expect(manager.status(completedIds[2]!)).toMatchObject({ ok: true, value: { state: 'exited' } });

      const logs = manager.logs(completedIds[2]!, {});
      expect(logs).toMatchObject({
        ok: true,
        value: { entries: [expect.objectContaining({ text: expect.stringContaining('three') })] },
      });
      expect(manager.list()).toHaveLength(3);
    } finally {
      await manager.stop(active.value.processId, true);
    }
  });
});
