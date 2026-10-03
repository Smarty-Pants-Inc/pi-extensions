# Pi 1.0.0 compatibility

## Dependency boundary

The Pi-dependent packages retain their existing 0.84–0.87 and 0.99 peer ranges and add `^1.0.0`. Development pins for `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` are 1.0.0. The lock also resolves Pi's Chord, codemode, MCP, and telemetry packages to 1.0.0. The independent subagent protocol package has no Pi dependency or protocol change.

This refresh includes the Pi 0.99.1 upstream extension changes described in [the previous compatibility review](pi-0.99-compatibility.md). CI retains its fork-specific check name and publishing restrictions.

## Fullscreen default

Pi 1.0 uses fullscreen terminal mode by default. BTW's dedicated side-thread renderer already stops the parent before starting its own alternate-screen renderer. On the 1.0 host, `stop({ preserveScreen: true })` still exits the alternate screen without projecting its document into terminal scrollback. Closing the side flow stops that renderer, restarts the parent, and repaints the parent synchronously.

Two added regressions use an actual `TuiAltScreen` parent and verify the ordered alternate-screen transitions, restored main transcript, retained editor draft, and re-enabled mouse tracking after both success and failure. No fullscreen implementation change was needed. The shared UI border adapter's existing tests cover native mouse coordinates, clipped containers, and editor autocomplete retaining overlay keyboard focus; those also pass against Pi 1.0.

The `/btw` command remains restricted to `ctx.mode === "tui"`. Other extension custom surfaces use Pi's injected TUI and `ctx.ui.custom()` rather than creating independent terminal owners.

## Other 1.0 defaults

- Subagents already capability-check Pi's public codemode, tool-search, and MCP factories. Child extension selection passes its `noExtensions` policy to the resource loader. This refresh does not introduce a separate built-in-extension configuration schema.
- Pi's new ChatGPT sign-in route belongs to the `openai` provider. The experimental remote Codex compaction package remains deliberately bound to legacy `openai-codex` checkpoints; widening its host peer range does **not** add support for the new sign-in route or migrate existing checkpoint payloads.
- Packages already use TypeScript 7 development pins where they invoke the compiler. There are no package-manifest `tsx` dependencies to migrate. The release/configuration tooling uses Node `.mjs` entrypoints.

## Review repairs

The round-one safety review identified production fixes beyond dependency admission:

- BTW credential-resolution custom UI now closes before editor-changing navigation, retains the live editor draft on ordinary completion or cancellation, and fences late credential callbacks.
- Timeout-enabled interactive subagent children use sequential preflight/execution for sibling tool calls, on fresh and resumed turns. Human approval for a sibling cannot consume an earlier tool's timeout. Other children retain the host's execution strategy.
- The PR status extension clears old status and expiry as soon as a refresh observes a different Git HEAD. An aborted, unrendered request is not coverage that can suppress the installed watcher's recovery.

Each fix has a package-local regression observed failing before the fix and passing afterward. The four deterministic Pi SDK safety suites now admit Pi 1.x rather than silently excluding the pinned target.

## Verification

The repair run used Pi 1.0.0, Node 24.19.0 and Bun 1.4.0. `bun install --frozen-lockfile` left `bun.lock` unchanged. CI pins Bun 1.3.14; the local binary satisfies the engine constraint but is not that exact CI version.

`CHANGESET_BASE=fork-main nice -n 10 bun run check` passed with changeset enforcement enabled. The root gate includes npm version comparisons; the fork's pull-request workflow deliberately excludes that upstream publishing check while registering every other root check once under `smarty-ci`.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Package tests (29 packages) | 3,635 | 0 | 4 |
| Release tooling | 37 | 0 | 0 |
| Package configuration | 49 | 0 | 0 |
| **Total** | **3,721** | **0** | **4** |

The earlier 33-skip claim was incorrect: 29 deterministic safety cases were excluded by 0.99-only guards. All now run on Pi 1.0. The only remaining skips are these four explicitly opt-in live-model cases in `packages/pi-subagents/test/subagents-print-mode-e2e.test.ts` (`PI_E2E_LIVE` is unset):

1. `FOREGROUND spawn — real model spawns a subagent and reports its output`
2. `BACKGROUND spawn + get_subagent_result — model backgrounds work then retrieves it`
3. `Explore subagent_type — model dispatches a non-default agent type`
4. `SELF-SMOKE — the agent drives a multi-feature smoke of its own Agent toolset`

All 29 package lint/typecheck commands passed, and the inventory covers 261 test files. JSON/package/boundary/shared-dependency checks, npm versions, changesets, capabilities, release/configuration tests, packaged-loader smoke, all 29 tarball validations and secret scanning passed. Loader smoke activated 27 extensions independently, the subagent/workflow pair, and all 24 stable extensions together.

Real repo-local Pi CLI recordings now cover fullscreen and regular modes in an isolated HOME and PTY, with BTW, input history, subagents, Codex compaction and PR status loaded. They show BTW menu cancellation, the real side-thread missing-key failure and return to the parent transcript; history popup acceptance/cancellation and editor restoration; subagent management and failed-run surfaces; and the Codex settings menu. A recording-only interposer delays real empty-auth resolution and triggers competing-extension committed tree navigation/session replacement: pending loaders close and destination drafts survive late completion. These are real CLI/rendering paths, not SDK-session substitutes; the interposer is explicitly test-only and does not inject model credentials.

## Remaining evidence and compatibility boundary

No model-backed successful turn, live approval interaction, real GitHub response, external MCP/LSP server, or new ChatGPT sign-in flow was exercised. Successful BTW bring-to-main/resume, running-child chat/stop/resume and model-backed compaction still require the authorized release operator's Pi 1.0 evidence gate. Credential-boundary recordings do not substitute for that gate or authorize merging a held release.

Experimental Codex compaction remains bound to legacy `openai-codex`. Its registration-based comparison still safely falls back to native compaction for prepared tool descriptions, including unchanged codemode loadouts. Fixing that reviewed limitation requires a public effective-loadout API (with pending changes observable), not removal of description/ownership validation. Prepared-loadout remote compaction is not claimed as supported by this proof.
