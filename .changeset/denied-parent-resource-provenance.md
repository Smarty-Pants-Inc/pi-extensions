---
"@signalridge/pi-subagents": patch
---

Preserve denied parent resource provenance when a child changes its configuration root. Reject explicit parent extensions and filter configured/discovered extensions and skills using both denied roots, including canonical aliases, before extension execution or skill injection. Named skill preloading also rejects denied sources behind global-root ancestor aliases. Genuine global resources and trusted parent configuration during worktree execution remain available; this resource trust boundary is not an OS sandbox or containment of arbitrary global extension behavior.
