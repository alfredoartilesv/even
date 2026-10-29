import { adminStore } from "./admin";
import { migrateServer } from "./migrate";
import { openDb } from "./db";

/**
 * Operator chores against DATABASE_URL (the Docker `db` service, or Neon for Vercel), or without it
 * the PGlite database of npm run dev:web (stop the dev server first: one process at a time):
 *
 *   npm run sync:migrate                               apply server/migrations
 *   npm run sync:invite -- --email you@example.com     an invite code for one account (14 days), printed once
 *   npm run sync:accounts                              accounts with device counts and storage, no data
 *   npm run sync:admin -- --email you@example.com      make an account an admin (add --remove to take it away)
 *
 * In Docker: docker compose run --rm sync npm run sync:invite -- --email ...
 */
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (line: string) => process.stdout.write(`${line}\n`);

const pg = await openDb(process.env, { max: 1 });
try {
  const applied = await migrateServer(pg);
  if (command === "migrate") {
    out(`server migrations applied: ${applied.length ? applied.join(", ") : "none (up to date)"}`);
  } else if (command === "invite") {
    const email = flag("email");
    if (!email || !email.includes("@")) throw new Error("Pass --email <address>: the invite only works for that email");
    const { code } = await adminStore(pg).createInvite({ id: "cli", via: "cli" }, email);
    // The one time the code is shown: only its hash is kept.
    out(`invite for ${email.trim().toLowerCase()}: ${code}  (valid 14 days, one account)`);
  } else if (command === "accounts") {
    const rows = await pg.query<{ email: string; display_name: string; devices: number; bytes: number; created_at: number }>(
      `SELECT a.email, a.display_name, a.created_at,
              (SELECT COUNT(*)::int FROM devices d WHERE d.owner_id = a.id AND d.revoked_at IS NULL) AS devices,
              (SELECT COALESCE(SUM(length(blob)), 0)::bigint FROM sync_rows r WHERE r.owner_id = a.id) AS bytes
         FROM accounts a ORDER BY a.created_at`,
    );
    if (rows.length === 0) out("no accounts yet");
    for (const r of rows)
      out(
        `${r.email}  ${r.display_name}  devices ${r.devices}  ${(r.bytes / 1_048_576).toFixed(1)} MB  since ${new Date(r.created_at).toISOString().slice(0, 10)}`,
      );
  } else if (command === "admin") {
    const email = flag("email");
    if (!email) throw new Error("Pass --email <address> of an existing account");
    const remove = rest.includes("--remove");
    await adminStore(pg).setAdmin(email, !remove);
    out(`${email.trim().toLowerCase()} ${remove ? "is no longer an admin" : "is now an admin"}`);
  } else {
    throw new Error("Commands: migrate, invite, accounts, admin");
  }
} finally {
  await pg.close();
}
