import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  COMPANION_API_PREFIX,
  companionScopesAllow,
  parseCompanionPairingQr,
  parseCompanionPublicKeyJwk,
  type CompanionDevice,
  type CompanionHostStatus,
  type CompanionPairingQr,
  type CompanionRegisterDeviceRequest,
  type CompanionScope,
  type CompanionWorkspaceSummary,
} from '@lnwjud/companion-contracts';
import type { SecretProtector } from '@lnwjud/shared';

const PAIRING_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 8 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const READ_ONLY_SCOPES = ['companion.status.read', 'companion.workspace.read'] as const satisfies readonly CompanionScope[];
const MAX_DEVICES = 16;
const MAX_REFRESH_GRANTS = 16;

interface PairingSession {
  readonly ticket: string;
  readonly code: string;
  readonly expiresAt: number;
  failures: number;
}

interface CompanionGrant {
  readonly tokenSha256: string;
  readonly deviceId: string;
  readonly scopes: readonly CompanionScope[];
  readonly expiresAt: number;
}

interface CompanionPersistedState {
  readonly schemaVersion: 1;
  readonly devices: readonly CompanionDevice[];
  readonly refreshGrants: readonly CompanionGrant[];
}

interface CompanionTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessGrant: CompanionGrant;
  readonly refreshGrant: CompanionGrant;
}

export interface CompanionPairingBundle {
  readonly qr: CompanionPairingQr;
  readonly pairingCode: string;
}

export interface CompanionGatewayOptions {
  readonly dataPath: string;
  readonly getHostStatus: () => Promise<CompanionHostStatus>;
  readonly listWorkspaces: () => Promise<readonly CompanionWorkspaceSummary[]>;
  readonly secretProtector: SecretProtector;
  readonly now?: () => number;
}

export class CompanionGateway {
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly getHostStatus: () => Promise<CompanionHostStatus>;
  private readonly listWorkspaces: () => Promise<readonly CompanionWorkspaceSummary[]>;
  private readonly secretProtector: SecretProtector;
  private readonly devices = new Map<string, CompanionDevice>();
  private readonly accessGrants = new Map<string, CompanionGrant>();
  private readonly refreshGrants = new Map<string, CompanionGrant>();
  private pairing: PairingSession | null = null;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  public constructor(options: CompanionGatewayOptions) {
    this.now = options.now ?? Date.now;
    this.statePath = path.join(options.dataPath, 'companion', 'state.secret');
    this.getHostStatus = options.getHostStatus;
    this.listWorkspaces = options.listWorkspaces;
    this.secretProtector = options.secretProtector;
  }

  public async beginPairing(publicOrigin: string): Promise<CompanionPairingBundle> {
    await this.ensureLoaded();
    const host = await this.getHostStatus();
    const ticket = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairing = { ticket, code, expiresAt, failures: 0 };
    const qr = parseCompanionPairingQr({
      schemaVersion: 1,
      kind: 'lnwjud-companion-pairing',
      hostId: host.hostId,
      publicOrigin,
      pairingTicket: ticket,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return { qr, pairingCode: code };
  }

  public async revokeDevice(deviceId: string): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.devices.get(deviceId);
    if (existing === undefined || existing.revokedAt !== null) return false;
    this.devices.set(deviceId, { ...existing, revokedAt: new Date(this.now()).toISOString() });
    this.deleteDeviceGrants(deviceId);
    await this.persist();
    return true;
  }

  public async listDevices(): Promise<readonly CompanionDevice[]> {
    await this.ensureLoaded();
    return [...this.devices.values()];
  }

  public async handleRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== COMPANION_API_PREFIX && !url.pathname.startsWith(`${COMPANION_API_PREFIX}/`)) return false;
    await this.ensureLoaded();

    if (request.method === 'POST' && url.pathname === `${COMPANION_API_PREFIX}/register`) {
      let registration: CompanionRegisterDeviceRequest;
      try {
        registration = parseRegisterRequest(await readJson(request, 64 * 1024));
      } catch (error) {
        json(response, 400, { error: 'invalid_request', error_description: errorMessage(error) });
        return true;
      }
      if (!this.verifyPairing(registration.pairingTicket, registration.pairingCode)) {
        json(response, 403, { error: 'pairing_rejected' });
        return true;
      }
      const nowIso = new Date(this.now()).toISOString();
      const device: CompanionDevice = {
        deviceId: registration.deviceId,
        deviceName: registration.deviceName,
        platform: registration.platform,
        publicKeyJwk: registration.publicKeyJwk,
        pairedAt: nowIso,
        lastSeenAt: nowIso,
        revokedAt: null,
      };
      this.deleteDeviceGrants(device.deviceId);
      this.devices.set(device.deviceId, device);
      const pair = this.createTokenPair(device.deviceId, READ_ONLY_SCOPES);
      this.accessGrants.set(pair.accessGrant.tokenSha256, pair.accessGrant);
      this.refreshGrants.set(pair.refreshGrant.tokenSha256, pair.refreshGrant);
      await this.persist();
      this.pairing = null;
      tokenResponse(response, 201, pair, device);
      return true;
    }

    if (request.method === 'POST' && url.pathname === `${COMPANION_API_PREFIX}/token`) {
      let refreshToken: string;
      try {
        const body = strictRecord(await readJson(request, 16 * 1024), ['refreshToken']);
        refreshToken = boundedString(body.refreshToken, 'refreshToken', 256);
      } catch (error) {
        json(response, 400, { error: 'invalid_request', error_description: errorMessage(error) });
        return true;
      }
      const rotated = await this.rotateRefreshToken(refreshToken);
      if (rotated === null) {
        json(response, 401, { error: 'invalid_grant' });
        return true;
      }
      tokenResponse(response, 200, rotated.pair, rotated.device);
      return true;
    }

    if (request.method === 'GET' && url.pathname === `${COMPANION_API_PREFIX}/status`) {
      const authorization = this.authorize(request, 'status.get');
      if (!authorization.ok) {
        companionAuthError(response, authorization.status);
        return true;
      }
      json(response, 200, await this.getHostStatus());
      return true;
    }

    if (request.method === 'GET' && url.pathname === `${COMPANION_API_PREFIX}/workspaces`) {
      const authorization = this.authorize(request, 'workspaces.list');
      if (!authorization.ok) {
        companionAuthError(response, authorization.status);
        return true;
      }
      json(response, 200, { workspaces: await this.listWorkspaces() });
      return true;
    }

    response.statusCode = 404;
    response.end('Not found');
    return true;
  }

  private authorize(request: IncomingMessage, route: 'status.get' | 'workspaces.list'): { readonly ok: true } | { readonly ok: false; readonly status: 401 | 403 } {
    const bearer = parseBearer(request.headers.authorization);
    if (bearer === null || !bearer.startsWith('lnwjud_comp_') || bearer.startsWith('lnwjud_comp_refresh_')) return { ok: false, status: 401 };
    const digest = sha256(bearer);
    const grant = this.accessGrants.get(digest);
    if (grant === undefined) return { ok: false, status: 401 };
    if (grant.expiresAt <= this.now()) {
      this.accessGrants.delete(digest);
      return { ok: false, status: 401 };
    }
    const device = this.devices.get(grant.deviceId);
    if (device === undefined || device.revokedAt !== null) return { ok: false, status: 401 };
    if (!companionScopesAllow(grant.scopes, route)) return { ok: false, status: 403 };
    this.devices.set(device.deviceId, { ...device, lastSeenAt: new Date(this.now()).toISOString() });
    return { ok: true };
  }

  private async rotateRefreshToken(value: string): Promise<{ readonly pair: CompanionTokenPair; readonly device: CompanionDevice } | null> {
    if (!value.startsWith('lnwjud_comp_refresh_')) return null;
    const digest = sha256(value);
    const grant = this.refreshGrants.get(digest);
    if (grant === undefined || grant.expiresAt <= this.now()) {
      if (grant !== undefined) this.refreshGrants.delete(digest);
      return null;
    }
    const device = this.devices.get(grant.deviceId);
    if (device === undefined || device.revokedAt !== null) return null;
    const pair = this.createTokenPair(device.deviceId, grant.scopes);
    this.refreshGrants.delete(digest);
    this.refreshGrants.set(pair.refreshGrant.tokenSha256, pair.refreshGrant);
    this.accessGrants.set(pair.accessGrant.tokenSha256, pair.accessGrant);
    try {
      await this.persist();
    } catch (error) {
      this.refreshGrants.delete(pair.refreshGrant.tokenSha256);
      this.accessGrants.delete(pair.accessGrant.tokenSha256);
      this.refreshGrants.set(digest, grant);
      throw error;
    }
    const refreshedDevice = { ...device, lastSeenAt: new Date(this.now()).toISOString() };
    this.devices.set(device.deviceId, refreshedDevice);
    return { pair, device: refreshedDevice };
  }

  private createTokenPair(deviceId: string, scopes: readonly CompanionScope[]): CompanionTokenPair {
    const accessToken = `lnwjud_comp_${randomBytes(32).toString('base64url')}`;
    const refreshToken = `lnwjud_comp_refresh_${randomBytes(32).toString('base64url')}`;
    return {
      accessToken,
      refreshToken,
      accessGrant: { tokenSha256: sha256(accessToken), deviceId, scopes, expiresAt: this.now() + ACCESS_TTL_MS },
      refreshGrant: { tokenSha256: sha256(refreshToken), deviceId, scopes, expiresAt: this.now() + REFRESH_TTL_MS },
    };
  }

  private deleteDeviceGrants(deviceId: string): void {
    for (const [digest, grant] of this.accessGrants) if (grant.deviceId === deviceId) this.accessGrants.delete(digest);
    for (const [digest, grant] of this.refreshGrants) if (grant.deviceId === deviceId) this.refreshGrants.delete(digest);
  }

  private verifyPairing(ticket: string, code: string): boolean {
    const pairing = this.pairing;
    if (pairing === null || this.now() >= pairing.expiresAt) {
      this.pairing = null;
      return false;
    }
    const accepted = secureEqual(ticket, pairing.ticket) && secureEqual(code, pairing.code);
    if (accepted) return true;
    pairing.failures += 1;
    if (pairing.failures >= 5) this.pairing = null;
    return false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.load();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async load(): Promise<void> {
    let encrypted: string;
    try {
      encrypted = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        this.loaded = true;
        return;
      }
      throw error;
    }
    const decrypted = await this.secretProtector.decrypt('companion_state', encrypted.trim());
    const state = normalizeState(JSON.parse(decrypted.plainText) as unknown, this.now());
    for (const device of state.devices) this.devices.set(device.deviceId, device);
    for (const grant of state.refreshGrants) this.refreshGrants.set(grant.tokenSha256, grant);
    this.loaded = true;
    if (decrypted.shouldReEncrypt) await this.persist();
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true });
    const now = this.now();
    const devices = [...this.devices.values()].slice(-MAX_DEVICES);
    const deviceIds = new Set(devices.map((device) => device.deviceId));
    const refreshGrants = [...this.refreshGrants.values()]
      .filter((grant) => grant.expiresAt > now && deviceIds.has(grant.deviceId))
      .slice(-MAX_REFRESH_GRANTS);
    const plainText = JSON.stringify({ schemaVersion: 1, devices, refreshGrants } satisfies CompanionPersistedState);
    const encrypted = await this.secretProtector.encrypt('companion_state', plainText);
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, encrypted, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.statePath);
  }
}

function tokenResponse(response: ServerResponse, status: number, pair: CompanionTokenPair, device: CompanionDevice): void {
  json(response, status, {
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
    device,
    scopes: pair.accessGrant.scopes,
  });
}

function parseRegisterRequest(value: unknown): CompanionRegisterDeviceRequest {
  const record = strictRecord(value, ['pairingTicket', 'pairingCode', 'deviceId', 'deviceName', 'platform', 'publicKeyJwk']);
  const pairingTicket = boundedString(record.pairingTicket, 'pairingTicket', 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairingTicket)) throw new Error('pairingTicket is invalid');
  const pairingCode = boundedString(record.pairingCode, 'pairingCode', 6);
  if (!/^\d{6}$/.test(pairingCode)) throw new Error('pairingCode must be 6 digits');
  const deviceId = boundedString(record.deviceId, 'deviceId', 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) throw new Error('deviceId is invalid');
  const deviceName = boundedString(record.deviceName, 'deviceName', 120).trim();
  if (deviceName.length === 0) throw new Error('deviceName must not be blank');
  if (record.platform !== 'ios' && record.platform !== 'android') throw new Error('platform must be ios or android');
  return {
    pairingTicket,
    pairingCode,
    deviceId,
    deviceName,
    platform: record.platform,
    publicKeyJwk: parseCompanionPublicKeyJwk(record.publicKeyJwk),
  };
}

function normalizeState(value: unknown, now: number): CompanionPersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { schemaVersion: 1, devices: [], refreshGrants: [] };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return { schemaVersion: 1, devices: [], refreshGrants: [] };
  const devices = Array.isArray(record.devices)
    ? record.devices.flatMap((entry): CompanionDevice[] => {
      try { return [normalizeDevice(entry)]; } catch { return []; }
    }).slice(-MAX_DEVICES)
    : [];
  const deviceIds = new Set(devices.filter((device) => device.revokedAt === null).map((device) => device.deviceId));
  const refreshGrants = Array.isArray(record.refreshGrants)
    ? record.refreshGrants.flatMap((entry): CompanionGrant[] => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const grant = entry as Record<string, unknown>;
      if (typeof grant.tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(grant.tokenSha256)) return [];
      if (typeof grant.deviceId !== 'string' || !deviceIds.has(grant.deviceId)) return [];
      if (!Array.isArray(grant.scopes) || grant.scopes.some((scope) => scope !== 'companion.status.read' && scope !== 'companion.workspace.read')) return [];
      if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) return [];
      return [{ tokenSha256: grant.tokenSha256, deviceId: grant.deviceId, scopes: grant.scopes as CompanionScope[], expiresAt: grant.expiresAt }];
    }).slice(-MAX_REFRESH_GRANTS)
    : [];
  return { schemaVersion: 1, devices, refreshGrants };
}

function normalizeDevice(value: unknown): CompanionDevice {
  const record = strictRecord(value, ['deviceId', 'deviceName', 'platform', 'publicKeyJwk', 'pairedAt', 'lastSeenAt', 'revokedAt']);
  const deviceId = boundedString(record.deviceId, 'deviceId', 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) throw new Error('deviceId is invalid');
  const deviceName = boundedString(record.deviceName, 'deviceName', 120);
  if (record.platform !== 'ios' && record.platform !== 'android') throw new Error('platform is invalid');
  const pairedAt = isoDate(record.pairedAt, 'pairedAt');
  const lastSeenAt = record.lastSeenAt === null ? null : isoDate(record.lastSeenAt, 'lastSeenAt');
  const revokedAt = record.revokedAt === null ? null : isoDate(record.revokedAt, 'revokedAt');
  return { deviceId, deviceName, platform: record.platform, publicKeyJwk: parseCompanionPublicKeyJwk(record.publicKeyJwk), pairedAt, lastSeenAt, revokedAt };
}

function strictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected field: ${key}`);
  return record;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`${field} is invalid`);
  return value;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${field} is invalid`);
  return value;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

function companionAuthError(response: ServerResponse, status: 401 | 403): void {
  if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
  json(response, status, { error: status === 401 ? 'unauthorized' : 'insufficient_scope' });
}

function parseBearer(value: string | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value ?? '');
  return match?.[1] ?? null;
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function isMissingFileError(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}
