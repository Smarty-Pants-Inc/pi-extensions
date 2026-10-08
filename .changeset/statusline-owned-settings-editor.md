---
"@signalridge/pi-statusline": patch
---

Close the settings JSON editor synchronously before tree navigation or shutdown, preserving Pi's native editing, configured external editor, and focus behavior without allowing late callbacks to dismiss a replacement dialog or apply retired settings. Prevent a pending native external editor from restarting the terminal after shutdown.
