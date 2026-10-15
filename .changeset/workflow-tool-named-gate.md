---
"@signalridge/pi-workflows": patch
---

Refuse every `workflow` tool call, including a saved workflow `name` and `resumeFromRunId`, with the same gate and message as inline `script`: a file in the agent directory is not trusted input because the model can write it. Saved and built-in workflows still run through user-typed slash commands.
