declare module "bun:sqlite" {
  export class Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class Database {
    constructor(filename: string, options?: { create?: boolean });
    exec(sql: string): void;
    query(sql: string): Statement;
  }
}
