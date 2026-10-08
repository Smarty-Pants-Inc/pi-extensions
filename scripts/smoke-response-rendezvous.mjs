// Private smoke oracle: only actual entry into both designated provider callbacks
// proves overlap. The deadline starts at the first callback, not workflow startup.
export function createResponseRendezvous(label, participants, timeoutMs = 5_000, releaseWhen = () => true) {
  if (participants.length !== 2 || new Set(participants).size !== 2) {
    throw new Error("Response rendezvous requires two distinct provider callbacks");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Response rendezvous requires a positive bounded timeout");
  }
  const expected = new Set(participants);
  const entered = new Set();
  const { promise, resolve, reject } = Promise.withResolvers();
  // Disposal can precede callback entry; observe rejection even with no waiter.
  // Callbacks still await the original promise and receive the same error.
  promise.catch(() => {});
  let timer;
  let releaseTimer;
  let released = false;
  let failure;
  const waitingFor = () => participants.filter((name) => !entered.has(name)).join(", ") || "release condition";
  const clearDeadline = () => {
    clearTimeout(timer);
    timer = undefined;
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    releaseTimer = undefined;
  };
  const fail = (error) => {
    if (released || failure) return;
    failure = error;
    clearDeadline();
    reject(error);
  };

  const tryRelease = () => {
    if (released || failure) return;
    try {
      if (releaseWhen()) {
        released = true;
        clearDeadline();
        resolve();
      } else {
        releaseTimer = setTimeout(tryRelease, 10);
      }
    } catch (error) {
      fail(error);
    }
  };

  return {
    async enter(name) {
      if (failure) throw failure;
      if (!expected.has(name)) throw new Error(`${label} unexpected provider callback: ${name}`);
      if (entered.has(name)) throw new Error(`${label} duplicate provider callback: ${name}`);
      entered.add(name);
      if (entered.size === 2) {
        tryRelease();
      } else {
        timer = setTimeout(() => {
          fail(
            new Error(
              `${label} response rendezvous timed out after ${timeoutMs}ms: waiting for ${waitingFor()}; provider callbacks must overlap`,
            ),
          );
        }, timeoutMs);
      }
      await promise;
    },
    assertReleased() {
      if (failure) throw failure;
      if (!released) throw new Error(`${label} response rendezvous incomplete: waiting for ${waitingFor()}`);
    },
    dispose(error = new Error(`${label} response rendezvous disposed`)) {
      fail(error);
      clearDeadline();
    },
  };
}

// Consume latest managed lifecycle states, not transient allocation tombstones.
// Pending allocation is allowed; over-admission must fail before releasing the
// designated provider pair, even when the third callback has not started yet.
export function queueAdmissionReady(states) {
  if (states.length < 3) return false;
  const running = states.filter((state) => state === "running").length;
  const queued = states.filter((state) => state === "queued").length;
  if (states.length !== 3 || running !== 2 || queued !== 1) {
    throw new Error(`real Pi queue must admit two running and one queued task, observed: ${states.join(", ")}`);
  }
  return true;
}
