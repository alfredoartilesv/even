/**
 * Spike (docs/architecture.md risk 4): can Drizzle's sqlite-proxy run on top of our SqlDriver,
 * i.e. on @capacitor-community/sqlite? Uses the Android plugin fake from tests/, real migrations.
 *
 *   npx tsx scripts/drizzle-spike.ts
 *
 * The catch: sqlite-proxy wants every row as an ARRAY in select order, but the plugin
 * (and so SqlDriver.all) returns OBJECTS keyed by column name. Converting with
 * Object.values() works until two selected columns share a name, as in any join that
 * selects id from both tables: the object keeps one key, and Drizzle silently reads the
 * wrong values into the wrong fields. This script checks both cases and prints the result.
 */
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { capacitorDriver } from "../src/platform/sqlite";
import type { SqlValue } from "../src/db/driver";
import { migrate } from "../src/db/migrate";
import { fakePlugin } from "../tests/fakePlugin";
import { realMigrations } from "../tests/helpers";

const conversations = sqliteTable("chat_conversations", {
  id: text("id").primaryKey(),
  title: text("title"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  originDeviceId: text("origin_device_id").notNull(),
});
const messages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  contentJson: text("content_json").notNull(),
  inputTokens: real("input_tokens"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  originDeviceId: text("origin_device_id").notNull(),
});

async function main() {
  const db = capacitorDriver(fakePlugin().conn);
  await migrate(db, realMigrations());

  const orm = drizzle(async (sql, params, method) => {
    if (method === "run") {
      await db.run(sql, params as SqlValue[]);
      return { rows: [] };
    }
    const rows = (await db.all<Record<string, unknown>>(sql, params as SqlValue[])).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows } as { rows: unknown[] };
  });

  const T = 1_800_000_000_000;
  await orm.insert(conversations).values({ id: "c1", title: "Sleep", createdAt: T, updatedAt: T, originDeviceId: "d" });
  await orm.insert(messages).values({ id: "m1", conversationId: "c1", seq: 0, role: "user", contentJson: "[]", createdAt: T + 1, updatedAt: T + 1, originDeviceId: "d" });

  const simple = await orm.select().from(conversations).where(eq(conversations.id, "c1"));
  const simpleOk = simple[0]?.title === "Sleep" && simple[0]?.createdAt === T;
  console.log(`single-table select and insert: ${simpleOk ? "OK" : "WRONG"} ->`, simple[0]);

  const joined = await orm
    .select({ convId: conversations.id, title: conversations.title, msgId: messages.id, role: messages.role })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id));
  const j = joined[0];
  const joinOk = j?.convId === "c1" && j?.msgId === "m1" && j?.title === "Sleep" && j?.role === "user";
  console.log(`join selecting two "id" columns: ${joinOk ? "OK" : "WRONG"} ->`, j);

  console.log(
    joinOk
      ? "\nResult: Drizzle works on SqlDriver for these cases."
      : "\nResult: Drizzle over object rows is unsafe for joins with duplicate column names. Use typed raw SQL + Zod, or alias every joined column.",
  );
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
