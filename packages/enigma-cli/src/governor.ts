/**
 * Resource governor for work an agent executes on the user's machine.
 *
 * An agent session once ran the full test suite three times plus two 5000-file worktree
 * checkouts on a 32-core box. CPU never passed 13%: the machine crawled on I/O and on the
 * antivirus scanning ~10k new files, and stayed degraded after the commands finished. So the
 * budget here is not a CPU share with a nice name - it caps the dimensions that actually
 * hurt, and where a platform offers no real cap it says so instead of pretending.
 *
 * The budget maths is pure and lives apart from the spawning so it can be tested without
 * starting processes; `applyBudget` is the only part that touches a live child.
 */

import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpus, totalmem, freemem, setPriority } from "node:os";

/** A machine small enough that memory pressure, not CPU share, is the failure mode. */
export const LOW_MEMORY_GB = 16;

/** Percentage of the machine agent-executed work may occupy. */
export const DEFAULT_RESOURCE_CAP = 60;

/** On a low-memory machine, the system memory-use percentage that blocks new heavy work. */
export const DEFAULT_LOW_MEMORY_CAP = 80;

/** Priority for governed children: below the user's own work, never idle-starved. */
export type GovernedPriority = "below-normal" | "idle";

/** The resolved budget for one governed launch. */
export interface ResourceBudget {
    /** Logical cores on this machine. */
    cores: number;
    /** Cores the child may run on (>= 1, even at a 1% cap). */
    allowedCores: number;
    /** Affinity mask over the first `allowedCores` cores, or null where unsupported. */
    affinityMask: number | null;
    /** Scheduling priority to apply to the child. */
    priority: GovernedPriority;
    /** Whether the child should also be dropped to background I/O priority. */
    ioBackground: boolean;
    /** True when this machine is at or below LOW_MEMORY_GB. */
    lowMemory: boolean;
    /** Concurrency knobs to push into the child so build tools obey the same budget. */
    env: Record<string, string>;
}

/** Why a launch was refused, or null when it may proceed. */
export interface LaunchRefusal {
    reason: string;
    memoryUsePercent: number;
}

/** Inputs the caller resolves from config; defaults match the shipped settings. */
export interface GovernorOptions {
    /** Percentage cap, 1-100. Values outside the range are clamped. */
    cap?: number;
    /** Memory-use percentage that blocks new heavy work on a low-memory machine. */
    lowMemoryCap?: number;
    /** Bulk file work (checkouts, installs): drops to idle + background I/O. */
    bulk?: boolean;
}

function clampPercent(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(100, Math.max(1, Math.round(value)));
}

/**
 * Parses a percentage a user typed into a settings field. A blank or unparseable entry keeps
 * `fallback` rather than silently becoming 0, which would pin every agent to a single core.
 */
export function clampCapPercent(value: string, fallback: number): number {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(100, Math.max(1, parsed));
}

/** Total RAM in GB, rounded down - the comparison against LOW_MEMORY_GB is inclusive. */
export function totalMemoryGB(total = totalmem()): number {
    return Math.floor(total / 1024 ** 3);
}

/** Percentage of system memory currently in use. */
export function memoryUsePercent(total = totalmem(), free = freemem()): number {
    if (total <= 0) return 0;
    return Math.round(100 * (1 - free / total));
}

/**
 * Resolves the budget for a governed launch. `cores`/`totalBytes` are injectable so the
 * maths can be tested across machine shapes without pretending about the host.
 *
 * On a low-memory machine the cap is halved: there the scarce resource is RAM, and every
 * extra worker is another copy of a toolchain in memory.
 */
export function resourceBudget(
    opts: GovernorOptions = {},
    cores = cpus().length || 1,
    totalBytes = totalmem()
): ResourceBudget {
    const cap = clampPercent(opts.cap, DEFAULT_RESOURCE_CAP);
    const lowMemory = totalMemoryGB(totalBytes) <= LOW_MEMORY_GB;
    const effectiveCap = lowMemory ? Math.max(1, Math.round(cap / 2)) : cap;
    const allowedCores = Math.max(1, Math.min(cores, Math.floor((cores * effectiveCap) / 100)));

    let affinityMask: number | null = null;
    // A mask is only meaningful where the OS exposes affinity, and only up to the 31 bits a
    // JS bitwise operation can address; beyond that the priority and concurrency caps carry it.
    if (process.platform !== "darwin" && allowedCores < cores && allowedCores <= 31) {
        affinityMask = (1 << allowedCores) - 1;
    }

    const env: Record<string, string> = {
        JOBS: String(allowedCores),
        MAKEFLAGS: `-j${allowedCores}`,
        CARGO_BUILD_JOBS: String(allowedCores),
        UV_THREADPOOL_SIZE: String(Math.min(allowedCores, 16))
    };
    // A small machine also needs a ceiling per node child, or several toolchains at once swap.
    if (lowMemory) env.NODE_OPTIONS = "--max-old-space-size=2048";

    return {
        cores,
        allowedCores,
        affinityMask,
        priority: opts.bulk ? "idle" : "below-normal",
        ioBackground: true,
        lowMemory,
        env
    };
}

/**
 * Reports whether heavy work should be refused right now rather than throttled. Only a
 * low-memory machine refuses: on a large box, throttling is enough, and refusing a command
 * the user asked for is worse than running it slowly.
 */
export function refuseLaunch(
    opts: GovernorOptions = {},
    totalBytes = totalmem(),
    freeBytes = freemem()
): LaunchRefusal | null {
    if (totalMemoryGB(totalBytes) > LOW_MEMORY_GB) return null;
    const ceiling = clampPercent(opts.lowMemoryCap, DEFAULT_LOW_MEMORY_CAP);
    const inUse = memoryUsePercent(totalBytes, freeBytes);
    if (inUse < ceiling) return null;
    return {
        reason: `system memory is ${inUse}% used, at or above the ${ceiling}% ceiling for a ${totalMemoryGB(totalBytes)} GB machine`,
        memoryUsePercent: inUse
    };
}

/** Node's priority scale: 0 is normal, 10 is below normal, 19 is idle. */
function priorityValue(priority: GovernedPriority): number {
    return priority === "idle" ? 19 : 10;
}

/**
 * Applies the budget to a live child: scheduling priority first (it is what keeps the user's
 * UI responsive), then affinity where the platform supports it. Returns what was actually
 * applied, so a caller can report the honest subset rather than the intended one.
 *
 * Never throws: a governed command must still run if the OS refuses a hint. A failure to
 * lower priority is worth reporting, never worth failing the command over.
 */
export function applyBudget(child: ChildProcess, budget: ResourceBudget): {
    priority: boolean;
    affinity: boolean;
} {
    const applied = { priority: false, affinity: false };
    if (child.pid === undefined) return applied;
    try {
        // os.setPriority maps onto the platform's own scale, including Windows priority classes.
        setPriority(child.pid, priorityValue(budget.priority));
        applied.priority = true;
    } catch {
        // Permission or platform refusal; the concurrency env still applies.
    }
    if (budget.affinityMask !== null) applied.affinity = applyAffinity(child.pid, budget.affinityMask);
    return applied;
}

/**
 * Pins a process to an affinity mask. Windows goes through PowerShell's Process object
 * because Node exposes no affinity API; Linux uses taskset when present. A failure is
 * reported, never thrown, for the same reason as the priority hint.
 */
function applyAffinity(pid: number, mask: number): boolean {
    try {
        if (process.platform === "win32") {
            execFileSync(
                "powershell",
                ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`],
                { stdio: "ignore", timeout: 5000, windowsHide: true }
            );
            return true;
        }
        execFileSync("taskset", ["-p", mask.toString(16), String(pid)], { stdio: "ignore", timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/** One-line description of the budget for a log or a notice. */
export function describeBudget(budget: ResourceBudget): string {
    const parts = [`${budget.allowedCores}/${budget.cores} cores`, budget.priority];
    if (budget.affinityMask === null) parts.push("no affinity control");
    if (budget.lowMemory) parts.push("low-memory machine: cap halved");
    return parts.join(", ");
}
