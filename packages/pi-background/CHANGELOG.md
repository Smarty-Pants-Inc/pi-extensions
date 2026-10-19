# Changelog

## 1.4.0
### Minor Changes

- 1170952: Add explicit, live `/background` task and `/background view <id>` log screens with stable selection, bounded terminal-safe rendering, scrolling/follow-tail, stream filtering, and captured-ID stop/clear confirmations. Release view subscriptions on close or session retirement and retain tools/snapshots without custom UI in RPC/headless modes. Encourage proactive background execution for long builds/tests with independent work, while preserving regular bash for immediate dependencies and event-driven completion without polling.

## 1.3.0
### Minor Changes

- c2fd867: Add an opt-in experimental package for session-owned background shell jobs and low-noise literal log monitors, with bounded process/log ownership, graceful termination, coalesced idle notifications and explicit recovery.
  
  Report shell results before inherited pipes close, drain through descendant cleanup without charging grace to command deadlines, and fence tool/delivery/ACK updates by the live session manager and branch prefix. Navigation preflight (including fork) retains jobs and pending notices on cancellation for explicit retry. Preserve exact literal whitespace and sanitize DCS/C1/fragmented terminal-control excerpts without altering retained decoded logs.

## 1.2.0

- Initial experimental background shell and literal log-monitor implementation.
- Session-owned process groups, bounded logs/history, controlled exit/match notifications, explicit stop and recovery tools.
