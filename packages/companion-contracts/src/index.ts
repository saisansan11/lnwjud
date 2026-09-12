export const COMPANION_API_VERSION = 'v1' as const;
export const COMPANION_API_PREFIX = `/companion/${COMPANION_API_VERSION}` as const;
export const COMPANION_TOKEN_AUDIENCE = 'lnwjud-companion' as const;
export const COMPANION_DEVICE_KEY_ALGORITHM = 'ES256' as const;
export const COMPANION_DEVICE_KEY_CURVE = 'P-256' as const;
export const COMPANION_ACTION_DIGEST_ALGORITHM = 'SHA-256' as const;

export const ALL_COMPANION_SCOPES = [
  'companion.status.read',
  'companion.workspace.read',
  'companion.task.read',
  'companion.task.control',
  'companion.command.start',
  'companion.approval.read',
  'companion.approval.respond',
  'companion.logs.read',
  'companion.events.read',
] as const;
export type CompanionScope = typeof ALL_COMPANION_SCOPES[number];

export const COMPANION_ROUTE_IDS = [
  'status.get',
  'workspaces.list',
  'tasks.list',
  'tasks.get',
  'tasks.cancel',
  'approvals.list',
  'approvals.respond',
  'commands.start',
  'logs.list',
  'events.stream',
] as const;
export type CompanionRouteId = typeof COMPANION_ROUTE_IDS[number];

export const COMPANION_ROUTE_SCOPES: Readonly<Record<CompanionRouteId, readonly CompanionScope[]>> = Object.freeze({
  'status.get': ['companion.status.read'],
  'workspaces.list': ['companion.workspace.read'],
  'tasks.list': ['companion.task.read'],
  'tasks.get': ['companion.task.read'],
  'tasks.cancel': ['companion.task.control'],
  'approvals.list': ['companion.approval.read'],
  'approvals.respond': ['companion.approval.respond'],
  'commands.start': ['companion.command.start'],
  'logs.list': ['companion.logs.read'],
  'events.stream': ['companion.events.read'],
});

export function isCompanionScope(value: unknown): value is CompanionScope {
  return typeof value === 'string' && (ALL_COMPANION_SCOPES as readonly string[]).includes(value);
}

export function companionScopesAllow(
  granted: readonly CompanionScope[],
  route: CompanionRouteId,
): boolean {
  const grantedSet = new Set(granted);
  return COMPANION_ROUTE_SCOPES[route].every((scope) => grantedSet.has(scope));
}

export type RemoteClientKind = 'chatgpt' | 'mobile';
export type CompanionDevicePlatform = 'ios' | 'android';

export interface CompanionPublicKeyJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly alg: 'ES256';
  readonly use?: 'sig';
  readonly key_ops?: readonly ['verify'];
}

export interface CompanionDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: CompanionDevicePlatform;
  readonly publicKeyJwk: CompanionPublicKeyJwk;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

export interface CompanionPairingQr {
  readonly schemaVersion: 1;
  readonly kind: 'lnwjud-companion-pairing';
  readonly hostId: string;
  readonly publicOrigin: string;
  readonly pairingTicket: string;
  readonly expiresAt: string;
}

export interface CompanionRegisterDeviceRequest {
  readonly pairingTicket: string;
  readonly pairingCode: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: CompanionDevicePlatform;
  readonly publicKeyJwk: CompanionPublicKeyJwk;
}

export interface CompanionAccessTokenClaims {
  readonly aud: 'lnwjud-companion';
  readonly sub: string;
  readonly clientKind: 'mobile';
  readonly deviceId: string;
  readonly scopes: readonly CompanionScope[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface CompanionWorkspaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly archived: boolean;
}

export interface CompanionHostStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly appVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly arch: 'x64' | 'arm64';
  readonly online: boolean;
  readonly activeWorkspace: CompanionWorkspaceSummary | null;
  readonly runningTaskCount: number;
  readonly pendingApprovalCount: number;
  readonly serverTime: string;
}

export type CompanionTaskState =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CompanionTaskKind = 'managed_task' | 'codex' | 'delegate' | 'durable_goal' | 'process';

export interface CompanionTaskSummary {
  readonly taskId: string;
  readonly kind: CompanionTaskKind;
  readonly workspaceId: string;
  readonly title: string;
  readonly state: CompanionTaskState;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly progressLabel: string | null;
  readonly cancellable: boolean;
  readonly resultSummary: string | null;
}

export type CompanionPermission = 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface CompanionApprovalChallenge {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly workspaceDisplayName: string;
  readonly toolName: string;
  readonly action: string;
  readonly targetSummary: string | null;
  readonly permission: CompanionPermission;
  readonly argumentsSha256: string;
  readonly nonce: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export type CompanionApprovalDecision = 'approve' | 'deny';

export interface CompanionApprovalResponse {
  readonly approvalId: string;
  readonly deviceId: string;
  readonly decision: CompanionApprovalDecision;
  readonly signature: string;
}

export interface CompanionApprovalSignatureInput {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly action: string;
  readonly argumentsSha256: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly decision: CompanionApprovalDecision;
  readonly deviceId: string;
}

export function companionApprovalSignatureInput(
  challenge: CompanionApprovalChallenge,
  response: Pick<CompanionApprovalResponse, 'deviceId' | 'decision'>,
): CompanionApprovalSignatureInput {
  return {
    approvalId: challenge.approvalId,
    workspaceId: challenge.workspaceId,
    toolName: challenge.toolName,
    action: challenge.action,
    argumentsSha256: challenge.argumentsSha256,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    decision: response.decision,
    deviceId: response.deviceId,
  };
}

export function canonicalCompanionApprovalPayload(input: CompanionApprovalSignatureInput): string {
  return JSON.stringify([
    'lnwjud-companion-approval-v1',
    input.approvalId,
    input.workspaceId,
    input.toolName,
    input.action,
    input.argumentsSha256,
    input.nonce,
    input.expiresAt,
    input.decision,
    input.deviceId,
  ]);
}

export interface CompanionCancelTaskRequest {
  readonly requestId: string;
}

export type CompanionStartCommandRequest =
  | {
    readonly kind: 'codex';
    readonly workspaceId: string;
    readonly instruction: string;
  }
  | {
    readonly kind: 'recipe';
    readonly workspaceId: string;
    readonly recipeId: string;
    readonly input: Readonly<Record<string, unknown>>;
  };

export type CompanionEventType =
  | 'host.status'
  | 'task.started'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'approval.required'
  | 'approval.resolved';

export interface CompanionEventEnvelope {
  readonly eventId: string;
  readonly type: CompanionEventType;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function parseCompanionPublicKeyJwk(value: unknown): CompanionPublicKeyJwk {
  const record = strictRecord(value, ['kty', 'crv', 'x', 'y', 'alg', 'use', 'key_ops']);
  expectLiteral(record.kty, 'EC', 'kty');
  expectLiteral(record.crv, COMPANION_DEVICE_KEY_CURVE, 'crv');
  expectLiteral(record.alg, COMPANION_DEVICE_KEY_ALGORITHM, 'alg');
  const x = expectBase64Url(record.x, 'x');
  const y = expectBase64Url(record.y, 'y');
  if (x.length !== 43 || y.length !== 43) throw new Error('P-256 x/y coordinates must be 32-byte base64url values');
  if (record.use !== undefined) expectLiteral(record.use, 'sig', 'use');
  let keyOps: readonly ['verify'] | undefined;
  if (record.key_ops !== undefined) {
    if (!Array.isArray(record.key_ops) || record.key_ops.length !== 1 || record.key_ops[0] !== 'verify') {
      throw new Error('key_ops must be exactly ["verify"]');
    }
    keyOps = ['verify'];
  }
  return {
    kty: 'EC',
    crv: COMPANION_DEVICE_KEY_CURVE,
    x,
    y,
    alg: COMPANION_DEVICE_KEY_ALGORITHM,
    ...(record.use === undefined ? {} : { use: 'sig' as const }),
    ...(keyOps === undefined ? {} : { key_ops: keyOps }),
  };
}

export function parseCompanionPairingQr(value: unknown): CompanionPairingQr {
  const record = strictRecord(value, ['schemaVersion', 'kind', 'hostId', 'publicOrigin', 'pairingTicket', 'expiresAt']);
  if (record.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  expectLiteral(record.kind, 'lnwjud-companion-pairing', 'kind');
  const hostId = expectId(record.hostId, 'hostId');
  const publicOrigin = expectString(record.publicOrigin, 'publicOrigin', 2048);
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Companion pairing requires a bare HTTPS origin');
  }
  const pairingTicket = expectBase64Url(record.pairingTicket, 'pairingTicket');
  const expiresAt = expectIsoDateTime(record.expiresAt, 'expiresAt');
  return { schemaVersion: 1, kind: 'lnwjud-companion-pairing', hostId, publicOrigin: parsed.origin, pairingTicket, expiresAt };
}

export function parseCompanionAccessTokenClaims(value: unknown): CompanionAccessTokenClaims {
  const record = strictRecord(value, ['aud', 'sub', 'clientKind', 'deviceId', 'scopes', 'iat', 'exp', 'jti']);
  expectLiteral(record.aud, COMPANION_TOKEN_AUDIENCE, 'aud');
  expectLiteral(record.clientKind, 'mobile', 'clientKind');
  const sub = expectId(record.sub, 'sub');
  const deviceId = expectId(record.deviceId, 'deviceId');
  if (sub !== deviceId) throw new Error('Companion token subject must match deviceId');
  const jti = expectId(record.jti, 'jti');
  if (!Array.isArray(record.scopes) || record.scopes.length === 0 || record.scopes.length > ALL_COMPANION_SCOPES.length) {
    throw new Error('scopes must be a non-empty bounded array');
  }
  const scopes = record.scopes.map((scope) => {
    if (!isCompanionScope(scope)) throw new Error(`Unsupported Companion scope: ${String(scope)}`);
    return scope;
  });
  const iat = expectNonNegativeInteger(record.iat, 'iat');
  const exp = expectPositiveInteger(record.exp, 'exp');
  if (exp <= iat) throw new Error('Token expiry must be after issue time');
  return { aud: COMPANION_TOKEN_AUDIENCE, sub, clientKind: 'mobile', deviceId, scopes, iat, exp, jti };
}

export function parseCompanionApprovalChallenge(value: unknown): CompanionApprovalChallenge {
  const record = strictRecord(value, [
    'approvalId', 'workspaceId', 'workspaceDisplayName', 'toolName', 'action', 'targetSummary',
    'permission', 'argumentsSha256', 'nonce', 'requestedAt', 'expiresAt',
  ]);
  const permission = record.permission;
  if (permission !== 'WRITE' && permission !== 'EXECUTE' && permission !== 'DANGEROUS') {
    throw new Error('permission must be WRITE, EXECUTE, or DANGEROUS');
  }
  const targetSummary = record.targetSummary === null ? null : expectString(record.targetSummary, 'targetSummary', 1000, true);
  const requestedAt = expectIsoDateTime(record.requestedAt, 'requestedAt');
  const expiresAt = expectIsoDateTime(record.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) throw new Error('Approval expiry must be after request time');
  return {
    approvalId: expectId(record.approvalId, 'approvalId'),
    workspaceId: expectId(record.workspaceId, 'workspaceId'),
    workspaceDisplayName: expectString(record.workspaceDisplayName, 'workspaceDisplayName', 256),
    toolName: expectString(record.toolName, 'toolName', 256),
    action: expectString(record.action, 'action', 256),
    targetSummary,
    permission,
    argumentsSha256: expectSha256(record.argumentsSha256, 'argumentsSha256'),
    nonce: expectBase64Url(record.nonce, 'nonce'),
    requestedAt,
    expiresAt,
  };
}

export function parseCompanionStartCommandRequest(value: unknown): CompanionStartCommandRequest {
  const record = expectRecord(value, 'command');
  if (record.kind === 'codex') {
    const strict = strictRecord(record, ['kind', 'workspaceId', 'instruction']);
    const instruction = expectString(strict.instruction, 'instruction', 32_768).trim();
    if (instruction.length === 0) throw new Error('instruction must not be blank');
    return {
      kind: 'codex',
      workspaceId: expectId(strict.workspaceId, 'workspaceId'),
      instruction,
    };
  }
  if (record.kind === 'recipe') {
    const strict = strictRecord(record, ['kind', 'workspaceId', 'recipeId', 'input']);
    const input = strict.input === undefined ? {} : expectRecord(strict.input, 'input');
    return {
      kind: 'recipe',
      workspaceId: expectId(strict.workspaceId, 'workspaceId'),
      recipeId: expectId(strict.recipeId, 'recipeId'),
      input,
    };
  }
  throw new Error('Unsupported Companion command kind');
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function strictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = expectRecord(value, 'value');
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field: ${key}`);
  }
  return record;
}

function expectLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${expected}`);
  return expected;
}

function expectString(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) throw new Error(`${field} has invalid length`);
  return value;
}

function expectId(value: unknown, field: string): string {
  return expectString(value, field, 256);
}

function expectBase64Url(value: unknown, field: string): string {
  const stringValue = expectString(value, field, 4096);
  if (stringValue.length < 16 || !/^[A-Za-z0-9_-]+$/.test(stringValue)) throw new Error(`${field} must be base64url`);
  return stringValue;
}

function expectSha256(value: unknown, field: string): string {
  const stringValue = expectString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(stringValue)) throw new Error(`${field} must be lowercase SHA-256 hex`);
  return stringValue;
}

function expectIsoDateTime(value: unknown, field: string): string {
  const stringValue = expectString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(stringValue)
    || Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${field} must be an offset-aware ISO 8601 timestamp`);
  }
  return stringValue;
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
  const result = expectNonNegativeInteger(value, field);
  if (result === 0) throw new Error(`${field} must be positive`);
  return result;
}
