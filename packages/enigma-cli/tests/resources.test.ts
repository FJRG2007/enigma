/**
 * System-resource parsers: the pure output-parsing of tasklist/ps/netstat/lsof, which is the
 * only part of resources.ts that can be tested without spawning processes or killing anything.
 * The destructive actions (killPid/freePort/shutdownWsl/quitDocker) are verified by the user.
 */
import { test, expect } from "bun:test";
import { parseTasklist, parsePs, parseNetstat, parseLsof } from "../src/resources";

test("parseTasklist reads name/pid/mem from CSV (commas in mem stripped)", () => {
    const out = '"chrome.exe","1234","Console","1","523,480 K"\r\n"vmmemWSL","9001","Services","0","2,100,000 K"\r\n';
    const procs = parseTasklist(out);
    expect(procs).toHaveLength(2);
    expect(procs[0]).toEqual({ name: "chrome.exe", pid: 1234, memKB: 523480 });
    expect(procs[1]).toEqual({ name: "vmmemWSL", pid: 9001, memKB: 2100000 });
});

test("parsePs reads pid/rss/comm", () => {
    const procs = parsePs("  1234   523480 /usr/lib/firefox/firefox\n  42 100 node\n");
    expect(procs[0]).toEqual({ pid: 1234, memKB: 523480, name: "firefox" });
    expect(procs[1]).toEqual({ pid: 42, memKB: 100, name: "node" });
});

test("parseNetstat keeps only LISTENING TCP rows and dedupes", () => {
    const out = [
        "  Proto  Local Address          Foreign Address        State           PID",
        "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234",
        "  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       9999",
        "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234",
        "  TCP    10.0.0.1:54321         93.184.216.34:443     ESTABLISHED     5555",
        "  UDP    0.0.0.0:53             *:*                                    7777",
    ].join("\r\n");
    const ports = parseNetstat(out);
    expect(ports).toHaveLength(2);
    expect(ports.find((p) => p.port === 3000)).toEqual({ proto: "tcp", port: 3000, pid: 1234, name: "" });
    expect(ports.find((p) => p.port === 5432)?.pid).toBe(9999);
});

test("parseLsof reads command/pid/port from LISTEN rows", () => {
    const out = [
        "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
        "node    1234 me     20u  IPv4  0x12      0t0  TCP *:3000 (LISTEN)",
        "postgres 999 me      7u  IPv6  0x34      0t0  TCP [::1]:5432 (LISTEN)",
    ].join("\n");
    const ports = parseLsof(out);
    expect(ports.find((p) => p.port === 3000)).toEqual({ proto: "tcp", port: 3000, pid: 1234, name: "node" });
    expect(ports.find((p) => p.port === 5432)?.name).toBe("postgres");
});
