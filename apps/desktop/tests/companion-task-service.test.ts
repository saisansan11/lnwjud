import { describe, expect, it, vi } from 'vitest';
import { ok, type GoalRecord, type GoalTrackedTask, type Result } from '@lnwjud/domain';
import type { AgentSwarmSnapshot, GoalTaskCancellationPort, GoalTaskCancellationResult } from '@lnwjud/application';
import { CompanionTaskService, type CompanionDelegateHostPort } from '../src/main/companion-task-service.js';

function goal(task: GoalTrackedTask): GoalRecord {
  return {
    id: 'goal-1',
    goalKey: 'mobile-m4',
    workspaceId: 'workspace-1',
    ownerClientId: 'client-1',
    objective: 'Ship task monitor',
    plan: { steps: [{ id: 's1', title: 'Implement', status: 'in_progress' }] },
    status: 'active',
    revision: 3,
    currentPhase: 'implementation',
    nextAction: 'Run tests',
    blockers: [],
    activeTaskIds: [task.taskId],
    trackedTasks: [task],
    leaseGeneration: 1,
    leaseActivitySeq: 2,
    createdAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T02:00:00.000Z',
    checkpoints: [],
  };
}

function delegate(state: AgentSwarmSnapshot['state'] = 'running'): AgentSwarmSnapshot {
  return {
    swarmId: 'swarm-1',
    workspaceId: 'workspace-1',
    state,
    maxConcurrency: 1,
    createdAt: '2026-09-12T01:30:00.000Z',
    updatedAt: '2026-09-12T02:30:00.000Z',
    tasks: [{
      id: 'delegate-1',
      dependsOn: [],
      state: state === 'running' ? 'running' : state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed',
      createdAt: '2026-09-12T01:30:00.000Z',
      ...(state === 'completed' || state === 'cancelled' || state === 'failed' ? { finishedAt: '2026-09-12T02:30:00.000Z' } : {}),
      resultAvailable: state === 'completed',
      outputTruncated: false,
    }],
  };
}

function provider(value: Record<string, unknown> = { state: 'running', startedAt: '2026-09-12T01:10:00.000Z' }): { statusForGoalLiveness: ReturnType<typeof vi.fn> } {
  return { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => ok(value)) };
}

function fixture(task: GoalTrackedTask = { taskId: 'shell-task-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }): {
  service: CompanionTaskService;
  taskCancellation: GoalTaskCancellationPort;
  process: ReturnType<typeof provider>;
  codex: ReturnType<typeof provider>;
  shell: ReturnType<typeof provider>;
  delegates: CompanionDelegateHostPort;
  goalRecord: GoalRecord;
} {
  const goalRecord = goal(task);
  const process = provider();
  const codex = provider();
  const shell = provider();
  let currentDelegate = delegate();
  const taskCancellation: GoalTaskCancellationPort = {
    cancelForGoal: vi.fn(async (): Promise<readonly GoalTaskCancellationResult[]> => [{ taskId: task.taskId, provider: task.provider, status: 'cancelled', providers: [] }]),
  };
  const delegates: CompanionDelegateHostPort = {
    listForHost: (): readonly AgentSwarmSnapshot[] => [currentDelegate],
    getForHost: (id: string): AgentSwarmSnapshot | undefined => id === currentDelegate.swarmId ? currentDelegate : undefined,
    cancelForHost: vi.fn(async (): Promise<Result<AgentSwarmSnapshot>> => {
      currentDelegate = delegate('cancelled');
      return ok(currentDelegate);
    }),
  };
  const service = new CompanionTaskService({
    listWorkspaceIds: async (): Promise<readonly string[]> => ['workspace-1'],
    goals: {
      listWorkspaceGoalsForHost: async (): Promise<readonly GoalRecord[]> => [goalRecord],
      getById: async (id: string): Promise<GoalRecord | null> => id === goalRecord.id ? goalRecord : null,
    },
    taskCancellation,
    process,
    codex,
    shell,
    delegates,
  });
  return { service, taskCancellation, process, codex, shell, delegates, goalRecord };
}

describe('CompanionTaskService', () => {
  it('projects goals, tracked provider tasks, and delegates without raw command data', async () => {
    const { service, shell } = fixture();
    const tasks = await service.listTasks();
    expect(tasks.map((task) => task.kind)).toEqual(['delegate', 'durable_goal', 'managed_task']);
    const managed = tasks.find((task) => task.kind === 'managed_task');
    expect(managed).toMatchObject({ workspaceId: 'workspace-1', state: 'running', cancellable: true });
    expect(managed?.taskId).toMatch(/^managed_task:/);
    expect(JSON.stringify(tasks)).not.toContain('stdout');
    expect(JSON.stringify(tasks)).not.toContain('cwd');
    expect(shell.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'shell-task-1');
  });

  it('cancels only through the goal-owned provider binding and returns the refreshed authoritative state', async () => {
    const { service, taskCancellation, shell } = fixture();
    const managed = (await service.listTasks()).find((task) => task.kind === 'managed_task');
    expect(managed).toBeDefined();
    shell.statusForGoalLiveness
      .mockResolvedValueOnce(ok({ state: 'running', started_at: '2026-09-12T01:10:00.000Z' }))
      .mockResolvedValueOnce(ok({ state: 'cancelled', started_at: '2026-09-12T01:10:00.000Z', finished_at: '2026-09-12T02:10:00.000Z' }));
    const result = await service.cancelTask(managed!.taskId, 'request-1234');
    expect(result).toMatchObject({ status: 'ok', task: { state: 'cancelled', cancellable: false } });
    expect(taskCancellation.cancelForGoal).toHaveBeenCalledWith('client-1', 'workspace-1', [{ taskId: 'shell-task-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }]);
  });

  it('does not expose Cancel for shared supporting tasks', async () => {
    const { service, taskCancellation } = fixture({ taskId: 'service-1', provider: 'process', role: 'supporting_service', cancelWithGoal: false });
    const task = (await service.listTasks()).find((entry) => entry.kind === 'process');
    expect(task?.cancellable).toBe(false);
    const result = await service.cancelTask(task!.taskId, 'request-1234');
    expect(result.status).toBe('not_cancellable');
    expect(taskCancellation.cancelForGoal).not.toHaveBeenCalled();
  });

  it('treats terminal cancellation as idempotent without dispatching another stop', async () => {
    const { service, shell, taskCancellation } = fixture();
    const task = (await service.listTasks()).find((entry) => entry.kind === 'managed_task');
    shell.statusForGoalLiveness.mockResolvedValue(ok({ state: 'completed', started_at: '2026-09-12T01:10:00.000Z', finished_at: '2026-09-12T02:10:00.000Z' }));
    const result = await service.cancelTask(task!.taskId, 'request-1234');
    expect(result).toMatchObject({ status: 'ok', task: { state: 'completed', cancellable: false } });
    expect(taskCancellation.cancelForGoal).not.toHaveBeenCalled();
  });

  it('cancels a live delegate through the host-safe delegate port', async () => {
    const { service, delegates } = fixture();
    const task = (await service.listTasks()).find((entry) => entry.kind === 'delegate');
    const first = await service.cancelTask(task!.taskId, 'request-1234');
    expect(first).toMatchObject({ status: 'ok', task: { state: 'cancelled', cancellable: false } });
    const second = await service.cancelTask(task!.taskId, 'request-5678');
    expect(second).toMatchObject({ status: 'ok', task: { state: 'cancelled', cancellable: false } });
    expect(delegates.cancelForHost).toHaveBeenCalledWith('swarm-1');
    expect(delegates.cancelForHost).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed cancellation request ids before any provider action', async () => {
    const { service, taskCancellation } = fixture();
    const task = (await service.listTasks()).find((entry) => entry.kind === 'managed_task');
    await expect(service.cancelTask(task!.taskId, 'bad')).rejects.toThrow('Invalid cancellation requestId');
    expect(taskCancellation.cancelForGoal).not.toHaveBeenCalled();
  });
});
