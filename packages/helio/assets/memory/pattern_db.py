#!/usr/bin/env python3
"""
pattern_db.py — Cross-Target Pattern Learning

Learns successful patterns from confirmed findings and applies them
to new targets based on tech stack similarity.

Usage:
    from memory.pattern_db import PatternDB
    
    db = PatternDB()
    db.add_pattern("target.com", "idor", "/api/users/{id}", "numeric_id_swap")
    patterns = db.get_patterns_for_tech("rails", "graphql")
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

class PatternDB:
    """Pattern database for cross-target learning."""

    def __init__(self, memory_dir: str = None):
        if memory_dir is None:
            BASE_DIR = Path(__file__).parent.parent
            memory_dir = BASE_DIR / "memory"
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        
        self.patterns_file = self.memory_dir / "patterns.jsonl"

    def _append(self, entry: dict) -> None:
        """Append entry to patterns file."""
        with open(self.patterns_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def add_pattern(
        self,
        target: str,
        vuln_class: str,
        endpoint_pattern: str,
        technique: str,
        tech_stack: list = None,
        payout: str = "",
    ) -> None:
        """Add a successful pattern to the database."""
        entry = {
            "type": "pattern",
            "target": target,
            "vuln_class": vuln_class,
            "endpoint_pattern": endpoint_pattern,
            "technique": technique,
            "tech_stack": tech_stack or [],
            "payout": payout,
            "timestamp": datetime.now().isoformat()
        }
        self._append(entry)

    def get_patterns(self, vuln_class: str = None, tech_stack: list = None) -> list:
        """Get patterns, optionally filtered by vuln class or tech stack."""
        patterns = []
        if not self.patterns_file.exists(): return patterns

        with open(self.patterns_file, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                try:
                    p = json.loads(line)
                    if vuln_class and p.get("vuln_class") != vuln_class: continue
                    if tech_stack:
                        p_tech = p.get("tech_stack", [])
                        if not any(t in p_tech for t in tech_stack): continue
                    patterns.append(p)
                except json.JSONDecodeError: continue

        return patterns

    def get_suggestions(self, tech_stack: list, vuln_classes: list = None) -> dict:
        """Get pattern suggestions based on tech stack."""
        suggestions = {}
        
        for vuln_class in (vuln_classes or ["idor", "ssrf", "xss", "auth_bypass"]):
            patterns = self.get_patterns(vuln_class, tech_stack)
            if patterns:
                suggestions[vuln_class] = [
                    {
                        "technique": p.get("technique"),
                        "endpoint_pattern": p.get("endpoint_pattern"),
                        "target": p.get("target"),
                        "payout": p.get("payout")
                    }
                    for p in patterns[:5]
                ]
        
        return suggestions

    def get_top_techniques(self, vuln_class: str, limit: int = 10) -> list:
        """Get most successful techniques for a vulnerability class."""
        patterns = self.get_patterns(vuln_class)
        
        techniques = {}
        for p in patterns:
            tech = p.get("technique", "unknown")
            payout = p.get("payout", "")
            if tech in techniques:
                techniques[tech]["count"] += 1
                if payout: techniques[tech]["payouts"].append(payout)
            else: techniques[tech] = {"count": 1, "payouts": [payout] if payout else []}
        
        sorted_techs = sorted(
            techniques.items(),
            key=lambda x: x[1]["count"],
            reverse=True
        )
        
        return [
            {
                "technique": t,
                "count": d["count"],
                "avg_payout": sum(int(p.strip("$").replace(",", "")) for p in d["payouts"] if p.strip("$").isdigit()) / max(len(d["payouts"]), 1) if d["payouts"] else 0,
            }
            for t, d in sorted_techs[:limit]
        ]

    def get_stats(self) -> dict:
        """Get pattern database statistics."""
        patterns = self.get_patterns()
        
        by_vuln_class = {}
        by_tech = {}
        
        for p in patterns:
            vc = p.get("vuln_class", "unknown")
            by_vuln_class[vc] = by_vuln_class.get(vc, 0) + 1
            
            for t in p.get("tech_stack", []):
                by_tech[t] = by_tech.get(t, 0) + 1
        
        return {
            "total_patterns": len(patterns),
            "by_vuln_class": by_vuln_class,
            "by_tech_stack": by_tech
        }


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Pattern Database")
    parser.add_argument("--add", action="store_true", help="Add a pattern")
    parser.add_argument("--target", help="Target domain")
    parser.add_argument("--vuln-class", help="Vulnerability class")
    parser.add_argument("--technique", help="Technique used")
    parser.add_argument("--endpoint", help="Endpoint pattern")
    parser.add_argument("--tech", nargs="+", help="Tech stack")
    parser.add_argument("--list", action="store_true", help="List patterns")
    parser.add_argument("--stats", action="store_true", help="Show stats")
    parser.add_argument("--suggest", action="store_true", help="Get suggestions")
    args = parser.parse_args()

    db = PatternDB()

    if args.stats:
        s = db.get_stats()
        print(f"Total patterns: {s['total_patterns']}")
        print("\nBy vuln class:")
        for vc, count in s['by_vuln_class'].items():
            print(f"  {vc}: {count}")
        print("\nBy tech stack:")
        for t, count in s['by_tech_stack'].items():
            print(f"  {t}: {count}")
        return

    if args.suggest and args.tech:
        suggestions = db.get_suggestions(args.tech)
        for vc, patterns in suggestions.items():
            print(f"\n{vc.upper()}:")
            for p in patterns:
                print(f"  - {p['technique']}: {p['endpoint_pattern']} ({p.get('target', 'unknown')})")
        return

    if args.add:
        if not all([args.target, args.vuln_class, args.technique]):
            print("--add requires: --target, --vuln-class, --technique")
            return
        db.add_pattern(
            args.target,
            args.vuln_class,
            args.endpoint or "",
            args.technique,
            args.tech or []
        )
        print("Pattern added")
        return

    print("Use: --stats | --add --target X --vuln-class X --technique X | --suggest --tech ...")


if __name__ == "__main__": main()