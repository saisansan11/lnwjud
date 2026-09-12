import {
  parseCompanionPairingQr,
  type CompanionDevice,
  type CompanionPairingQr,
  type CompanionScope,
} from '@lnwjud/companion-contracts';

export interface CompanionTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly CompanionScope[];
  readonly device: CompanionDevice;
}

export interface StoredCompanionSession {
  readonly hostId: string;
  readonly publicOrigin: string;
  readonly deviceId: string;
  readonly refreshToken: string;
}

export function parsePairingPayload(raw: string): CompanionPairingQr {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('The scanned QR code is not valid lnwjud pairing data.');
  }
  const pairing = parseCompanionPairingQr(value);
  if (Date.parse(pairing.expiresAt) <= Date.now()) throw new Error('This pairing QR code has expired. Generate a new one on Desktop.');
  return pairing;
}

export function parseTokenResponse(value: unknown): CompanionTokenResponse {
  const record = requireRecord(value, 'token response');
  const accessToken = requireString(record.access_token, 'access_token', 256);
  const refreshToken = requireString(record.refresh_token, 'refresh_token', 256);
  if (!accessToken.startsWith('lnwjud_comp_') || accessToken.startsWith('lnwjud_comp_refresh_')) throw new Error('Invalid Companion access token.');
  if (!refreshToken.startsWith('lnwjud_comp_refresh_')) throw new Error('Invalid Companion refresh token.');
  const expiresInSeconds = record.expires_in;
  if (typeof expiresInSeconds !== 'number' || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('Invalid token expiry.');
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) throw new Error('Companion scopes are missing.');
  const scopes = record.scopes.map((scope): CompanionScope => {
    if (scope !== 'companion.status.read' && scope !== 'companion.workspace.read') throw new Error('Unexpected Companion scope.');
    return scope;
  });
  if (!scopes.includes('companion.status.read') || !scopes.includes('companion.workspace.read')) throw new Error('Required read scopes are missing.');
  const device = parseDevice(record.device);
  return { accessToken, refreshToken, expiresInSeconds, scopes, device };
}

export function parseStoredSession(value: string): StoredCompanionSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Stored Companion session is invalid.');
  }
  const record = requireRecord(parsed, 'stored session');
  const publicOrigin = requireString(record.publicOrigin, 'publicOrigin', 2048);
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) throw new Error('Stored Companion origin is invalid.');
  const refreshToken = requireString(record.refreshToken, 'refreshToken', 256);
  if (!refreshToken.startsWith('lnwjud_comp_refresh_')) throw new Error('Stored Companion refresh token is invalid.');
  return {
    hostId: requireString(record.hostId, 'hostId', 256),
    publicOrigin,
    deviceId: requireString(record.deviceId, 'deviceId', 256),
    refreshToken,
  };
}

function parseDevice(value: unknown): CompanionDevice {
  const record = requireRecord(value, 'device');
  const platform = record.platform;
  if (platform !== 'ios' && platform !== 'android') throw new Error('Invalid device platform.');
  const publicKey = requireRecord(record.publicKeyJwk, 'publicKeyJwk');
  if (publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || publicKey.alg !== 'ES256') throw new Error('Invalid device public key.');
  return {
    deviceId: requireString(record.deviceId, 'deviceId', 256),
    deviceName: requireString(record.deviceName, 'deviceName', 256),
    platform,
    publicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: requireString(publicKey.x, 'x', 64),
      y: requireString(publicKey.y, 'y', 64),
      alg: 'ES256',
      ...(publicKey.use === 'sig' ? { use: 'sig' as const } : {}),
      ...(Array.isArray(publicKey.key_ops) && publicKey.key_ops.length === 1 && publicKey.key_ops[0] === 'verify' ? { key_ops: ['verify'] as const } : {}),
    },
    pairedAt: requireString(record.pairedAt, 'pairedAt', 64),
    lastSeenAt: record.lastSeenAt === null ? null : requireString(record.lastSeenAt, 'lastSeenAt', 64),
    revokedAt: record.revokedAt === null ? null : requireString(record.revokedAt, 'revokedAt', 64),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`${field} is invalid.`);
  return value;
}
