#!/usr/bin/env python3
"""
hunt_journal.py — Hunt Memory & Session Tracking

Persistent hunt journal that tracks:
- Target sessions
- Findings
- Tested endpoints
- Payouts

Usage:
    from memory.hunt_journal import HuntJournal
    
    journal = HuntJournal()
    journal.start_session("target.com")
    journal.log_finding("target.com", "idor", "/api/users/123", "confirmed", "HIGH")
    journal.end_session("target.com")
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

class HuntJournal:
    """Append-only hunt journal with JSONL storage."""

    def __init__(self, memory_dir: str = None):
        if memory_dir is None:
            BASE_DIR = Path(__file__).parent.parent
            memory_dir = BASE_DIR / "memory"
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        
        self.journal_file = self.memory_dir / "journal.jsonl"
        self.targets_dir = self.memory_dir / "targets"
        self.targets_dir.mkdir(parents=True, exist_ok=True)

    def _append(self, entry: dict) -> None:
        """Append entry to journal."""
        with open(self.journal_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _load_target(self, target: str) -> dict:
        """Load target profile."""
        path = self.targets_dir / f"{target}.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return {
            "target": target,
            "sessions": [],
            "findings": [],
            "tested_endpoints": [],
            "created": datetime.now().isoformat()
        }

    def _save_target(self, target: str, data: dict) -> None:
        """Save target profile."""
        path = self.targets_dir / f"{target}.json"
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

    def start_session(self, target: str, program: str = "", scope: list = None) -> str:
        """Start a new hunt session. Returns session_id."""
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        entry = {
            "type": "session_start",
            "target": target,
            "session_id": session_id,
            "program": program,
            "scope": scope or [],
            "timestamp": datetime.now().isoformat()
        }
        self._append(entry)

        target_data = self._load_target(target)
        target_data["sessions"].append({
            "session_id": session_id,
            "start": entry["timestamp"],
            "program": program
        })
        self._save_target(target, target_data)

        return session_id

    def end_session(self, target: str, session_id: str = None, summary: str = "") -> None:
        """End the current session."""
        entry = {
            "type": "session_end",
            "target": target,
            "session_id": session_id or "",
            "summary": summary,
            "timestamp": datetime.now().isoformat()
        }
        self._append(entry)

    def log_finding(
        self,
        target: str,
        vuln_class: str,
        endpoint: str,
        result: str,
        severity: str = "",
        payout: str = "",
        notes: str = "",
        session_id: str = None
    ) -> None:
        """Log a finding to journal."""
        entry = {
            "type": "finding",
            "target": target,
            "session_id": session_id or "",
            "vuln_class": vuln_class,
            "endpoint": endpoint,
            "result": result,
            "severity": severity,
            "payout": payout,
            "notes": notes,
            "timestamp": datetime.now().isoformat(),
        }
        self._append(entry)

        target_data = self._load_target(target)
        target_data["findings"].append({
            "vuln_class": vuln_class,
            "endpoint": endpoint,
            "result": result,
            "severity": severity,
            "payout": payout,
            "logged_at": entry["timestamp"],
        })
        self._save_target(target, target_data)

    def log_endpoint_tested(self, target: str, endpoint: str, method: str = "", notes: str = "") -> None:
        """Log a tested endpoint."""
        entry = {
            "type": "endpoint_tested",
            "target": target,
            "endpoint": endpoint,
            "method": method,
            "notes": notes,
            "timestamp": datetime.now().isoformat()
        }
        self._append(entry)

        target_data = self._load_target(target)
        if endpoint not in target_data["tested_endpoints"]: target_data["tested_endpoints"].append(endpoint)
        self._save_target(target, target_data)

    def get_target_summary(self, target: str) -> dict:
        """Get summary for a target."""
        target_data = self._load_target(target)
        return {
            "target": target,
            "total_sessions": len(target_data.get("sessions", [])),
            "total_findings": len(target_data.get("findings", [])),
            "confirmed_findings": sum(1 for f in target_data.get("findings", []) if f.get("result") == "confirmed"),
            "tested_endpoints_count": len(target_data.get("tested_endpoints", [])),
            "last_session": target_data.get("sessions", [{}])[-1].get("start", "never") if target_data.get("sessions") else "never"
        }

    def get_untested_endpoints(self, target: str, all_endpoints: list) -> list:
        """Get endpoints that haven't been tested yet."""
        target_data = self._load_target(target)
        tested = set(target_data.get("tested_endpoints", []))
        return [ep for ep in all_endpoints if ep not in tested]

    def list_targets(self) -> list:
        """List all targets with data."""
        targets = []
        for f in self.targets_dir.glob("*.json"):
            target = f.stem
            summary = self.get_target_summary(target)
            targets.append(summary)
        return sorted(targets, key=lambda x: x.get("last_session", ""), reverse=True)

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Hunt Journal")
    parser.add_argument("--target", help="Target domain")
    parser.add_argument("--session-start", action="store_true", help="Start session")
    parser.add_argument("--session-end", action="store_true", help="End session")
    parser.add_argument("--list", action="store_true", help="List all targets")
    parser.add_argument("--summary", help="Show summary for target")
    args = parser.parse_args()

    journal = HuntJournal()

    if args.list:
        targets = journal.list_targets()
        print(f"Total targets: {len(targets)}")
        for t in targets[:10]:
            print(f"  {t['target']}: {t['confirmed_findings']} confirmed, {t['tested_endpoints_count']} endpoints")
        return

    if args.summary:
        s = journal.get_target_summary(args.summary)
        print(f"Target: {s['target']}")
        print(f"  Sessions: {s['total_sessions']}")
        print(f"  Findings: {s['total_findings']} ({s['confirmed_findings']} confirmed)")
        print(f"  Tested endpoints: {s['tested_endpoints_count']}")
        print(f"  Last session: {s['last_session']}")
        return

    if args.target and args.session_start:
        sid = journal.start_session(args.target)
        print(f"Session started: {sid}")
        return

    if args.target and args.session_end:
        journal.end_session(args.target)
        print("Session ended")
        return

    print("Use: --target TARGET --session-start | --list | --summary TARGET")


if __name__ == "__main__": main()