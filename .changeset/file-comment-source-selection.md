---
"@signalridge/pi-files-widget": patch
---

Prevent diff and wrapped display rows from selecting unrelated source for comments. Diff mode now disables selection/comments with a hint; full-file selection uses an unwrapped source snapshot with matching displayed line numbers, comment ranges, and snippets.
