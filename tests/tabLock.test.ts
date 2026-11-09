import test from "node:test";
import assert from "node:assert/strict";
import { consumeTakeOver, holdTabLock, takeOverOnReload } from "../src/platform/tabLock";

// A LockManager with the browser's rules for one exclusive lock: ifAvailable gets null when it is
// held, and steal takes it, rejecting the holder's request with an AbortError.
function fakeLocks() {
  let holder: { reject: (e: Error) => void } | null = null;
  return {
    request(_name: string, options: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (holder && options.ifAvailable) return resolve(cb(null));
        if (holder && options.steal) {
          const old = holder;
          holder = null;
          old.reject(Object.assign(new Error("stolen"), { name: "AbortError" }));
        }
        holder = { reject };
        void Promise.resolve(cb({ name: "even-db", mode: "exclusive" } as Lock)).then(resolve, reject);
      });
    },
  } as Pick<LockManager, "request">;
}

test("the first tab owns the database; a second one is told another tab has it", async () => {
  const locks = fakeLocks();
  const lost: string[] = [];
  assert.deepEqual(await holdTabLock({ locks, onLost: () => lost.push("a") }), { held: true });
  assert.deepEqual(await holdTabLock({ locks, onLost: () => lost.push("b") }), { held: false });
  assert.deepEqual(lost, [], "asking without taking over never disturbs the owner");
});

test("Use Even here takes the database over, and the tab that had it is told to stop", async () => {
  const locks = fakeLocks();
  const lost: string[] = [];
  await holdTabLock({ locks, onLost: () => lost.push("background tab") });
  assert.deepEqual(await holdTabLock({ locks, takeOver: true, onLost: () => lost.push("this tab") }), { held: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lost, ["background tab"]);
});

test("a browser without Web Locks just opens the database, as before", async () => {
  assert.deepEqual(await holdTabLock({ locks: null, onLost: () => {} }).then((l) => l.held), true);
});

test("the take-over flag survives exactly one reload of this tab", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  let reloads = 0;
  takeOverOnReload(storage, () => reloads++);
  assert.equal(reloads, 1);
  assert.equal(consumeTakeOver(storage), true);
  assert.equal(consumeTakeOver(storage), false, "a later reload asks again instead of taking over");
});

test("blocked storage never breaks the reload or the next start", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  let reloads = 0;
  takeOverOnReload(blocked, () => reloads++);
  assert.equal(reloads, 1);
  assert.equal(consumeTakeOver(blocked), false);
});
