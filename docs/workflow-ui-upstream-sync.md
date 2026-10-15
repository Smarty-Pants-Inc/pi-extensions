# Workflow and subagent UI synchronization

Reference snapshot: 2026-10-12. This is a selective adaptation, not a replacement
of the local runtime, an installation update, or a publication.

## Sources and disposition

The direct fork reference is
[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents/tree/e819a82ae364a2b0432881b89b0c784b413a88c1).
That HEAD declares 0.21.0 and contains additional unreleased changes. The tagged
release is [0.21.0](https://github.com/tintinweb/pi-subagents/tree/26c23bb7db7b181ff3f4233cdc4e5bc9fefb6f04).
The original MIT notice remains in `packages/pi-subagents/LICENSE`.

| Reference | Local adaptation |
| --- | --- |
| [Workflow phase inspector](https://github.com/tintinweb/pi-subagents/blob/e819a82ae364a2b0432881b89b0c784b413a88c1/src/ui/workflow-dialog.ts) | A workflow-owned live command center, phase/task/call navigation, readable results and reachable legal controls. Local DAG and journal authority remain separate from subagent execution. |
| [Fullscreen observer](https://github.com/tintinweb/pi-subagents/commit/7bec8b9a12e3d9f206f92018714ba680c2b4037c) | Public fullscreen hosts use the terminal-sized conversation view; regular hosts retain floating borders. Keyboard interaction remains mandatory even when mouse controls exist. |
| [Foreground handoff](https://github.com/tintinweb/pi-subagents/commit/83fdf77f918e37c0b0116cade493569d7e745ae1) | A user can detach an eligible fresh foreground child without restarting its session, provider request, transcript or worktree. Unlike upstream, a full background pool refuses transfer instead of oversubscribing it. |
| [Bounded render work](https://github.com/tintinweb/pi-subagents/commit/3d91023268a5897b5b92f08aeabd4630666deb47) | Width/content-aware layout and failure caches, bounded untrusted text and independently reachable controls. Bounds must be disclosed rather than presented as unlimited history. |
| [Native transcript changes](https://github.com/tintinweb/pi-subagents/commit/25eb4fab35b6ca9284e2b6985ed645dd7609ac2a) | Skip the first actual user message already written by the fresh-spawn path, omit native system records, and append resumed history from an explicit boundary. No parent-history cloning is adopted. |
| [Dynamic-workflows 3.14.0 UI](https://unpkg.com/@quintinshaw/pi-dynamic-workflows@3.14.0/src/workflow-ui.ts) | Reference for stable selection, pinned controls and phase-to-call navigation. No runtime source, direct model routing or new checkpoint/replay protocol is imported. |

For `@quintinshaw/pi-dynamic-workflows`, npm 3.14.0 still identifies
`3a52f19ab1f01e09535b6b3e1d8200b6f3bcb63a`, the previously reviewed reference.
The GitHub repository was unavailable during this review; no newer HEAD is
claimed. Published source is evidence of that release, not a local test result.

## Ownership and operator behavior

- **Workflows owns execution facts and controls.** Runtime observations populate
  detached, bounded inspection snapshots. Declared phases do not prove entry or
  completion, and restoration does not invent historical labels. Phase keys
  distinguish full titles even when their display copies have the same prefix.
- **Subagents owns child sessions.** Conversation controls capture a session and
  the complete owner tuple, including attempt. Reused IDs do not silently
  redirect old viewers. Native steering rejection leaves a recoverable draft.
- **The bridge is optional.** Shared, validated UI version-1 query/change/open
  channels carry compact authoritative metadata and explicit user admissions.
  A missing peer falls back to the retained-child list. Required managed
  protocol v4 capabilities and ping envelopes remain unchanged.
- **Counts have different meanings.** Logical calls, replay and physical
  dispatch are not interchangeable. Fleet retains lifetime usage; managed
  attempts additionally report scoped usage, preventing sequential threads from
  charging earlier turns again. Unknown usage is not fabricated from a missing
  historical callback.
- **Stop is not merely a button state.** Accepted work, exact-owned cleanup and
  journal settlement must finish before terminal publication/removal. Negative
  cleanup confirmation remains busy and retryable through explicit control;
  observer callbacks and delayed replies cannot donate authority to a new
  branch or attempt.
- **Presentation is not persistence.** Display sanitization never changes source,
  prompts, result values, identifiers or journal facts. Navigation and rendering
  remain separate from permission decisions and agent/model policy.

The passive panel has a total terminal-height budget, prioritizes live calls and
reports overflow. `/workflows watch <runId>` opens the live inspector in TUI;
print/RPC receive a snapshot rather than an uncancellable watch. Outside TUI,
custom components, mouse handlers and editor input interception remain disabled.

## Intentionally not synchronized

- Raw parent conversation inheritance or mention clones: the public host cannot
  supply the required post-hook context and physical-endpoint pinning guarantee.
- The upstream integrated workflow engine or a second model/tier/queue settings
  surface: local managed ownership, strength routing and journals remain
  authoritative.
- Unreleased package-agent/package-workflow discovery at `e819a82`: new resource
  provenance and trust admission need their own acceptance scope rather than a
  UI synchronization silently executing additional project resources.
- Upstream steered completion-outbox semantics and automatic Esc-triggered
  continuations: local branch-bound follow-up delivery and human permission
  boundaries are retained.
- Per-call skip/retry controls, durable external-response checkpoints,
  completed-sibling replay and throughput estimates: these change recovery or
  accounting contracts and are not imported as cosmetic UI features.

## Verification boundaries

The development host remains Pi 1.0.4; public renderer capability checks do not
constitute blanket qualification of older or newer hosts. Acceptance uses
component tests and offline real-SDK/faux-provider fixtures for selection,
viewport, lifecycle, persistence, ownership and recovery. Actual Pi 1.0.4 CLI
runs through PTYs additionally exercise fullscreen and regular navigation,
phase/task/call drill-down, pause/resume, distinct-key stop confirmation, native
steering rejection and acceptance, foreground handoff, CJK resizing and main
editor draft restoration. Both modes were rerun after correcting inspector
clipping and superseded-attempt error display; their recorded screen assertions
passed. This is not live OAuth/provider/MCP, browser, or physical-terminal
acceptance.

Independent pre-PR review also produced controlled reproductions for queued-child
cleanup ownership, retained terminal cleanup, reentrant execution admission and
nested generation recovery. Regressions exercise exact-owner cleanup across
observer callbacks, start/resume state identity and multi-resume journal restore.
Accepted nested generation watermarks are seeded independently of replay-cache
eligibility. Transcript and viewer regressions cover extension-handled turns and
selectable long-message paging. Further controlled regressions cover same-cycle
restore and cleanup handshakes, lost spawn replies, never-submitted reservations,
handled input versus legacy queue provenance, reentrant SDK subscribers,
selected cursors across history windows and unread text after width changes.

Completed final gate after the review corrections:

```sh
bun run check  # passed
```

Final package evidence includes 1,960 passing subagent tests (four existing
opt-in live-provider skips), 804 workflow tests and 29 protocol tests. Production
source hashes remained unchanged throughout the complete gate. Both actual Pi
1.0.4 CLI PTY modes were rerun on that source, with all recorded screen assertions
passing. Packed smoke activated all 28 independent extension tarballs, the stable
pair and all 24 stable extensions together. Integration, release/configuration,
tarball validation, secret scanning and the subagent build also passed.

The installed-SDK trust fixture failure was reproduced as a readiness race: a
prompt can complete after its bounded startup wait while the native MCP runtime
continues loading. Positive controls now await the actual public transport
callback; teardown also drains startup and rejects unexpected late launches.
Production trust admission is unchanged. A checkpoint-test scheduling race was
separately changed to gate fatal execution on the actual public dialog mounting
rather than assuming transport order.

The complete gate covers independently published manifests, shared ranges and
boundaries, capability documentation, changesets, lint/typechecks/tests, private
integration, warning-sensitive packed loading, tarball validation and secret
scanning. Package checks and PTY smoke are not substitutes for that complete
gate. No physical-terminal or live-provider acceptance is inferred.

Versions and dependency floors are generated by Changesets; the existing
`updateInternalDependencies: patch` policy updates a consuming package's range
when the protocol library gains its minor UI exports. No manual version bump,
installation update or publication is included.
