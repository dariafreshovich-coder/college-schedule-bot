from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests


@dataclass(frozen=True)
class SourceFiles:
    schedule: Path
    changes: list[Path]


class MailCloudSource:
    """Download the current XLSX and DOCX files from a public Mail Cloud folder."""

    def __init__(self, public_url: str, cache_dir: str | Path, timeout: int = 45) -> None:
        self.public_url = public_url
        self.cache_dir = Path(cache_dir)
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "telegram-schedule-bot/1.0"})

    def _share_id(self) -> str:
        path = unquote(urlparse(self.public_url).path)
        marker = "/public/"
        if marker not in path:
            raise ValueError("Ссылка Cloud Mail должна иметь вид https://cloud.mail.ru/public/...")
        share_id = path.split(marker, 1)[1].strip("/")
        if not share_id:
            raise ValueError("Не найден идентификатор публичной папки Cloud Mail")
        return share_id

    def _download_base(self, html: str) -> str:
        # This endpoint is embedded in the public page. Mail Cloud changes its
        # host from time to time, so it is intentionally extracted dynamically.
        html = html.replace("\\/", "/")
        patterns = (
            r'"weblink_get"\s*:\s*(?:\[\s*)?\{[^{}]*?"url"\s*:\s*"([^"]+)"',
            r'"weblink_get"\s*:\s*\[\s*\{[^{}]*?"url"\s*:\s*"([^"]+)"',
        )
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                return match.group(1)
        raise RuntimeError("Cloud Mail не отдал ссылку на скачивание")

    def _list_files(self, share_id: str) -> list[dict]:
        response = self.session.get(
            "https://cloud.mail.ru/api/v2/folder",
            params={"weblink": share_id, "offset": 0, "limit": 500, "api": 2},
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        files = payload.get("body", {}).get("list", [])
        return [item for item in files if item.get("kind") == "file" and item.get("weblink")]

    @staticmethod
    def _newest(items: list[dict]) -> dict:
        return max(items, key=lambda item: (int(item.get("mtime", 0)), item.get("name", "")))

    def _download_item(self, base_url: str, item: dict, target: Path) -> None:
        item_url = f"{base_url.rstrip('/')}/{quote(item['weblink'], safe='/')}"
        response = self.session.get(item_url, allow_redirects=True, timeout=self.timeout)
        response.raise_for_status()
        if not response.content:
            raise RuntimeError(f"Пустой файл: {item.get('name', '')}")
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_bytes(response.content)
        temporary.replace(target)

    def refresh(self) -> SourceFiles:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        share_id = self._share_id()
        page = self.session.get(self.public_url, timeout=self.timeout)
        page.raise_for_status()
        base_url = self._download_base(page.text)
        files = self._list_files(share_id)

        xlsx_files = [item for item in files if str(item.get("name", "")).casefold().endswith(".xlsx")]
        if not xlsx_files:
            raise RuntimeError("В папке Cloud Mail не найден файл XLSX с расписанием")
        named_changes = [
            item
            for item in files
            if str(item.get("name", "")).casefold().endswith(".docx")
            and any(word in str(item.get("name", "")).casefold() for word in ("замен", "измен"))
        ]
        change_files = named_changes or [
            item for item in files if str(item.get("name", "")).casefold().endswith(".docx")
        ]

        schedule_path = self.cache_dir / "schedule.xlsx"
        self._download_item(base_url, self._newest(xlsx_files), schedule_path)

        for old_file in self.cache_dir.glob("change_*.docx"):
            old_file.unlink(missing_ok=True)
        downloaded_changes: list[Path] = []
        for index, item in enumerate(sorted(change_files, key=lambda value: int(value.get("mtime", 0))), start=1):
            target = self.cache_dir / f"change_{index:03d}.docx"
            self._download_item(base_url, item, target)
            downloaded_changes.append(target)

        (self.cache_dir / "source.json").write_text(
            json.dumps(
                {
                    "public_url": self.public_url,
                    "schedule": self._newest(xlsx_files).get("name"),
                    "changes": [item.get("name") for item in change_files],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return SourceFiles(schedule=schedule_path, changes=downloaded_changes)
