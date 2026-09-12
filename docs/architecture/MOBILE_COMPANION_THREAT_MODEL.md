# lnwjud Mobile Companion Threat Model

Status: Phase 0 security baseline
Date: 2026-09-12

## Security objective

Mobile Companion must let a trusted phone observe and control a bounded subset of lnwjud without turning a leaked URL, stolen bearer token, compromised app process, or stale approval into general remote execution on the host.

The Desktop remains the final authorization authority.

## Protected assets

High-value assets include:

- local source repositories and documents;
- credentials and environment secrets reachable by lnwjud;
- Git remotes and authenticated developer tools;
- browser, Office, system, and native automation capabilities;
- task results and logs that may contain sensitive project context;
- approval authority for mutations;
- trusted-device and OAuth refresh state;
- host identity and active-workspace state.

## Trust boundaries

1. **Mobile app process** — trusted only after device pairing; may still be compromised at runtime.
2. **Mobile secure key/storage facility** — protects device signing key and refresh credentials.
3. **Public HTTPS transport** — fully attacker-controlled network; confidentiality/integrity rely on TLS plus application authentication.
4. **Remote gateway** — validates OAuth audience, scopes, client kind, rate limits, and request shape.
5. **Desktop application authority** — enforces workspace, permission, approval, goal lease, task ownership, audit, and capability policy.
6. **Local machine and external tools** — highest-impact boundary; never directly exposed by Companion routes.

## Security invariants

The following are non-negotiable:

1. A Companion access token must never authorize `/mcp`.
2. An MCP/ChatGPT token must never authorize `/companion/v1/*` merely because it is otherwise valid.
3. Companion tokens are sent in authorization headers, never query strings.
4. Pairing requires HTTPS and a short-lived second factor shown on the Desktop.
5. A paired device registers only a public verification key; private key material never crosses the device boundary.
6. Mobile v1 cannot enable or use Full Bypass.
7. Mobile v1 cannot submit a raw shell command or arbitrary MCP tool invocation.
8. Approval is exact-action, single-use, expiring, nonce-bound, argument-digest-bound, workspace-bound, and device-signed.
9. Revoked devices fail closed for refresh, task control, command start, and approval response.
10. Desktop authorization remains authoritative after successful remote authentication.
11. Logs and events are bounded and redacted before leaving the host.
12. Network loss never silently changes task ownership or converts a pending approval into approval.

## Threats and mitigations

| Threat | Impact | Required mitigation |
| --- | --- | --- |
| Public ngrok URL discovered | Unauthorized probing | OAuth required on every protected route; public URL alone grants nothing |
| Stolen Companion access token | Unauthorized mobile actions until expiry | Separate audience, narrow scopes, short access lifetime, device revocation, no raw MCP scope |
| Refresh token theft | Longer-lived access | Mobile secure storage, rotation, revocation, device binding where implementation permits |
| Token leaked through URL/log | Credential disclosure | Authorization header only; redact auth headers/query secrets; never accept Companion token query parameter |
| Pairing-code brute force | Unauthorized device trust | Short TTL, random ticket plus six-digit code, bounded failures, invalidate on threshold/success |
| QR screenshot copied | Unauthorized pairing attempt | QR ticket is short-lived and still requires Desktop-displayed pairing code |
| Malicious app sends arbitrary executable | Remote code execution | Typed command union only; no shell command request schema |
| Mobile calls arbitrary MCP tool | General capability escalation | Companion audience/scopes and separate route surface; `/mcp` rejects Companion token |
| Approval replay | Repeated mutation | Single-use approval ID and nonce, expiry, consumed-state persistence |
| Approval swapped to different args | Different mutation executed | Canonical arguments SHA-256 included in signed payload and rechecked at dispatch |
| Approval swapped to another workspace | Cross-project mutation | Workspace ID included in challenge/signature and current pending request comparison |
| Approval accepted after device revoke | Unauthorized mutation | Device trust checked at response verification time, not only token issue time |
| Stale phone approves old request | Unexpected mutation | Short approval expiry, explicit requested/expires timestamps, single-use challenge |
| MITM modifies approval | Mutation tampering | TLS plus device ES256 signature over exact challenge fields |
| Compromised mobile UI lies about action | User deception | Signature binds canonical machine fields, but Desktop should still show approval history; sanitized display strings are not authorization inputs |
| Companion route bypasses Permission v2 | Policy bypass | Routes call application services/approval adapter, never backend capability implementations directly |
| Companion route bypasses goal lease | Stale worker mutation | Existing durable-goal lease validation remains authoritative |
| Full Bypass exposed remotely | Broad policy bypass | No Companion scope/route/control for Full Bypass in v1 |
| Unbounded logs/events | Memory/network exhaustion or secret spill | Bounded windows, payload size limits, redaction, backpressure, rate limits |
| Event reconnect duplicates action | Duplicate mutation | Events are observational; mutations use idempotency/request IDs where required |
| Cross-host identifier collision | Action on wrong machine | Host identity retained in connection context and multi-host storage |
| Device clock skew | Broken security decision | Server time is authoritative for token/challenge expiry |
| Compromised ngrok provider/runtime | Traffic exposure/redirect | TLS endpoint verification, OAuth at lnwjud gateway, Desktop authorization after gateway; no raw local MCP publication |
| Dependency/supply-chain compromise | App/runtime compromise | Existing pinned lockfile, release verification, provenance/signing gates; minimize new dependencies |

## Approval cryptography

Device approval signing uses ES256 over P-256. The private key should be generated as non-exportable in Secure Enclave/Keychain-backed APIs on iOS and hardware-backed Android Keystore where available. The server stores only the public JWK.

The v1 canonical payload is an ordered JSON array beginning with the domain separator `lnwjud-companion-approval-v1` and then:

1. approval ID;
2. workspace ID;
3. tool name;
4. action;
5. SHA-256 of canonical arguments;
6. nonce;
7. expiry;
8. decision;
9. device ID.

Human-readable summaries are deliberately excluded from the authorization proof because they are presentation data. Authorization compares the signed machine fields to the still-pending Desktop request.

## OAuth/resource separation

Companion access tokens use audience `lnwjud-companion` and `clientKind=mobile`. ChatGPT/MCP remains a distinct protected resource.

Implementation must test both negative directions:

```text
Companion token -> /mcp                 DENY
MCP/ChatGPT token -> /companion/v1/*   DENY
```

A valid token with insufficient Companion scope returns authorization failure and must not fall through to Desktop dispatch.

## Rate and abuse controls

Before production release, the gateway must have explicit limits for:

- pairing attempts per ticket/source window;
- OAuth registration volume;
- command starts per device;
- approval responses per device/approval;
- event-stream connections per device;
- log request page size and request rate;
- malformed-body size and parsing time.

Limits are defense in depth and must not be used as substitutes for authorization.

## Data minimization

Mobile-safe DTOs should omit:

- raw environment variables;
- secret paths where unnecessary;
- command-line credentials;
- OAuth client secrets/refresh tokens;
- tunnel/ngrok authtokens;
- private file contents unless a later explicitly reviewed feature requires them;
- raw MCP request/response payloads by default.

Task/result summaries should be bounded. Full result retrieval, if introduced later, requires a separate contract and security review.

## Revocation

Desktop must expose paired-device inventory and revocation in a later implementation phase. Revocation must:

1. mark the trusted device revoked;
2. invalidate or reject associated refresh grants;
3. reject new Companion token issue/refresh;
4. reject approval signatures from that device even if an old access token remains cryptographically valid;
5. preserve audit history.

## Required security acceptance before Mobile 1.0

The production gate must demonstrate at least:

- leaked public URL without authorization cannot read host status;
- wrong audience is rejected in both resource directions;
- missing/insufficient scope is rejected before dispatch;
- bearer token in query string is ignored/rejected;
- brute-force pairing lock/expiry works;
- non-HTTPS pairing payload is rejected;
- private JWK material is rejected by shared contracts;
- raw shell/MCP command input is rejected;
- approval replay is rejected;
- changed arguments after approval challenge are rejected;
- changed workspace/tool/action are rejected;
- expired approval is rejected;
- revoked device approval is rejected;
- consumed nonce/approval cannot be reused;
- mobile cannot enable Full Bypass;
- Active Project, Permission v2, host exact-action approval, and goal-lease rules remain effective;
- logs/events are redacted and bounded;
- long-lived event connection does not cause unbounded memory growth;
- Desktop restart and network interruption recover state without implicitly approving or cancelling work.

## Deferred threats

Push notification providers, multi-host cloud discovery, account sync, remote file viewing, media upload, and general chat history sync are out of scope for Phase 0. Each requires an additional threat-model delta before implementation.
