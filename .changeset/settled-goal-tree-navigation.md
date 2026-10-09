---
"@signalridge/pi-goal": patch
---

Replace the one-second tree-navigation idle retry loop with session-owned work consumed once at an unblocked agent_settled or native ui_prompt_end event. Revalidate branch ownership and use the fresh settlement context before dispatching restored queue actions or a queued head; cancel deferred work on further navigation or shutdown. Tree restoration and passive idle time no longer arm polling timers.
