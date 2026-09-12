# lnwjud Mobile Companion Architecture

Status: Phase 0 contract — implementation baseline
Date: 2026-09-12
Target: lnwjud Mobile Companion v1

## Decision

lnwjud Mobile Companion is a thin remote control plane for the existing lnwjud Desktop runtime. It is not a second agent engine, not a generic remote shell, and not a clone of KookAI.

The Desktop runtime remains authoritative for workspace scope, permissions, exact-action approvals, task ownership, audit, recovery, provider readiness, and host capability gates. The mobile application consumes a deliberately smaller Companion API and never receives a token that authorizes raw `/mcp` invocation.

## Goals

The first production version focuses on five user outcomes:

1. **View** host, active workspace, task, approval, and bounded log state.
2. **Start** supported lnwjud work through typed commands such as Codex and Recipes.
3. **Track** durable work while the phone disconnects or the app backgrounds.
4. **Approve or deny** one exact pending mutation with a device-bound cryptographic response.
5. **Cancel** a cancellable task owned by lnwjud.

The v1 product explicitly does not provide a raw terminal, file editor, arbitrary MCP explorer, remote desktop, or mobile Full Bypass switch.

## Existing lnwjud capabilities reused

Mobile Companion builds on the existing lnwjud architecture instead of duplicating it:

- loopback MCP runtime and application services;
- Remote MCP OAuth gateway and ngrok transport;
- Authorization Code + PKCE S256;
- pair-once trusted-client persistence;
- host secure-storage provider;
- workspace service and Active Project boundaries;
- Permission v2 and host exact-action approval boundary;
- managed tasks, Codex tasks, delegates, durable goals, and owned process handles;
- Work Log, Live Logs, audit metadata, recovery, and task cancellation.

## Trust boundaries

```text
┌──────────────────────────────┐
│ Mobile Companion            │
│ iOS / Android               │
│ P-256 device signing key    │
└──────────────┬───────────────┘
               │ HTTPS + OAuth/PKCE
               │ Companion access token
               ▼
┌──────────────────────────────┐
│ Remote Gateway              │
│                              │
│ /mcp          ChatGPT OAuth │
│ /companion/v1 Mobile scopes │
└──────────────┬───────────────┘
               │ loopback / typed service calls
               ▼
┌──────────────────────────────┐
│ Desktop authority           │
│ Application / Permission    │
│ Workspace / Task / Audit    │
└──────────────┬───────────────┘
               ▼
        Local machine resources
```

The network edge authenticates the client, but authentication does not replace Desktop authorization. A valid mobile token is only permission to ask the Desktop authority for a Companion operation.

## Repository layout

The intended layout is:

```text
apps/
  desktop/                 existing Desktop authority
  mobile/                  React Native / Expo Development Build

packages/
  companion-contracts/     shared runtime schemas and mobile-safe DTOs
  application/             existing use cases
  permissions/             existing authorization policy
  audit/                   existing audit pipeline
  workspace/               existing workspace authority
```

`@lnwjud/companion-contracts` is deliberately independent of Electron. Both Desktop and Mobile may depend on it without pulling Desktop IPC internals into the mobile bundle.

## Remote routes

The Companion API is versioned separately from MCP:

```text
GET  /companion/v1/status
GET  /companion/v1/workspaces
GET  /companion/v1/tasks
GET  /companion/v1/tasks/:taskId
POST /companion/v1/tasks/:taskId/cancel
GET  /companion/v1/approvals
POST /companion/v1/approvals/:approvalId/respond
POST /companion/v1/commands
GET  /companion/v1/logs
GET  /companion/v1/events
```

The route identifiers and required scopes are canonicalized in `@lnwjud/companion-contracts`.

### Companion scopes

Only the following scopes exist in v1:

- `companion.status.read`
- `companion.workspace.read`
- `companion.task.read`
- `companion.task.control`
- `companion.command.start`
- `companion.approval.read`
- `companion.approval.respond`
- `companion.logs.read`
- `companion.events.read`

There is intentionally no `mcp.invoke`, `shell`, `filesystem.write`, `git.write`, `system.admin`, or `full_bypass` Companion scope.

## Client separation

Remote trusted clients gain an explicit client kind:

```text
chatgpt
mobile
```

ChatGPT continues to use the MCP OAuth resource. Mobile uses a separate audience (`lnwjud-companion`) and Companion scopes. A token accepted by one resource must fail closed on the other resource.

## Pairing and device identity

Mobile pairing is pair-once but device-bound.

1. Desktop starts or reuses the protected remote gateway.
2. Desktop displays a QR payload containing only a host identifier, HTTPS public origin, short-lived pairing ticket, and expiry.
3. The user confirms pairing with the short-lived six-digit code displayed by Desktop.
4. The phone creates a non-exportable P-256 signing key in the platform secure-key facility where available.
5. Mobile registers only the public JWK and device metadata.
6. Desktop persists trusted-device metadata and OAuth refresh state using host secure storage.
7. Mobile stores refresh credentials in iOS Keychain / Android Keystore-backed secure storage, never generic AsyncStorage.

The QR ticket is not a bearer credential for normal Companion routes and expires independently of the post-pair OAuth session.

## Exact-action approval

A mobile approval is not a Boolean `approved=true` message.

Desktop creates an approval challenge containing:

- approval ID;
- workspace ID;
- tool name;
- exact action name;
- SHA-256 digest of the canonical tool arguments;
- random nonce;
- request and expiry timestamps;
- sanitized human-readable context.

The device signs a canonical v1 payload containing the security-critical challenge fields plus the decision and device ID using ES256/P-256. Desktop verifies:

1. trusted, non-revoked device;
2. access token with `companion.approval.respond`;
3. approval still pending and unexpired;
4. exact workspace/tool/action/arguments digest match;
5. nonce has not been consumed;
6. device signature is valid;
7. approval ID has not previously resolved.

Only then may the existing host exact-action approval adapter return approval to `ToolRegistry`.

Mobile approval does not weaken Full Bypass or goal-lease behavior. Mobile v1 has no Full Bypass control.

## Command start boundary

`POST /companion/v1/commands` accepts typed command families only. Phase 0 defines Codex and Recipe requests. It does not accept a raw executable, shell command string, arbitrary MCP tool call, or arbitrary filesystem operation.

A command request still passes through the same workspace, task, provider, permission, audit, and durable-goal rules as the equivalent Desktop/local request.

## Task model

The mobile task list is a projection over existing lnwjud task providers, not a new task engine. The Companion service normalizes managed tasks, Codex tasks, delegates, durable goals, and owned processes into mobile-safe task summaries.

Phone disconnect, app background, token refresh, and transient network failure do not cancel Desktop work. Cancellation is explicit and only available where the owning provider reports that cancellation is supported.

## Events and logs

Foreground live updates should use one bounded event stream rather than sub-second polling. Candidate transport is SSE first because v1 traffic is server-to-client except for normal HTTPS commands; WebSocket is not required to satisfy the product goal.

Event payloads are mobile-safe projections and must never contain credentials, raw authorization headers, private-key material, full environment variables, or unbounded process output.

Push notifications are an optional later transport. Core task correctness must never depend on a third-party push provider.

## Multi-host

Multi-host is a later phase but the v1 contract must not assume one global machine. Host ID, device trust, task identifiers, approval identifiers, and workspace IDs are all scoped to the host connection. The mobile app must not merge tasks or approvals from different hosts without retaining host identity.

## Backward compatibility

Existing `/mcp`, ChatGPT OAuth, Secure MCP Tunnel, local stdio, and loopback HTTP behavior must remain unchanged during Companion development. Companion routes are additive. Refactoring `remote-mcp-controller.ts` is allowed only behind existing regression tests and must not change current MCP OAuth behavior unless the change is independently required and tested.

## Phase gates

Phase 0 is complete only when:

- contracts build and tests pass;
- every Companion route has at least one explicit Companion scope;
- no Companion scope grants raw MCP or Full Bypass;
- pairing contracts reject non-HTTPS public origins;
- device public-key contract rejects private-key material;
- approval canonical payload includes workspace, tool, action, argument digest, nonce, expiry, decision, and device identity;
- typed command schema rejects arbitrary shell;
- architecture and threat model are committed with the same branch.
