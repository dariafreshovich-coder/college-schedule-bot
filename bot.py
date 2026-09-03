from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message
from aiogram.exceptions import TelegramForbiddenError
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from config import Settings, load_settings
from formatting import format_help, format_schedule, groups_keyboard, main_keyboard
from models import ScheduleData
from repository import ScheduleRepository
from storage import UserStorage


logger = logging.getLogger(__name__)


async def _run_refresh(repository: ScheduleRepository) -> ScheduleData | None:
    try:
        data = await asyncio.to_thread(repository.refresh_remote)
        logger.info("Расписание обновлено: %d групп", len(data.groups))
        return data
    except Exception as error:  # the bot should keep serving the last good copy
        repository.last_error = str(error)
        logger.exception("Не удалось обновить файлы из Cloud Mail")
        return repository.get()


def _local_date(timezone: ZoneInfo, offset: int = 0) -> date:
    return (datetime.now(timezone) + timedelta(days=offset)).date()


def register_handlers(
    dispatcher: Dispatcher,
    bot: Bot,
    settings: Settings,
    timezone: ZoneInfo,
    repository: ScheduleRepository,
    storage: UserStorage,
) -> None:
    async def show_groups(target: Message | CallbackQuery, page: int = 0) -> None:
        data = repository.get()
        if data is None or not data.groups:
            text = "Пока не удалось загрузить список групп. Попробуй нажать /refresh чуть позже."
            if isinstance(target, CallbackQuery) and target.message:
                await target.message.edit_text(text)
            else:
                await target.answer(text)
            return
        text = "Выбери свою группу — она сохранится для следующих запусков:"
        if isinstance(target, CallbackQuery) and target.message:
            await target.message.edit_text(text, reply_markup=groups_keyboard(data.groups, page))
        else:
            await target.answer(text, reply_markup=groups_keyboard(data.groups, page))

    async def render_for_user(
        target: Message | CallbackQuery,
        user_id: int,
        offset: int = 0,
        edit: bool = False,
    ) -> None:
        data = repository.get()
        if data is None:
            text = "Не удалось прочитать расписание. Проверь источник или нажми /refresh."
            if isinstance(target, CallbackQuery) and target.message:
                await target.message.edit_text(text)
            else:
                await target.answer(text)
            return

        group = await asyncio.to_thread(storage.get_group, user_id)
        if not group or data.find_group(group) is None:
            await show_groups(target)
            return
        group = data.find_group(group) or group
        target_date = _local_date(timezone, offset)
        enabled = await asyncio.to_thread(storage.notifications_enabled, user_id)
        text = format_schedule(data, group, target_date, timezone)
        keyboard = main_keyboard(enabled)
        if edit and isinstance(target, CallbackQuery) and target.message:
            await target.message.edit_text(text, reply_markup=keyboard)
        else:
            await target.answer(text, reply_markup=keyboard)

    @dispatcher.message(CommandStart())
    async def start(message: Message) -> None:
        user_id = message.from_user.id if message.from_user else message.chat.id
        group = await asyncio.to_thread(storage.get_group, user_id)
        if group and repository.get() and repository.get().find_group(group):
            await render_for_user(message, user_id)
            return
        await message.answer(
            "Привет! Я покажу расписание по группе и учту изменения.\n\n"
            "Сначала выбери свою группу:",
            reply_markup=groups_keyboard(repository.groups()),
        )

    @dispatcher.message(Command("group", "groups"))
    async def choose_group(message: Message) -> None:
        await show_groups(message)

    @dispatcher.message(Command("today"))
    async def today(message: Message) -> None:
        user_id = message.from_user.id if message.from_user else message.chat.id
        await render_for_user(message, user_id, offset=0)

    @dispatcher.message(Command("tomorrow"))
    async def tomorrow(message: Message) -> None:
        user_id = message.from_user.id if message.from_user else message.chat.id
        await render_for_user(message, user_id, offset=1)

    @dispatcher.message(Command("help"))
    async def help_command(message: Message) -> None:
        await message.answer(format_help())

    @dispatcher.message(Command("notify"))
    async def notify_command(message: Message) -> None:
        user_id = message.from_user.id if message.from_user else message.chat.id
        await asyncio.to_thread(storage.toggle_notifications, user_id)
        await render_for_user(message, user_id)

    @dispatcher.message(Command("refresh"))
    async def refresh_command(message: Message) -> None:
        await message.answer("⏳ Обновляю расписание из Cloud Mail…")
        await _run_refresh(repository)
        user_id = message.from_user.id if message.from_user else message.chat.id
        await render_for_user(message, user_id)

    @dispatcher.callback_query(F.data.startswith("groups:"))
    async def group_page(callback: CallbackQuery) -> None:
        await callback.answer()
        if not callback.message:
            return
        try:
            page = int(callback.data.split(":", 1)[1])
        except (ValueError, AttributeError):
            page = 0
        await show_groups(callback, page)

    @dispatcher.callback_query(F.data.startswith("select:"))
    async def select_group(callback: CallbackQuery) -> None:
        await callback.answer("Группа сохранена")
        if not callback.message:
            return
        data = repository.get()
        if data is None:
            await callback.message.edit_text("Данные ещё не загружены. Нажми /refresh.")
            return
        try:
            index = int(callback.data.split(":", 1)[1])
            group = data.groups[index]
        except (ValueError, IndexError, AttributeError):
            await callback.message.edit_text("Не понял выбор. Открой список групп ещё раз: /group")
            return
        await asyncio.to_thread(storage.set_group, callback.from_user.id, group)
        await render_for_user(callback, callback.from_user.id, edit=True)

    @dispatcher.callback_query(F.data.startswith("day:"))
    async def day_button(callback: CallbackQuery) -> None:
        await callback.answer()
        try:
            offset = int(callback.data.split(":", 1)[1])
        except (ValueError, AttributeError):
            offset = 0
        await render_for_user(callback, callback.from_user.id, offset=offset, edit=True)

    @dispatcher.callback_query(F.data == "menu:group")
    async def change_group_button(callback: CallbackQuery) -> None:
        await callback.answer()
        await show_groups(callback)

    @dispatcher.callback_query(F.data == "menu:notify")
    async def notification_button(callback: CallbackQuery) -> None:
        await callback.answer()
        await asyncio.to_thread(storage.toggle_notifications, callback.from_user.id)
        await render_for_user(callback, callback.from_user.id, edit=True)

    @dispatcher.callback_query(F.data == "menu:refresh")
    async def refresh_button(callback: CallbackQuery) -> None:
        await callback.answer("Обновляю…")
        if callback.message:
            await callback.message.edit_text("⏳ Обновляю расписание из Cloud Mail…")
        await _run_refresh(repository)
        await render_for_user(callback, callback.from_user.id, edit=True)

    @dispatcher.callback_query(F.data == "noop")
    async def noop(callback: CallbackQuery) -> None:
        await callback.answer()

    @dispatcher.message()
    async def text_message(message: Message) -> None:
        data = repository.get()
        text = (message.text or "").strip()
        if data and text:
            group = data.find_group(text)
            if group:
                user_id = message.from_user.id if message.from_user else message.chat.id
                await asyncio.to_thread(storage.set_group, user_id, group)
                await render_for_user(message, user_id)
                return
        await message.answer("Выбери действие кнопками ниже или введи /help.")


async def refresh_loop(repository: ScheduleRepository, minutes: int) -> None:
    while True:
        await asyncio.sleep(minutes * 60)
        await _run_refresh(repository)


async def notification_loop(
    bot: Bot,
    settings: Settings,
    timezone: ZoneInfo,
    repository: ScheduleRepository,
    storage: UserStorage,
) -> None:
    while True:
        now = datetime.now(timezone)
        if now.strftime("%H:%M") == settings.notify_time:
            target_date = now.date()
            data = repository.get()
            if data is not None:
                subscribers = await asyncio.to_thread(storage.subscribers, target_date.isoformat())
                for user_id, saved_group in subscribers:
                    group = data.find_group(saved_group)
                    if not group:
                        continue
                    enabled = True
                    text = format_schedule(data, group, target_date, timezone)
                    try:
                        await bot.send_message(user_id, text, reply_markup=main_keyboard(enabled))
                    except TelegramForbiddenError:
                        await asyncio.to_thread(storage.disable_notifications, user_id)
                    except Exception:
                        logger.exception("Не удалось отправить уведомление пользователю %s", user_id)
                    else:
                        await asyncio.to_thread(storage.mark_notification, user_id, target_date.isoformat())
            await asyncio.sleep(65)
        else:
            await asyncio.sleep(20)


async def run_webhook(
    bot: Bot,
    dispatcher: Dispatcher,
    settings: Settings,
) -> None:
    if not settings.webhook_base_url:
        raise RuntimeError(
            "Для BOT_MODE=webhook нужно задать WEBHOOK_BASE_URL, например https://имя-сервиса.onrender.com"
        )

    path = settings.webhook_path
    if not path.startswith("/"):
        path = "/" + path

    async def health(_: web.Request) -> web.Response:
        return web.Response(text="ok")

    application = web.Application()
    application.router.add_get("/", health)
    application.router.add_get("/health", health)
    SimpleRequestHandler(
        dispatcher=dispatcher,
        bot=bot,
        secret_token=settings.webhook_secret or None,
    ).register(application, path=path)
    setup_application(application, dispatcher, bot=bot)

    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", settings.port)
    await site.start()
    webhook_url = f"{settings.webhook_base_url}{path}"
    await bot.set_webhook(webhook_url, secret_token=settings.webhook_secret or None)
    logger.info("Webhook запущен: %s, порт %s", webhook_url, settings.port)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


async def main() -> None:
    settings = load_settings()
    if not settings.bot_token:
        raise RuntimeError("Не задан BOT_TOKEN. Скопируй .env.example в .env и вставь токен от @BotFather.")

    try:
        timezone = ZoneInfo(settings.timezone)
    except Exception as error:
        raise RuntimeError(f"Неизвестный TIMEZONE: {settings.timezone}") from error

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    storage = UserStorage(settings.database_path)
    repository = ScheduleRepository(settings.public_url, settings.cache_dir, settings.fallback_dir)

    if await _run_refresh(repository) is None:
        logger.warning("Cloud Mail недоступен, пробую локальную копию")
        try:
            repository.load_fallback()
        except Exception:
            logger.exception("Локальная копия тоже не читается")
    if repository.get() is None:
        raise RuntimeError("Не найдено рабочее расписание: проверь data/schedule.xlsx")

    bot = Bot(
        settings.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dispatcher = Dispatcher()
    register_handlers(dispatcher, bot, settings, timezone, repository, storage)
    background_tasks = [
        asyncio.create_task(refresh_loop(repository, settings.refresh_minutes)),
        asyncio.create_task(notification_loop(bot, settings, timezone, repository, storage)),
    ]
    try:
        if settings.bot_mode == "webhook":
            await run_webhook(bot, dispatcher, settings)
        else:
            await dispatcher.start_polling(bot)
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
