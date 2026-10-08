---
"@signalridge/pi-analytics": patch
---

Require a current observed dispatch before attributing assistant failures to a physical provider, and ignore idle cache-warming provider hooks so they cannot create phantom response cycles.
