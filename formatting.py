from __future__ import annotations

from datetime import date, datetime, tzinfo
from html import escape

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from models import ScheduleData


DAY_NAMES = {
    0: "понедельник",
    1: "вторник",
    2: "среда",
    3: "четверг",
    4: "пятница",
    5: "суббота",
    6: "воскресенье",
}


def _safe(value: str) -> str:
    return escape(value or "", quote=False)


def format_schedule(data: ScheduleData, group: str, target_date: date, timezone: tzinfo) -> str:
    lessons = data.get_lessons(group, target_date)
    title = (
        f"📚 <b>{_safe(group)}</b>\n"
        f"🗓 {target_date:%d.%m.%Y}, {DAY_NAMES[target_date.weekday()]}"
    )
    if not lessons:
        lines = [title, "", "📭 На этот день занятий нет."]
    else:
        lines = [title, ""]
        for pair, lesson in sorted(lessons.items()):
            if lesson.cancelled:
                lines.append(f"<b>{pair}-я пара — отмена</b>")
                if lesson.change_from:
                    lines.append(f"🔄 Было: {_safe(lesson.change_from)}")
                lines.append("")
                continue

            subject = _safe(lesson.subject or "Занятие")
            lines.append(f"<b>{pair}-я пара: {subject}</b>")
            if lesson.teacher:
                lines.append(f"👨‍🏫 {_safe(lesson.teacher)}")
            if lesson.room:
                lines.append(f"📍 {_safe(lesson.room)}")
            if lesson.changed:
                lines.append("🔄 <i>Замена по актуальному уведомлению</i>")
                if lesson.change_from:
                    lines.append(f"Было: {_safe(lesson.change_from)}")
            lines.append("")

    if data.loaded_at is not None:
        loaded = data.loaded_at.astimezone(timezone).strftime("%d.%m.%Y %H:%M")
        lines.append(f"<i>Данные: {data.source_label}, обновлены {loaded}</i>")
    return "\n".join(lines).strip()


def format_help() -> str:
    return (
        "<b>Что умеет бот</b>\n\n"
        "👥 выбрать и сохранить группу\n"
        "📅 показать расписание на сегодня или завтра\n"
        "🔄 учитывать изменения из DOCX\n"
        "🔔 по желанию присылать расписание каждое утро\n\n"
        "Команды: /today, /tomorrow, /group, /notify, /refresh"
    )


def groups_keyboard(groups: list[str], page: int = 0, page_size: int = 10) -> InlineKeyboardMarkup:
    page_count = max(1, (len(groups) + page_size - 1) // page_size)
    page = max(0, min(page, page_count - 1))
    start = page * page_size
    rows: list[list[InlineKeyboardButton]] = []
    for index in range(start, min(start + page_size, len(groups))):
        rows.append([InlineKeyboardButton(text=groups[index], callback_data=f"select:{index}")])

    navigation: list[InlineKeyboardButton] = []
    if page > 0:
        navigation.append(InlineKeyboardButton(text="⬅️", callback_data=f"groups:{page - 1}"))
    navigation.append(InlineKeyboardButton(text=f"{page + 1}/{page_count}", callback_data="noop"))
    if page + 1 < page_count:
        navigation.append(InlineKeyboardButton(text="➡️", callback_data=f"groups:{page + 1}"))
    if navigation:
        rows.append(navigation)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def main_keyboard(notifications: bool) -> InlineKeyboardMarkup:
    notification_text = "🔕 Выключить утренние уведомления" if notifications else "🔔 Включить утренние уведомления"
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="📅 Сегодня", callback_data="day:0"),
                InlineKeyboardButton(text="📆 Завтра", callback_data="day:1"),
            ],
            [InlineKeyboardButton(text="🔁 Обновить данные", callback_data="menu:refresh")],
            [InlineKeyboardButton(text=notification_text, callback_data="menu:notify")],
            [InlineKeyboardButton(text="👥 Сменить группу", callback_data="menu:group")],
        ]
    )
