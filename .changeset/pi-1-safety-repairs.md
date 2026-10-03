---
"@signalridge/pi-btw": patch
"@signalridge/pi-subagents": patch
"@signalridge/pi-github-pr": patch
---

Fix Pi 1.0 safety regressions: close BTW credential loaders before editor-changing navigation and retain live drafts; serialize timeout-enabled interactive child batches so sibling approval cannot consume a tool budget; clear stale PR status as soon as HEAD changes and recover watcher refreshes after an aborted request.
