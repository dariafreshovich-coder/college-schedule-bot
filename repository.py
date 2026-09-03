from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path

from models import ScheduleData
from parser import merge_changes, parse_docx_changes, parse_xlsx
from source import MailCloudSource


class ScheduleRepository:
    def __init__(self, public_url: str, cache_dir: str | Path, fallback_dir: str | Path) -> None:
        self.public_url = public_url
        self.cache_dir = Path(cache_dir)
        self.fallback_dir = Path(fallback_dir)
        self._data: ScheduleData | None = None
        self._lock = threading.RLock()
        self.last_error: str = ""

    @staticmethod
    def _build(schedule_path: Path, change_paths: list[Path], label: str) -> ScheduleData:
        groups, lessons = parse_xlsx(schedule_path)
        changes = {}
        for path in change_paths:
            merge_changes(changes, parse_docx_changes(path))
        return ScheduleData(
            groups=groups,
            lessons=lessons,
            changes=changes,
            loaded_at=datetime.now(timezone.utc),
            source_label=label,
        )

    def refresh_remote(self) -> ScheduleData:
        source_files = MailCloudSource(self.public_url, self.cache_dir).refresh()
        data = self._build(source_files.schedule, source_files.changes, "Cloud Mail")
        with self._lock:
            self._data = data
            self.last_error = ""
        return data

    def load_fallback(self) -> ScheduleData | None:
        schedule_path = self.fallback_dir / "schedule.xlsx"
        if not schedule_path.exists():
            return None
        change_paths = sorted(self.fallback_dir.glob("*.docx"))
        data = self._build(schedule_path, change_paths, "локальная копия")
        with self._lock:
            self._data = data
        return data

    def get(self) -> ScheduleData | None:
        with self._lock:
            return self._data

    def groups(self) -> list[str]:
        data = self.get()
        return data.groups if data else []
