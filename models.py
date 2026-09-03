from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime

from utils import normalize_key


WEEKDAY_KEYS = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")


@dataclass(frozen=True)
class Lesson:
    subject: str
    room: str = ""
    teacher: str = ""
    changed: bool = False
    cancelled: bool = False
    change_from: str = ""


@dataclass(frozen=True)
class Change:
    lesson: Lesson | None
    cancelled: bool = False
    old_description: str = ""


@dataclass
class ScheduleData:
    """Parsed weekly schedule plus date-specific replacement entries."""

    groups: list[str]
    lessons: dict[str, dict[str, dict[int, Lesson]]]
    changes: dict[date, dict[str, dict[int, Change]]]
    loaded_at: datetime | None = None
    source_label: str = ""

    def get_lessons(self, group: str, target_date: date) -> dict[int, Lesson]:
        group_key = normalize_key(group)
        weekday = WEEKDAY_KEYS[target_date.weekday()]
        base = self.lessons.get(weekday, {}).get(group_key, {})
        date_changes = self.changes.get(target_date, {}).get(group_key, {})

        result: dict[int, Lesson] = {}
        for pair in sorted(set(base) | set(date_changes)):
            original = base.get(pair)
            change = date_changes.get(pair)
            if change is None:
                if original is not None:
                    result[pair] = original
                continue

            if change.cancelled:
                result[pair] = Lesson(
                    subject="Пара отменена",
                    changed=True,
                    cancelled=True,
                    change_from=change.old_description,
                )
                continue

            if change.lesson is not None:
                # If the replacement document omits the room, retain the
                # original room when it exists.
                room = change.lesson.room or (original.room if original else "")
                result[pair] = replace(
                    change.lesson,
                    room=room,
                    changed=True,
                    change_from=change.old_description,
                )
            elif original is not None:
                result[pair] = original
        return result

    def find_group(self, value: str) -> str | None:
        wanted = normalize_key(value)
        for group in self.groups:
            if normalize_key(group) == wanted:
                return group
        return None
