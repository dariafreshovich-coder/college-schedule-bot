from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from parser import merge_changes, parse_docx_changes, parse_xlsx  # noqa: E402
from source import MailCloudSource  # noqa: E402


DEFAULT_URL = "https://cloud.mail.ru/public/LQtu/LPPHQ7i4C"


def export_data(schedule_path: Path, change_paths: list[Path]) -> dict:
    groups, lessons = parse_xlsx(schedule_path)
    changes = {}
    for path in change_paths:
        merge_changes(changes, parse_docx_changes(path))

    lesson_json = {}
    for weekday, weekday_groups in lessons.items():
        lesson_json[weekday] = {}
        for group_key, pairs in weekday_groups.items():
            lesson_json[weekday][group_key] = {
                str(pair): asdict(lesson) for pair, lesson in pairs.items()
            }

    changes_json = {}
    for change_date, date_groups in changes.items():
        changes_json[change_date.isoformat()] = {}
        for group_key, pairs in date_groups.items():
            changes_json[change_date.isoformat()][group_key] = {}
            for pair, change in pairs.items():
                if change.cancelled:
                    changes_json[change_date.isoformat()][group_key][str(pair)] = {
                        "cancelled": True,
                        "old_description": change.old_description,
                    }
                elif change.lesson is not None:
                    changes_json[change_date.isoformat()][group_key][str(pair)] = {
                        "lesson": asdict(change.lesson),
                        "old_description": change.old_description,
                    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "Cloud Mail",
        "groups": groups,
        "lessons": lesson_json,
        "changes": changes_json,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", action="store_true", help="use files in data/ instead of downloading Cloud Mail")
    args = parser.parse_args()

    if args.local:
        schedule_path = PROJECT_ROOT / "data" / "schedule.xlsx"
        change_paths = sorted((PROJECT_ROOT / "data").glob("*.docx"))
        result = export_data(schedule_path, change_paths)
    else:
        url = os.getenv("CLOUD_PUBLIC_URL", DEFAULT_URL)
        with tempfile.TemporaryDirectory() as temporary:
            source_files = MailCloudSource(url, temporary).refresh()
            result = export_data(source_files.schedule, source_files.changes)

    output = PROJECT_ROOT / "cloudflare" / "data" / "schedule.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"written {output} ({len(result['groups'])} groups)")


if __name__ == "__main__":
    main()
