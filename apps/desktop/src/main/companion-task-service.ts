import type { AgentSwarmSnapshot, GoalTaskCancellationPort } from '@lnwjud/application';
import type { CompanionTaskKind, CompanionTaskState, CompanionTaskSummary } from '@lnwjud/companion-contracts';
import type { GoalRecord, GoalTrackedTask, Result } from '@lnwjud/domain';

const MAX_WORKSPACES = 50;
const MAX_GOALS_PER_WORKSPACE = 25;
const MAX_DELEGATES = 50;
const MAX_TASKS = 100;
const MAX_TITLE_CHARS = 160;
const MAX_LABEL_CHARS = 160;
const MAX_RESULT_CHARS = 240;

interface GoalRepositoryHostPort {
  listWorkspaceGoalsForHost(workspaceId: string, limit?: number): Promise<readonly GoalRecord[]>;
  getById(goalId: string): Promise<GoalRecord | null>;
}

interface GoalTaskStatusProvider {
  statusForGoalLiveness(workspaceId: string, taskId: string): Result<unknown> | Promise<Result<unknown>>;
}

export interface CompanionDelegateHostPort {
  listForHost(limit?: number): readonly AgentSwarmSnapshot[];
  getForHost(swarmId: string): AgentSwarmSnapshot | undefined;
  cancelForHost(swarmId: string): Promise<Result<AgentSwarmSnapshot>>;
}

export interface CompanionTaskServiceOptions {
  readonly listWorkspaceIds: () => Promise<readonly string[]>;
  readonly goals: GoalRepositoryHostPort;
  readonly taskCancellation: GoalTaskCancellationPort;
  readonly process: GoalTaskStatusProvider;
  readonly codex: GoalTaskStatusProvider;
  readonly shell: GoalTaskStatusProvider;
  readonly delegates: CompanionDelegateHostPort;
}

export type CompanionCancelTaskResult =
  | { readonly status: 'ok'; readonly task: CompanionTaskSummary }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_cancellable'; readonly task: CompanionTaskSummary };

export class CompanionTaskService {
  private readonly taskProviders: Readonly<Record<'process' | 'codex' | 'shell', GoalTaskStatusProvider>>;

  public constructor(private readonly options: CompanionTaskServiceOptions) {
    this.taskProviders = {
      process: options.process,
      codex: options.codex,
      shell: options.shell,
    };
  }

  public async listTasks(): Promise<readonly CompanionTaskSummary[]> {
    const workspaceIds = (await this.options.listWorkspaceIds()).slice(0, MAX_WORKSPACES);
    const goalsByWorkspace = await Promise.all(workspaceIds.map((workspaceId) => this.options.goals.listWorkspaceGoalsForHost(workspaceId, MAX_GOALS_PER_WORKSPACE)));
    const summaries: CompanionTaskSummary[] = [];
    for (const goals of goalsByWorkspace) {
      for (const goal of goals) {
        summaries.push(goalSummary(goal));
        for (const task of goal.trackedTasks ?? []) summaries.push(await this.trackedTaskSummary(goal, task));
      }
    }
    for (const delegate of this.options.delegates.listForHost(MAX_DELEGATES)) summaries.push(delegateSummary(delegate));
    return summaries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId))
      .slice(0, MAX_TASKS);
  }

  public async getTask(taskId: string): Promise<CompanionTaskSummary | null> {
    const ref = decodeTaskRef(taskId);
    if (ref === null) return null;
    if (ref.kind === 'durable_goal') {
      const goal = await this.options.goals.getById(ref.id);
      return goal === null ? null : goalSummary(goal);
    }
    if (ref.kind === 'delegate') {
      const delegate = this.options.delegates.getForHost(ref.id);
      return delegate === undefined ? null : delegateSummary(delegate);
    }
    if (!('goalId' in ref)) return null;
    const goal = await this.options.goals.getById(ref.goalId);
    if (goal === null) return null;
    const binding = (goal.trackedTasks ?? []).find((task) => task.provider === providerForKind(ref.kind) && task.taskId === ref.id);
    return binding === undefined ? null : this.trackedTaskSummary(goal, binding);
  }

  public async cancelTask(taskId: string, requestId: string): Promise<CompanionCancelTaskResult> {
    if (!isRequestId(requestId)) throw new Error('Invalid cancellation requestId');
    const ref = decodeTaskRef(taskId);
    if (ref === null) return { status: 'not_found' };
    if (ref.kind === 'durable_goal') {
      const task = await this.getTask(taskId);
      return task === null ? { status: 'not_found' } : { status: 'not_cancellable', task };
    }
    if (ref.kind === 'delegate') {
      const before = this.options.delegates.getForHost(ref.id);
      if (before === undefined) return { status: 'not_found' };
      const beforeSummary = delegateSummary(before);
      if (!beforeSummary.cancellable) return isTerminal(beforeSummary.state) ? { status: 'ok', task: beforeSummary } : { status: 'not_cancellable', task: beforeSummary };
      const cancelled = await this.options.delegates.cancelForHost(ref.id);
      if (!cancelled.ok) {
        const current = this.options.delegates.getForHost(ref.id);
        return current === undefined ? { status: 'not_found' } : { status: 'not_cancellable', task: delegateSummary(current) };
      }
      return { status: 'ok', task: delegateSummary(cancelled.value) };
    }
    if (!('goalId' in ref)) return { status: 'not_found' };
    const goal = await this.options.goals.getById(ref.goalId);
    if (goal === null) return { status: 'not_found' };
    const binding = (goal.trackedTasks ?? []).find((task) => task.provider === providerForKind(ref.kind) && task.taskId === ref.id);
    if (binding === undefined) return { status: 'not_found' };
    const before = await this.trackedTaskSummary(goal, binding);
    if (!before.cancellable) return isTerminal(before.state) ? { status: 'ok', task: before } : { status: 'not_cancellable', task: before };
    const results = await this.options.taskCancellation.cancelForGoal(goal.ownerClientId, goal.workspaceId, [binding]);
    const result = results[0];
    if (result === undefined || result.status === 'failed' || result.status === 'skipped') {
      const current = await this.trackedTaskSummary(goal, binding);
      return { status: 'not_cancellable', task: current };
    }
    return { status: 'ok', task: await this.trackedTaskSummary(goal, binding) };
  }

  private async trackedTaskSummary(goal: GoalRecord, task: GoalTrackedTask): Promise<CompanionTaskSummary> {
    const provider = task.provider === 'legacy_auto' ? undefined : this.taskProviders[task.provider];
    const result = provider === undefined ? undefined : await Promise.resolve(provider.statusForGoalLiveness(goal.workspaceId, task.taskId)).catch(() => undefined);
    const snapshot = result?.ok === true && isRecord(result.value) ? result.value : undefined;
    const mapped = mapProviderState(snapshot, result?.ok === false ? result.error.code : undefined);
    const kind = kindForProvider(task.provider);
    const startedAt = dateField(snapshot, 'startedAt', 'started_at');
    const completedAt = dateField(snapshot, 'finishedAt', 'finished_at');
    const updatedAt = completedAt ?? startedAt ?? goal.updatedAt;
    return {
      taskId: encodeTrackedTaskRef(kind, goal.id, task.taskId),
      kind,
      workspaceId: goal.workspaceId,
      title: taskTitle(kind, task.taskId),
      state: mapped.state,
      startedAt,
      updatedAt,
      completedAt,
      progressLabel: mapped.progressLabel,
      cancellable: task.cancelWithGoal && mapped.state === 'running' && task.provider !== 'legacy_auto',
      resultSummary: mapped.resultSummary,
    };
  }
}

function goalSummary(goal: GoalRecord): CompanionTaskSummary {
  const state: CompanionTaskState = goal.status === 'active' ? 'running'
    : goal.status === 'completed' ? 'completed'
      : goal.status === 'cancelled' ? 'cancelled' : 'failed';
  return {
    taskId: encodeSimpleTaskRef('durable_goal', goal.id),
    kind: 'durable_goal',
    workspaceId: goal.workspaceId,
    title: boundedText(goal.objective || goal.goalKey, MAX_TITLE_CHARS, 'Durable goal') ?? 'Durable goal',
    state,
    startedAt: safeDate(goal.createdAt),
    updatedAt: safeDate(goal.updatedAt) ?? new Date(0).toISOString(),
    completedAt: safeDate(goal.terminalAt),
    progressLabel: state === 'running' ? boundedText(goal.currentPhase, MAX_LABEL_CHARS, null) : null,
    cancellable: false,
    resultSummary: state === 'running' ? boundedText(goal.nextAction, MAX_RESULT_CHARS, null) : boundedText(goal.terminalSummary, MAX_RESULT_CHARS, terminalLabel(state)),
  };
}

function delegateSummary(delegate: AgentSwarmSnapshot): CompanionTaskSummary {
  const state = mapDelegateState(delegate.state);
  const completedAt = delegate.tasks.map((task) => safeDate(task.finishedAt)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const running = delegate.tasks.filter((task) => task.state === 'running').length;
  const queued = delegate.tasks.filter((task) => task.state === 'queued' || task.state === 'blocked').length;
  return {
    taskId: encodeSimpleTaskRef('delegate', delegate.swarmId),
    kind: 'delegate',
    workspaceId: delegate.workspaceId,
    title: `Delegate · ${delegate.tasks.length} task${delegate.tasks.length === 1 ? '' : 's'}`,
    state,
    startedAt: safeDate(delegate.createdAt),
    updatedAt: safeDate(delegate.updatedAt) ?? safeDate(delegate.createdAt) ?? new Date(0).toISOString(),
    completedAt: isTerminal(state) ? completedAt : null,
    progressLabel: state === 'running' || state === 'queued' ? boundedText(`${running} running · ${queued} queued`, MAX_LABEL_CHARS, null) : null,
    cancellable: state === 'running' || state === 'queued',
    resultSummary: delegate.state === 'termination_unverified' ? 'Runtime termination could not be verified after Desktop restart.' : isTerminal(state) ? terminalLabel(state) : null,
  };
}

function mapProviderState(snapshot: Record<string, unknown> | undefined, errorCode?: string): { state: CompanionTaskState; progressLabel: string | null; resultSummary: string | null } {
  if (snapshot === undefined) {
    return errorCode === 'PROCESS_NOT_FOUND'
      ? { state: 'failed', progressLabel: null, resultSummary: 'Task handle is no longer available.' }
      : { state: 'failed', progressLabel: null, resultSummary: 'Task state could not be verified.' };
  }
  const raw = typeof snapshot.state === 'string' ? snapshot.state : 'unknown';
  switch (raw) {
    case 'starting':
    case 'running': return { state: 'running', progressLabel: raw === 'starting' ? 'Starting' : 'Running', resultSummary: null };
    case 'completed': return { state: 'completed', progressLabel: null, resultSummary: 'Completed' };
    case 'exited': {
      const exitCode = typeof snapshot.exitCode === 'number' ? snapshot.exitCode : typeof snapshot.exit_code === 'number' ? snapshot.exit_code : 0;
      return exitCode === 0 ? { state: 'completed', progressLabel: null, resultSummary: 'Completed' } : { state: 'failed', progressLabel: null, resultSummary: `Exited with code ${exitCode}` };
    }
    case 'cancelled':
    case 'stopped': return { state: 'cancelled', progressLabel: null, resultSummary: 'Cancelled' };
    case 'timed_out': return { state: 'failed', progressLabel: null, resultSummary: 'Timed out' };
    case 'termination_unverified': return { state: 'failed', progressLabel: null, resultSummary: 'Runtime termination could not be verified.' };
    case 'failed': return { state: 'failed', progressLabel: null, resultSummary: 'Failed' };
    default: return { state: 'failed', progressLabel: null, resultSummary: 'Task state could not be verified.' };
  }
}

function mapDelegateState(value: AgentSwarmSnapshot['state']): CompanionTaskState {
  if (value === 'queued') return 'queued';
  if (value === 'running') return 'running';
  if (value === 'completed') return 'completed';
  if (value === 'cancelled') return 'cancelled';
  return 'failed';
}

function kindForProvider(provider: GoalTrackedTask['provider']): Extract<CompanionTaskKind, 'managed_task' | 'codex' | 'process'> {
  if (provider === 'codex') return 'codex';
  if (provider === 'process') return 'process';
  return 'managed_task';
}

function providerForKind(kind: Extract<CompanionTaskKind, 'managed_task' | 'codex' | 'process'>): 'shell' | 'codex' | 'process' {
  if (kind === 'codex') return 'codex';
  if (kind === 'process') return 'process';
  return 'shell';
}

function taskTitle(kind: CompanionTaskKind, taskId: string): string {
  const short = taskId.length <= 12 ? taskId : `${taskId.slice(0, 8)}…`;
  if (kind === 'codex') return `Codex · ${short}`;
  if (kind === 'process') return `Owned process · ${short}`;
  return `Managed task · ${short}`;
}

type SimpleTaskKind = Extract<CompanionTaskKind, 'delegate' | 'durable_goal'>;
type TrackedTaskKind = Extract<CompanionTaskKind, 'managed_task' | 'codex' | 'process'>;
type DecodedTaskRef = { readonly kind: SimpleTaskKind; readonly id: string } | { readonly kind: TrackedTaskKind; readonly goalId: string; readonly id: string };

function encodeSimpleTaskRef(kind: SimpleTaskKind, id: string): string {
  return `${kind}:${Buffer.from(id, 'utf8').toString('base64url')}`;
}

function encodeTrackedTaskRef(kind: TrackedTaskKind, goalId: string, id: string): string {
  return `${kind}:${Buffer.from(goalId, 'utf8').toString('base64url')}:${Buffer.from(id, 'utf8').toString('base64url')}`;
}

function decodeTaskRef(value: string): DecodedTaskRef | null {
  if (value.length < 3 || value.length > 768) return null;
  const parts = value.split(':');
  if (parts.length === 2 && (parts[0] === 'delegate' || parts[0] === 'durable_goal')) {
    const id = decodeSegment(parts[1]!);
    return id === null ? null : { kind: parts[0], id };
  }
  if (parts.length === 3 && (parts[0] === 'managed_task' || parts[0] === 'codex' || parts[0] === 'process')) {
    const goalId = decodeSegment(parts[1]!);
    const id = decodeSegment(parts[2]!);
    return goalId === null || id === null ? null : { kind: parts[0], goalId, id };
  }
  return null;
}

function decodeSegment(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded.length > 0 && decoded.length <= 256 && !decoded.includes('\0') ? decoded : null;
  } catch {
    return null;
  }
}

function isRequestId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function dateField(snapshot: Record<string, unknown> | undefined, camel: string, snake: string): string | null {
  if (snapshot === undefined) return null;
  return safeDate(snapshot[camel]) ?? safeDate(snapshot[snake]);
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function boundedText(value: unknown, maxChars: number, fallback: string | null): string | null {
  if (typeof value !== 'string') return fallback;
  const sanitized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length === 0) return fallback;
  return sanitized.length <= maxChars ? sanitized : `${sanitized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function terminalLabel(state: CompanionTaskState): string {
  if (state === 'completed') return 'Completed';
  if (state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function isTerminal(state: CompanionTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
