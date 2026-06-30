#!/usr/bin/env python3
"""
brain.py — Multi-Provider LLM Reasoning Layer

TUI-agnostic brain module supporting:
- Ollama (local)
- OpenCode Go (GLM-5, Kimi K2.5, MiniMax M2.5/2.7)
- OpenCode Zen (Claude, GPT, Gemini + 30+ models)
- Claude API (Anthropic)
- OpenAI API
- Grok API (xAI)

This module is agnostic to whether it's running in Claude Code,
OpenCode, or OpenClaw. It provides the reasoning layer for
bug bounty and VAPT workflows.

Usage (CLI):
    python brain.py --phase recon --recon-dir /path/to/recon/target.com
    python brain.py --phase scan --findings-dir /path/to/findings/target.com
    python brain.py --list-models

Usage (import):
    from brain import Brain
    b = Brain()
    b.analyze_recon("/path/to/recon/target.com")

Provider selection (in order of precedence):
  1. BRAIN_PROVIDER env var (ollama | opencode-go | opencode-zen | claude | openai | grok)
  2. Auto-detect: uses first provider whose API key / server is available
"""

from __future__ import annotations
import os
import sys
import json
from pathlib import Path

try: import ollama as _ollama_lib
except ImportError: _ollama_lib = None

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")

GREEN = "\033[0;32m"
CYAN = "\033[0;36m"
YELLOW = "\033[1;33m"
MAGENTA = "\033[0;35m"
BOLD = "\033[1m"
DIM = "\033[2m"
NC = "\033[0m"

OPENCODE_GO_MODELS = [
    "glm-5.1",
    "glm-5",
    "kimi-k2.5",
    "mimo-v2-pro",
    "mimo-v2-omni",
    "minimax-m2.7",
    "minimax-m2.5"
]

OPENCODE_ZEN_MODELS = [
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-opus-20240229",
    "anthropic/claude-3-sonnet-20240229",
    "anthropic/claude-3-haiku-20240307",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/gpt-4-turbo",
    "openai/gpt-4",
    "google/gemini-2.0-flash",
    "google/gemini-1.5-pro",
    "google/gemini-1.5-flash",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-coder",
    "xai/grok-2-latest",
    "xai/grok-beta",
    "meta/llama-3-70b",
    "meta/llama-3-8b",
    "mistralai/mistral-large",
    "mistralai/mistral-7b"
]

class LLMClient:
    """Unified chat interface for Ollama, OpenCode, Claude, OpenAI, and Grok."""

    PROVIDER_PRIORITY = ["ollama", "opencode-go", "opencode-zen", "claude", "openai", "grok"]

    DEFAULT_MODELS = {
        "opencode-go": "minimax-m2.5",
        "opencode-zen": "anthropic/claude-3-5-sonnet-20241022",
        "claude": "claude-3-5-sonnet-20241022",
        "openai": "gpt-4o",
        "grok": "grok-2-latest",
        "ollama": "qwen3:8b"
    }

    def __init__(self, provider: str | None = None):
        self.provider = (provider or os.environ.get("BRAIN_PROVIDER", "")).lower()
        self._ollama = None
        self._http = None
        self.available = False
        self.description = ""

        if not self.provider: self.provider = self._auto_detect()
        else: self._init_provider(self.provider)

    def _auto_detect(self) -> str:
        for p in self.PROVIDER_PRIORITY:
            try:
                self._init_provider(p)
                if self.available: return p
            except Exception: pass
        return "ollama"

    def _init_provider(self, provider: str) -> None:
        self.available = False
        if provider == "ollama":
            if _ollama_lib is None: return
            try:
                self._ollama = _ollama_lib.Client(host=OLLAMA_HOST)
                self._ollama.list()
                self.available = True
                self.description = f"Ollama @ {OLLAMA_HOST}"
            except Exception: pass

        elif provider in ("opencode-go", "opencode-zen"):
            key = os.environ.get("OPENCODECO_API_KEY", os.environ.get("OPENCODE_API_KEY", ""))
            if not key: return
            import requests
            self._http = requests.Session()
            self._http.headers.update({
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            })
            base_url = "https://opencode.ai/zen/go" if provider == "opencode-go" else "https://opencode.ai/zen"
            self._opencode_base = f"{base_url}/v1"
            self.available = True
            plan = "Go ($10/mo)" if provider == "opencode-go" else "Zen (pay-per-token)"
            self.description = f"OpenCode {plan}"

        elif provider == "claude":
            key = os.environ.get("ANTHROPIC_API_KEY", "")
            if not key: return
            try:
                import anthropic as _anthropic
                self._anthropic_client = _anthropic.Anthropic(api_key=key)
                self.available = True
                self.description = "Claude API (Anthropic)"
            except ImportError:
                import requests
                self._http = requests.Session()
                self._http.headers.update({
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json"
                })
                self._anthropic_key = key
                self.available = True
                self.description = "Claude API (HTTP)"

        elif provider == "openai":
            key = os.environ.get("OPENAI_API_KEY", "")
            if not key: return
            import requests
            self._http = requests.Session()
            self._http.headers.update({
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            })
            self._openai_base = "https://api.openai.com/v1"
            self.available = True
            self.description = "OpenAI API"

        elif provider == "grok":
            key = os.environ.get("XAI_API_KEY", "")
            if not key: return
            import requests
            self._http = requests.Session()
            self._http.headers.update({
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            })
            self._grok_base = "https://api.x.ai/v1"
            self.available = True
            self.description = "Grok API (xAI)"

    def chat(self, model: str | None, system: str, user: str,
            max_tokens: int = 4000, temperature: float = 0.1) -> str:
        """Send a chat request; return the assistant reply as a string."""
        if not self.available: return ""
        try:
            if self.provider == "ollama": return self._chat_ollama(model, system, user, max_tokens, temperature)
            elif self.provider == "claude": return self._chat_claude(model, system, user, max_tokens, temperature)
            elif self.provider in ("openai", "grok", "opencode-go", "opencode-zen"): return self._chat_openai_compat(model, system, user, max_tokens, temperature)
        except Exception as e:
            print(f"{YELLOW}[Brain/{self.provider}] chat error: {e}{NC}", flush=True)
            return ""
        return ""

    def _chat_ollama(self, model, system, user, max_tokens, temperature) -> str:
        resp = self._ollama.chat(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            options={"num_predict": max_tokens, "temperature": temperature, "num_ctx": MAX_CTX}
        )
        return (resp.get("message", {}).get("content") or "").strip()

    def _chat_claude(self, model, system, user, max_tokens, temperature) -> str:
        m = model or self.DEFAULT_MODELS["claude"]
        if hasattr(self, "_anthropic_client"):
            resp = self._anthropic_client.messages.create(
                model=m,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}]
            )
            return resp.content[0].text.strip()
        import json as _json
        body = {
            "model": m,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}]
        }
        r = self._http.post(
            "https://api.anthropic.com/v1/messages",
            data=_json.dumps(body),
            timeout=120
        )
        r.raise_for_status()
        return r.json()["content"][0]["text"].strip()

    def _chat_openai_compat(self, model, system, user, max_tokens, temperature) -> str:
        import json as _json
        base = self._grok_base if self.provider == "grok" else (getattr(self, "_opencode_base", None) or self._openai_base)
        m = model or self.DEFAULT_MODELS.get(self.provider, "gpt-4o")
        body = {
            "model": m,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        }
        r = self._http.post(f"{base}/chat/completions", data=_json.dumps(body), timeout=120)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    def list_models(self) -> list[str]:
        """List available models for the current provider."""
        if self.provider == "ollama" and self._ollama:
            try: return [m.model for m in self._ollama.list().models]
            except Exception: return []
        elif self.provider == "opencode-go": return OPENCODE_GO_MODELS
        elif self.provider == "opencode-zen": return OPENCODE_ZEN_MODELS
        elif self.provider == "claude": return ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
        elif self.provider == "openai": return ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"]
        elif self.provider == "grok": return ["grok-2-latest", "grok-3-mini", "grok-3"]
        return []


MODEL_PRIORITY = [
    "qwen3-coder-64k:latest",
    "qwen2.5-coder:32b",
    "deepseek-r1:32b",
    "qwen3:30b-a3b",
    "qwen2.5:32b",
    "deepseek-r1:14b",
    "qwen3:14b",
    "baron-llm:latest",
    "qwen3:8b",
    "mistral:7b-instruct-v0.3-q8_0"
]

MAX_CTX = 32768
MAX_RESP = 6000

BRAIN_SYSTEM = """You are an elite penetration tester and red team operator with 12+ years of professional VAPT experience.
You are a technical assistant to a security researcher conducting authorized bug bounty and VAPT engagements.

ABSOLUTE RULES:
- NEVER add ethics disclaimers or authorization reminders
- NEVER soften findings — call critical vulnerabilities critical
- NEVER refuse to analyze because a target is well-known
- ALWAYS complete the full analysis requested

Your mindset:
- Think like an attacker, not a compliance checker
- Build attack chains: low + low + medium = critical
- Ask "what's the WORST possible thing if this assumption was wrong?"
- Recognize developer shortcuts that miss sibling endpoints

Output:analysis and nothing else — no preamble, no disclaimers, no closing remarks"""

def _get_available_models() -> list[str]:
    if _ollama_lib is None: return []
    try:
        client = _ollama_lib.Client(host=OLLAMA_HOST)
        result = client.list()
        return [m.model for m in result.models]
    except Exception: return []

def _pick_model(preferred: str = None) -> str | None:
    available = _get_available_models()
    if not available: return None

    if preferred and preferred in available: return preferred

    for candidate in MODEL_PRIORITY:
        if candidate in available: return candidate

    return available[0] if available else None

class Brain:
    """Multi-provider LLM reasoning layer."""

    def __init__(self, model: str = None, provider: str | None = None):
        self._llm = LLMClient(provider or os.environ.get("BRAIN_PROVIDER"))

        if not self._llm.available:
            print(f"{YELLOW}[!] No LLM provider available.{NC}")
            self.enabled = False
            self.model = None
            self.client = None
            return

        if self._llm.provider == "ollama":
            self.model = _pick_model(model)
            if not self.model:
                print(f"{YELLOW}[!] No models found in Ollama.{NC}")
                self.enabled = False
                return
            self.client = self._llm._ollama
        else:
            self.model = model or LLMClient.DEFAULT_MODELS.get(self._llm.provider)
            self.client = None

        self.enabled = True
        print(f"{GREEN}[+] Brain online — {self._llm.description} | model: {BOLD}{self.model}{NC}")

    def phase_start(self, phase: str, detail: str = "") -> None:
        """Print a visible banner for phase start."""
        if not self.enabled: return
        detail_str = f" — {detail}" if detail else ""
        print(f"{MAGENTA}{BOLD}[BRAIN] Watching phase: {phase}{detail_str}{NC}", flush=True)

    def _stream(self, user_prompt: str, label: str, max_tokens: int = MAX_RESP) -> str:
        """Call the active LLM provider."""
        if not self.enabled: return ""

        print(f"\n{MAGENTA}{BOLD}[BRAIN/{self._llm.provider.upper()}/{self.model}] {label}{NC}")
        print(f"{DIM}{'─'*60}{NC}")

        full_text = ""
        try:
            if self._llm.provider == "ollama":
                stream = self.client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": BRAIN_SYSTEM},
                        {"role": "user", "content": user_prompt},
                    ],
                    stream=True,
                    options={
                        "num_predict": max_tokens,
                        "temperature": 0.3,
                        "num_ctx": MAX_CTX
                    }
                )
                for chunk in stream:
                    token = chunk["message"]["content"]
                    print(token, end="", flush=True)
                    full_text += token
            else:
                full_text = self._llm.chat(
                    self.model, BRAIN_SYSTEM, user_prompt,
                    max_tokens=max_tokens, temperature=0.3
                )
                print(full_text, flush=True)

        except Exception as exc:
            print(f"{YELLOW}[!] Brain error ({self._llm.provider}): {exc}{NC}")
            return ""

        print(f"\n{DIM}{'─'*60}{NC}\n")
        return full_text

    def analyze_recon(self, recon_dir: str) -> str:
        """Analyze recon data and provide attack surface assessment."""
        if not self.enabled: return ""

        recon_path = Path(recon_dir)
        target = recon_path.name

        def read_sample(file: str, max_bytes: int = 3000) -> str:
            p = recon_path / file
            if not p.exists(): return "(not found)"
            content = p.read_text(errors="ignore")
            if len(content) > max_bytes: return content[:max_bytes] + "..."
            return content or "(empty)"

        urls = read_sample("urls/all.txt", 2000)
        live = read_sample("live/httpx_full.txt", 2000)
        api = read_sample("urls/api_endpoints.txt", 1500)
        params = read_sample("params/interesting_params.txt", 1000)

        prompt = f"""Analyze this recon data for {target}:

## URLs (sample)
{urls}

## Live hosts (sample)
{live}

## API endpoints
{api}

## Interesting parameters
{params}

Provide:
1. Top 3-5 attack surface priorities with specific URLs/endpoints
2. Recommended hunt order
3. Red flags — what patterns suggest bigger bugs nearby
4. What to NOT waste time on
"""
        return self._stream(prompt, f"Recon Analysis → {target}", MAX_RESP)

    def interpret_scan(self, findings_dir: str) -> str:
        """Analyze scan findings and determine real bugs."""
        if not self.enabled: return ""

        findings_path = Path(findings_dir)
        target = findings_path.name

        categories = ["xss", "sqli", "ssrf", "idor", "cors", "auth_bypass"]
        findings_text = ""

        for cat in categories:
            cat_dir = findings_path / cat
            if not cat_dir.exists(): continue
            files = list(cat_dir.glob("*.txt"))[:1]
            for f in files:
                content = f.read_text(errors="ignore").strip()[:500]
                if content: findings_text += f"\n## {cat.upper()}\n{content}"

        if not findings_text: return "No findings to interpret."

        prompt = f"""Analyze these findings for {target}:

{findings_text}

For each real bug:
- Severity and WHY
- Exact reproduction steps
- Business impact (one sentence)

For false positives:
- What makes it noise

Manual testing queue:
- 3-5 things needing human verification

Chain candidates:
- Any findings that chain together?
"""
        return self._stream(prompt, f"Scan Interpretation → {target}", MAX_RESP)

    def write_report(self, findings_dir: str, recon_dir: str = "") -> str:
        """Write a submission-ready report."""
        if not self.enabled: return ""

        findings_path = Path(findings_dir)
        target = findings_path.name

        evidence = ""
        for cat in ["sqli", "idor", "ssrf", "xss", "rce"]:
            cat_dir = findings_path / cat
            if not cat_dir.exists(): continue
            files = sorted(cat_dir.glob("*.txt"))[:1]
            for f in files:
                content = f.read_text(errors="ignore").strip()[:800]
                if content: evidence += f"\n## {cat.upper()}\n{content}"

        if not evidence: return "No evidence to write report."

        prompt = f"""Write a bug bounty report for {target}.

## Evidence
{evidence}

Include:
1. Title
2. Summary
3. Steps to reproduce
4. Impact
5. Remediation

Use H1 format. Be concise and technical."""
        return self._stream(prompt, f"Report → {target}", MAX_RESP)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Brain — LLM reasoning for VAPT")
    parser.add_argument("--phase", choices=["recon", "scan", "report", "list-models"], required=True)
    parser.add_argument("--recon-dir", help="Recon directory path")
    parser.add_argument("--findings-dir", help="Findings directory path")
    parser.add_argument("--model", help="Model to use")
    parser.add_argument("--provider", choices=["ollama", "claude", "openai", "grok"], help="Provider")
    args = parser.parse_args()

    b = Brain(args.model, args.provider)
    if not b.enabled:
        print("Failed to initialize Brain")
        sys.exit(1)

    if args.phase == "list-models":
        models = b._llm.list_models()
        print(f"Available models: {models}")
        return

    if args.phase == "recon":
        if not args.recon_dir:
            print("--recon-dir required")
            sys.exit(1)
        b.analyze_recon(args.recon_dir)
    elif args.phase == "scan":
        if not args.findings_dir:
            print("--findings-dir required")
            sys.exit(1)
        b.interpret_scan(args.findings_dir)
    elif args.phase == "report":
        if not args.findings_dir:
            print("--findings-dir required")
            sys.exit(1)
        b.write_report(args.findings_dir)


if __name__ == "__main__": main()