from __future__ import annotations

import time
from typing import Any


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class ProgressTracker:
    def update_task(
        self,
        task_board: dict[str, Any],
        task_id: str,
        *,
        status: str | None = None,
        progress: int | None = None,
        next_steps: list[str] | None = None,
        verify_command: str | None = None,
        latest_summary: str | None = None,
        latest_error: str | None = None,
        blocked_reason: str | None = None,
        assigned_agent_id: str | None = None,
        increment_attempts: bool = False,
    ) -> dict[str, Any]:
        for task in task_board.get("tasks", []):
            if task.get("task_id") != task_id:
                continue
            if status is not None:
                task["status"] = status
            if progress is not None:
                task["progress"] = max(0, min(100, progress))
            if next_steps is not None:
                task["next_steps"] = next_steps
            if verify_command is not None:
                task["verify_command"] = verify_command
            if latest_summary is not None:
                task["latest_summary"] = latest_summary
            if latest_error is not None:
                task["latest_error"] = latest_error
            if blocked_reason is not None:
                task["blocked_reason"] = blocked_reason
            if assigned_agent_id is not None:
                task["assigned_agent_id"] = assigned_agent_id
            if increment_attempts:
                task["attempts"] = int(task.get("attempts", 0) or 0) + 1
            task["updated_at"] = _utc_ts()
            task_board["updated_at"] = _utc_ts()
            return task
        raise KeyError(f"Unknown task: {task_id}")

    def summarize(self, task_board: dict[str, Any]) -> dict[str, Any]:
        tasks = [
            task
            for task in task_board.get("tasks", [])
            if task.get("status") != "superseded"
        ]
        total = len(tasks)
        if total == 0:
            return {"progress": 0, "status_counts": {}}

        status_counts: dict[str, int] = {}
        total_progress = 0
        for task in tasks:
            status = str(task.get("status", "queued"))
            status_counts[status] = status_counts.get(status, 0) + 1
            total_progress += int(task.get("progress", 0) or 0)

        return {
            "progress": round(total_progress / total),
            "status_counts": status_counts,
            "completed": status_counts.get("completed", 0),
            "failed": status_counts.get("failed", 0),
            "blocked": status_counts.get("blocked", 0),
            "total": total,
        }

    def active_task_ids(self, task_board: dict[str, Any]) -> set[str]:
        return {
            task["task_id"]
            for task in task_board.get("tasks", [])
            if task.get("status") == "in_progress"
        }
