---
"@signalridge/pi-subagents": patch
---

Close configuration-admission gaps: apply model scope only from admitted settings at the captured configuration root, retain ancestor denials, and reject resource aliases that traverse denied project paths before escaping outside. Refresh provider-facing Agent descriptions and configuration-derived parameter descriptions through Pi's public tool-registration API when preparing prompts and continuations, preserving inactive tools. Disable gate-result caching while untracked files exist and prevent external diff commands during fingerprint inspection.
