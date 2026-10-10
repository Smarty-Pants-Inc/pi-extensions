---
"@signalridge/pi-worktree": patch
"@signalridge/pi-subagents": patch
---

Fix cancelled worktree creation by preserving completed Git Add results and reconciling the registered path and local branch with bounded reads independent of the cancelled UI owner. Report retained or uncertain outcomes even after the owner retires, including branch-only partial mutations, without deleting data or offering a stale workspace switch.

Disable acceptance-gate verdict reuse when ignored files or directories are present, because shell gates have no declared input set and Git diffs cannot account for ignored content. Changes to ignored inputs now force the gate to run instead of returning a stale pass.
