import type { createMockContext, createMockPi } from "./support.js";

let timestamp = 10_000;
const branches = new WeakMap<object, unknown[]>();
/** Explicitly reproduce the host's accepted input -> native message boundary. */
export async function nativeInput(
  mock: Pick<ReturnType<typeof createMockPi>, "events">,
  ctx: ReturnType<typeof createMockContext>["ctx"],
  text = "Please revise the plan",
  source: "interactive" | "rpc" | "extension" = "interactive",
) {
  await mock.events.get("input")?.[0]?.({ text, source }, ctx);
  const message = { role: "user", content: [{ type: "text", text }], timestamp: ++timestamp };
  await mock.events.get("message_start")?.[0]?.({ message }, ctx);
  const manager = (
    ctx as { sessionManager: { getBranch(): unknown[]; appendCustomEntry?(type: string, data: unknown): void } }
  ).sessionManager;
  let appended = branches.get(manager);
  if (!appended) {
    appended = [];
    branches.set(manager, appended);
    const original = manager.getBranch.bind(manager);
    const messages = appended;
    manager.getBranch = () => [...original(), ...messages];
    manager.appendCustomEntry = (customType, data) => {
      messages.push({ type: "custom", id: `custom-${++timestamp}`, customType, data });
    };
  }
  appended.push({ type: "message", id: `native-${timestamp}`, message });
  return message;
}
