'use strict';

const { logger } = require('../util/log');

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Telegram hard-rejects a message over 4096 characters and the failure is a
// silent 400, so a long report would simply never arrive. Split on line
// boundaries, and never inside a <pre>, since a half-open tag breaks the
// message that carries it.
const LIMIT = 3800;

function chunk(text, limit = LIMIT) {
  if (text.length <= limit) return [text];

  const out = [];
  let buf = '';
  let depth = 0;

  for (const line of text.split('\n')) {
    if (depth === 0 && buf && buf.length + 1 + line.length > limit) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n${line}` : line;
    depth += (line.match(/<pre>/g) || []).length - (line.match(/<\/pre>/g) || []).length;
  }
  if (buf) out.push(buf);

  // A single <pre> longer than the cap cannot be split safely on lines, so cut
  // it bluntly rather than let Telegram drop the message.
  return out.flatMap((p) => (p.length <= 4096 ? p : p.match(/[\s\S]{1,4000}/g)));
}

// One token, one send queue, one long-poll. Two of these can live in the same
// process because Telegram keys the 409 conflict on the bot token, not the host.
class Inbox {
  constructor({ token, st, keys, fallbackOwner, logName }) {
    this.token = token;
    this.st = st;
    this.keys = keys;
    this.log = logger(logName);
    this.offset = Number(st.getSetting.get(keys.offset)?.value || 0);
    this.owner = st.getSetting.get(keys.owner)?.value || fallbackOwner || null;
    this.stopped = false;
    this.queue = Promise.resolve();
    this.onMessage = null;
  }

  // Serialised with a gap so a burst of leader trades cannot trip Telegram's
  // rate limit and drop messages. Anything over the length cap is split first,
  // otherwise the whole reply is dropped with only a warning in the log.
  send(text, chatId = this.owner, extra = {}) {
    if (chatId && typeof chatId === 'object') {
      extra = chatId;
      chatId = this.owner;
    }
    if (!chatId) return;

    const parts = chunk(text);
    for (const [i, part] of parts.entries()) {
      this.queue = this.queue
        .then(() =>
          fetch(API(this.token, 'sendMessage'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: part,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              // Buttons belong on the last part, where the reader ends up.
              ...(extra.reply_markup && i === parts.length - 1 ? { reply_markup: extra.reply_markup } : {}),
            }),
          }).then(async (r) => {
            if (!r.ok) this.log.warn(`sendMessage ${r.status}: ${(await r.text()).slice(0, 160)}`);
          })
        )
        .then(() => new Promise((r) => setTimeout(r, 1100)))
        .catch((e) => this.log.warn(e.message));
    }
    return this.queue;
  }

  async start() {
    const me = await (await fetch(API(this.token, 'getMe'))).json();
    if (!me.ok) throw new Error(`getMe failed: ${JSON.stringify(me).slice(0, 160)}`);
    this.username = me.result.username;
    this.log.ok(`@${this.username} connected${this.owner ? ` (owner ${this.owner})` : ' — send /start to bind'}`);
    this.poll();
    return me.result;
  }

  stop() {
    this.stopped = true;
  }

  async poll() {
    while (!this.stopped) {
      try {
        const res = await fetch(API(this.token, 'getUpdates') + `?timeout=30&offset=${this.offset}`, {
          signal: AbortSignal.timeout(40_000),
        });
        const json = await res.json();

        // Two processes cannot long-poll the same bot. This happens for a
        // moment during a --watch restart while the old one is still winding
        // down, and resolves itself, so it is not worth shouting about.
        if (json.error_code === 409) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }

        for (const update of json.result || []) {
          this.offset = update.update_id + 1;
          this.st.setSetting.run(this.keys.offset, String(this.offset));
          const msg = update.message;
          if (msg?.text && this.onMessage) await this.onMessage(msg);
        }
      } catch (e) {
        if (!this.stopped) {
          this.log.warn(`poll: ${e.message}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  bind(chatId) {
    this.owner = String(chatId);
    this.st.setSetting.run(this.keys.owner, this.owner);
  }
}

module.exports = { Inbox, chunk, API };
