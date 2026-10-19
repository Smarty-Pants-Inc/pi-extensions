---
"@signalridge/pi-ui": minor
"@signalridge/pi-files-widget": patch
"@signalridge/pi-input-history": patch
---

Add a shared dependency-free terminal-text sanitizer and apply it before layout and styling to file browser names, paths and branch/search labels, viewer content and titles, comment previews, path/error notifications, and history popup previews and filters. Strip terminal controls (including OSC52 clipboard writes) and Unicode format controls; retain contextual emoji joiners and variation selectors. Expand tabs to three spaces, normalize Unicode line separators, and replace unpaired surrogates in display copies. Keep original filesystem paths, file selection/comment payloads and recalled history text unchanged.
