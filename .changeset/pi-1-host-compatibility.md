---
"@signalridge/pi-agent-guidance": patch
"@signalridge/pi-analytics": patch
"@signalridge/pi-ask-user-question": patch
"@signalridge/pi-btw": patch
"@signalridge/pi-code-actions": patch
"@signalridge/pi-codex-compact": patch
"@signalridge/pi-files-widget": patch
"@signalridge/pi-github-pr": patch
"@signalridge/pi-goal": patch
"@signalridge/pi-gpt-fast": patch
"@signalridge/pi-herdr-state": patch
"@signalridge/pi-input-history": patch
"@signalridge/pi-input-prefix": patch
"@signalridge/pi-lsp": patch
"@signalridge/pi-plan-mode": patch
"@signalridge/pi-ralph-wiggum": patch
"@signalridge/pi-recall": patch
"@signalridge/pi-session-recap": patch
"@signalridge/pi-stamp": patch
"@signalridge/pi-statusline": patch
"@signalridge/pi-subagents": patch
"@signalridge/pi-tab-status": patch
"@signalridge/pi-ui": patch
"@signalridge/pi-usage-extension": patch
"@signalridge/pi-welcome": patch
"@signalridge/pi-workflows": patch
"@signalridge/pi-worktime": patch
"@signalridge/pi-worktree": patch
---

Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
