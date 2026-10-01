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

## Verification

`bun install --frozen-lockfile` and the workflow's complete `bun run check` passed with Pi 1.0.0, Node 24.19.0, and Bun 1.4.0. The frozen install left `bun.lock` unchanged. CI pins Bun 1.3.14; this local verification used the available newer Bun satisfying the repository's engine constraint, not the exact CI binary.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Package tests (29 packages) | 3,592 | 0 | 33 |
| Release tooling | 37 | 0 | 0 |
| Package configuration | 49 | 0 | 0 |
| **Total** | **3,678** | **0** | **33** |

The 33 skipped subagent cases span four opt-in live-provider test files. All 29 package lint and typecheck commands passed, and the test inventory covers 260 files. The full gate also passed JSON/package/boundary/shared-dependency checks, npm version comparisons, capability generation, packaged-loader smoke, all 29 tarball validations, and secret scanning. The loader smoke activated 27 extensions independently, the subagent/workflow pair, and all 24 stable extensions together.

Without a default-branch ref the full command reports changeset comparison as skipped. A separate `CHANGESET_BASE=fork-main bun run check:changesets` passed with enforcement enabled. A mechanical probe confirmed all 54 Pi peer entries across 28 packages, all 46 development pins, all eight installed Pi 1.0 lock packages, the 28 pending minor changeset entries, and the retained CI check name and install/check commands.

The first complete run after installation was green; no additional Pi 1.0 production fixes were necessary. The earlier missing-dependency failures are resolved by the checkout-local install. Live providers, external MCP/LSP servers, physical terminal behavior, and the new ChatGPT authentication route remain outside this verification. Experimental Codex compaction retains its legacy-provider boundary described above.
