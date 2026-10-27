/** The slice of sql.js the screen captures use (the package ships no types). */
declare module "sql.js" {
  interface Statement {
    bind(params?: unknown): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }
  interface Database {
    exec(sql: string): unknown;
    run(sql: string, params?: unknown): void;
    prepare(sql: string): Statement;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<{ Database: new () => Database }>;
}
