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

  async scheduled(_controller, env, ctx) {
    // 00:00 UTC is 07:00 in Novokuznetsk.
    ctx.waitUntil(sendMorningNotifications(env));
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
      await sendMessage(env, chatId, "Привет! Сначала выбери свою группу:", groupsKeyboard(data.groups));
    }
    return;
  }

  if (command === "/group" || command === "/groups") {
    await sendMessage(env, chatId, "Выбери свою группу:", groupsKeyboard(data.groups));
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
    await toggleNotifications(env, userId);
    await showSchedule(env, chatId, userId, data, 0);
    return;
  }

  const typedGroup = findGroup(data, text);
  if (typedGroup) {
    await setGroup(env, userId, typedGroup);
    await showSchedule(env, chatId, userId, data, 0);
    return;
  }

  await sendMessage(env, chatId, "Выбери действие кнопками ниже или введи /help.");
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
    await editSchedule(env, chatId, messageId, userId, data, 0);
    return;
  }

  if (callbackData.startsWith("d:")) {
    const offset = Number(callbackData.slice(2)) || 0;
    await editSchedule(env, chatId, messageId, userId, data, offset);
    return;
  }

  if (callbackData === "m:g") {
    await editMessage(env, chatId, messageId, "Выбери свою группу:", groupsKeyboard(data.groups));
    return;
  }

  if (callbackData === "m:n") {
    await toggleNotifications(env, userId);
    await editSchedule(env, chatId, messageId, userId, data, 0);
    return;
  }

  if (callbackData === "m:r") {
    const freshData = await loadSchedule(env, true);
    await editSchedule(env, chatId, messageId, userId, freshData, 0);
  }
}

async function showSchedule(env, chatId, userId, data, offset) {
  const user = await getUser(env, userId);
  const group = findGroup(data, user?.group_name);
  if (!group) {
    await sendMessage(env, chatId, "Сначала выбери группу:", groupsKeyboard(data.groups));
    return;
  }
  const text = formatSchedule(data, group, offset, env.TIMEZONE || "Asia/Novokuznetsk");
  await sendMessage(env, chatId, text, mainKeyboard(Boolean(user?.notifications)));
}

async function editSchedule(env, chatId, messageId, userId, data, offset) {
  const user = await getUser(env, userId);
  const group = findGroup(data, user?.group_name);
  if (!group) {
    await editMessage(env, chatId, messageId, "Сначала выбери группу:", groupsKeyboard(data.groups));
    return;
  }
  const text = formatSchedule(data, group, offset, env.TIMEZONE || "Asia/Novokuznetsk");
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
      "🔔 включить утреннее уведомление\n\n" +
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
  return String(value || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

function findGroup(data, value) {
  const key = normalizeKey(value);
  if (!key) return null;
  return data.groups.find((group) => normalizeKey(group) === key) || null;
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
      if (lesson.cancelled) {
        lines.push(`<b>${pair}-я пара — отмена</b>`);
        if (lesson.change_from) lines.push(`🔄 Было: ${escapeHtml(lesson.change_from)}`);
        lines.push("");
        continue;
      }
      lines.push(`<b>${pair}-я пара: ${escapeHtml(lesson.subject || "Занятие")}</b>`);
      if (lesson.teacher) lines.push(`👨‍🏫 ${escapeHtml(lesson.teacher)}`);
      if (lesson.room) lines.push(`📍 ${escapeHtml(lesson.room)}`);
      if (lesson.changed) {
        lines.push("🔄 <i>Замена по актуальному уведомлению</i>");
        if (lesson.change_from) lines.push(`Было: ${escapeHtml(lesson.change_from)}`);
      }
      lines.push("");
    }
  }

  if (data.generated_at) {
    lines.push(`<i>Данные обновлены: ${escapeHtml(String(data.generated_at).replace("T", " ").replace("Z", " UTC"))}</i>`);
  }
  return lines.join("\n").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function groupsKeyboard(groups, page = 0) {
  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * PAGE_SIZE;
  const rows = [];
  for (let index = start; index < Math.min(start + PAGE_SIZE, groups.length); index += 1) {
    rows.push([{ text: groups[index], callback_data: `g:${index}` }]);
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: "⬅️", callback_data: `p:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pageCount}`, callback_data: "noop" });
  if (safePage + 1 < pageCount) navigation.push({ text: "➡️", callback_data: `p:${safePage + 1}` });
  rows.push(navigation);
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

async function sendMorningNotifications(env) {
  const data = await loadSchedule(env, true);
  const timezone = env.TIMEZONE || "Asia/Novokuznetsk";
  const today = localDate(0, timezone).iso;
  const result = await env.DB.prepare(
    "SELECT telegram_id, group_name FROM users WHERE notifications = 1 AND group_name IS NOT NULL AND (last_notification IS NULL OR last_notification <> ?)",
  )
    .bind(today)
    .all();

  for (const user of result.results || []) {
    const group = findGroup(data, user.group_name);
    if (!group) continue;
    const text = formatSchedule(data, group, 0, timezone);
    const response = await telegram(env, "sendMessage", {
      chat_id: user.telegram_id,
      text,
      parse_mode: "HTML",
      reply_markup: mainKeyboard(true),
    });
    if (response?.ok) {
      await env.DB.prepare("UPDATE users SET last_notification = ? WHERE telegram_id = ?")
        .bind(today, user.telegram_id)
        .run();
    }
  }
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
