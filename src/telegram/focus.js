'use strict';

const fmt = require('./format');
const { makeAlerter } = require('./alerts');
const { Inbox } = require('./inbox');

const WELCOME = [
  '<b>FOMO Copy</b> · quiet alerts',
  'This bot only fires when a leader you picked trades. The other bot still gets everyone.',
  '',
  'Pick them over there with <code>/focus handle</code>.',
].join('\n');

// Same process, different BotFather token. Telegram will not split one bot's
// notifications across chats, so the hand-picked tape lives here and the full
// firehose stays on the main bot.
class FocusBot {
  constructor({ token, st }) {
    this.st = st;
    this.inbox = new Inbox({
      token,
      st,
      keys: { offset: 'focus_tg_offset', owner: 'focus_chat_id' },
      fallbackOwner: process.env.TELEGRAM_FOCUS_CHAT_ID || null,
      logName: 'telegram-focus',
    });
    this.inbox.onMessage = (msg) => this.handle(msg);
    this.alerter = makeAlerter((text, extra) => this.inbox.send(text, extra));
    this.username = null;
  }

  get bound() {
    return !!this.inbox.owner;
  }

  get paused() {
    return this.st.getSetting.get('paused')?.value === '1';
  }

  notify(trade) {
    if (this.paused || !this.bound) return;
    if (!this.st.isFocused.get(trade.leader)) return;
    this.alerter(trade);
  }

  async start() {
    const me = await this.inbox.start();
    this.username = me.username;
    return me;
  }

  stop() {
    this.inbox.stop();
  }

  async handle(msg) {
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    if (!this.inbox.owner) {
      this.inbox.bind(chatId);
      this.inbox.log.ok(`bound to chat ${chatId} (@${msg.from?.username || msg.from?.first_name})`);
      await this.inbox.send(this.hello(), chatId);
      return;
    }
    if (chatId !== this.inbox.owner) {
      this.inbox.log.warn(`ignoring message from ${chatId}`);
      return;
    }

    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help' || cmd === '/focused') {
      return this.inbox.send(this.hello(), chatId);
    }
    return this.inbox.send(
      `This bot only sends alerts. Pick leaders on the other bot with <code>/focus handle</code>.`,
      chatId
    );
  }

  hello() {
    const rows = this.st.listFocused.all();
    const list = rows.length
      ? `Watching: ${fmt.named(rows)}`
      : 'Nobody picked yet.';
    return `${WELCOME}\n\n${list}`;
  }
}

module.exports = { FocusBot, WELCOME };
