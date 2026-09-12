import type { CompanionHostStatus, CompanionPairingQr, CompanionPublicKeyJwk, CompanionWorkspaceSummary } from '@lnwjud/companion-contracts';
import { parseTokenResponse, type CompanionTokenResponse } from './protocol';

const REQUEST_TIMEOUT_MS = 12_000;

export async function registerDevice(input: {
  readonly pairing: CompanionPairingQr;
  readonly pairingCode: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: 'ios' | 'android';
  readonly publicKeyJwk: CompanionPublicKeyJwk;
}): Promise<CompanionTokenResponse> {
  if (!/^\d{6}$/.test(input.pairingCode)) throw new Error('Enter the 6-digit code shown on lnwjud Desktop.');
  const value = await requestJson(`${input.pairing.publicOrigin}/companion/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingTicket: input.pairing.pairingTicket,
      pairingCode: input.pairingCode,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: input.platform,
      publicKeyJwk: input.publicKeyJwk,
    }),
  });
  return parseTokenResponse(value);
}

export async function refreshSession(publicOrigin: string, refreshToken: string): Promise<CompanionTokenResponse> {
  const value = await requestJson(`${publicOrigin}/companion/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return parseTokenResponse(value);
}

export async function getHostStatus(publicOrigin: string, accessToken: string): Promise<CompanionHostStatus> {
  const value = await requestJson(`${publicOrigin}/companion/v1/status`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return parseHostStatus(value);
}

export async function listWorkspaces(publicOrigin: string, accessToken: string): Promise<readonly CompanionWorkspaceSummary[]> {
  const value = await requestJson(`${publicOrigin}/companion/v1/workspaces`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const record = requireRecord(value, 'workspace response');
  if (!Array.isArray(record.workspaces)) throw new Error('Workspace response is invalid.');
  return record.workspaces.map(parseWorkspace);
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let value: unknown = {};
    if (text.length > 0) {
      try { value = JSON.parse(text) as unknown; } catch { value = {}; }
    }
    if (!response.ok) {
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
      const detail = typeof record.error_description === 'string' ? record.error_description
        : typeof record.error === 'string' ? record.error
          : `HTTP ${response.status}`;
      const error = new Error(detail) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('The lnwjud Desktop connection timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseHostStatus(value: unknown): CompanionHostStatus {
  const record = requireRecord(value, 'host status');
  if (record.platform !== 'win32' && record.platform !== 'darwin' && record.platform !== 'linux') throw new Error('Host platform is invalid.');
  if (record.arch !== 'x64' && record.arch !== 'arm64') throw new Error('Host architecture is invalid.');
  const activeWorkspace = record.activeWorkspace === null ? null : parseWorkspace(record.activeWorkspace);
  return {
    hostId: requireString(record.hostId, 'hostId'),
    hostName: requireString(record.hostName, 'hostName'),
    appVersion: requireString(record.appVersion, 'appVersion'),
    platform: record.platform,
    arch: record.arch,
    online: record.online === true,
    activeWorkspace,
    runningTaskCount: requireCount(record.runningTaskCount, 'runningTaskCount'),
    pendingApprovalCount: requireCount(record.pendingApprovalCount, 'pendingApprovalCount'),
    serverTime: requireString(record.serverTime, 'serverTime'),
  };
}

function parseWorkspace(value: unknown): CompanionWorkspaceSummary {
  const record = requireRecord(value, 'workspace');
  return {
    id: requireString(record.id, 'workspace.id'),
    displayName: requireString(record.displayName, 'workspace.displayName'),
    active: record.active === true,
    archived: record.archived === true,
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} is invalid.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new Error(`${field} is invalid.`);
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid.`);
  return value;
}
