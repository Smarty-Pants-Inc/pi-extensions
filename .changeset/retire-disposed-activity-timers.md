---
"@signalridge/pi-github-pr": patch
"@signalridge/pi-tab-status": patch
"@signalridge/pi-session-recap": patch
---

Retire GitHub watchers and refresh timers safely when SDK contexts are disposed, avoid headless title inactivity timers, and stop title settlement polling on invalidated contexts. Cancel pending resume and fork recaps when the user types before their deadline.
