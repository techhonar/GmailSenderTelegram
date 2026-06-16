// ─────────────────────────────────────────────
//  CONFIGURATION — fill these in
// ─────────────────────────────────────────────
const TELEGRAM_TOKEN = "your_bot_token";

const ALLOWED_CHAT_IDS = [
  "111111111",   // you
  "222222222",   // person 2
  "333333333",   // person 3
];

// Emails from these senders will be skipped entirely
const IGNORED_SENDERS = [
  "noreply-apps-scripts-notifications@google.com",
];

// Safety cap: max emails processed in a single run (protects against spam floods)
const MAX_EMAILS_PER_RUN = 20;
// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
//  MAIN EMAIL CHECKER
// ─────────────────────────────────────────────
function checkAndForwardEmails() {
  const props = PropertiesService.getScriptProperties();

  // If bot is paused, do nothing
  if (props.getProperty("paused") === "true") {
    console.log("Bot is paused. Skipping check.");
    return;
  }

  // Load already-sent email IDs
  const sentIdsRaw = props.getProperty("sentIds");
  const sentIds = sentIdsRaw ? JSON.parse(sentIdsRaw) : [];
  const sentIdsSet = new Set(sentIds);

  // Load last emails log (for /last command)
  const lastEmailsRaw = props.getProperty("lastEmails");
  const lastEmails = lastEmailsRaw ? JSON.parse(lastEmailsRaw) : [];

  // Search only the last ~10 minutes of inbox emails (cheaper than scanning the whole day)
  const threads = GmailApp.search("in:inbox newer_than:10m");

  let sent = 0;

  outerLoop:
  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const msg of messages) {
      // Stop processing if we've hit the safety cap for this run
      if (sent >= MAX_EMAILS_PER_RUN) {
        console.log(`Reached cap of ${MAX_EMAILS_PER_RUN} emails this run. Remaining will be processed next run.`);
        break outerLoop;
      }

      const msgId = msg.getId();

      // Skip if we already sent this email
      if (sentIdsSet.has(msgId)) continue;

      const from = msg.getFrom();

      // Skip if sender is in the ignore list
      const isIgnored = IGNORED_SENDERS.some(ignored =>
        from.toLowerCase().includes(ignored.toLowerCase())
      );
      if (isIgnored) {
        sentIdsSet.add(msgId); // mark as seen so it's not re-checked every time
        continue;
      }

      const subject     = msg.getSubject() || "(no subject)";
      const date        = msg.getDate().toLocaleString();
      const body        = msg.getPlainBody() || "";
      const attachments = msg.getAttachments();

      // Truncate body preview
      const preview = body.length > 800 ? body.substring(0, 800) + "…" : body;
      const attachmentNote = attachments.length > 0
        ? `\n📎 ${attachments.length} attachment(s)`
        : "";

      const text =
        `📧 <b>New Email</b>\n\n` +
        `<b>From:</b> ${escapeHtml(from)}\n` +
        `<b>Subject:</b> ${escapeHtml(subject)}\n` +
        `<b>Date:</b> ${escapeHtml(date)}${attachmentNote}\n\n` +
        `${escapeHtml(preview)}`;

      // Send to all allowed users
      for (const chatId of ALLOWED_CHAT_IDS) {
        sendTelegram(text, chatId);
        Utilities.sleep(1000);
      }

      // Save to last emails log (keep last 5)
      lastEmails.unshift({ from, subject, date, preview });
      if (lastEmails.length > 5) lastEmails.pop();

      // Mark as sent
      sentIdsSet.add(msgId);

      // Save immediately after every single email
      const updatedIds = Array.from(sentIdsSet).slice(-500);
      props.setProperty("sentIds", JSON.stringify(updatedIds));
      props.setProperty("lastEmails", JSON.stringify(lastEmails));
      props.setProperty("lastCheck", new Date().toLocaleString());

      sent++;
      Utilities.sleep(500);
    }
  }

  console.log(`Forwarded ${sent} email(s) at ${new Date().toLocaleString()}`);
}


function runEvery30Seconds() {
  // Single Gmail search per trigger run, to stay within Gmail's daily quota
  checkAndForwardEmails();
}


// ─────────────────────────────────────────────
//  TELEGRAM COMMANDS + BUTTON HANDLER
// ─────────────────────────────────────────────
function handleCommands() {
  const props = PropertiesService.getScriptProperties();
  const lastUpdateId = parseInt(props.getProperty("lastUpdateId") || "0");

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(response.getContentText());

  if (!data.ok || data.result.length === 0) return;

  for (const update of data.result) {
    const updateId = update.update_id;

    // Handle inline button taps (callback queries)
    if (update.callback_query) {
      handleCallbackQuery(update.callback_query);
      props.setProperty("lastUpdateId", String(updateId));
      continue;
    }

    const msg = update.message;
    if (!msg || !msg.text) {
      props.setProperty("lastUpdateId", String(updateId));
      continue;
    }

    const chatId = String(msg.chat.id);
    const text   = msg.text.trim();

    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      sendTelegram("⛔ You are not authorized to use this bot.", chatId);
      props.setProperty("lastUpdateId", String(updateId));
      continue;
    }

    routeCommand(text, chatId);
    props.setProperty("lastUpdateId", String(updateId));
  }
}


function handleCallbackQuery(callback) {
  const chatId = String(callback.message.chat.id);

  // Acknowledge the tap so Telegram clears the button's loading spinner
  answerCallbackQuery(callback.id);

  if (!ALLOWED_CHAT_IDS.includes(chatId)) {
    sendTelegram("⛔ You are not authorized to use this bot.", chatId);
    return;
  }

  routeCommand(callback.data, chatId);
}


function routeCommand(text, chatId) {
  if (text === "/start" || text === "/help") {
    handleStart(chatId);
  } else if (text === "/status") {
    handleStatus(chatId);
  } else if (text === "/last") {
    handleLast(chatId);
  } else if (text === "/pause") {
    handlePause(chatId);
  } else if (text === "/resume") {
    handleResume(chatId);
  } else {
    sendTelegram("❓ Unknown command. Send /start to see the menu.", chatId);
  }
}


// ─────────────────────────────────────────────
//  COMMAND HANDLERS
// ─────────────────────────────────────────────
function handleStart(chatId) {
  const menu =
    `👋 <b>Welcome to your Gmail Bot!</b>\n\n` +
    `Available commands:\n\n` +
    `📊 /status — Check if the bot is running\n` +
    `📬 /last — Show the last 5 emails received\n` +
    `⏸ /pause — Stop forwarding new emails\n` +
    `▶️ /resume — Resume forwarding\n` +
    `❓ /help — Show this menu`;

  sendTelegramWithButtons(menu, chatId, [
    [{ text: "📊 Status", callback_data: "/status" }, { text: "📬 Last 5", callback_data: "/last" }],
    [{ text: "⏸ Pause", callback_data: "/pause" }, { text: "▶️ Resume", callback_data: "/resume" }],
  ]);
}


function handleStatus(chatId) {
  const props     = PropertiesService.getScriptProperties();
  const paused    = props.getProperty("paused") === "true";
  const lastCheck = props.getProperty("lastCheck") || "Never";
  const sentRaw   = props.getProperty("sentIds");
  const totalSent = sentRaw ? JSON.parse(sentRaw).length : 0;

  const status =
    `📊 <b>Bot Status</b>\n\n` +
    `• Status: ${paused ? "⏸ Paused" : "✅ Running"}\n` +
    `• Last check: ${escapeHtml(lastCheck)}\n` +
    `• Emails forwarded: ${totalSent}`;

  sendTelegramWithButtons(status, chatId, [
    [{ text: "🔄 Refresh", callback_data: "/status" }],
  ]);
}


function handleLast(chatId) {
  const props         = PropertiesService.getScriptProperties();
  const lastEmailsRaw = props.getProperty("lastEmails");
  const lastEmails    = lastEmailsRaw ? JSON.parse(lastEmailsRaw) : [];

  if (lastEmails.length === 0) {
    sendTelegram("📭 No emails have been forwarded yet.", chatId);
    return;
  }

  sendTelegram(`📬 <b>Last ${lastEmails.length} Email(s):</b>`, chatId);
  Utilities.sleep(500);

  lastEmails.forEach((e, i) => {
    const emailText =
      `📧 <b>#${i + 1}</b>\n` +
      `<b>From:</b> ${escapeHtml(e.from)}\n` +
      `<b>Subject:</b> ${escapeHtml(e.subject)}\n` +
      `<b>Date:</b> ${escapeHtml(e.date)}\n\n` +
      `${escapeHtml(e.preview || "(no body)")}`;

    sendTelegram(emailText, chatId);
    Utilities.sleep(700);
  });

  sendTelegramWithButtons("────────────", chatId, [
    [{ text: "🔄 Refresh", callback_data: "/last" }],
  ]);
}


function handlePause(chatId) {
  PropertiesService.getScriptProperties().setProperty("paused", "true");
  sendTelegram("⏸ Forwarding paused. Send /resume anytime to continue.", chatId);
}


function handleResume(chatId) {
  PropertiesService.getScriptProperties().setProperty("paused", "false");
  sendTelegram("✅ Forwarding resumed.", chatId);
}


// ─────────────────────────────────────────────
//  TELEGRAM HELPERS
// ─────────────────────────────────────────────
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


function sendTelegram(text, chatId, retries) {
  if (retries === undefined) retries = 1;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result   = JSON.parse(response.getContentText());
    if (!result.ok) {
      console.error(`Telegram error for ${chatId}: ` + response.getContentText());
      if (retries > 0) {
        Utilities.sleep(1000);
        sendTelegram(text, chatId, retries - 1);
      }
    }
  } catch (e) {
    console.error(`Failed to send to ${chatId}: ${e.message}`);
    if (retries > 0) {
      Utilities.sleep(1000);
      sendTelegram(text, chatId, retries - 1);
    }
  }
}


function sendTelegramWithButtons(text, chatId, buttons) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result   = JSON.parse(response.getContentText());
    if (!result.ok) {
      console.error(`Telegram button error for ${chatId}: ` + response.getContentText());
    }
  } catch (e) {
    console.error(`Failed to send buttons to ${chatId}: ${e.message}`);
  }
}


function answerCallbackQuery(callbackQueryId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
  const payload = { callback_query_id: callbackQueryId };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    UrlFetchApp.fetch(url, options);
  } catch (e) {
    console.error("answerCallbackQuery failed: " + e.message);
  }
}


// ─────────────────────────────────────────────
//  TEST & RESET UTILITIES
// ─────────────────────────────────────────────
function testBot() {
  for (const chatId of ALLOWED_CHAT_IDS) {
    sendTelegram("✅ <b>Gmail → Telegram bot is working!</b>", chatId);
    Utilities.sleep(1000);
  }
}

function resetSentIds() {
  PropertiesService.getScriptProperties().deleteProperty("sentIds");
  PropertiesService.getScriptProperties().deleteProperty("lastEmails");
  PropertiesService.getScriptProperties().deleteProperty("lastCheck");
  console.log("All data cleared. Fresh start!");
}
