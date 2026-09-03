# Версия для Cloudflare Workers

Эта папка запускает Telegram-бота как Cloudflare Worker через webhook.

- бот принимает сообщения на Cloudflare;
- выбранная группа хранится в D1;
- `schedule.json` обновляется GitHub Actions из XLSX и DOCX в Cloud Mail;
- Cron Trigger каждые 15 минут проверяет новые изменения и отправляет их пользователям с включёнными уведомлениями в период с 07:00 до 00:00 по Новокузнецку; утренняя рассылка расписания отключена.

## Что нужно сделать один раз

### 1. Загрузить проект на GitHub

Загрузи содержимое всей папки `telegram_schedule_bot` в репозиторий. Для автоматического чтения `schedule.json` через raw-ссылку репозиторий лучше сделать публичным: в нём нет токена Telegram, а расписание уже лежит в открытом Cloud Mail. Токен Telegram в GitHub не добавляй.

После создания репозитория замени в `cloudflare/wrangler.jsonc` строку `SCHEDULE_URL` на адрес:

```text
https://raw.githubusercontent.com/ТВОЙ_GITHUB/ИМЯ_РЕПОЗИТОРИЯ/main/cloudflare/data/schedule.json
```

### 2. Создать Worker и D1

Нужен Node.js 20+ только для первоначальной настройки с компьютера. Сам бот потом работает в Cloudflare, компьютер можно выключить.

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler d1 create college-schedule-bot
```

Команда выведет `database_id`. Вставь его вместо `REPLACE_WITH_D1_DATABASE_ID` в `wrangler.jsonc`.

Создай таблицу пользователей:

```bash
npx wrangler d1 execute college-schedule-bot --remote --file=schema.sql
```

### 3. Добавить секреты

Токен от `@BotFather` вводится прямо в консоль и не попадает в GitHub:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Для `WEBHOOK_SECRET` придумай любую длинную строку, например `my_schedule_webhook_2026`.

### 4. Опубликовать Worker

```bash
npx wrangler deploy
```

В конце появится адрес примерно такого вида:

```text
https://college-schedule-bot.ТВОЙ_ACCOUNT.workers.dev
```

### 5. Подключить Telegram

Подставь свои значения в команду и выполни её в терминале:

```bash
curl -X POST "https://api.telegram.org/botТОКЕН/setWebhook" \
  --data-urlencode "url=https://ТВОЙ_WORKER.workers.dev/telegram" \
  --data-urlencode "secret_token=ТВОЙ_WEBHOOK_SECRET"
```

После этого напиши боту `/start`.

### 6. Включить автоматическое обновление файлов

В GitHub открой **Settings → Actions → General** и разреши Actions записывать в репозиторий, если GitHub попросит это сделать. Workflow `Update schedule data` будет проверять Cloud Mail каждые 30 минут и обновлять `cloudflare/data/schedule.json`.

Проверить вручную можно во вкладке **Actions → Update schedule data → Run workflow**.

## Как работают уведомления

- Пользователь выбирает и сохраняет группу в боте; после выбора бот явно пишет `✅ Группа сохранена`.
- Кнопка `🔔 Включить уведомления` включает уведомления именно для сохранённой группы.
- Worker каждые 15 минут проверяет актуальный файл расписания.
- При новом изменении бот отправляет сообщение только подписанным пользователям соответствующей группы.
- Отправка выполняется с 07:00 до 00:00 по Новокузнецку. Изменения, найденные ночью, ждут ближайшей разрешённой проверки после 07:00.
- Утренняя рассылка полного расписания отключена.

## Важно

- `BOT_TOKEN` хранится только в Cloudflare Secret.
- Бесплатный Cloudflare Worker не держит бесконечный процесс — он всегда доступен на входящем webhook-запросе.
- `keep_vars: true` сохраняет переменные и секреты, добавленные в Cloudflare Dashboard, при следующих деплоях из GitHub.
