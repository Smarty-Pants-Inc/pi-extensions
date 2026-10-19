---
"@signalridge/pi-todo": patch
---

Verify session-file bytes on every durability inspection so same-size corruption cannot reuse stale Todo authority when file metadata is unchanged. Preserve fail-closed behavior and explicit reconciliation after storage repair.
