"""
Skill registry — implements Anthropic's three-level progressive disclosure.

Level 1: At startup, scan skills/ directory, load ONLY name + description
         from YAML frontmatter. Inject this catalog into system prompts.
Level 2: Agent decides a skill is relevant → reads SKILL.md via read_file tool.
Level 3: SKILL.md references sub-files → Agent reads those on demand too.

The key insight: the AGENT decides when to load skills, not external code.
We just make the catalog visible and the files accessible.

Structure:
  skills/
    frontend-design/
      SKILL.md          ← frontmatter (name, description) + instructions
      reference.md      ← additional detail, referenced from SKILL.md
    another-skill/
      SKILL.md
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger("harness")

SKILLS_DIR = Path(__file__).parent / "skills"


class SkillRegistry:
    """
    Discovers skills at startup (metadata only).
    Provides a catalog string for injection into system prompts.
    Does NOT load or inject skill content — that's the agent's job.
    """

    def __init__(self, skills_dir: Path | str | None = None):
        self.skills_dir = Path(skills_dir) if skills_dir else SKILLS_DIR
        self.catalog: list[dict[str, str]] = []
        self._discover()

    def _discover(self):
        """Scan skills directory, load only metadata (name + description)."""
        if not self.skills_dir.is_dir():
            log.info(f"No skills directory found at {self.skills_dir}")
            return

        for skill_file in sorted(self.skills_dir.rglob("SKILL.md")):
            meta = _parse_frontmatter(skill_file)
            if meta:
                name = meta.get("name", skill_file.parent.name)
                desc = meta.get("description", "")
                rel_path = skill_file.relative_to(Path(__file__).parent)
                self.catalog.append({
                    "name": name,
                    "description": desc,
                    "path": str(rel_path),
                })
                log.info(f"Discovered skill: {name} — {desc[:80]}")

    def build_catalog_prompt(self) -> str:
        """
        Build the catalog string to inject into system prompts.
        This is Level 1 of progressive disclosure — just metadata.
        The agent sees what skills exist and can choose to load them.
        """
        if not self.catalog:
            return ""

        lines = [
            "\n## Available Skills",
            "The following skills are available. If a skill is relevant to your "
            "current task, load it by reading its SKILL.md file with the read_file tool. "
            "Only load skills you actually need — don't load them all.\n",
        ]
        for skill in self.catalog:
            lines.append(
                f"- **{skill['name']}**: {skill['description']}\n"
                f"  Path: `{skill['path']}`"
            )
        return "\n".join(lines) + "\n"


def _parse_frontmatter(path: Path) -> dict | None:
    """Parse YAML frontmatter from a Markdown file."""
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return None
    meta = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta
