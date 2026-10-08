---
"@signalridge/pi-code-actions": patch
"@signalridge/pi-lsp": patch
---

Replace POSIX clipboard pipeline shells with argument-safe exec redirection so cancellation terminates the clipboard utility itself, while preserving private-file cleanup and platform fallbacks.

Omit unchanged dry-run LSP file text and independently bound result details. Spill oversized edits and diagnostics to private files instead of retaining full payloads in session history, preserving compact fix outcome metadata and bounded notices.
