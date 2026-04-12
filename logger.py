"""
Rich logging for the harness.
Color-coded agents, emoji markers, structured phase banners.
"""
from __future__ import annotations

import logging
import sys
import time

# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------

class C:
    """ANSI color codes."""
    RESET   = "\033[0m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    # Agent colors
    PLANNER = "\033[38;5;141m"   # purple
    BUILDER = "\033[38;5;39m"    # blue
    EVALUATOR = "\033[38;5;208m" # orange
    CONTRACT = "\033[38;5;249m"  # gray
    SUB     = "\033[38;5;245m"   # dim gray
    # Status colors
    GREEN   = "\033[38;5;78m"
    RED     = "\033[38;5;196m"
    YELLOW  = "\033[38;5;220m"
    CYAN    = "\033[38;5;87m"
    WHITE   = "\033[38;5;255m"


# Agent name → (color, emoji)
AGENT_STYLES = {
    "planner":           (C.PLANNER,   "📋"),
    "builder":           (C.BUILDER,   "🔨"),
    "evaluator":         (C.EVALUATOR, "🔍"),
    "contract_proposer": (C.CONTRACT,  "📝"),
    "contract_reviewer": (C.CONTRACT,  "✅"),
}


def _agent_style(name: str) -> tuple[str, str]:
    """Get color and emoji for an agent name."""
    for key, style in AGENT_STYLES.items():
        if key in name:
            return style
    if name.startswith("sub_"):
        return (C.SUB, "🔧")
    return (C.WHITE, "⚙️")


# ---------------------------------------------------------------------------
# Custom formatter
# ---------------------------------------------------------------------------

class HarnessFormatter(logging.Formatter):
    """
    Formats log messages with:
    - Color-coded agent names
    - Emoji markers for different event types
    - Compact timestamps
    """

    def format(self, record: logging.LogRecord) -> str:
        msg = record.getMessage()
        ts = time.strftime("%H:%M:%S")
        level = record.levelno

        # --- Phase banners ---
        if msg.startswith("=" * 10):
            return f"\n{C.BOLD}{C.CYAN}{msg}{C.RESET}"

        # --- Agent messages: [agent_name] ... ---
        if msg.startswith("["):
            bracket_end = msg.find("]")
            if bracket_end > 0:
                agent_name = msg[1:bracket_end]
                rest = msg[bracket_end + 1:].strip()
                color, emoji = _agent_style(agent_name)

                # Categorize the message
                if rest.startswith("iteration="):
                    # Iteration header — dim
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.DIM}{rest}{C.RESET}"
                elif rest.startswith("tool:"):
                    # Tool call — highlight tool name
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} 🛠️  {C.CYAN}{rest}{C.RESET}"
                elif rest.startswith("assistant:"):
                    # LLM response — show first line
                    text = rest[len("assistant:"):].strip()
                    preview = text[:150].replace("\n", " ")
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} 💬 {preview}{C.DIM}...{C.RESET}"
                elif rest.startswith("Finished"):
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.GREEN}✓ {rest}{C.RESET}"
                elif rest.startswith("Compacting"):
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.YELLOW}📦 {rest}{C.RESET}"
                elif "reset" in rest.lower() or "checkpoint" in rest.lower():
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.RED}🔄 {rest}{C.RESET}"
                elif "anxiety" in rest.lower():
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.RED}😰 {rest}{C.RESET}"
                elif "error" in rest.lower() or "Error" in rest:
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {C.RED}❌ {rest}{C.RESET}"
                else:
                    return f"{C.DIM}{ts}{C.RESET} {emoji} {color}{agent_name}{C.RESET} {rest}"

        # --- Harness-level messages ---
        if "PHASE" in msg or "ROUND" in msg:
            return f"\n{C.BOLD}{C.CYAN}{ts} {msg}{C.RESET}"
        if "PASSED" in msg:
            return f"{C.BOLD}{C.GREEN}{ts} 🎉 {msg}{C.RESET}"
        if "Did not pass" in msg:
            return f"{C.BOLD}{C.RED}{ts} 😞 {msg}{C.RESET}"
        if "HARNESS COMPLETE" in msg:
            return f"\n{C.BOLD}{C.GREEN}{ts} 🏁 {msg}{C.RESET}"
        if "score" in msg.lower():
            return f"{ts} 📊 {C.YELLOW}{msg}{C.RESET}"
        if "contract" in msg.lower():
            return f"{ts} 📝 {msg}"
        if "API OK" in msg:
            return f"{ts} {C.GREEN}✓ {msg}{C.RESET}"
        if "Verifying" in msg:
            return f"{ts} 🔌 {msg}"
        if "Project directory" in msg:
            return f"{ts} 📁 {C.CYAN}{msg}{C.RESET}"
        if "completed in" in msg:
            return f"{ts} ⏱️  {msg}"

        # --- Warnings and errors ---
        if level >= logging.ERROR:
            return f"{C.RED}{ts} ❌ {msg}{C.RESET}"
        if level >= logging.WARNING:
            return f"{C.YELLOW}{ts} ⚠️  {msg}{C.RESET}"

        # --- Default ---
        return f"{C.DIM}{ts}{C.RESET} {msg}"


def setup_logging(verbose: bool = False):
    """Configure logging with the rich formatter."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(HarnessFormatter())

    logger = logging.getLogger("harness")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
