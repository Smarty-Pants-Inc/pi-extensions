# Open decisions

This document records settled ownership decisions, individually scoped package
proposals, and a completed reference review. Open proposals are written up
rather than adopted as a batch: each adds a policy or maintenance surface and
needs its own concrete use and acceptance evidence.

Each open section states the current state, the options, and a recommendation.
None is blocking; the code is coherent as it stands under every option below.

---

## 1. Per-call worktree isolation — **settled in protocol v3**

Kept as a record of what was decided and what the decision costs to maintain;
there is nothing left to choose here.

**What shipped.** Worktree isolation is owned by
`pi-subagents/src/worktree.ts`, which handles creation, cleanup, and cleanup
forensics. It is triggered either by an agent's own frontmatter
(`isolation: worktree`) or by the per-call managed-spawn `isolation` request —
the latter added in protocol **v3**, alongside the `managedPolicy` capability
that gates policy-bearing requests. Protocol v4 changed model routing, not
isolation; the field and its capability are unchanged.

That seam follows the upstream per-call behavior while keeping creation,
cleanup, and failure handling in the existing worktree implementation, and it
keeps the ownership boundary explicit: one agentType can still answer
differently per call.

**Constraints the implementation must keep honoring.** Each is easy to
regress and none is enforced by a type:

- worktree names must be `${runId}-${callIndex}-${label}` — **deterministic, no
  wall clock**. A name containing a timestamp changes between a run and its
  resume, so the resume's cache keys no longer address the same worktrees.
- every failure path must be a **logged no-op**. An isolation failure that
  throws turns a recoverable "this agent ran in the shared tree" into a failed
  workflow.
- it must route into the existing `worktree.ts`. A fourth worktree
  implementation in this repository would be one too many.

Revisit only if per-call isolation turns out never to be used.

---

## 2. The dynamic-import rule — **settled**

`AGENTS.md` permits exactly the narrow exception recommended by the reference
review: defer a TUI-only dependency so headless paths do not load it. Menu code
may therefore load `@narumitw/pi-tui-kit` after confirming it will draw a TUI.
This is not permission for arbitrary dynamic source imports, private host
patches, or importing another extension's implementation. The general rule to
avoid dynamic imports and `any` remains in force.

The rule and implementation no longer disagree. Keep TUI capability checks
before deferred loading and continue testing print/RPC paths without that
rendering dependency.

---

## 3. Seven proposed new packages

**Current state.** Not started, deliberately. The proposals are `pi-review`,
`pi-session-query`, `pi-gate`, `pi-import-cc-codex`, `pi-raw-paste`,
`pi-caffeinate`, and `pi-tool`.

**Why this is a decision and not a task.** Each new package is a permanent
maintenance surface: a version line, a changeset discipline, a peer-range entry
in the shared-dependency check, a README that ships in a tarball, and a place in
the release ordering. Thirty packages is already a lot to keep honest;
seven more adds another independently maintained set before any of them has a
concrete user.

**One hard constraint, whatever is decided.** `/import` is a native Pi command.
`pi-import-cc-codex` **must not register it** — registering over a host command
is not a name clash this repository can win, and the existing name-clash guard
in `pi-workflows` (`pi.getCommands?.()` before registering) is the pattern any
new package should follow.

**Also worth noting:** `pi-gate` overlaps with what now ships as the `gate:`
frontmatter field in `pi-subagents`, where a host-run command's verdict is
attached to an agent's result. If a separate package is still wanted, its scope
should be stated against that, not alongside it.

**Recommendation: decide them individually, not as a batch,** and only when
there is a specific use for one. Nothing else in the roadmap depends on any of
them.

---

## 4. Workflow orchestration reference review

External coding-agent implementations suggest two complementary patterns:

- A script/engine seam with worker isolation, explicit fatal-vs-child-failure
  classification, paired lifecycle events, and bounded cancellation. A simple
  `parallel()`/`pipeline()` API is useful, but does not by itself provide named
  dependencies, durable nested runs, or provider-aware recovery.
- A subagent batch with ordered per-item outcomes, background controls, and
  adaptive admission after provider rate limits. This is useful for homogeneous
  batches, but it is not a general dependency graph and needs provider-specific
  rate-limit signals.

The package adopts the safe subset: named dependency graphs with deterministic
layer barriers, status-aware results, bounded task retries/failure policies,
whole-batch fatal barriers, and a replayable nested-workflow boundary. Script VM
execution and user callbacks now run in an owned, terminable Node helper; native
bindings, managed dispatch, budgets and journal authority remain in the parent.
This fences asynchronous CPU stalls without claiming an OS security sandbox or
isolating arbitrary external resources. Provider-specific adaptive scheduling
remains a separate follow-up seam: changing admission without explicit ownership
and lifecycle evidence would make recovery less honest, not more capable.
