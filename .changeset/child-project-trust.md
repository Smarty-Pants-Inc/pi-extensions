---
"@signalridge/pi-subagents": patch
---

Inherit the parent's public Pi project-trust decision before child resource resolution instead of accepting the SDK's trusted default. Unknown trust and different configuration roots deny project settings, extension factories, skills (including named preloading), and MCP configuration without prompting or granting trust. Explicit project resource paths cannot bypass denial. Preserve global resources, child policy restrictions, and trusted parent configuration during worktree execution and nested delegation; bind built-in MCP configuration discovery to that same trusted configuration root.
