import { describe, expect, it } from 'vitest';
import { parsePairingPayload, parseStoredSession, parseTokenResponse } from './protocol.js';

const device = {
  deviceId: 'device-1',
  deviceName: 'iPhone',
  platform: 'ios',
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), alg: 'ES256', use: 'sig', key_ops: ['verify'] },
  pairedAt: '2026-09-12T05:00:00.000Z',
  lastSeenAt: '2026-09-12T05:01:00.000Z',
  revokedAt: null,
} as const;

describe('mobile Companion protocol', () => {
  it('accepts only an unexpired bare-HTTPS pairing payload', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      kind: 'lnwjud-companion-pairing',
      hostId: 'host-1',
      publicOrigin: 'https://safe.example.test',
      pairingTicket: 'A'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(parsePairingPayload(payload).publicOrigin).toBe('https://safe.example.test');
    expect(() => parsePairingPayload(payload.replace('https://', 'http://'))).toThrow(/HTTPS/i);
  });

  it('rejects expired pairing material before network use', () => {
    expect(() => parsePairingPayload(JSON.stringify({
      schemaVersion: 1,
      kind: 'lnwjud-companion-pairing',
      hostId: 'host-1',
      publicOrigin: 'https://safe.example.test',
      pairingTicket: 'A'.repeat(43),
      expiresAt: '2020-01-01T00:00:00.000Z',
    }))).toThrow(/expired/i);
  });

  it('separates access and refresh token namespaces', () => {
    const parsed = parseTokenResponse({
      access_token: `lnwjud_comp_${'a'.repeat(43)}`,
      refresh_token: `lnwjud_comp_refresh_${'b'.repeat(43)}`,
      expires_in: 28_800,
      scopes: ['companion.status.read', 'companion.workspace.read'],
      device,
    });
    expect(parsed.accessToken).toMatch(/^lnwjud_comp_/);
    expect(parsed.refreshToken).toMatch(/^lnwjud_comp_refresh_/);
    expect(() => parseTokenResponse({
      access_token: parsed.refreshToken,
      refresh_token: parsed.refreshToken,
      expires_in: 28_800,
      scopes: ['companion.status.read', 'companion.workspace.read'],
      device,
    })).toThrow(/access token/i);
  });

  it('requires a HTTPS origin and refresh token in stored session data', () => {
    const valid = JSON.stringify({
      hostId: 'host-1',
      publicOrigin: 'https://safe.example.test',
      deviceId: 'device-1',
      refreshToken: `lnwjud_comp_refresh_${'c'.repeat(43)}`,
    });
    expect(parseStoredSession(valid).deviceId).toBe('device-1');
    expect(() => parseStoredSession(valid.replace('https://', 'http://'))).toThrow(/origin/i);
  });
});
