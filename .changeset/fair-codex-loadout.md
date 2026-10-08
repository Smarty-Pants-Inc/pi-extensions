---
"@signalridge/pi-codex-compact": patch
---

Recognize already-dispatched model-facing tool descriptions transformed by codemode or other loadout hooks instead of comparing them with raw registry descriptions. Preserve native fallback for unobserved transformations and genuine prompt, registry, schema, or branch changes, including changes during remote requests. Scope dispatch evidence to the active session and clear it on reload or tree navigation.
