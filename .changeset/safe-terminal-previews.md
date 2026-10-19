---
"@signalridge/pi-ui": minor
"@signalridge/pi-files-widget": patch
"@signalridge/pi-input-history": patch
---

Add a shared dependency-free terminal-text sanitizer and apply it to file viewer rows and history popup previews before application styling. Strip terminal controls (including OSC52 clipboard writes) and Unicode bidi controls while preserving printable Unicode, tabs and newlines. Keep original file selection payloads and recalled history text unchanged.
