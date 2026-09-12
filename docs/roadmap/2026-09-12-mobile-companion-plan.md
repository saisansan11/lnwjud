# lnwjud Mobile Companion Implementation Plan

Date: 2026-09-12
Branch sequence starts from `main`
Product goal: secure iOS/Android companion for viewing, starting, tracking, approving, and cancelling lnwjud work while Desktop remains authoritative.

## Global constraints

- Do not fork KookAI or add a second agent backend.
- Do not expose raw local MCP through Companion credentials.
- Do not add a mobile Full Bypass control.
- Reuse existing lnwjud application/task/permission/audit services.
- Add typed, versioned Companion contracts before network handlers or UI.
- Keep current ChatGPT `/mcp`, Remote MCP OAuth, Secure Tunnel, stdio, and Desktop behavior regression-compatible.
- Prefer standard/platform facilities and current dependencies before introducing new libraries.
- Every mutation path must have negative authorization tests.
- Mobile disconnect/backgrounding must not own task lifetime.
- CI/release standards are not weaker for mobile code than for Desktop code.

## PR-M1 — Architecture, contracts, threat model

**Goal:** Freeze the security and API vocabulary that later phases implement.

Deliverables:

- `@lnwjud/companion-contracts` package;
- Companion API version, scopes, route IDs, mobile-safe DTO schemas;
- pair-once device registration contract;
- ES256/P-256 public-key contract;
- exact-action approval challenge/response and canonical signature payload;
- typed Codex/Recipe command request that rejects arbitrary shell;
- architecture decision document;
- threat model and 1.0 security acceptance checklist.

Acceptance:

- package test/typecheck/build pass;
- every route has explicit scope;
- no MCP invoke or Full Bypass scope;
- pairing requires HTTPS;
- private JWK fields rejected;
- exact-action signature payload is deterministic;
- arbitrary shell command fails schema validation;
- root lint/typecheck relevant gates pass.

## PR-M2 — Trusted mobile clients and scoped gateway

**Goal:** Add Mobile as a separate protected resource without changing existing MCP OAuth behavior.

Implementation outline:

1. Refactor reusable OAuth/trusted-client primitives out of `remote-mcp-controller.ts` only as needed.
2. Persist `clientKind` and mobile trusted-device metadata with migration-safe defaults for existing ChatGPT trusted clients.
3. Add Companion audience and scope issuance/validation.
4. Add `/companion/v1/status` and `/companion/v1/workspaces` read-only endpoints first.
5. Enforce Authorization header only for Companion bearer tokens.
6. Add per-route body size, scope, audience, and client-kind gates.
7. Add paired-device revoke service and Desktop settings surface.

Security tests:

- Companion token denied at `/mcp`;
- ChatGPT/MCP token denied at Companion routes;
- wrong/missing scope denied before service dispatch;
- revoked device denied even with previously issued token;
- query token ignored/rejected;
- existing ChatGPT OAuth tests stay green.

## PR-M3 — Mobile foundation and pairing

**Goal:** Build the first real iOS/Android client that can pair and show host status.

Repository:

```text
apps/mobile/
```

Preferred stack:

- React Native;
- Expo Development Build rather than browser/PWA wrapper;
- TypeScript;
- `@lnwjud/companion-contracts` shared package;
- platform secure key/storage integration for refresh credential + device key.

First UI:

- Pair Device;
- Home;
- Tasks placeholder;
- Approvals placeholder;
- Settings / paired host information.

Pairing flow:

1. Desktop generates short-lived QR ticket and 6-digit code.
2. Mobile scans QR.
3. Mobile creates P-256 signing key.
4. User enters/confirms code.
5. Device registers public JWK.
6. OAuth pair-once grant is stored securely.
7. Home calls host status and workspace list.

Acceptance uses a physical iPhone first, then Android from the same codebase.

## PR-M4 — Durable task monitoring and cancellation

**Goal:** Make the mobile app useful before adding remote command creation.

Desktop Companion service normalizes:

- managed tasks;
- Codex tasks;
- delegates;
- durable goals;
- owned processes.

Routes:

- `GET /tasks`;
- `GET /tasks/:id`;
- `POST /tasks/:id/cancel`.

Requirements:

- only owned/cancellable tasks expose Cancel;
- cancellation is idempotent;
- task summaries are bounded;
- app background/network loss does not cancel tasks;
- Desktop restart recovery shows the authoritative recovered state.

## PR-M5 — Cryptographic mobile exact-action approval

**Goal:** Let the phone act as a trusted second exact-action approval provider without weakening Desktop policy.

Desktop work:

- pending approval repository/service;
- approval challenge creation;
- canonical argument hashing;
- nonce/single-use state;
- expiry;
- trusted-device ES256 verification;
- adapter into existing host exact-action approval boundary;
- audit trail.

Mobile work:

- approval inbox;
- clear workspace/tool/action/target/risk presentation;
- approve/deny;
- biometric/device-auth confirmation when supported;
- sign canonical payload with non-exportable P-256 key.

Must reject:

- replay;
- stale/expired challenge;
- changed workspace;
- changed tool/action;
- changed argument digest;
- wrong device;
- revoked device;
- consumed nonce;
- unsigned Boolean approval.

## PR-M6 — Remote typed commands

**Goal:** Start supported work remotely without a raw terminal.

Initial command families:

- Codex instruction;
- Recipe execution.

Later opt-in candidate:

- Agent Swarm after its own permission/UX review.

Do not accept:

- arbitrary executable;
- shell string;
- direct arbitrary MCP tool name/arguments;
- arbitrary filesystem write request.

Every command returns an existing lnwjud task identity and is then monitored through the normal task API.

## PR-M7 — Live events and notifications

**Goal:** Remove manual refresh while keeping memory/network use bounded.

Foreground:

- SSE preferred for v1;
- bounded replay cursor/event IDs;
- heartbeat;
- reconnect with Last-Event-ID or equivalent bounded cursor;
- per-device stream limit;
- no unbounded in-memory subscriber queue.

Events:

- host status;
- task start/progress/terminal;
- approval required/resolved.

Push notifications are optional and must be transport-only. They never carry credentials or become the source of truth.

## PR-M8 — Multi-host, resilience, release hardening

**Goal:** Production-ready 1.0 behavior.

Features:

- multiple paired lnwjud hosts;
- strict host context separation;
- device list/revoke UX;
- connection health and last-seen state;
- offline/reconnect UX;
- bounded log viewer;
- localization Thai/English;
- accessibility and mobile layout acceptance.

Security/reliability acceptance:

- full checklist from `MOBILE_COMPANION_THREAT_MODEL.md`;
- long-session memory soak for gateway + event streams;
- Desktop restart/network interruption tests;
- iOS real-device acceptance;
- Android real-device acceptance;
- package/release provenance for mobile artifacts;
- privacy review for crash diagnostics/telemetry;
- no secrets in logs, deep links, URLs, QR screenshots, or exported diagnostics.

## Dependency order

```text
M1 contracts/security
  ↓
M2 gateway/auth
  ↓
M3 mobile pairing/home
  ↓
M4 task monitor
  ↓
M5 approvals
  ↓
M6 remote command
  ↓
M7 events/notifications
  ↓
M8 multi-host/release
```

M5 intentionally precedes M6 so remote work creation is added only after the trusted remote approval path is hardened.

## Definition of Mobile Companion v1

Version 1 is successful when the user can leave the Desktop running, open the phone, securely connect to the correct host, see the active project and current work, start a supported lnwjud task, follow its progress, approve/deny exact risky actions, cancel supported tasks, survive phone/network disconnects, and revoke the phone from Desktop — without creating a second agent runtime or exposing raw MCP/shell authority to the mobile credential.
