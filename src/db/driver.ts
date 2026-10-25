/**
 * Minimal async SQL driver. The app implements it on top of
 * @capacitor-community/sqlite (SQLCipher); tests implement it on node:sqlite.
 * Keeping this tiny means the migration + query code is testable without a phone.
 */
export type SqlValue = string | number | null;

export interface SqlDriver {
  /** Run one or more statements with no parameters / no result. */
  exec(sql: string): Promise<void>;
  /** Run a single parameterised statement. */
  run(sql: string, params?: SqlValue[]): Promise<void>;
  /** Run a query and return all rows. */
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
}
