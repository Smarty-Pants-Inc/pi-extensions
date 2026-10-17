# pi-codex-compact — remote compaction V2 for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-codex-compact)](https://www.npmjs.com/package/@signalridge/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> This extension is experimental. It depends on an undocumented OpenAI Codex Responses wire
> contract and stores provider-specific opaque checkpoints. Keep backups of important sessions.

`@signalridge/pi-codex-compact` adds Codex Remote Compaction V2 to the
[Pi Coding Agent](https://pi.dev) for the built-in `openai-codex` OAuth provider. It replaces Pi's
plaintext summary-generation call with a server-generated opaque compaction item and safely replays
that item in later OpenAI Codex Responses requests.

Pi remains responsible for deciding when compaction runs, including automatic thresholds, the
built-in `/compact` command, overflow retries, retained-message selection, and append-only session
publication. This package owns only the Remote V2 request, checkpoint persistence, and later payload
replay.

## Features

- Uses the active `openai-codex` OAuth credentials without persisting tokens or request headers.
- Handles Pi's manual, threshold, and overflow compaction reasons through the same lifecycle hook.
- Validates one bounded opaque `compaction` item from a completed Responses SSE stream.
- Persists a versioned checkpoint in `CompactionEntry.details` and restores it after reload, resume,
  or a fork that retains the checkpoint.
- Replays the newest compatible checkpoint while preserving later conversation and extension-added
  context.
- Supports repeated compaction by carrying the previous opaque item into the next Remote V2 request.
- Requires informed authorization for persisted canonical history before credentials or transport.
  Unconsented compaction cancels, including in headless/RPC modes; it does not launch native fallback.
- After authorization, authentication, transport, protocol, or validation failures can use Pi's
  native plaintext compaction. Session/branch divergence and user cancellation cancel instead.
- Provides `/codex-compact` for manual compaction, effective-route visibility, and bounded settings.

## Install

Install persistently from npm:

```bash
pi install npm:@signalridge/pi-codex-compact
```

Try the published package without installing:

```bash
pi -e npm:@signalridge/pi-codex-compact
```

Try a local checkout from the repository root:

```bash
pi -e ./packages/pi-codex-compact
# or
just try codex-compact
```

Loading the package enables the Remote V2 hook, but does **not** authorize sending canonical history.
Avoid loading a global npm installation and the local workspace at the same time.

## Quick start

1. Sign in through Pi's built-in OpenAI Codex OAuth provider.
2. Select a model whose provider is `openai-codex` and API is `openai-codex-responses`.
3. Work normally. In a UI-capable TUI, compaction asks permission to use canonical history **once**.
   Declining, cancelling, timing out, or having no suitable UI cancels compaction, not just the remote
   request. To authorize future requests explicitly, toggle **Allow canonical history** in this
   extension's Settings menu. In headless/RPC modes that persistent opt-in is required.
4. Run `/codex-compact` to inspect the effective route or choose **Compact now**.
5. After compaction, continue the session normally; compatible requests replay the opaque checkpoint.

The extension shows an experimental warning at session start in UI-capable modes. When the active
model is unsupported, compaction remains entirely Pi-native.

## Command

```text
/codex-compact
```

In TUI mode, the root menu shows whether Remote V2 is enabled, the active model, and whether a
manual compact will use **Codex Remote V2** (asking once unless canonical history is allowed) or
**Pi native**. It contains:

```text
Compact now
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session. Escape or Ctrl+C
closes without compacting, and an obsolete menu cannot trigger work after session replacement or
shutdown. **Settings** opens the bounded settings editor. In non-TUI modes, the command reports the
manual settings path instead of opening custom UI or compacting.

Pi's built-in `/compact` remains available and follows the same extension hook when the active model
is compatible.

## Settings

The extension has one optional, global-only JSON settings file:

```text
<getAgentDir()>/pi-codex-compact.json
```

The normal path is `~/.pi/agent/pi-codex-compact.json`. There is no environment-variable or
project-level override.

```json
{
  "enabled": true,
  "allowCanonicalHistory": false,
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Intercept compaction for a compatible model. Turning it off leaves Pi-native compaction outside this consent gate. | Keep enabled to enforce the gate. |
| `allowCanonicalHistory` | `false` | Boolean | Explicit persistent authorization to send canonical history and permit native summary fallback without asking each time. | Leave off unless you understand the privacy boundary below; toggle in this extension's Settings menu to opt in. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound authentication, retries, and response-body inspection after authorization. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item. | Keep 64K; lower it to reduce session size or raise it only when recent user context is being lost. |
| `notifyOnFallback` | `true` | Boolean | Warn when Remote V2 fails and Pi-native compaction takes over. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |

Missing fields use defaults. Settings reload on every `session_start`, including `/reload`, resume,
and fork. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current
Pi process, and use a final conflict check plus same-directory atomic rename. On Unix, temporary
files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files are never overwritten. Safe defaults stay
active, and the menu provides read-only repair guidance until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the
user can reopen Settings and retry.

### Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to this extension's `enabled`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not used by Remote V2, whose opaque checkpoint is generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- The built-in provider `openai-codex`.
- API `openai-codex-responses` on the active model.
- A working OpenAI Codex OAuth login and Remote V2 entitlement.

OpenAI API-key, Azure, GitHub Copilot, and arbitrary Responses-compatible providers are not
supported. The built-in Codex provider's credential-resolved destination is honored together with
its API key, headers, and environment; a configured destination must implement the same Codex wire
contract. Compatibility with arbitrary proxies is not guaranteed. Switching to another provider or
model leaves Pi's visible fallback marker plus retained recent messages in context. Switching back
to the checkpoint's original compatible model restores opaque replay.

## How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. The extension captures session/branch ownership and requires canonical-history authorization,
   before resolving credentials. TUI confirmation is cancellable, expires after five minutes, and
   grants only this operation; persistent authorization is a separate explicit settings toggle.
   It then projects an earlier compatible checkpoint, if present, into the canonical Responses input.
3. It appends exactly one final `compaction_trigger` and sends a normal authenticated Codex Responses
   SSE request with cache retention disabled.
4. It requires a completed response containing exactly one non-empty opaque `compaction` item.
5. It constructs bounded replacement history from recent raw user-role Responses items followed by
   the opaque item.
6. It stores that history and fingerprints of Pi's retained suffix in versioned
   `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted
   replacement history immediately before provider dispatch.

If fingerprints, model identity, payload shape, or marker count do not match exactly, the extension
leaves Pi's visible fallback context unchanged instead of guessing.

Loadout hooks can transform model-facing tool descriptions without changing the raw registry.
The extension recognizes those transformations only after fresh agent-context preparation and a
provider payload whose tool names and descriptions match the persisted declarations. It freezes
both public tool surfaces and the serialized wire tools; Remote V2 must reproduce that wire snapshot
before sending. Cached provider callbacks cannot approve unsent registry edits, and hidden
declarations cause Pi-native fallback rather than restoring hidden tools remotely. Evidence is
in-memory only and resets on startup, reload, or tree navigation. A fresh, unchanged normal request
can establish it again; prompt, tool, and schema changes remain guarded.

## Privacy, storage, and limits

Remote compaction sends Pi's **persisted canonical projection**, system instructions, and tool
schemas to the selected model's credential-resolved Codex destination. It honors durable
`context_edit` omissions/replacements; it does not send unprojected raw session entries.

This is **not** a snapshot of the final context sent in an ordinary model request. Pi 1.0.4 exposes
no such snapshot to extensions. Remote V2 does not invoke ordinary `context`,
`context_with_system`, or `before_provider_request` handlers. Pi 1.0.4's native summary also bypasses
ordinary context filters. Request-local privacy filters, hidden custom content, and historical
persisted workflow arming can therefore differ from ordinary model context. No generic text stripping can establish equivalent privacy. New request-local guidance
that is not persisted does not become canonical history, but existing persisted content remains.

Default `allowCanonicalHistory: false` requires a clear, one-operation TUI confirmation. No UI,
RPC, denial, cancellation, uncertain dialog result, or retired ownership returns cancellation:
**no credentials, remote request, checkpoint, or native summary fallback**. Native fallback alone
is not privacy-safe: Pi's native summary also consumes canonical history without these filters.
After explicit authorization, remote failure may use that native summary. Consent is never reused
for a changed session/branch. Disabling this extension's hook leaves native compaction outside this
gate; this gate is not a universal privacy policy for unsupported models or other extensions.

The session stores the opaque compaction item and bounded recent user-role Responses items,
including canonical content you authorized even if ordinary filters hid it. Replay can restore that
content after filters have run, including after reload. The authorization setting gates **new
compactions**, not replay of an existing checkpoint (including one created by an earlier version).
Opaque items cannot be inspected or selectively redacted. Authorization is not persisted in
checkpoint details. OAuth tokens, headers, environment secrets, and destination URLs are not
stored there. This extension's compaction-failure notifications use fixed messages without provider
error details, including when native fallback fails. Pi core and other extensions own their own
notifications and renderers; this package cannot sanitize those upstream messages.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream | 8 MiB |
| Serialized opaque compaction item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded. The
oldest fitting text item may be partially truncated to preserve newer context. These hard byte
ceilings are intentionally not configurable.

## Experimental limitations

- The wire contract is undocumented and can change independently of Pi or this package.
- Full older history depends on this extension and the same compatible model. Removing the extension
  exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model
  compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- A live prompt or tool change that has not been written into Pi's transcript causes a native
  compaction fallback; an opaque checkpoint must match the system state Pi will persist.
- Pi exposes no public effective-loadout snapshot. Observed, unchanged description-only rewrites
  (including codemode `mode: "on"`) can use Remote V2, but unproven transformations, hidden declarations
  (including codemode `mode: "only"`), membership/schema mismatches, or different serialized wire tools
  use native compaction. Observation does not weaken prompt/tool equality or stale-state checks.
- Pi invokes `session_before_compact` handlers in registration order. Another extension that mutates
  prompt, tools, or context **after this handler returns** can invalidate an already prepared opaque
  checkpoint before Pi appends it. Load such handlers before this extension or disable Remote V2 in
  that combination; the extension cannot inspect later handlers' changes.
- Only **authorized** remote failure falls back to Pi's plaintext summary, so a session can contain
  both remote opaque and native entries over time. Both paths use canonical history, not a guaranteed
  filter-safe current-model projection.
- Request-local payload hooks such as priority service-tier selection are not dispatched for Remote
  V2. Ordinary and replay requests still compose those hooks in registration order. Remote V2 uses
  provider defaults, not necessarily an ordinary request's selected tier.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the
  final conflict check.

## Package layout

```text
src/index.ts          Thin Pi entrypoint
src/codex-compact.ts  Pi lifecycle, command, provider projection, and fallback
src/authorization.ts Cancellable, operation-owned canonical-history consent
src/tool-state.ts     Prepared/observed public tool surfaces and frozen wire evidence
src/remote.ts         Provider stream invocation, auth payload, timeout, and retry controls
src/protocol.ts       Bounded SSE parsing and Remote V2 payload/output validation
src/checkpoint.ts     Replacement history, fingerprints, persistence, and replay projection
src/settings.ts       Global settings validation and atomic persistence
src/settings-menu.ts  Manual compaction and settings TUI

test/                 Protocol, checkpoint, lifecycle, remote, settings, and menu coverage
```

## Development

From the repository root:

```bash
npm --workspace @signalridge/pi-codex-compact run check
npm test
just pack codex-compact
```

The checkpoint and remote protocol boundaries are documented in `src/checkpoint.ts` and `src/remote.ts`.

## License

[MIT](LICENSE)
