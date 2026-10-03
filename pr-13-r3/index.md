# Round-three real Pi CLI evidence

Revision: `d566d42c3252d041d2eaf36b69edcb1d51309b6b`. Pi 1.0.0; fullscreen; 120×60; actual `script(1)` PTY; checkout BTW/subagent packages. Existing authorized route, real model responses, no provider/renderer replacement or credential injection.

`r3-terminal.cast` is asciicast v2; `r3-terminal.ansi` retains the sanitized terminal stream. `r3-command.txt` is the actual launch command with checkout/test paths replaced. `r3-result.json` is the driver result; `r3-observer.jsonl` independently reads the parent through public editor/session APIs. `r3-frames.json` and individual `r3-screen-*.txt` are decoded **current terminal frames**, not a cumulative grep of historical output. `r3-steps.json` maps native keys to recording times.

| Time | Frame | Evidence |
| --- | --- | --- |
| ~6 s | `parent_success` | Successful parent model answer establishes transcript marker. |
| ~14 s | `btw_answer` | Actual BTW answer `42_R3_SIDE`. |
| ~16 s | `btw_success_return` | Visible parent transcript and unsent draft restored. |
| ~20 s | `btw_resume_picker` | Native same-thread resume. |
| ~26 s | `btw_resumed_answer` | Follow-up answer `43_R3_SIDE`, using the existing side history. |
| ~27–30 s | `btw_bring_menu`, `btw_append_menu`, `btw_bring_append` | Explicit append into the existing marked draft without submission. |
| ~35–36 s | `btw_running_cancel`, `btw_cancel_return` | Active `Answering…` request cancelled; restored parent. |
| ~40–42 s | `btw_failure`, `btw_failure_return` | Production parent-history destination mismatch rejects locally; restored parent. Not a provider outage claim. |
| ~49 s | `child_viewer` | Actual arithmetic child's viewer, `completed`, answer `42_R3_CHILD`, marked parent draft. |
| ~64 s | `child_success_viewer_return` | Native viewer close; original transcript and draft remain; parent acknowledgement settled. |

The recording-only observer seeds the unsent parent draft while native UI is open, clears it between scenarios with a test-only F12 shortcut, and reads public APIs. All production interaction and rendering is unchanged. The scratch child has no tools, extensions, nested delegation or persistence; it is only a functionality probe. Reproduction files are kept in the task artifacts, not loaded in normal package use.

`red-before-fix/` retains the failing real-CLI menu transition. It loses the live draft and directly loads brought context instead of offering append. Both final CLI and driver exit 0; the independent retained-artifact verifier exits 0. See `.local/round-answer.md` for RED/GREEN commands, limits and the full-check result.
