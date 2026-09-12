import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanionHostStatus, CompanionTaskSummary, CompanionWorkspaceSummary } from '@lnwjud/companion-contracts';
import { createExplicitKeySecretProtector } from '@lnwjud/shared';
import { CompanionGateway } from '../src/main/companion-gateway.js';

const roots: string[] = [];

function task(state: CompanionTaskSummary['state'] = 'running'): CompanionTaskSummary {
  return {
    taskId: 'managed_task:Z29hbC0x:dGFzay0x',
    kind: 'managed_task',
    workspaceId: 'workspace-1',
    title: 'Managed task · task-1',
    state,
    startedAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T01:01:00.000Z',
    completedAt: state === 'running' ? null : '2026-09-12T01:02:00.000Z',
    progressLabel: state === 'running' ? 'Running' : null,
    cancellable: state === 'running',
    resultSummary: state === 'running' ? null : 'Cancelled',
  };
}

const workspace: CompanionWorkspaceSummary = {
  id: 'workspace-1',
  displayName: 'Training',
  active: true,
  archived: false,
};

const hostStatus: CompanionHostStatus = {
  hostId: 'host-1',
  hostName: 'desktop-fixture',
  appVersion: '4.61.0',
  platform: 'win32',
  arch: 'x64',
  online: true,
  activeWorkspace: workspace,
  runningTaskCount: 1,
  pendingApprovalCount: 0,
  serverTime: '2026-09-12T01:01:00.000Z',
};

async function listenGateway(gateway: CompanionGateway): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? '/', origin);
    void gateway.handleRequest(request, response, url).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404;
        response.end('Not found');
      }
    }).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function register(origin: string, gateway: CompanionGateway, deviceId: string): Promise<{ access_token: string; refresh_token: string; scopes: string[] }> {
  const pairing = await gateway.beginPairing('https://companion.example.test');
  const response = await fetch(`${origin}/companion/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingTicket: pairing.qr.pairingTicket,
      pairingCode: pairing.pairingCode,
      deviceId,
      deviceName: 'iPhone',
      platform: 'ios',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), alg: 'ES256', use: 'sig', key_ops: ['verify'] },
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ access_token: string; refresh_token: string; scopes: string[] }>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Companion task gateway', () => {
  it('grants task scopes only when host task callbacks exist and enforces scoped HTTP routes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-companion-task-'));
    roots.push(root);
    let currentTask = task();
    const cancelTask = vi.fn(async (taskId: string, requestId: string): Promise<{ readonly status: 'ok'; readonly task: CompanionTaskSummary }> => {
      expect(taskId).toBe(currentTask.taskId);
      expect(requestId).toBe('request-1234');
      currentTask = task('cancelled');
      return { status: 'ok' as const, task: currentTask };
    });
    const gateway = new CompanionGateway({
      dataPath: root,
      getHostStatus: async (): Promise<CompanionHostStatus> => hostStatus,
      listWorkspaces: async (): Promise<readonly CompanionWorkspaceSummary[]> => [workspace],
      listTasks: async (): Promise<readonly CompanionTaskSummary[]> => [currentTask],
      getTask: async (taskId: string): Promise<CompanionTaskSummary | null> => taskId === currentTask.taskId ? currentTask : null,
      cancelTask,
      secretProtector: createExplicitKeySecretProtector(Buffer.alloc(32, 23)),
    });
    const { origin, server } = await listenGateway(gateway);
    try {
      const tokens = await register(origin, gateway, 'ios-task-device');
      expect(tokens.scopes).toEqual([
        'companion.status.read',
        'companion.workspace.read',
        'companion.task.read',
        'companion.task.control',
      ]);
      const headers = { authorization: `Bearer ${tokens.access_token}` };
      const listed = await fetch(`${origin}/companion/v1/tasks`, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ tasks: [currentTask] });

      const encodedTaskId = encodeURIComponent(currentTask.taskId);
      const fetched = await fetch(`${origin}/companion/v1/tasks/${encodedTaskId}`, { headers });
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toEqual(currentTask);

      const cancelled = await fetch(`${origin}/companion/v1/tasks/${encodedTaskId}/cancel`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'request-1234' }),
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ state: 'cancelled', cancellable: false });
      expect(cancelTask).toHaveBeenCalledTimes(1);

      const encodedSlash = await fetch(`${origin}/companion/v1/tasks/${encodeURIComponent('managed_task:a/b:c')}`, { headers });
      expect(encodedSlash.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('does not silently privilege-upgrade an older refresh grant when task callbacks appear', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-companion-scope-'));
    roots.push(root);
    const secretProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 29));
    const readOnlyGateway = new CompanionGateway({
      dataPath: root,
      getHostStatus: async (): Promise<CompanionHostStatus> => hostStatus,
      listWorkspaces: async (): Promise<readonly CompanionWorkspaceSummary[]> => [workspace],
      secretProtector,
    });
    const first = await listenGateway(readOnlyGateway);
    const original = await register(first.origin, readOnlyGateway, 'ios-old-device');
    expect(original.scopes).toEqual(['companion.status.read', 'companion.workspace.read']);
    await closeServer(first.server);

    const upgradedHost = new CompanionGateway({
      dataPath: root,
      getHostStatus: async (): Promise<CompanionHostStatus> => hostStatus,
      listWorkspaces: async (): Promise<readonly CompanionWorkspaceSummary[]> => [workspace],
      listTasks: async (): Promise<readonly CompanionTaskSummary[]> => [task()],
      getTask: async (): Promise<CompanionTaskSummary | null> => task(),
      cancelTask: async (): Promise<{ readonly status: 'ok'; readonly task: CompanionTaskSummary }> => ({ status: 'ok', task: task('cancelled') }),
      secretProtector,
    });
    const second = await listenGateway(upgradedHost);
    try {
      const refreshedResponse = await fetch(`${second.origin}/companion/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: original.refresh_token }),
      });
      expect(refreshedResponse.status).toBe(200);
      const refreshed = await refreshedResponse.json() as { access_token: string; scopes: string[] };
      expect(refreshed.scopes).toEqual(['companion.status.read', 'companion.workspace.read']);

      const tasksResponse = await fetch(`${second.origin}/companion/v1/tasks`, {
        headers: { authorization: `Bearer ${refreshed.access_token}` },
      });
      expect(tasksResponse.status).toBe(403);
    } finally {
      await closeServer(second.server);
    }
  });
});
