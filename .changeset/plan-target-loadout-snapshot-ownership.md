---
"@signalridge/pi-plan-mode": patch
---

Preserve canonical transcript-restored target tools, including empty loadouts, during tree navigation before applying branch-local planning restrictions. Retain in-memory parent snapshots once fresh-session setup begins so failures after destination commit remain resumable, while pre-commit failures still clean up.
