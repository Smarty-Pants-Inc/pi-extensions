# @signalridge/pi-subagents-protocol

Pure, side-effect-free wire contracts for the managed subagent protocol used by
`@signalridge/pi-subagents` and `@signalridge/pi-workflows`.

This package is a normal npm dependency, not a Pi extension. It does not register
listeners, read settings, own lifecycle state, or start timers. The runtime owner
remains `pi-subagents`; workflow state and journal ownership remain in
`pi-workflows`.

The protocol-v4 contract validates managed spawn requests, exact workflow owners, bounded terminal snapshots, owned quiescence responses, capabilities, and RPC envelopes.

A separate optional **UI version 1** contract exports `WORKFLOW_UI_CHANNELS`, workflow snapshot/query/open parsers, and the exact-attempt owned-conversation open parser. Snapshots carry at most 256 runs and bounded original names/identifiers, safe-integer counts, finite elapsed time and authoritative workflow statuses. Parsers return detached data; display consumers sanitize text before styling. They never infer run completion from child counts.

UI query/open requests use the existing request-correlated reply idiom. A conversation request must include a complete managed owner with `attemptId`; session, branch, current attempt and TUI availability are still enforced by the runtime owner. Admission is not dialog completion, agent dispatch or a permission grant. These channels add no required v4 capability or unsolicited ping fields. This package remains side-effect-free and owns no UI, state, listeners or timers.

A managed request names an Agent `tier` — a key in the host's own tier catalogue, not a separate workflow vocabulary — and carries no per-call model or thinking: a tier is the only model policy a caller can express, so there is no second selector that could silently win or be silently ignored. Optional hints can carry a named toolset, tool denylist, thread name, or worktree intent; `pi-subagents` remains the final resolver and enforces model scope, tool policy, concurrency, retries, skills, cwd, and isolation.

Every v4 capability is required — there is no partial peer to negotiate with — and every ping carries the host's Agent-tier catalogue plus a canonical SHA-256 fingerprint. `agentTierPolicyIdentity()` narrows that catalogue to the part that decides how one named tier resolves, so a caller's replay cache can key each call on its own tier: defining or editing an unrelated tier then invalidates nothing.

Because `parseProtocolPing` rejects unknown keys, the ping envelope cannot grow by a peer simply volunteering a field — that would make every already-published caller refuse the handshake. It grows the other way instead: a caller lists the extra fields it can parse in the request's `include` array (read with `parsePingIncludes`, which bounds it to 8 names), and the peer answers with only those. `maxConcurrent`, the peer's live background-agent pool size, is the first such field. Both directions stay compatible without a version bump, and an absent field means "this peer does not publish it", not a malformed reply.
