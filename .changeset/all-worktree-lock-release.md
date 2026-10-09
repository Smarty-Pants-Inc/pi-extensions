---
"@signalridge/pi-worktree": patch
---

Preserve every completed mutation's result or recovery error when releasing the mutation lock fails. Report both the remove, prune, Add, or quarantine/move outcome and the release failure, even after the UI owner is cancelled, using the shared mutation-lock recovery path.
