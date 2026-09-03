from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    bot_token: str
    public_url: str
    timezone: str
    refresh_minutes: int
    notify_time: str
    bot_mode: str
    webhook_base_url: str
    webhook_path: str
    webhook_secret: str
    port: int
    cache_dir: Path
    fallback_dir: Path
    database_path: Path


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
        return value if value > 0 else default
    except ValueError:
        return default


def load_settings() -> Settings:
    return Settings(
        bot_token=os.getenv("BOT_TOKEN", "").strip(),
        public_url=os.getenv(
            "CLOUD_PUBLIC_URL",
            "https://cloud.mail.ru/public/LQtu/LPPHQ7i4C",
        ).strip(),
        timezone=os.getenv("TIMEZONE", "Asia/Novokuznetsk").strip(),
        refresh_minutes=_positive_int("REFRESH_MINUTES", 30),
        notify_time=os.getenv("NOTIFY_TIME", "07:00").strip(),
        bot_mode=os.getenv("BOT_MODE", "polling").strip().casefold(),
        webhook_base_url=(
            os.getenv("WEBHOOK_BASE_URL", "").strip().rstrip("/")
            or os.getenv("RENDER_EXTERNAL_URL", "").strip().rstrip("/")
        ),
        webhook_path=os.getenv("WEBHOOK_PATH", "/telegram").strip() or "/telegram",
        webhook_secret=os.getenv("WEBHOOK_SECRET", "").strip(),
        port=_positive_int("PORT", 8080),
        cache_dir=Path(os.getenv("CACHE_DIR", str(ROOT / "runtime"))),
        fallback_dir=Path(os.getenv("FALLBACK_DIR", str(ROOT / "data"))),
        database_path=Path(os.getenv("DATABASE_PATH", str(ROOT / "runtime" / "users.sqlite3"))),
    )
