declare module 'sql.js' {
  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  interface ParamsObject {
    [key: string]: string | number | null | Uint8Array;
  }

  type BindParams = (string | number | null | Uint8Array)[] | ParamsObject;

  interface Statement {
    bind(params?: BindParams): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, never>): Record<string, unknown>;
    get(params?: BindParams): unknown[];
    free(): boolean;
    reset(): void;
  }

  interface Database {
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface InitSqlJsOptions {
    locateFile?: (filename: string) => string;
  }

  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
  export type { Database, Statement, QueryExecResult, BindParams, SqlJsStatic };
}
