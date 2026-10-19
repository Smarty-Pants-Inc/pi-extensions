---
"@signalridge/pi-background": minor
---

Import the opt-in experimental background package from upstream with session-owned jobs, bounded logs, and event-driven monitors for observing and controlling existing jobs. It registers no model tool that starts a command: `bash_background` is not registered and `monitor` has no command mode. The former `piBackground.allowShellTools` setting is retired, ignored, and warns by name when present.
