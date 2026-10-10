---
"@signalridge/pi-goal": patch
---

Remove timed retries after a Goal wait deadline is blocked. Keep the one persisted-deadline wake, then re-evaluate only on settlement, accepted input, tool-loadout changes, or compaction completion. Use Pi's public loadout callback to recover when Goal tools become available while idle, and retain the single cancellable manual-compaction event-tail task without a retry loop.
