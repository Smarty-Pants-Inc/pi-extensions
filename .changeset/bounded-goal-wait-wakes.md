---
"@signalridge/pi-goal": patch
---

Keep deadline wait wakes automatic and within the existing response limit, including responses that enter a wait and waits restored from session state. Cancel persisted waits before publishing terminal managed-run receipts so ended runs cannot wake as unowned work.
