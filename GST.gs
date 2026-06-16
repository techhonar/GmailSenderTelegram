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

      const subject = msg.getSubject() || "(no subject)";
      const date    = msg.getDate().toLocaleString();
      const body    = msg.getPlainBody() || "";

      // Truncate body preview
      const preview = body.length > 800 ? body.substring(0, 800) + "…" : body;

      const text =
        `📧 New Email\n\n` +
        `From: ${from}\n` +
        `Subject: ${subject}\n` +
        `Date: ${date}\n\n` +
        `${preview}`;

      // Send to all allowed users
      for (const chatId of ALLOWED_CHAT_IDS) {
        sendTelegram(text, chatId);
        Utilities.sleep(1000);
      }

      // ✅ Save preview in lastEmails too
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
//  TELEGRAM COMMANDS HANDLER
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
    const msg      = update.message;

    if (!msg || !msg.text) {
      props.setProperty("lastUpdateId", String(updateId));
      continue;
    }

    const chatId = String(msg.chat.id);
    const text   = msg.text.trim();

    // Only respond to allowed users
    if (!ALLOWED_CHAT_IDS.includes(chatId)) {
      sendTelegram("⛔ You are not authorized to use this bot.", chatId);
      props.setProperty("lastUpdateId", String(updateId));
      continue;
    }

    if (text === "/start") {
      handleStart(chatId);
    } else if (text === "/status") {
      handleStatus(chatId);
    } else if (text === "/last") {
      handleLast(chatId);
    } else {
      sendTelegram("❓ Unknown command. Send /start to see the menu.", chatId);
    }

    props.setProperty("lastUpdateId", String(updateId));
  }
}


// ─────────────────────────────────────────────
//  COMMAND HANDLERS
// ─────────────────────────────────────────────
function handleStart(chatId) {
  const menu =
    `👋 Welcome to your Gmail Bot!\n\n` +
    `Here are the available commands:\n\n` +
    `📊 /status — Check if the bot is running\n` +
    `📬 /last — Show the last 5 emails received`;

  sendTelegramWithButtons(menu, chatId, [
    [{ text: "📊 Status", callback_data: "/status" }],
    [{ text: "📬 Last 5 Emails", callback_data: "/last" }],
  ]);
}


function handleStatus(chatId) {
  const props     = PropertiesService.getScriptProperties();
  const paused    = props.getProperty("paused") === "true";
  const lastCheck = props.getProperty("lastCheck") || "Never";
  const sentRaw   = props.getProperty("sentIds");
  const totalSent = sentRaw ? JSON.parse(sentRaw).length : 0;

  const status =
    `📊 Bot Status\n\n` +
    `• Status: ${paused ? "⏸ Paused" : "✅ Running"}\n` +
    `• Last check: ${lastCheck}\n` +
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

  // Send each email as a separate message so it's not too long
  sendTelegram(`📬 Last ${lastEmails.length} Email(s):`, chatId);
  Utilities.sleep(500);

  lastEmails.forEach((e, i) => {
    const emailText =
      `📧 #${i + 1}\n` +
      `From: ${e.from}\n` +
      `Subject: ${e.subject}\n` +
      `Date: ${e.date}\n\n` +
      `${e.preview || "(no body)"}`;

    sendTelegram(emailText, chatId);
    Utilities.sleep(700);
  });

  sendTelegramWithButtons("─────────────────", chatId, [
    [{ text: "🔄 Refresh", callback_data: "/last" }],
  ]);
}


// ─────────────────────────────────────────────
//  TELEGRAM HELPERS
// ─────────────────────────────────────────────
function sendTelegram(text, chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
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
    }
  } catch (e) {
    console.error(`Failed to send to ${chatId}: ${e.message}`);
  }
}


function sendTelegramWithButtons(text, chatId, buttons) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
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


// ─────────────────────────────────────────────
//  TEST & RESET UTILITIES
// ─────────────────────────────────────────────
function testBot() {
  for (const chatId of ALLOWED_CHAT_IDS) {
    sendTelegram("✅ Gmail → Telegram bot is working!", chatId);
    Utilities.sleep(1000);
  }
}

function resetSentIds() {
  PropertiesService.getScriptProperties().deleteProperty("sentIds");
  PropertiesService.getScriptProperties().deleteProperty("lastEmails");
  PropertiesService.getScriptProperties().deleteProperty("lastCheck");
  console.log("All data cleared. Fresh start!");
}
