/**
 * Minimal ambient declaration for Bun's built-in `bun:sqlite` module. The repo
 * does not depend on `bun-types`/`@types/bun` (tsconfig `types: ["node"]`), so
 * this covers only the synchronous surface the gate db layer uses.
 */
declare module "bun:sqlite" {
    /** Prepared statement returned by `query`/`prepare`. */
    export interface Statement {
        get(...params: any[]): any;
        all(...params: any[]): any[];
        values(...params: any[]): any[][];
        run(...params: any[]): { lastInsertRowid: number | bigint; changes: number };
    }

    /** Synchronous SQLite database handle. */
    export class Database {
        constructor(filename?: string, options?: any);
        query(sql: string): Statement;
        prepare(sql: string): Statement;
        run(sql: string, ...params: any[]): { lastInsertRowid: number | bigint; changes: number };
        exec(sql: string): void;
        transaction<T extends (...args: any[]) => any>(fn: T): T;
        close(): void;
    }
}
