# Background execution and ecosystem review

Review snapshot: **2026-10-11**. This supplements the historical
[Pi 1.0 compatibility review](pi-1.0-compatibility.md); it does not replace that
review's baseline or imply an installation, host upgrade, or npm publication.

## Accepted design and coordinated fixes

`pi-background` is an independently implemented, experimental extension. It
keeps builtin `bash` unchanged and owns local process groups, bounded in-memory
logs, literal watches, and a session-local notification outbox. No child agent or
model polling is needed to wait for a command. PTY, SSH, external persistence,
Windows, and escaped/daemonized descendants are outside its initial contract.

Useful reference patterns were adopted selectively:

- [fl4p background shell](https://github.com/fl4p/pi-extensions/blob/master/extensions/bash-background.ts): finite exit attention and coalescing. The archived standalone package is not the maintained reference.
- [aliou/pi-processes](https://github.com/aliou/pi-processes): lifecycle/log attention and owned cleanup. Its [2026-10-02 idle-hook fix](https://github.com/aliou/pi-processes/commit/6708947e7d64a0dff8a19ca6c82f99f18531b83f) reinforces checking the actual delivery boundary, not merely receiving an exit callback.
- [99percentpeople background tasks](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks): separate inspect/control operations and explicit ownership. Its PTY/SSH implementation and deliberate no-automatic-wake behavior are not copied.
- [Pi public extension API](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/extensions.md): session fencing, context-only events, and normal extension-sourced prompts. On Pi 1.0.4 a bare custom-message turn can bypass `before_agent_start`; a separate short user-message wake preserves guidance and provider hooks.

The review found actual composition defects rather than requiring every package
to change. Published changes have independent changesets; public managed protocol
payloads remain unchanged.

| Package | Disposition / acceptance focus |
| --- | --- |
| `pi-background` | New opt-in package; supervisor handshake deadline, TERM/KILL ownership, incremental matches without stale replay, bounded batches, exact acknowledgments and explicit recovery. |
| `pi-workflows` | Defer result wakes until a safe owned boundary; retire delivery before shutdown quiescence; preserve pending-result recovery and normal prompt hooks. Keep keyword/effort guidance out of native user text, including queued follow-up and steering. |
| `pi-subagents` | Exclude `pi-background` before managed child factories load, including configured file aliases, glob/conventional declarations and canonical ancestor ownership. Preserve ordinary package tool narrowing; selectively port the FleetView custom-editor focus fix. |
| `pi-analytics` | Attribute extension-sourced wake runs correctly without making synthetic input an explicit user skill invocation. |
| `pi-recall` | Retire pending interactions on committed same-session tree events; live branch-prefix, canonical permission-repair and publication guards reject abandoned-branch callbacks even before its event handler runs. |
| `pi-lsp` | Escalate owned TERM-resistant servers; rejected termination settles with an explicit cleanup failure without releasing the child or admitting a replacement. |
| `pi-code-actions` | Own snippet process-group cleanup; bound helper readiness separately from command execution, including Bun/standalone runtime selection. |
| `pi-plan-mode` | Retain frozen read-only admission and nested-call checks; launching background commands requires its own explicit permission policy. |
| `pi-goal` | Retain Goal-owned continuation/wait state; a normal background turn is not authorization to resume a paused Goal. |
| `pi-ralph-wiggum` | Retain loop-owned completion and journal; background processes do not become loop state. |
| `pi-agent-guidance` | Normal wake prompt hooks preserve context discovery; no parallel guidance loader. |
| `pi-codex-compact` | Retain credential-safe compaction/request ownership; asynchronous notifications must wait outside compaction. |
| `pi-session-recap` | Retain explicit history consent and idle recap ownership; no second session store. |
| `pi-btw` | Retain side-question history consent and isolated request ownership. |
| `pi-gpt-fast` | Retain provider routing/settings ownership; no extension-owned pricing catalogue or forced host upgrade. |
| `pi-input-prefix` | Retain composing editor and synthetic-input boundaries. |
| `pi-input-history` | Retain composing history editor; no upstream history/privacy behavior replacement. |
| `pi-ask-user-question` | Retain UI/headless guards and question ownership. |
| `pi-files-widget` | Retain widget/dialog lifecycle fencing. |
| `pi-welcome` | Retain post-discovery inventory and native diagnostics ownership. |
| `pi-statusline` | Consume owned status keys; never mutate a background manager or analytics ledger. |
| `pi-tab-status` | Retain TUI-only terminal-title ownership. |
| `pi-usage-extension` | Retain persisted usage accounting; no second cost ledger. |
| `pi-herdr-state` | Retain validated state events; no process-control authority. |
| `pi-worktime` | Retain session-owned active-span accounting; a synthetic prompt uses normal host lifecycle events. |
| `pi-stamp` | Retain finalized transcript metadata/tool outcomes. |
| `pi-github-pr` | Retain nonblocking refresh and owned timer retirement. |
| `pi-worktree` | Retain repository identity, explicit opt-in and cleanup policy; child process work must not outlive isolated workspace removal. |
| `pi-ui` | Passive rendering library only; no new runtime coordinator. |
| `pi-subagents-protocol` | Existing managed wire contract remains authoritative; no background-process RPC or protocol bump. |

The targeted FleetView reference is upstream
[`7da6bef`, 2026-10-09](https://github.com/tintinweb/pi-subagents/commit/7da6bef828d7582ee33386ece9379c170e7742c4):
recognize the public editor text contract rather than one concrete `Editor` class.
Local fail-closed parent-history privacy and the executor/workflow split are
intentional divergences, not omitted merges. Existing upstream licenses remain.

The upstream [0.20.0 UI](https://github.com/tintinweb/pi-subagents/blob/fd8d81618d80ae83a3faf40cb87dae99cca33264/docs/workflows.md)
also has distinct workflow Fleet entries and a phase/agent inspector. That UI is
**not** ported by the editor-focus fix: this repository currently has a separate
workflow run view, while managed children still share the subagent Fleet roster.
Container-first grouping and phase drill-down are useful follow-up patterns; they
must preserve separate workflow/executor ownership rather than reintroduce the
upstream combined engine.

## Community candidates: useful does not mean safe to bundle

The candidates below were researched read-only. A dependency floor, wildcard
peer, star count, or download count is not runtime acceptance or evidence of a
security boundary. No complete third-party extension is added by this review.

| Reference | Bounded pattern worth retaining | Why wholesale adoption is deferred |
| --- | --- | --- |
| [pi-sandbox](https://github.com/carderne/pi-sandbox), [0.7.1](https://registry.npmjs.org/pi-sandbox) | Expiring approval dialogs, no-UI denial and distinct grant scopes. | Its declared Pi `^0.80.0` peer excludes 1.0.4; replacing shell/file tools is a separate policy decision. |
| [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native), [0.9.4](https://registry.npmjs.org/pi-agent-browser-native) | Fresh snapshots, ordered checks, artifact verification, and distinguishing failed from not-run checks. | Exact 1.0.4 acceptance was not established; shared browser ownership, native requirements and authenticated data need dedicated integration. |
| [pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote) | Endpoint identity and aggregate output budgets. | Local background jobs cannot inherit an unspecified remote execution contract. |
| [pi-agent-ide](https://github.com/alexshpunt/pi-agent-ide) | Individual debugger recipes and bounded debugger events. | Its umbrella read/edit/shell/LSP surface duplicates existing owners. |
| [pi-permissions](https://github.com/bu5hm4nn/pi-permissions) | Private, atomic, symlink-aware policy storage. | No exact current-host acceptance; generalized command grants are not safe defaults. |
| [pi-budget-guard](https://github.com/omkarrajmane/pi-budget-guard) | Threshold state transitions and warn-once policy. | Tool blocking is not a pre-request spend cap; assistant-only accounting omits separate usage entries. |
| [pi-session-finder](https://github.com/pungggi/pi-session-finder) | Bounded previews, keyword-centered excerpts and lazy facets. | No duplicate session index/history store; old parser/usage assumptions need review first. |
| [pi-condense](https://github.com/jjuraszek/pi-condense), [2.11.5](https://github.com/jjuraszek/pi-condense/releases/tag/v2.11.5) | Read-only context diagnostics and explicit recovery identity. | Summarizer, archive, settings and additional cost channels overlap existing compaction ownership. |
| [pi-better-prompt](https://github.com/janvitos/pi-better-prompt) | Grapheme/paste-marker selection test cases. | Avoid private renderer/mouse patches and competing global editor-history ownership. |
| [agent-halter](https://github.com/fgrehm/agent-halter) | Pure deadline/turn decisions. | Early maturity and detached stop commands do not justify replacing Goal/loop ownership. |

These repositories have MIT license texts, but copied substantial code or tests
would still require retaining their applicable full notices. Researching a design
pattern is not a license to omit attribution or import dependency trees unchecked.

## Host and verification boundaries

The workspace development baseline remains **Pi 1.0.4**.
[Pi 1.1.0, released 2026-10-07](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md)
adds tool `durationMs`, `agent_settled.aborted`, terminal state reporting, and
long-context tier-pricing fixes. Prefer host-owned timing/pricing data over another
extension inference layer. These additions do not require upgrading dependencies
merely to deliver a background event.

The new background package's three real-SDK/faux-provider cases also pass against
an independently resolved **1.1.0** host: normal exit wakes execute prompt hooks,
context-only delivery does not request a model, committed tree navigation retires
job state, and a wake suspended by an earlier input hook is consumed after its
branch retires. This is scoped compatibility evidence, not a claim that the
entire monorepo or every host version has been qualified on 1.1.0.

Repository acceptance uses `bun install --frozen-lockfile` and `bun run check`,
including package lint/typechecks/tests, editor composition, manifests, boundaries,
release/config tests, packaged-loader smoke, tarball validation and secret scanning.
Offline SDK and harmless process fixtures do not establish live-provider,
physical-terminal, browser, remote-host, Linux, Windows, or external-LSP acceptance.
Permission annotations are hints, not an operating-system sandbox.

Signal failure is not successful cleanup: LSP ownership remains until confirmed
close. Recall checks live ownership after awaited canonical reads and immediately
before dispatching permission repair or canonical file replacement; an
already-dispatched filesystem operation cannot be retracted.
Bun/standalone supervisor launch selection is covered through a runtime seam,
not a physical standalone-Pi qualification; those hosts require `node` on `PATH`.
The process fixtures executed for this review run on macOS.

## Recorded acceptance

The final frozen install made no dependency changes. The full `bun run check`
completed successfully across all 30 packages, including lint, typechecks,
package tests, six editor-composition tests, 37 release tests, 128 configuration
tests, loader smoke, tarball validation and secret scanning.

| Changed package | Executed package tests |
| --- | ---: |
| `pi-background` | 58 passed |
| `pi-workflows` | 399 passed |
| `pi-subagents` | 1,644 passed; 4 skipped |
| `pi-analytics` | 77 passed |
| `pi-recall` | 85 passed |
| `pi-lsp` | 61 passed |
| `pi-code-actions` | 81 passed |

Loader smoke activated all 28 extension tarballs independently, the stable
subagents/workflows pair, and all 24 stable extensions together. All 30 package
tarballs passed validation. The separate Pi 1.1.0 background SDK run passed its
three cases again; this remains narrowly scoped host evidence.

Independent checks refuted the initially unguarded Recall permission repair and
configured ordinary-file-alias ownership suppression. Both have dedicated
regressions in the final passing suites. The final alias checker found no static
counterexample but did not re-execute temporary-fixture tests under its read-only
binding; runtime acceptance comes from the executed repository tests, not that
reviewer's inspection. Skipped tests and unexecuted deployment boundaries above
are not counted as qualification. No package was published or installed into a
running Pi environment by this acceptance run.
