import initialSchedule from "../data/schedule.json";

const DAY_KEYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DAY_NAMES = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];
const PAGE_SIZE = 10;
const SEARCH_RESULT_LIMIT = 20;
const BELL_SCHEDULES = {
  regular: {
    1: "08:30–10:00",
    2: "10:40–12:10",
    3: "12:25–13:55",
    4: "14:25–15:55",
    5: "16:05–17:35",
  },
  monday: {
    1: "08:30–09:40",
    2: "11:00–12:10",
    3: "12:25–13:35",
    4: "14:05–15:15",
    5: "16:05–17:15",
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && ["/", "/health"].includes(url.pathname)) {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (env.WEBHOOK_SECRET) {
        const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (received !== env.WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }

      // Telegram gets a quick 200; the actual reply continues in the background.
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (controller.cron === "*/15 * * * *") {
      ctx.waitUntil(checkForScheduleChanges(env));
    }
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
      return;
    }
    if (update.message) {
      await handleMessage(update.message, env);
    }
  } catch (error) {
    console.error("update error", error);
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId) {
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "Не смог обработать запрос. Попробуй ещё раз через несколько секунд.",
      });
    }
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id ?? chatId;
  const text = (message.text || "").trim();
  const command = text.split(/\s+/, 1)[0].split("@")[0].toLowerCase();

  if (command === "/help") {
    await sendHelp(env, chatId);
    return;
  }

  const forceRefresh = command === "/refresh";
  const data = await loadSchedule(env, forceRefresh);

  if (command === "/start") {
    const user = await getUser(env, userId);
    const group = findGroup(data, user?.group_name);
    if (group) {
      await showSchedule(env, chatId, userId, data, 0);
    } else {
      await sendMessage(env, chatId, "Привет! Напиши часть названия группы или выбери её из списка:", groupsKeyboard(data.groups));
    }
    return;
  }

  if (command === "/group" || command === "/groups") {
    await sendMessage(
      env,
      chatId,
      "Напиши часть названия группы, например <b>ПКД1-25</b>, или выбери группу из списка:",
      groupsKeyboard(data.groups),
    );
    return;
  }

  if (command === "/today" || command === "/refresh") {
    await showSchedule(env, chatId, userId, data, 0);
    return;
  }

  if (command === "/tomorrow") {
    await showSchedule(env, chatId, userId, data, 1);
    return;
  }

  if (command === "/notify") {
    const enabled = await toggleNotifications(env, userId);
    const notice = enabled
      ? "🔔 <b>Уведомления включены.</b>\nБуду присылать новые изменения по этой группе с 07:00 до 00:00."
      : "🔕 <b>Уведомления выключены.</b>";
    await showSchedule(env, chatId, userId, data, 0, notice);
    return;
  }

  const typedGroup = findGroup(data, text);
  if (typedGroup) {
    await setGroup(env, userId, typedGroup);
    const notice = `✅ <b>Группа сохранена: ${escapeHtml(typedGroup)}</b>`;
    await showSchedule(env, chatId, userId, data, 0, notice);
    return;
  }

  const matches = findGroups(data, text);
  if (matches.length) {
    const message = matches.length === 1
      ? `Нашла группу: <b>${escapeHtml(matches[0].group)}</b>. Нажми на неё, чтобы сохранить выбор.`
      : `Нашла подходящие группы: <b>${matches.length}</b>. ${matches.length > SEARCH_RESULT_LIMIT ? `Показываю первые ${SEARCH_RESULT_LIMIT}, уточни запрос. ` : ""}Выбери нужную:`;
    await sendMessage(env, chatId, message, searchGroupsKeyboard(data.groups, matches));
    return;
  }

  await sendMessage(env, chatId, "Не нашла такую группу. Напиши часть названия или введи /group.");
}

async function handleCallback(callback, env) {
  const callbackId = callback.id;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const userId = callback.from?.id;
  if (!chatId || !messageId || !userId) {
    await answerCallback(env, callbackId);
    return;
  }

  const data = await loadSchedule(env, false);
  const callbackData = callback.data || "";
  await answerCallback(env, callbackId);

  if (callbackData === "noop") return;

  if (callbackData.startsWith("p:")) {
    const page = Number(callbackData.slice(2)) || 0;
    await editMessage(env, chatId, messageId, "Выбери свою группу:", groupsKeyboard(data.groups, page));
    return;
  }

  if (callbackData.startsWith("g:")) {
    const index = Number(callbackData.slice(2));
    const group = data.groups[index];
    if (!group) {
      await editMessage(env, chatId, messageId, "Группа не найдена. Открой список заново: /group");
      return;
    }
    await setGroup(env, userId, group);
    const notice = `✅ <b>Группа сохранена: ${escapeHtml(group)}</b>`;
    await editSchedule(env, chatId, messageId, userId, data, 0, notice);
    return;
  }

  if (callbackData.startsWith("d:")) {
    const offset = Number(callbackData.slice(2)) || 0;
    await editSchedule(env, chatId, messageId, userId, data, offset);
    return;
  }

  if (callbackData === "m:g") {
    await editMessage(env, chatId, messageId, "Напиши часть названия группы или выбери её из списка:", groupsKeyboard(data.groups));
    return;
  }

  if (callbackData === "m:n") {
    const enabled = await toggleNotifications(env, userId);
    const notice = enabled
      ? "🔔 <b>Уведомления включены.</b>\nБуду присылать новые изменения по этой группе с 07:00 до 00:00."
      : "🔕 <b>Уведомления выключены.</b>";
    await editSchedule(env, chatId, messageId, userId, data, 0, notice);
    return;
  }

  if (callbackData === "m:r") {
    const freshData = await loadSchedule(env, true);
    await editSchedule(env, chatId, messageId, userId, freshData, 0);
  }
}

async function showSchedule(env, chatId, userId, data, offset, notice = "") {
  const user = await getUser(env, userId);
  const group = findGroup(data, user?.group_name);
  if (!group) {
    await sendMessage(env, chatId, "Сначала выбери группу:", groupsKeyboard(data.groups));
    return;
  }
  const scheduleText = formatSchedule(data, group, offset, env.TIMEZONE || "Asia/Novokuznetsk");
  const text = notice ? `${notice}\n\n${scheduleText}` : scheduleText;
  await sendMessage(env, chatId, text, mainKeyboard(Boolean(user?.notifications)));
}

async function editSchedule(env, chatId, messageId, userId, data, offset, notice = "") {
  const user = await getUser(env, userId);
  const group = findGroup(data, user?.group_name);
  if (!group) {
    await editMessage(env, chatId, messageId, "Сначала выбери группу:", groupsKeyboard(data.groups));
    return;
  }
  const scheduleText = formatSchedule(data, group, offset, env.TIMEZONE || "Asia/Novokuznetsk");
  const text = notice ? `${notice}\n\n${scheduleText}` : scheduleText;
  await editMessage(env, chatId, messageId, text, mainKeyboard(Boolean(user?.notifications)));
}

async function sendHelp(env, chatId) {
  await sendMessage(
    env,
    chatId,
    "<b>Бот расписания</b>\n\n" +
      "👥 выбрать и сохранить группу\n" +
      "📅 смотреть сегодня или завтра\n" +
      "🔄 учитывать изменения и отмены\n" +
      "🔔 получать уведомления о новых изменениях с 07:00 до 00:00\n\n" +
      "Команды: /today, /tomorrow, /group, /notify, /refresh",
  );
}

async function loadSchedule(env, forceRefresh) {
  const scheduleUrl = env.SCHEDULE_URL;
  if (scheduleUrl && !scheduleUrl.includes("REPLACE_USERNAME")) {
    try {
      const response = await fetch(scheduleUrl, forceRefresh ? { cache: "no-store" } : { cf: { cacheTtl: 300 } });
      if (response.ok) {
        const value = await response.json();
        if (value && Array.isArray(value.groups) && value.lessons) return value;
      }
    } catch (error) {
      console.error("schedule fetch error", error);
    }
  }
  return initialSchedule;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ");
}

function searchKey(value) {
  return normalizeKey(value).replace(/[^a-zа-я0-9]/g, "");
}

function findGroup(data, value) {
  const key = normalizeKey(value);
  if (!key) return null;
  return data.groups.find((group) => normalizeKey(group) === key) || null;
}

function findGroups(data, value) {
  const key = searchKey(value);
  if (!key) return [];
  return data.groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => searchKey(group).includes(key));
}

function localDate(offset, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const current = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offset));
  const year = current.getUTCFullYear();
  const month = String(current.getUTCMonth() + 1).padStart(2, "0");
  const day = String(current.getUTCDate()).padStart(2, "0");
  return {
    iso: `${year}-${month}-${day}`,
    display: `${day}.${month}.${year}`,
    weekday: current.getUTCDay(),
  };
}

function getLessons(data, group, offset, timezone) {
  const selected = localDate(offset, timezone);
  const weekday = DAY_KEYS[selected.weekday];
  const groupKey = normalizeKey(group);
  const base = data.lessons?.[weekday]?.[groupKey] || {};
  const changes = data.changes?.[selected.iso]?.[groupKey] || {};
  const pairs = [...new Set([...Object.keys(base), ...Object.keys(changes)])]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const result = {};

  for (const pair of pairs) {
    const original = base[String(pair)];
    const change = changes[String(pair)];
    if (!change) {
      if (original) result[pair] = original;
      continue;
    }
    if (change.cancelled) {
      result[pair] = {
        subject: "Пара отменена",
        cancelled: true,
        changed: true,
        change_from: change.old_description || "",
      };
      continue;
    }
    if (change.lesson) {
      result[pair] = {
        ...change.lesson,
        room: change.lesson.room || original?.room || "",
        changed: true,
        change_from: change.old_description || "",
      };
    }
  }
  return { lessons: result, selected };
}

function formatSchedule(data, group, offset, timezone) {
  const { lessons, selected } = getLessons(data, group, offset, timezone);
  const bellTimes = bellTimesForWeekday(selected.weekday);
  const lines = [
    `📚 <b>${escapeHtml(group)}</b>`,
    `🗓 ${selected.display}, ${DAY_NAMES[selected.weekday]}`,
    "",
  ];
  const pairs = Object.keys(lessons).map(Number).sort((a, b) => a - b);

  if (!pairs.length) {
    lines.push("📭 На этот день занятий нет.");
  } else {
    for (const pair of pairs) {
      const lesson = lessons[pair];
      const time = bellTimes[pair] ? ` · ${bellTimes[pair]}` : "";
      if (lesson.cancelled) {
        lines.push(`<b>${pair}-я пара${time} — отмена</b>`);
        if (lesson.change_from) lines.push(`Было: <s>${escapeHtml(lesson.change_from)}</s>`);
        if (data.generated_at) lines.push(`🕒 Замена загружена: ${escapeHtml(formatGeneratedAt(data.generated_at, timezone))}`);
        lines.push("");
        continue;
      }

      if (lesson.changed) {
        lines.push(`<b>${pair}-я пара${time}</b>`);
        if (lesson.change_from) lines.push(`Было: <s>${escapeHtml(lesson.change_from)}</s>`);
        lines.push(`Стало: ${formatLessonTitle(lesson)}`);
        if (lesson.room) lines.push(`📍 ${escapeHtml(lesson.room)}`);
        if (data.generated_at) lines.push(`🕒 Замена загружена: ${escapeHtml(formatGeneratedAt(data.generated_at, timezone))}`);
      } else {
        lines.push(`<b>${pair}-я пара${time}: ${escapeHtml(lesson.subject || "Занятие")}</b>`);
        if (lesson.teacher) lines.push(`👨‍🏫 ${escapeHtml(lesson.teacher)}`);
        if (lesson.room) lines.push(`📍 ${escapeHtml(lesson.room)}`);
      }
      lines.push("");
    }
  }

  if (data.generated_at) {
    lines.push("");
    lines.push(`<i>🕒 Файл расписания обновлён: ${escapeHtml(formatGeneratedAt(data.generated_at, timezone))}.</i>`);
    lines.push("<i>🔎 Новые изменения проверяются каждые 15 минут.</i>");
  }
  return lines.join("\n").trim();
}

function bellTimesForWeekday(weekday) {
  return weekday === 1 ? BELL_SCHEDULES.monday : BELL_SCHEDULES.regular;
}

function weekdayFromIso(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatLessonTitle(lesson) {
  const subject = escapeHtml(lesson.subject || "Занятие");
  return lesson.teacher ? `${subject} (${escapeHtml(lesson.teacher)})` : subject;
}

function formatGeneratedAt(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date) + " по Новокузнецку";
}

function formatDateOnly(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return String(value);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function groupsKeyboard(groups, page = 0) {
  return groupsKeyboardForIndices(groups, groups.map((_, index) => index), page);
}

function groupsKeyboardForIndices(groups, indices, page = 0) {
  const pageCount = Math.max(1, Math.ceil(indices.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * PAGE_SIZE;
  const rows = [];
  for (let position = start; position < Math.min(start + PAGE_SIZE, indices.length); position += 1) {
    const originalIndex = indices[position];
    rows.push([{ text: groups[originalIndex], callback_data: `g:${originalIndex}` }]);
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: "⬅️", callback_data: `p:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pageCount}`, callback_data: "noop" });
  if (safePage + 1 < pageCount) navigation.push({ text: "➡️", callback_data: `p:${safePage + 1}` });
  rows.push(navigation);
  return { inline_keyboard: rows };
}

function searchGroupsKeyboard(groups, matches) {
  const rows = matches.slice(0, SEARCH_RESULT_LIMIT).map(({ group, index }) => [
    { text: group, callback_data: `g:${index}` },
  ]);
  return { inline_keyboard: rows };
}

function mainKeyboard(notifications) {
  return {
    inline_keyboard: [
      [
        { text: "📅 Сегодня", callback_data: "d:0" },
        { text: "📆 Завтра", callback_data: "d:1" },
      ],
      [{ text: "🔁 Обновить данные", callback_data: "m:r" }],
      [{ text: notifications ? "🔕 Выключить уведомления" : "🔔 Включить уведомления", callback_data: "m:n" }],
      [{ text: "👥 Сменить группу", callback_data: "m:g" }],
    ],
  };
}

async function getUser(env, userId) {
  return env.DB.prepare("SELECT telegram_id, group_name, notifications, last_notification FROM users WHERE telegram_id = ?")
    .bind(String(userId))
    .first();
}

async function setGroup(env, userId, group) {
  await env.DB.prepare(
    "INSERT INTO users(telegram_id, group_name, notifications) VALUES (?, ?, 0) ON CONFLICT(telegram_id) DO UPDATE SET group_name = excluded.group_name",
  )
    .bind(String(userId), group)
    .run();
}

async function toggleNotifications(env, userId) {
  const current = await getUser(env, userId);
  const next = current?.notifications ? 0 : 1;
  await env.DB.prepare(
    "INSERT INTO users(telegram_id, group_name, notifications) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET notifications = excluded.notifications",
  )
    .bind(String(userId), current?.group_name || null, next)
    .run();
  return Boolean(next);
}

async function ensureChangeTables(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS schedule_change_notifications (
        change_key TEXT PRIMARY KEY,
        change_date TEXT NOT NULL,
        group_name TEXT NOT NULL,
        pair TEXT NOT NULL,
        payload TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        sent_at TEXT
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS schedule_notification_state (
        id INTEGER PRIMARY KEY,
        initialized INTEGER NOT NULL DEFAULT 0
      )
    `),
  ]);
}

function flattenChanges(data) {
  const changes = [];
  for (const [date, groups] of Object.entries(data.changes || {})) {
    for (const [groupName, pairs] of Object.entries(groups || {})) {
      for (const [pair, change] of Object.entries(pairs || {})) {
        const payload = JSON.stringify(change);
        changes.push({
          key: `${date}|${groupName}|${pair}|${payload}`,
          date,
          groupName,
          pair,
          payload,
        });
      }
    }
  }
  return changes;
}

async function checkForScheduleChanges(env) {
  await ensureChangeTables(env);
  const data = await loadSchedule(env, true);
  const now = new Date();
  const detectedAt = now.toISOString();
  const changes = flattenChanges(data);
  const state = await env.DB.prepare("SELECT initialized FROM schedule_notification_state WHERE id = 1").first();

  if (!state) {
    await env.DB.prepare("INSERT INTO schedule_notification_state(id, initialized) VALUES (1, 0)").run();
  }

  if (!state || !state.initialized) {
    if (changes.length) {
      await env.DB.batch(changes.map((change) => env.DB.prepare(
        "INSERT OR IGNORE INTO schedule_change_notifications(change_key, change_date, group_name, pair, payload, detected_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(change.key, change.date, change.groupName, change.pair, change.payload, detectedAt, detectedAt)));
    }
    await env.DB.prepare("UPDATE schedule_notification_state SET initialized = 1 WHERE id = 1").run();
    return;
  }

  if (changes.length) {
    await env.DB.batch(changes.map((change) => env.DB.prepare(
      "INSERT OR IGNORE INTO schedule_change_notifications(change_key, change_date, group_name, pair, payload, detected_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(change.key, change.date, change.groupName, change.pair, change.payload, detectedAt)));
  }

  const timezone = env.TIMEZONE || "Asia/Novokuznetsk";
  if (!isNotificationWindow(timezone)) return;

  const pending = await env.DB.prepare(
    "SELECT change_key, change_date, group_name, pair, payload FROM schedule_change_notifications WHERE sent_at IS NULL ORDER BY change_date, group_name, CAST(pair AS INTEGER)",
  ).all();
  if (!pending.results?.length) return;

  const users = await env.DB.prepare(
    "SELECT telegram_id, group_name FROM users WHERE notifications = 1 AND group_name IS NOT NULL",
  ).all();
  if (!users.results?.length) return;

  const pendingByGroup = new Map();
  for (const change of pending.results) {
    const key = normalizeKey(change.group_name);
    if (!pendingByGroup.has(key)) pendingByGroup.set(key, []);
    pendingByGroup.get(key).push(change);
  }

  const sentKeys = new Set();
  for (const [groupKey, groupChanges] of pendingByGroup) {
    const groupUsers = users.results.filter((user) => normalizeKey(user.group_name) === groupKey);
    if (!groupUsers.length) continue;

    const groupName = groupUsers[0].group_name;
    const text = formatChangeNotification(groupName, groupChanges, timezone);
    let delivered = false;
    for (const user of groupUsers) {
      const result = await sendMessage(env, user.telegram_id, text, mainKeyboard(true));
      if (result?.ok) delivered = true;
    }
    if (delivered) {
      for (const change of groupChanges) sentKeys.add(change.change_key);
    }
  }

  if (sentKeys.size) {
    await env.DB.batch([...sentKeys].map((key) => env.DB.prepare(
      "UPDATE schedule_change_notifications SET sent_at = ? WHERE change_key = ?",
    ).bind(detectedAt, key)));
  }
}

function isNotificationWindow(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return hour >= 7 && hour < 24;
}

function formatChangeNotification(groupName, changes, timezone) {
  const lines = [
    "⚠️ <b>Изменения в расписании</b>",
    `📚 <b>${escapeHtml(groupName)}</b>`,
    "",
  ];

  for (const change of changes) {
    let payload;
    try {
      payload = JSON.parse(change.payload);
    } catch {
      payload = {};
    }
    const lesson = payload.lesson || {};
    const weekday = weekdayFromIso(change.change_date);
    const bellTimes = weekday === null ? {} : bellTimesForWeekday(weekday);
    const time = bellTimes[change.pair] ? ` · ${bellTimes[change.pair]}` : "";
    lines.push(`<b>🗓 ${escapeHtml(formatDateOnly(change.change_date))}, ${escapeHtml(change.pair)}-я пара${time}</b>`);
    if (payload.old_description) lines.push(`Было: <s>${escapeHtml(payload.old_description)}</s>`);
    if (payload.cancelled || lesson.cancelled) {
      lines.push("❌ Пара отменена");
    } else {
      lines.push(`Стало: ${formatLessonTitle(lesson)}`);
      if (lesson.room) lines.push(`📍 ${escapeHtml(lesson.room)}`);
    }
    if (change.detected_at) lines.push(`🕒 Обнаружено ботом: ${escapeHtml(formatGeneratedAt(change.detected_at, timezone))}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function telegram(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const result = await response.json();
    if (!result.ok) console.error("Telegram API error", method, result);
    return result;
  } catch {
    console.error("Telegram returned a non-JSON response", method, response.status);
    return { ok: false };
  }
}

async function sendMessage(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, "sendMessage", payload);
}

async function editMessage(env, chatId, messageId, text, replyMarkup) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, "editMessageText", payload);
}

async function answerCallback(env, callbackId, text) {
  const payload = { callback_query_id: callbackId };
  if (text) payload.text = text;
  return telegram(env, "answerCallbackQuery", payload);
}
