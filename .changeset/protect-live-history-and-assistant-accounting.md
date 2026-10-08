---
"@signalridge/pi-input-history": patch
"@signalridge/pi-analytics": patch
---

Keep live native prompt history ahead of deferred cross-session scans without remounting the editor, while retaining cached prompts for Ctrl+R. Exclude streaming cache warming from assistant generations and reliability, preserve finalized model attribution across sequential tools and skill reads, and conservatively avoid dispatch attribution from untagged overlapping provider hooks.
