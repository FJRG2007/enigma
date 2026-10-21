/**
 * The janitor for what an agent session starts and walks away from, as a standalone Node
 * entry (`dist/leftovers.js`).
 *
 * TWO FAMILIES, one sweep. The status bar leaks processes it cannot clean up itself: the
 * harness re-runs it as a fresh process on a timer, and a tick landing while the session
 * tears down leaves a child that was CREATED and never started - one suspended thread, zero
 * CPU over its whole life, no module loaded, a dead parent (66 of them in a day on Windows
 * 11). No timeout, `unref` or signal handler written in JS can touch that, because none of
 * it runs in a thread that never ran. A whole-machine `find` is the same shape from the
 * other end: an agent starts it, the turn moves on, nothing reads the output, and it keeps
 * walking millions of files for hours. Both survive until reboot, so the only cure is a
 * sweep from a process that IS running - and the process that is always running wherever
 * this happens is the next status-bar render, which spawns this one detached, at most once
 * an hour. `reapAgentLeftovers` in resources.ts holds the rules and what they refuse.
 *
 * Its own entry rather than a branch of the post-edit hook: the bar runs in sessions that
 * never edit a file, and a sweep that costs a process enumeration has no business on the
 * path of a hook that must answer in milliseconds. Its own PROCESS rather than a call
 * inside the renderer, because the probe takes seconds (see `leftoverCandidates`) and the
 * bar has to print now. Nothing here writes to stdout: it is spawned with its stdio
 * discarded.
 */

import { reapAgentLeftovers } from "./resources";

reapAgentLeftovers();
