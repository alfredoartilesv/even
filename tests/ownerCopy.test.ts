import test from "node:test";
import assert from "node:assert/strict";
import { cloudSync } from "../src/domain/cloudsync/cloudSync";
import { syncKeyBits, syncKeys } from "../src/domain/cloudsync/seal";
import type { SyncRow } from "../src/core/syncWire";
import { firstLoad } from "../server/ownerCopy";
import { migratedNodeDb } from "../server/sqlite";
import { addFood, foods, type Phone } from "../scripts/lib/syncScenario";

// The health connector's first load (server/ownerCopy.ts) must leave a copy exactly where cloudSync would.
test("the first load merges in batches, sets a bad row aside, and leaves the cursor where cloudSync carries on", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const keys = await syncKeys(secret);
  const store: (SyncRow & { seq: number })[] = [];
  const server = {
    push: async (rows: SyncRow[]) => {
      for (const r of rows) store.push({ ...r, seq: store.length + 1 });
      return { accepted: rows.length, ignored: 0 };
    },
    pull: async (after: number, limit: number) => {
      const rest = store.filter((r) => r.seq > after);
      const rows = rest.slice(0, limit);
      return { rows, next: rows.at(-1)?.seq ?? after, more: rest.length > limit };
    },
  };
  const phone = { name: "p", db: (await migratedNodeDb()).db } as Phone;
  for (let i = 0; i < 30; i++) await addFood(phone, `f${i}`, `food ${i}`, 100 + i, 1_700_000_000_000 + i);
  await cloudSync(phone.db, server, keys);
  store[3] = { ...store[3], blob: store[4].blob }; // sealed for another row: must not open

  const copy = { name: "c", db: (await migratedNodeDb()).db } as Phone;
  await copy.db.run("DELETE FROM cloud_sync_outbox");
  const report = await firstLoad(copy.db, server.pull, Buffer.from((await syncKeyBits(secret)).enc), Date.now());
  assert.equal(report.rejected, 1);
  assert.equal((await foods(copy)).length, 29);
  assert.equal((await copy.db.all("SELECT 1 FROM cloud_sync_outbox")).length, 0, "nothing queued to push back");

  await addFood(phone, "f-new", "later", 1, 1_800_000_000_000);
  await cloudSync(phone.db, server, keys);
  const next = await cloudSync(copy.db, server, keys);
  assert.equal(next.pulled, 1, "only the new row");
  assert.ok((await foods(copy)).some((f) => f.id === "f-new"));
});
