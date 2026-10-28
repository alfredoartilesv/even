import { migrateServer } from "./migrate";
import { postgresJs } from "./pg";
import { syncStore } from "./store";

/**
 * Server chores against DATABASE_URL (the Docker `db` service, or Neon for Vercel):
 *
 *   npm run sync:migrate                                      apply server/migrations
 *   npm run sync:device -- --owner <google subject> --name s23  register a device, print its token once
 *   npm run sync:device -- --revoke <device id>
 *
 * In Docker: docker compose run --rm sync npm run sync:device -- --owner ... --name ...
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const pg = postgresJs(url, { max: 1 });
try {
  const applied = await migrateServer(pg);
  if (command === "migrate") {
    process.stdout.write(`server migrations applied: ${applied.length ? applied.join(", ") : "none (up to date)"}\n`);
  } else if (command === "device") {
    const store = syncStore(pg);
    const revoke = flag("revoke");
    if (revoke) {
      await store.revokeDevice(revoke);
      process.stdout.write(`device ${revoke} revoked\n`);
    } else {
      const owner = flag("owner");
      const name = flag("name") ?? "phone";
      if (!owner) throw new Error("Pass --owner <google subject> (Settings > Account on the phone shows it)");
      const { id, token } = await store.addDevice(owner, name);
      // The one time the token is shown: it goes in the phone's Keystore, the server keeps its hash.
      process.stdout.write(`device ${id} (${name})\ntoken ${token}\n`);
    }
  } else {
    throw new Error("Commands: migrate, device");
  }
} finally {
  await pg.close();
}
