---
"@signalridge/pi-subagents": patch
"@signalridge/pi-workflows": patch
"@signalridge/pi-ralph-wiggum": patch
---

Declare `@sinclair/typebox` as a host-provided peer dependency with a `*` range instead of a runtime dependency, avoiding duplicate runtime modules and Pi extension-loader warnings.
