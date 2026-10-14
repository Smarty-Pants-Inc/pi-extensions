# pi-background

Opt-in, experimental background shell jobs and low-noise log monitors for the
[Pi coding agent](https://pi.dev). Runs ordinary local processes, not child agents.
There are no model calls while a job is running or a monitor is waiting. Only an
exit or a configured literal log match can request another agent turn.

## Try from this checkout

```bash
pi -ne -e ./packages/pi-background
```

After this package is published, install it with
`pi install npm:@signalridge/pi-background`. Do not load this package alongside
another extension owning `bash_background`, `monitor`, or `background_*` tools.
The package refuses to start if Pi resolves one of its tool names to an earlier
extension. Pi can disambiguate duplicate commands; load only one background
manager rather than relying on registration order.

The workspace test baseline is Pi **1.0.4**. Real-SDK tests cover delivery,
committed-tree suspended input, and cancelled fork recovery using an offline
faux provider; they are enabled for **1.0.4** and **1.1.0**. Host peers use `"*"`
for module ownership, not a promise of compatibility with every host version.
This version targets local macOS/Linux; baseline acceptance ran on macOS/Pi
1.0.4, not Linux.
Windows, PTY attachment, SSH execution, and durable external services are
deliberately outside this first version. Bun-based and standalone Pi hosts require
a `node` executable on `PATH` for the owned supervisor; missing or stalled startup
fails rather than silently starting an unmanaged command.

## Shell tool opt-in

Shell tools are **disabled by default** in this fork. `bash_background` is not
registered, and `monitor({ command: ... })` returns a clear refusal without
starting a process. `monitor({ id: ... })` can still watch an existing owned job;
inspection and job-control tools remain available. This package does not add a
separate file-watching mode.

To opt in, add the following to your Pi settings and run `/reload`:

```json
{
  "piBackground": {
    "allowShellTools": true
  }
}
```

Only the boolean `true` enables shell tools. A missing setting, `false`, an
invalid value, or an unreadable settings snapshot leaves them disabled. The
extension uses Pi's public effective settings API; user and trusted project
settings follow Pi's normal merge rules. Registration happens at session startup,
when that API is bound. Each shell launch also checks the setting, so disabling
it prevents new launches even if a tool was previously registered.

**Keep `piBackground.allowShellTools` false until the host's command-approval
policy covers both `bash_background` and command-mode `monitor`.** Opt-in does
not install an approval policy or make these tools inherit builtin `bash` guards.

**ponytail:** this is a fork-local, default-deny gate: the smallest safe change
while command-policy integration is incomplete, not a new shell sandbox.

## Tools

| Tool | Purpose |
| --- | --- |
| `bash_background` | With explicit shell opt-in, start a finite command and return its ID |
| `monitor` | Watch an existing job; starting a command requires explicit shell opt-in |
| `background_list` | Inspect running and retained completed jobs, optionally by ID |
| `background_logs` | Read a bounded tail of stdout/stderr, optionally select a stream |
| `background_stop` | Stop an owned process group, wait for exit, retain its logs |
| `background_clear` | Remove completed jobs and their logs; never removes running jobs |

Tools return structured results as well as model-facing text. IDs are opaque and
unique to an extension runtime. There is no tool accepting an arbitrary PID.

Use background execution when the user asks for it or useful independent work
remains. If a command's result is needed immediately, use foreground `bash` rather
than starting a job and repeatedly inspecting its status.

### Finite work

The following shell examples require `piBackground.allowShellTools: true`.

```js
bash_background({
  command: "bun run check",
  description: "Repository checks",
  timeout_ms: 1800000,
  notify: "turn"
})
```

The default timeout is 30 minutes, with a maximum of 24 hours. `notify` accepts:

- `turn` (default): an exit requests an agent turn after current work settles;
- `context`: record the event in the transcript without starting a model turn;
- `off`: do not send an exit notification; inspect status and logs explicitly.

A successful start reports a spawned process, not command success. Command
failures appear as a completed job with its exit code/error, and an exit event
unless disabled. Launch validation failures throw a tool error.

### Event-driven monitoring

```js
monitor({
  command: "bun run dev",
  description: "Development server",
  patterns: ["ready", "ERROR"],
  stream: "both"
})

// Or attach rules to an existing job, without starting another process:
monitor({ id: "<job-id>", patterns: ["FAIL", "Tests passed"] })
```

Supply **exactly one** of `command` or `id`. Patterns are case-sensitive literal
substrings of future output lines, not regular expressions. Whitespace is
preserved exactly: `" ERROR "` and `"ERROR"` are different patterns. Only exact
duplicates are removed; bounds apply to the original pattern. Matching happens
incrementally, without requiring a newline. Replacing rules
resets their matching state; previous output is not replayed. Each distinct
pattern fires once by default. Limits are eight patterns, 256 characters per
pattern and 8 KiB per matching line. Oversized lines are truncated for matching;
use logs for their retained content. Stdout and stderr are decoded independently
so fragmented UTF-8 or interleaved streams do not create artificial matches.

Set `repeat: true` for new repeated occurrences and `cooldown_ms` to control their
rate (default 10 seconds, minimum one second, maximum one hour). An old occurrence
is not replayed when unrelated text is appended; matches suppressed during the
cooldown are consumed, not delayed. The extension also
limits automatic wake batches to at most one every ten seconds. Patterns that
never occur remain silent: inspect the actual output to choose accurate markers.

New monitor commands have **no timeout by default**. An optional `timeout_ms`
bounds their lifetime. When attaching to an existing job, its original timeout
and exit-notification policy remain unchanged. `notify` on the watch controls
match notifications (`turn` or `context`); a newly started monitor uses it for
exits too. Attaching cannot change launch cwd/description/timeout.

```js
background_logs({ id: "<job-id>", tail: 200, stream: "stderr" })
background_stop({ id: "<job-id>" })
background_clear({ id: "<completed-job-id>" })
```

## Lifecycle and limits

- At most eight running jobs and 32 retained jobs. Admission evicts the oldest
  completed job when necessary, never a running process.
- Combined stdout/stderr retention is 256 KiB **per job**, in memory. Oldest bytes
  are discarded; `droppedBytes` exposes this loss. Logs default to 200 lines and
  accept at most 1,000; model-facing log text is additionally capped at 24 KiB.
- Pending notifications are bounded and coalesced per job. Event messages are
  capped at 8 KiB; whole job summaries that do not fit remain queued for a later
  batch. Individual excerpts are truncated. Capacity overflow warns and is counted
  in the next accepted event message. Output is explicitly marked untrusted data.
  Terminal control sequences are removed from model-facing output.
- Jobs survive ordinary agent turns. Reload, successful session replacement,
  session-tree navigation, and shutdown terminate jobs and discard their logs
  and undelivered notifications. **No jobs or logs are restored from a session
  file**, and no temporary log files are written.
- Stop and shutdown send TERM, then escalate to KILL while the original owned
  process-group leader is still live. Stop waits for confirmed exit. Normal shell
  completion reports its result on shell exit, not pipe closure, and cleans
  same-group descendants with inherited or redirected output. Pipes keep draining
  through cleanup, preserving the shell's exit result and termination logs.
  Cleanup grace is not charged to the command deadline. Intentional-stop output remains
  in logs but cannot create new watch notifications. Commands must not daemonize
  or escape their process group; this is not a service manager.
- The supervisor's startup handshake is bounded to five seconds independently
  of the command timeout, including inherited Node debugger flags.
- Cancelling the launch before successful startup cleans up the process. Once
  the tool returns, the job belongs to the session, not to that tool's abort
  signal. Use `background_stop` to cancel later.
- No polling model turns, sleep loops, or background agents. Small timers only
  implement timeout, termination grace, batching and notification cooldown.

### Notification safety and recovery

Events remain extension-local while Pi is busy, compacting, navigating sessions,
or has queued work. Delivery is guarded by the fully settled boundary rather than
`agent_end`. No background message is inserted between a tool call and its result.
Events are persisted as context-only custom messages; a separate short user-message
wake runs the normal `input`/`before_agent_start` prompt pipeline. This preserves
other extensions' guidance, routing and continuation hooks. An exact wake ID
acknowledges the resulting user message before provider execution. The input hook
also consumes a known extension-sourced wake whose job owner has retired,
including a wake suspended in an earlier input handler when the host commits a
new leaf before this package's tree callback runs. Ownership captures the session
manager, session ID, and observed branch entry-ID prefix. Ordinary appends remain
owned; divergence retires the owner permanently at tool, delivery, consumption,
ACK, and asynchronous UI/update boundaries. Unrecognized lookalike inputs are
left unchanged. Context-only acceptance is
confirmed directly in the public transcript without a model call.
Terminal events are not duplicated by multiple child-process callbacks.

Synchronous delivery errors or an unaccepted wake observed at a settled boundary
are retried at most three times with backoff, then delivery pauses. A missing
acknowledgment after a run starts, or after a 30-second acknowledgment deadline
without a settled event, is ambiguous: delivery pauses instead of blindly
resending. This also exposes consumed input and asynchronous host rejection;
a late exact acknowledgment clears the pause.
`background_list` reports pending/paused delivery and the TUI shows a compact
owned status line. Use:

```text
/background status
/background retry
```

Retry is an explicit recovery action and can redeliver an ambiguously acknowledged
message. An input consumed by another extension, cancelled navigation, or manual
compaction without a subsequent agent run can defer notices; use retry after Pi
is idle. Switch, tree, and fork preflight gate delivery without destroying jobs or
the outbox on cancellation. Retry rechecks its captured live owner after waiting
for idle; it cannot recover an owner retired by committed navigation. Already handed-off transcript messages cannot be retracted by stopping a
job. Public hooks cannot fence an arbitrary later extension handler that suspends
after this package's input guard. Intentional stops/clears cancel only undelivered
notices.

`context` notifications do not start a model turn but become part of later model
context. `turn` notifications can consume provider tokens. Repeated monitoring is
an explicit opt-in, not a guarantee of zero cost.

TUI status is guarded by `ctx.mode === "tui"`; supported notifications use
`ctx.hasUI`. Tools work independently of UI in RPC/JSON/print modes, but a
short-lived host may shut down before a background job finishes and then kills
it. Use an interactive or long-lived RPC session for asynchronous work.

## Security and integration

Commands run with Pi's full local operating-system permissions using
`/bin/bash -c`. This package does not replace builtin `bash`, inherit its shell
path/prefix override, or detect another extension's remote workspace. Do not use
it for remote commands or to bypass a rejected foreground command.

Tools publish read-only/destructive/open-world annotations for permission
extensions. **Annotations are hints, not a sandbox.** An approval policy that
handles only `bash` must explicitly cover `bash_background` and command-mode
`monitor` too. Until that coverage exists, keep `piBackground.allowShellTools`
false; the fork-local gate prevents shell launches by default.
Plan-mode users must not opt these mutating tools into a read-only loadout.
There is no automatic change to any other extension's tool selection or settings.

This package does not resume or mutate a paused `pi-goal`. A background event can
start a normal agent turn; that is distinct from granting Goal ownership or
resuming an explicit Goal wait. No undocumented cross-extension protocol is used.

Logs can contain secrets. Retained raw logs stay in memory, but inspected output
and delivered events become part of Pi's transcript; avoid monitoring sensitive
streams.

For jobs that must survive closing Pi, use a terminal multiplexer or an external
service manager with an explicit ownership and reconnection policy.

## Design references

This is an independent implementation, not a bundled fork. References:

- [99percentpeople background tasks](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks): explicit process ownership and separate inspection/control operations;
- [aliou/pi-processes](https://github.com/aliou/pi-processes): event-driven attention levels and log watches; adversarial DCS/C1/fragmented terminal-control fixture forms inform plain-text sanitization tests (not its rendering implementation);
- [fl4p background shell](https://github.com/fl4p/pi-extensions/blob/master/extensions/bash-background.ts): finite exit notifications and coalesced output;
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): public tools, lifecycle and custom messages.

PTY, SSH, shell-provider protocols and cross-application persistence are not copied
into this package. There are no runtime dependencies beyond Pi's host-provided
modules and Node builtins.

## Development

```bash
bun run --cwd packages/pi-background check
```

## License

MIT
