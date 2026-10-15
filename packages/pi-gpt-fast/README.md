# pi-gpt-fast

Opt-in `/gpt-fast [on|off|toggle]` support for OpenAI/Codex priority service tiers. State is stored in Pi settings and the extension only changes eligible provider payloads.

Eligible requests require both the exact existing model allowlist and the
provider/API pair `openai` / `openai-responses` or `openai-codex` /
`openai-codex-responses`. Other APIs and compatible providers remain untouched.

Settings updates merge unknown keys under Pi's shared lock. Temporary files are
created exclusively with mode `0600`; replacement settings retain any stricter
owner permissions and never grant group/other access. Symlink and non-regular
targets are rejected rather than followed or replaced.

## Install

```bash
pi install npm:@signalridge/pi-gpt-fast
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-gpt-fast
```
