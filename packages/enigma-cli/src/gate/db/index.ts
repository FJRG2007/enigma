/**
 * Gate database handle. Opens (or creates) the SQLite file, applies the schema
 * idempotently, and runs the additive migrations tolerating "duplicate column"
 * errors so no version table is needed. Faithful port of `internal/db/db.go`.
 *
 * Persistence uses Bun's built-in `bun:sqlite`, keeping enigma's zero npm runtime
 * dependency posture. The CRUD functions in the sibling modules take a `Database`
 * and operate on its `sql` handle, mirroring the Go `(d *DB)` receiver methods.
 */

import { Database as BunSqlite } from "bun:sqlite";
import { schemaSQL, migrationStatements } from "./schema";

/** Reports whether `err` is SQLite's "duplicate column name" error. */
function isDuplicateColumnErr(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("duplicate column name");
}

/** Wraps a SQLite database connection for the gate subsystem. */
export class Database {
    readonly sql: BunSqlite;

    /** Opens (or creates) the SQLite database at `path` and runs migrations. */
    constructor(path: string) {
        this.sql = new BunSqlite(path);
        this.sql.exec("PRAGMA journal_mode = WAL");
        this.sql.exec("PRAGMA foreign_keys = ON");
        this.sql.exec("PRAGMA busy_timeout = 5000");
        this.sql.exec(schemaSQL);
        for (const stmt of migrationStatements) {
            try {
                this.sql.run(stmt);
            } catch (err) {
                if (!isDuplicateColumnErr(err)) throw err;
            }
        }
    }

    /** Closes the database connection. */
    close(): void {
        this.sql.close();
    }
}

export * from "./schema";
export * from "./id";
export * from "./repo";
export * from "./run";
export * from "./step";
export * from "./round";
export * from "./intentCache";
export * from "./stats";
