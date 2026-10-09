import { resolve } from "node:path";

// Package scripts may use Bun's runner; only refuse the mixed-runner root suite.
if (process.cwd() === resolve(import.meta.dirname, "..")) {
  console.error("This repository uses package-specific test runners. Run `bun run test` instead of `bun test`.");
  process.exit(1);
}
