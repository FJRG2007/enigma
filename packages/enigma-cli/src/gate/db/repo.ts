/**
 * Repository records: registration, lookup, and metadata updates. Faithful port
 * of no-mistakes' `internal/db/repo.go`.
 */

import type { Database } from "./index";
import { now, newId, nullableString } from "./id";

/** A registered repository. */
export interface Repo {
    id: string;
    workingPath: string;
    upstreamUrl: string;
    forkUrl: string;
    defaultBranch: string;
    createdAt: number;
}

const SELECT_REPO = "SELECT id, working_path, upstream_url, COALESCE(fork_url, ''), default_branch, created_at FROM repos";

function scanRepo(row: any[]): Repo {
    return {
        id: row[0] as string,
        workingPath: row[1] as string,
        upstreamUrl: row[2] as string,
        forkUrl: row[3] as string,
        defaultBranch: row[4] as string,
        createdAt: row[5] as number
    };
}

/** Returns the remote URL that should receive branch updates. */
export function repoPushURL(r: Repo | null): string {
    if (r === null) return "";
    if (r.forkUrl.trim() !== "") return r.forkUrl;
    return r.upstreamUrl;
}

/** Creates a new repo record with a caller-provided ID. */
export function insertRepoWithID(db: Database, id: string, workingPath: string, upstreamUrl: string, defaultBranch: string): Repo {
    return insertRepoWithIDAndFork(db, id, workingPath, upstreamUrl, "", defaultBranch);
}

/** Creates a repo record with a caller-provided ID and an optional fork push URL. */
export function insertRepoWithIDAndFork(db: Database, id: string, workingPath: string, upstreamUrl: string, forkUrl: string, defaultBranch: string): Repo {
    const r: Repo = {
        id,
        workingPath,
        upstreamUrl,
        forkUrl: forkUrl.trim(),
        defaultBranch,
        createdAt: now()
    };
    db.sql.query(
        "INSERT INTO repos (id, working_path, upstream_url, fork_url, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(r.id, r.workingPath, r.upstreamUrl, nullableString(r.forkUrl), r.defaultBranch, r.createdAt);
    return r;
}

/** Creates a new repo record and returns it with a generated ID. */
export function insertRepo(db: Database, workingPath: string, upstreamUrl: string, defaultBranch: string): Repo {
    return insertRepoWithFork(db, workingPath, upstreamUrl, "", defaultBranch);
}

/** Creates a new repo record with a generated ID and an optional fork push URL. */
export function insertRepoWithFork(db: Database, workingPath: string, upstreamUrl: string, forkUrl: string, defaultBranch: string): Repo {
    const r: Repo = {
        id: newId(),
        workingPath,
        upstreamUrl,
        forkUrl: forkUrl.trim(),
        defaultBranch,
        createdAt: now()
    };
    db.sql.query(
        "INSERT INTO repos (id, working_path, upstream_url, fork_url, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(r.id, r.workingPath, r.upstreamUrl, nullableString(r.forkUrl), r.defaultBranch, r.createdAt);
    return r;
}

/** Returns a repo by ID, or null when absent. */
export function getRepo(db: Database, id: string): Repo | null {
    const rows = db.sql.query(`${SELECT_REPO} WHERE id = ?`).values(id);
    if (rows.length === 0) return null;
    return scanRepo(rows[0]);
}

/** Returns a repo by its working path, or null when absent. */
export function getRepoByPath(db: Database, workingPath: string): Repo | null {
    const rows = db.sql.query(`${SELECT_REPO} WHERE working_path = ?`).values(workingPath);
    if (rows.length === 0) return null;
    return scanRepo(rows[0]);
}

/**
 * Refreshes mutable repository metadata while preserving the stable repo ID,
 * created_at timestamp, and any existing fork push URL.
 */
export function updateRepoMetadata(db: Database, id: string, upstreamUrl: string, defaultBranch: string): Repo | null {
    db.sql.query("UPDATE repos SET upstream_url = ?, default_branch = ? WHERE id = ?").run(upstreamUrl, defaultBranch, id);
    return getRepo(db, id);
}

/** Refreshes repo metadata and explicitly sets the optional fork push URL. */
export function updateRepoMetadataWithFork(db: Database, id: string, upstreamUrl: string, forkUrl: string, defaultBranch: string): Repo | null {
    db.sql.query(
        "UPDATE repos SET upstream_url = ?, fork_url = ?, default_branch = ? WHERE id = ?"
    ).run(upstreamUrl, nullableString(forkUrl), defaultBranch, id);
    return getRepo(db, id);
}

/** Sets or clears the optional fork push URL. */
export function updateRepoForkURL(db: Database, id: string, forkUrl: string): Repo | null {
    db.sql.query("UPDATE repos SET fork_url = ? WHERE id = ?").run(nullableString(forkUrl), id);
    return getRepo(db, id);
}

/**
 * Moves a repo record to a new working path, preserving the repo ID (and with it
 * the gate and run history) when the working directory is renamed or moved.
 */
export function updateRepoWorkingPath(db: Database, id: string, workingPath: string): Repo | null {
    db.sql.query("UPDATE repos SET working_path = ? WHERE id = ?").run(workingPath, id);
    return getRepo(db, id);
}

/** Deletes a repo by ID (cascade deletes runs and steps). */
export function deleteRepo(db: Database, id: string): void {
    db.sql.query("DELETE FROM repos WHERE id = ?").run(id);
}
