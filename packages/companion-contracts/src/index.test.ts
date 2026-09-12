import { describe, expect, it } from 'vitest';
import {
  ALL_COMPANION_SCOPES,
  COMPANION_DEVICE_KEY_ALGORITHM,
  COMPANION_ROUTE_SCOPES,
  canonicalCompanionApprovalPayload,
  companionApprovalSignatureInput,
  companionScopesAllow,
  parseCompanionAccessTokenClaims,
  parseCompanionApprovalChallenge,
  parseCompanionPairingQr,
  parseCompanionPublicKeyJwk,
  parseCompanionStartCommandRequest,
} from './index.js';

describe('companion security contracts', () => {
  it('never defines raw MCP invoke or Full Bypass as a mobile scope', () => {
    expect(ALL_COMPANION_SCOPES.some((scope) => scope.includes('mcp'))).toBe(false);
    expect(ALL_COMPANION_SCOPES.some((scope) => scope.includes('bypass'))).toBe(false);
  });

  it('requires an explicit scope for every companion route', () => {
    for (const scopes of Object.values(COMPANION_ROUTE_SCOPES)) {
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) expect(ALL_COMPANION_SCOPES).toContain(scope);
    }
  });

  it('does not allow a read-only token to control or start work', () => {
    const readOnly = [
      'companion.status.read',
      'companion.workspace.read',
      'companion.task.read',
    ] as const;
    expect(companionScopesAllow(readOnly, 'tasks.list')).toBe(true);
    expect(companionScopesAllow(readOnly, 'tasks.cancel')).toBe(false);
    expect(companionScopesAllow(readOnly, 'commands.start')).toBe(false);
    expect(companionScopesAllow(readOnly, 'approvals.respond')).toBe(false);
  });

  it('binds access-token claims to the mobile audience, client kind, and device subject', () => {
    const parsed = parseCompanionAccessTokenClaims({
      aud: 'lnwjud-companion',
      sub: 'device-1',
      clientKind: 'mobile',
      deviceId: 'device-1',
      scopes: ['companion.status.read'],
      iat: 1_000,
      exp: 2_000,
      jti: 'token-1',
    });
    expect(parsed.deviceId).toBe('device-1');

    expect(() => parseCompanionAccessTokenClaims({ ...parsed, aud: 'lnwjud-mcp' })).toThrow();
    expect(() => parseCompanionAccessTokenClaims({ ...parsed, sub: 'other-device' })).toThrow();
  });

  it('requires a bare HTTPS origin for pairing QR payloads', () => {
    const common = {
      schemaVersion: 1,
      kind: 'lnwjud-companion-pairing',
      hostId: 'host-1',
      pairingTicket: 'AbcdEFGHijklMNOPqrstUVWXyz_12345',
      expiresAt: '2026-09-12T10:15:00+07:00',
    };
    expect(parseCompanionPairingQr({ ...common, publicOrigin: 'https://example.ngrok.app/' }).publicOrigin)
      .toBe('https://example.ngrok.app');
    expect(() => parseCompanionPairingQr({ ...common, publicOrigin: 'http://example.test' })).toThrow();
    expect(() => parseCompanionPairingQr({ ...common, publicOrigin: 'https://example.test/path' })).toThrow();
    expect(() => parseCompanionPairingQr({ ...common, publicOrigin: 'https://example.test/?token=bad' })).toThrow();
  });

  it('accepts only public P-256 ES256 verification keys', () => {
    const key = parseCompanionPublicKeyJwk({
      kty: 'EC',
      crv: 'P-256',
      alg: COMPANION_DEVICE_KEY_ALGORITHM,
      use: 'sig',
      key_ops: ['verify'],
      x: 'A'.repeat(43),
      y: 'B'.repeat(43),
    });
    expect(key.crv).toBe('P-256');
    expect(() => parseCompanionPublicKeyJwk({ ...key, d: 'private-material' })).toThrow();
    expect(() => parseCompanionPublicKeyJwk({ ...key, x: 'A'.repeat(42) })).toThrow();
  });

  it('creates a stable exact-action approval signature payload', () => {
    const challenge = parseCompanionApprovalChallenge({
      approvalId: 'approval-1',
      workspaceId: 'workspace-1',
      workspaceDisplayName: 'EMSO',
      toolName: 'git',
      action: 'push',
      targetSummary: 'origin feat/mobile',
      permission: 'EXECUTE',
      argumentsSha256: 'a'.repeat(64),
      nonce: 'AbcdEFGHijklMNOPqrstUVWXyz_12345',
      requestedAt: '2026-09-12T10:00:00+07:00',
      expiresAt: '2026-09-12T10:05:00+07:00',
    });
    const input = companionApprovalSignatureInput(challenge, {
      deviceId: 'phone-1',
      decision: 'approve',
    });
    const payload = canonicalCompanionApprovalPayload(input);

    expect(payload).toContain('lnwjud-companion-approval-v1');
    expect(payload).toContain('workspace-1');
    expect(payload).toContain('a'.repeat(64));
    expect(payload).toContain('phone-1');
    expect(canonicalCompanionApprovalPayload(input)).toBe(payload);
  });

  it('does not expose arbitrary shell or blank Codex instructions', () => {
    expect(parseCompanionStartCommandRequest({
      kind: 'codex',
      workspaceId: 'workspace-1',
      instruction: 'Review the current branch',
    }).kind).toBe('codex');

    expect(() => parseCompanionStartCommandRequest({
      kind: 'shell',
      workspaceId: 'workspace-1',
      command: 'rm -rf /',
    })).toThrow();
    expect(() => parseCompanionStartCommandRequest({
      kind: 'codex',
      workspaceId: 'workspace-1',
      instruction: '   ',
    })).toThrow();
  });
});
