#!/usr/bin/env python3
"""
tui.py — Multi-TUI Detection & Command Routing

Detects which TUI is running (Claude Code, OpenCode, OpenClaw) and provides
appropriate model configuration for each.
"""

from __future__ import annotations

import os
import sys
import yaml
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

class TUIType(Enum):
    UNKNOWN = "unknown"
    CLAUDE_CODE = "claude_code"
    OPENCODE = "opencode"
    OPENCLAW = "openclaw"

@dataclass
class TUIInfo:
    type: TUIType
    name: str
    version: str
    has_mcp_support: bool
    default_model: str = "qwen3:8b"
    provider: str = "ollama"
    description: str = ""

    def is_claude_code(self) -> bool:
        return self.type == TUIType.CLAUDE_CODE

    def is_opencode(self) -> bool:
        return self.type == TUIType.OPENCODE

    def is_openclaw(self) -> bool:
        return self.type == TUIType.OPENCLAW

# Models available through TUI (do not require a manual API key).
CLAUDE_CODE_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]

OPENCODE_GO_MODELS = ["glm-5.1", "glm-5", "kimi-k2.5", "mimo-v2-pro", "mimo-v2-omni", "minimax-m2.7", "minimax-m2.5"]

OPENCODE_ZEN_MODELS = [
    "anthropic/claude-3-5-sonnet-20241022",
    "openai/gpt-4o", "openai/gpt-4o-mini",
    "google/gemini-2.0-flash", "google/gemini-1.5-pro",
    "deepseek/deepseek-chat", "deepseek/deepseek-coder",
    "xai/grok-2-latest", "meta/llama-3-70b"
]

OLLAMA_MODELS = ["qwen3:8b", "deepseek-r1:14b", "mistral:7b", "qwen2.5:32b"]

RESERVED_COMMANDS = {"resume", "claude", "think", "search", "read", "inspect", "ls", "grep", "glob", "bash", "task", "write", "edit", "question", "webfetch"}

def detect_tui() -> TUIInfo:
    """
    Detect which TUI is running.
    
    Claude Code: Has its own model management, we just detect it.
    OpenCode: Has built-in auth, we detect it and provide available models.
    """
    env = os.environ

    if _detect_openclaw():
        return TUIInfo(
            TUIType.OPENCLAW, "OpenClaw", 
            env.get("OPENCLAW_VERSION", "unknown"), True,
            "qwen3:8b", "ollama", "OpenClaw (future)"
        )

    if _detect_opencode():
        # OpenCode tiene autenticación integrada
        # Por defecto usamos Go (más económico)
        return TUIInfo(
            TUIType.OPENCODE, "OpenCode",
            env.get("OPENCODE_VERSION", "unknown"), True,
            "minimax-m2.5", "opencode-go", 
            "OpenCode Go ($10/mo) - GLM-5, Kimi K2.5, MiniMax"
        )

    if _detect_claude_code():
        # Claude Code maneja sus propios modelos internamente
        return TUIInfo(
            TUIType.CLAUDE_CODE, "Claude Code",
            env.get("CLAUDE_VERSION", env.get("CLAUDE_DEBIAN_PACKAGE_VERSION", "unknown")), True,
            "claude-sonnet-4-6", "claude",
            "Claude Code (built-in model)"
        )

    # Unknown - default to Ollama
    return TUIInfo(
        TUIType.UNKNOWN, "Unknown TUI", "unknown", False,
        "qwen3:8b", "ollama", "Local Ollama"
    )

def _detect_openclaw() -> bool:
    env = os.environ
    return bool(env.get("OPENCLAW_MODE") or env.get("OPENCLAW_VERSION") or "openclaw" in sys.argv[0].lower())

def _detect_opencode() -> bool:
    env = os.environ
    return bool(env.get("OPENCODE_VERSION") or env.get("OPENCODE_MODE") or "opencode" in sys.argv[0].lower() or env.get("OPENCODED_PROMPT"))

def _detect_claude_code() -> bool:
    env = os.environ
    return bool(env.get("CLAUDE_VERSION") or env.get("CLAUDE_DEBIAN_PACKAGE_VERSION") or "claude" in sys.argv[0].lower() or env.get("CLAUDE_PROJECT"))

def get_command_prefix() -> str:
    return "/"

def is_native_command(command: str) -> bool:
    return command.strip().lstrip("/").lower() in RESERVED_COMMANDS

def get_safe_command_name(command: str) -> str:
    return "continue" if command.lower() == "resume" else command

def route_command(user_input: str) -> tuple[str, dict]:
    user_input = user_input.strip()
    if user_input.startswith("/"):
        cmd = user_input[1:].split(maxsplit=1)[0]
        args = user_input.split(maxsplit=1)[1] if " " in user_input else ""
        return cmd, {"args": args}
    return "", {"raw": user_input}

def get_model_for_command(command_name: str) -> str | None:
    """Get model override for a command from frontmatter."""
    base_dir = Path(__file__).parent
    cmd_file = base_dir / "commands" / f"{command_name}.md"

    if not cmd_file.exists(): return None

    try:
        content = cmd_file.read_text(encoding="utf-8")
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 2:
                data = yaml.safe_load(parts[1].strip())
                if data and "model" in data: return data["model"]
    except Exception: pass
    return None

def get_default_model() -> str:
    """Get default model for current TUI."""
    return detect_tui().default_model

def get_tui_description() -> str:
    """Get description of current TUI including model info."""
    return detect_tui().description

def get_available_models() -> list[str]:
    """Get available models for current TUI."""
    tui = detect_tui()
    if tui.type == TUIType.CLAUDE_CODE: return CLAUDE_CODE_MODELS
    elif tui.type == TUIType.OPENCODE:
        # OpenCode Go by default; users can change this in the app.
        return OPENCODE_GO_MODELS
    return OLLAMA_MODELS

def list_commands() -> list[dict]:
    """List all available commands."""
    base_dir = Path(__file__).parent
    commands_dir = base_dir / "commands"

    if not commands_dir.exists(): return []

    commands = []
    for cmd_file in commands_dir.glob("*.md"):
        name = cmd_file.stem
        try:
            content = cmd_file.read_text(encoding="utf-8")
            description, model = "", None
            if content.startswith("---"):
                parts = content.split("---", 2)
                if len(parts) >= 2:
                    data = yaml.safe_load(parts[1].strip())
                    if data:
                        description = data.get("description", "")
                        model = data.get("model")
            commands.append({"name": name, "description": description, "model": model})
        except Exception: commands.append({"name": name, "description": "", "model": None})

    return sorted(commands, key=lambda x: x["name"])

if __name__ == "__main__":
    tui = detect_tui()
    print(f"TUI: {tui.name}")
    print(f"Type: {tui.type.value}")
    print(f"Version: {tui.version}")
    print(f"MCP Support: {tui.has_mcp_support}")
    print(f"Default Model: {tui.default_model}")
    print(f"Provider: {tui.provider}")
    print(f"Description: {tui.description}")
    print()
    print("Available Models:")
    for m in get_available_models():
        print(f"  - {m}")
    print()
    print("Available Commands:")
    for cmd in list_commands():
        model_note = f" [model: {cmd['model']}]" if cmd['model'] else ""
        print(f"  /{cmd['name']}{model_note}: {cmd['description']}")