# Whole-extension hardening and community adoption

This review extends the [background ecosystem review](background-ecosystem-review.md)
to every package, not only the initially changed execution extensions. Source
review, external research, reproduction, implementation, and deployment are
separate evidence stages. A passing baseline does not prove every lifecycle,
Unicode, or publication edge case was covered.

## Requirement map

| Requirement | Implementation boundary |
| --- | --- |
| Background execution without model polling | `pi-background` owns bounded local jobs, streams, literal watches, notifications and exact delivery acknowledgments; builtin `bash` stays unchanged. |
| Clean original user input | Workflow guidance is request-local model context. Original text, images and literal reminder quotations are not rewritten; queued input does not depend on another preparation hook. |
| No obsolete branch work | Context owners validate live branch ancestry before reads, requests, editor writes, publication or wake admission, not only delayed navigation callbacks. |
| Bounded process ownership | Process owners distinguish shell exit from pipe closure, signal acceptance from confirmed termination, and captured output from unlimited stream drainage. |
| Privacy beyond ordinary requests | Remote compaction requires explicit authorization for canonical persisted history; request-local filtering is not automatically a compaction boundary. |
| Useful community improvements | Adopt small, independently testable display, Unicode, Git, cleanup and ownership patterns in existing owners; do not bundle competing runtimes. |
| Main-agent clarification | Explicit opt-in for ordinary questions from nonblocking background children; one-use owned answers must not approve tool permissions, credentials, destructive actions or override human refusal. |
| Full review before PR | Inspect changed and unchanged runtime modules, verify concrete counterexamples, rerun repository acceptance after implementation, then review the resulting diff. |

## Review coverage

Twenty independently scoped evidence units covered fourteen local areas and six
external categories. The original aggregation script failed after those twenty
results were recorded; the results were recovered without treating that failure
as a successful coverage gate. Failed-run resume also exposed a real workflow
state-transition defect. Implementation and final acceptance must be assessed
from current files and executed checks, not the initial review summaries.

Local areas: process supervision; process delivery; workflow prompt handling;
workflow scheduling/journaling; child resource selection; Fleet/inspectors;
Recall/side questions/recaps; LSP/snippets; Goal/Ralph/Plan; editors/dialogs;
usage/analytics; provider/compaction/guidance; passive UI/Git/worktrees; and
publication/documentation. These include both pure libraries and all 28 extension
packages. Reviewers distinguish inspected code from executed fixtures.

## Selected patterns

| Reference | Accepted narrow boundary | Excluded scope |
| --- | --- | --- |
| [tintinweb Fleet/inspectors](https://github.com/tintinweb/pi-subagents/tree/fd8d81618d80ae83a3faf40cb87dae99cca33264/src/ui) and [duplicate-label projection](https://github.com/nicobailon/pi-subagents/blob/69673c7fbf3351e54a5b0786a7e9d9fff625a749/src/tui/render-helpers.ts) | Container-first groups of validated workflow-owned retained children; stable selection, bounded inspection and display-only label disambiguation. | No combined engine, raw parent inheritance, inferred phases, or claims that retained children describe authoritative whole-run status. |
| [fzf grapheme/preview rendering](https://github.com/junegunn/fzf/blob/c0a193e031f01fb50bf6f7be4381990a3753f7cf/src/terminal.go) and [multipart extraction](https://github.com/mrshu/pi-readline-search/blob/954ac31acb575089f2083244c38c02564f798362/extensions/readline-search.ts) | Original history payloads remain distinct from search keys and previews; highlights cover complete graphemes; scroll indicators do not replace content. | No private editor state, prototype patches, duplicate history database, or implicit image restoration. |
| [Git v2.49 porcelain and background refresh](https://github.com/git/git/blob/v2.49.0/Documentation/git-status.adoc) | NUL-delimited exact filenames, separate rename origins, optional-lock suppression and branch-aware inventory refresh. | No Git configuration changes or unowned repository mutation. |
| [CPython private exclusive temporary files](https://github.com/python/cpython/blob/v3.13.0/Lib/tempfile.py) | Usage exports use private exclusive creation and safe collision handling. | No Python dependency, overwrite-capable predictable exports, or new analytics ledger. |
| [Execa bounded termination](https://github.com/sindresorhus/execa/blob/v9.6.0/docs/termination.md) and [aliou bounded process output](https://github.com/aliou/pi-processes/blob/434fa0a860b1fa4fe9fccdc986964d865ef98e47/src/manager/process-output.ts) | Local owner-specific escalation, actual close confirmation, bounded output and explicit loss. | No dependency transplant, process adoption, PTY/SSH, or periodic model wake. |
| [Service-tier provider/API eligibility](https://github.com/mavam/pi-service-tier/blob/318ce1ef00693d34956f5fb39a8d1a71684b90a8/domain.ts) | Require supported provider/API tuples as well as the existing exact model allowlist. | No broader guessed provider support or extension-owned price multipliers. |
| [VS Code idempotent disposal](https://github.com/microsoft/vscode/blob/1.100.0/src/vs/base/common/lifecycle.ts) | A retired owner releases all its timers/subscriptions even if one cleanup fails. | No VS Code dependencies or cross-owner cleanup authority. |

These are independently implemented patterns, not wholesale code imports.
Existing fork license notices remain. A source whose license text could not be
verified is not a basis for copying substantial implementation or tests.

## Deliberately not bundled

Browser sessions, debugger adapters, OS sleep inhibition, monetary hard caps,
cross-session model-facing search and transcript import each add separate
permission, privacy, platform or ownership decisions. Candidate peer ranges,
stars and download counts are not compatibility evidence. Native tool selection
is not a permission boundary; cooperative spending warnings are not pre-request
billing enforcement. No additional provider credentials, authenticated browser
profiles, remote host access, global settings or network tracing exporter are
installed by this change.

## Reminder deployment and preserved history

Editing repository source does not replace an already running npm installation.
A release must be installed/updated and Pi reloaded before new input uses the
fixed implementation. For local testing, disable the installed copy's extension
resource before loading the local package; loading both can leave the old input
transform active. Do not overwrite unrelated package declarations or settings.
Previously persisted tagged user messages remain original; there is no generic
reminder stripping or private history/renderer patch.

## Acceptance boundaries

The development SDK remains Pi 1.0.4. Executed local fixtures are macOS/offline;
three background SDK cases have separate Pi 1.1.0 evidence. Actual Linux CI,
physical terminal, live provider, browser, debugger adapter, remote host,
Windows and standalone binary qualification must be reported separately.
Public custom-UI completion cannot distinguish every concurrent snapshot-equal
editor writer; the opt-in editor adapter documents that limit rather than
claiming an absolute lock over other extensions.

Final local acceptance passed `bun install --frozen-lockfile` and `bun run check`
on macOS, Node 24.21.0 and Bun 1.4.2 with the Pi 1.0.4 development SDK: all 30
package checks, six editor integration tests, 37 release tests, 160 configuration
tests, 28 individual extension loader cases, the stable pair, all 24 stable
extensions together, 30 package tarballs and the credential scan. This includes
467 workflow, 1,747 subagent (four unchanged skips), 275 Plan, 84 Ralph,
84 background, 153 compaction, 235 BTW, 94 Recall and 133 usage tests.

A separate fileless replay independently confirmed the root-awaited local-Promise
callback counterexample returns normally and closes its owned helper. Scoped
review covered the final Plan, passive UI/process leases, context/storage,
accounting, publication and clarification corrections. Static review is not
counted as independent test execution: the last image-normalization claim had
static support but an inconclusive read-only execution verdict; the parent-run
full suite executed its actual default-AUTO SDK image regressions.

A failed whole-repository run exposed a GitHub PR test mixing fake timers and OS
watcher delivery. Its behavior assertions now use an owned installation/event
barrier while independent real `fs.watch` smoke coverage remains; focused tests
passed 20 consecutive runs and four full package runs before the final repository
run. No production behavior was changed to hide that test failure.

Public hooks do not guarantee atomic cancellation before native persistence or
eliminate native concurrent-prompt rejection. Ambiguous control-token quotations
fail closed for the clarification channel without editing genuine text/images,
creating approval grants or aborting an unproved user run. Neither publication,
a live installation update nor Linux qualification follows from local acceptance.
