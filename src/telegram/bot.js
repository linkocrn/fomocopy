'use strict';

const { logger } = require('../util/log');
const { EVM_LEADERS } = require('../../config/leaders');
const fmt = require('./format');
const { makeAlerter } = require('./alerts');

const log = logger('telegram');
const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

const HELP = [
  '<b>FOMO Copy</b> — shadow mode',
  'Nothing is executed and no keys are loaded. This only watches and simulates.',
  '',
  '/status — what is running right now',
  '/report — the policy scoreboard and entry cost',
  '/leaders — who is trading the most',
  '/who — the emoji legend for every leader',
  '/pnl — profit and loss per leader',
  '/positions — open shadow positions',
  '/clusters — tokens several leaders bought',
  '/policies — what the five exit strategies do',
  '',
  '/mute &lt;handle&gt; — stop alerting and stop copying them',
  '/unmute &lt;handle&gt; — resume',
  '/muted — who is muted',
  '/pause · /resume — all alerts',
].join('\n');

class Bot {
  constructor({ token, st, db, state }) {
    this.token = token;
    this.st = st;
    this.db = db;
    this.state = state; // { startedAt, chains, watchers }
    // Persisted, because getUpdates replays anything unconfirmed. Under
    // `npm run dev` the process restarts on every file save, and a fresh
    // offset would make the bot answer the same command again after each one.
    this.offset = Number(st.getSetting.get('tg_offset')?.value || 0);
    this.stopped = false;
    this.queue = Promise.resolve();
    this.owner = st.getSetting.get('owner_chat_id')?.value || process.env.TELEGRAM_CHAT_ID || null;
    this.alerter = makeAlerter((text) => this.send(text));
  }

  get paused() {
    return this.st.getSetting.get('paused')?.value === '1';
  }

  // Serialised with a gap so a burst of leader trades cannot trip Telegram's
  // rate limit and drop messages.
  send(text, chatId = this.owner) {
    if (!chatId) return;
    this.queue = this.queue
      .then(() =>
        fetch(API(this.token, 'sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }).then(async (r) => {
          if (!r.ok) log.warn(`sendMessage ${r.status}: ${(await r.text()).slice(0, 160)}`);
        })
      )
      .then(() => new Promise((r) => setTimeout(r, 1100)))
      .catch((e) => log.warn(e.message));
    return this.queue;
  }

  // The alert path used by the engine. Takes a structured trade rather than a
  // string so the alerter can coalesce a burst into one rollup. Respects pause.
  notify(trade) {
    if (this.paused) return;
    this.alerter(trade);
  }

  async start() {
    const me = await (await fetch(API(this.token, 'getMe'))).json();
    if (!me.ok) throw new Error(`getMe failed: ${JSON.stringify(me).slice(0, 160)}`);
    log.ok(`@${me.result.username} connected${this.owner ? ` (owner ${this.owner})` : ' — send /start to bind'}`);
    this.poll();
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
          this.st.setSetting.run('tg_offset', String(this.offset));
          const msg = update.message;
          if (msg?.text) await this.handle(msg);
        }
      } catch (e) {
        if (!this.stopped) {
          log.warn(`poll: ${e.message}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  async handle(msg) {
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Single-user bot: the first chat to say anything becomes the owner, so
    // there is no chat id to look up by hand.
    if (!this.owner) {
      this.owner = chatId;
      this.st.setSetting.run('owner_chat_id', chatId);
      log.ok(`bound to chat ${chatId} (@${msg.from?.username || msg.from?.first_name})`);
      await this.send(`Bound to this chat. Alerts will arrive here.\n\n${HELP}`, chatId);
      return;
    }
    if (chatId !== this.owner) {
      log.warn(`ignoring message from ${chatId}`);
      return;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').replace(/^@/, '');
    const reply = (t) => this.send(t, chatId);

    switch (cmd.split('@')[0].toLowerCase()) {
      case '/start':
      case '/help':
        return reply(HELP);

      case '/status':
        return reply(this.status());

      case '/report':
        return reply(fmt.scoreboard(this.db));

      case '/leaders':
        return reply(fmt.leaders(this.db));

      case '/who':
        return reply(fmt.who());

      case '/pnl':
        return reply(fmt.perLeader(this.db));

      case '/positions':
        return reply(fmt.positions(this.db));

      case '/clusters':
        return reply(fmt.clusters(this.db));

      case '/policies':
        return reply(fmt.policies());

      case '/mute': {
        if (!arg) return reply('Usage: <code>/mute handle</code>');
        const hit = EVM_LEADERS.find((l) => l.handle.toLowerCase() === arg.toLowerCase());
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>. Try /leaders.`);
        this.st.mute.run(hit.handle, Date.now());
        return reply(`Muted <b>${fmt.esc(hit.handle)}</b>. No alerts and no new shadow positions from them. Their trades are still recorded.`);
      }

      case '/unmute': {
        if (!arg) return reply('Usage: <code>/unmute handle</code>');
        const hit = EVM_LEADERS.find((l) => l.handle.toLowerCase() === arg.toLowerCase());
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>.`);
        this.st.unmute.run(hit.handle);
        return reply(`Unmuted <b>${fmt.esc(hit.handle)}</b>.`);
      }

      case '/muted': {
        const rows = this.st.listMuted.all();
        return reply(rows.length ? `Muted: ${rows.map((r) => fmt.esc(r.leader)).join(', ')}` : 'Nobody is muted.');
      }

      case '/pause':
        this.st.setSetting.run('paused', '1');
        return reply('Alerts paused. Trades are still recorded and shadow positions still run. /resume to turn them back on.');

      case '/resume':
        this.st.setSetting.run('paused', '0');
        return reply('Alerts resumed.');

      default:
        return reply(`Unknown command.\n\n${HELP}`);
    }
  }

  status() {
    const up = (Date.now() - this.state.startedAt) / 3_600_000;
    const muted = this.st.listMuted.all().length;
    const lines = [
      '<b>Status</b>',
      `Shadow mode, nothing executed. Up ${up < 1 ? `${Math.round(up * 60)}m` : `${up.toFixed(1)}h`}.`,
      '',
    ];
    for (const w of this.state.watchers) {
      const cursor = this.st.getCursor.get(w.chain.id)?.block;
      lines.push(`<b>${fmt.esc(w.chain.name)}</b> — block ${cursor ?? '-'}`);
    }
    lines.push('', fmt.overview(this.db));
    if (muted) lines.push('', `${muted} leader(s) muted.`);
    if (this.paused) lines.push('', '<b>Alerts are paused.</b>');
    return lines.join('\n');
  }
}

module.exports = { Bot, HELP };
