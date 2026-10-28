import * as z from "zod/mini";

/**
 * The cloud sync wire format, shared by the phone (src/features/cloudsync) and the server
 * (server/). The server only ever sees what is here: a table name, an opaque row key (an HMAC
 * the phone makes, so not the row's id or metric), the row's updated_at, and a sealed blob.
 * Everything else stays encrypted end to end (docs/architecture.md section 6).
 */

/** Rows per push or pull page. The server refuses bigger pushes. */
export const SYNC_PAGE = 500;
/** A sealed row is a few hundred bytes; photos are the big ones. */
export const MAX_BLOB_CHARS = 1_000_000;
/** Vercel refuses request bodies over 4.5 MB, so the phone splits a push page to stay under this. */
export const MAX_PUSH_BYTES = 4_000_000;

export const syncRow = z.object({
  tbl: z.string().check(z.regex(/^[a-z][a-z0-9_]{0,62}$/)),
  key: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  updatedAt: z.int().check(z.nonnegative()),
  blob: z.string().check(z.minLength(1), z.maxLength(MAX_BLOB_CHARS)),
});
export type SyncRow = z.infer<typeof syncRow>;

export const pushBody = z.object({ rows: z.array(syncRow).check(z.maxLength(SYNC_PAGE)) });
export type PushBody = z.infer<typeof pushBody>;

export interface PushResult {
  /** Rows the server took: new, or newer than the copy it had. */
  accepted: number;
  /** Rows the server already had in the same or a newer version. */
  ignored: number;
}

export interface PulledRow extends SyncRow {
  seq: number;
}

export interface PullResult {
  rows: PulledRow[];
  /** Pass as `after` next time. */
  next: number;
  more: boolean;
}
