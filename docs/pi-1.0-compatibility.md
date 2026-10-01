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

## Verification and remaining gate

No dependency installation was performed. Existing read-only Pi 1.0 dependencies and test tools were used for bounded checks. Comparable subsets at the fork baseline and refreshed checkout passed:

| Suite | Before | After |
| --- | ---: | ---: |
| Release tooling | 34 | 37 |
| Package configuration | 49 | 49 |
| BTW fullscreen | 9 | 14 |
| Shared UI borders | 13 | 13 |
| **Subset total** | **105** | **113** |

The fullscreen suite had 12 passing cases immediately after the upstream merge, before the two new cases. Native TypeScript 7.0.2 typechecking of the fullscreen source and regression tests passed against Pi 1.0 declarations. Package boundaries, shared dependency ranges, the 260-file test inventory, npm version comparisons, changeset coverage against the fork baseline, capability generation, all 29 package tarball checks, and secret scanning passed. All 54 Pi peer entries, 46 development pins, eight npm-integrity lock records, workspace lock entries, and retained fork CI commits were mechanically checked; Bun parsed and hashed the lock successfully.

**The full CI gate is still unverified.** The checkout has no installed dependency tree: `bun run check` stops on missing `semver`, while standalone lint, full typecheck, package tests, and packaged-loader smoke stop on missing tooling or Pi modules. Bounded fallback checks are not a substitute for `bun install --frozen-lockfile` followed by the workflow's `bun run check` in an authorized disposable environment. Live providers, external MCP/LSP servers, physical terminal behavior, the full child-session suite, and the new ChatGPT authentication route were not exercised.
