'use strict';

const { logger } = require('../util/log');

const log = logger('telegram');

// Notifications only. There is no bot command surface here because this runs
// for one person; the reporting lives in `npm run report`.
function makeNotifier() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log.dim('disabled (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
    return () => {};
  }

  let chain = Promise.resolve();
  return (text) => {
    chain = chain
      .then(() =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        })
      )
      .then(() => new Promise((r) => setTimeout(r, 1200))) // stay under Telegram's rate limit
      .catch((e) => log.warn(e.message));
  };
}

module.exports = { makeNotifier };
