'use strict';

const { EVM_LEADERS, icon } = require('../../config/leaders');
const fmt = require('./format');
const { makeAlerter } = require('./alerts');
const { Inbox, chunk } = require('./inbox');

const HELP = [
  '<b>FOMO Copy</b> · shadow mode',
  'Nothing is executed and no keys are loaded. This only watches and simulates.',
  '',
  '/status · what is running right now',
  '/report · the policy scoreboard and entry cost',
  '/leaders · who is trading the most',
  '/who · the emoji legend for every leader',
  '/pnl · all leaders. /pnl handle or /pnl handle TOKEN for the tape',
  '/positions · open shadow positions',
  '/clusters · tokens several leaders bought',
  '/policies · what the five exit strategies do',
  '',
  '/mute &lt;handle&gt; · stop alerting and stop copying them',
  '/unmute &lt;handle&gt; · resume',
  '/muted · who is muted',
  '/focus &lt;handle&gt; · also alert on the quiet bot',
  '/unfocus &lt;handle&gt; · drop them from it',
  '/focused · who is on the quiet bot',
  '/pause · /resume · all alerts',
].join('\n');

function findLeader(arg) {
  return EVM_LEADERS.find((l) => l.handle.toLowerCase() === arg.toLowerCase());
}

class Bot {
  constructor({ token, st, db, state }) {
    this.st = st;
    this.db = db;
    this.state = state; // { startedAt, chains, watchers, focus }
    this.inbox = new Inbox({
      token,
      st,
      keys: { offset: 'tg_offset', owner: 'owner_chat_id' },
      fallbackOwner: process.env.TELEGRAM_CHAT_ID || null,
      logName: 'telegram',
    });
    this.inbox.onMessage = (msg) => this.handle(msg);
    this.alerter = makeAlerter((text, extra) => this.inbox.send(text, extra));
  }

  get owner() {
    return this.inbox.owner;
  }

  get paused() {
    return this.st.getSetting.get('paused')?.value === '1';
  }

  send(text, chatId, extra) {
    return this.inbox.send(text, chatId, extra);
  }

  // The alert path used by the engine. Takes a structured trade rather than a
  // string so the alerter can coalesce a burst into one rollup. Respects pause.
  notify(trade) {
    if (this.paused) return;
    this.alerter(trade);
  }

  start() {
    return this.inbox.start();
  }

  stop() {
    this.inbox.stop();
  }

  async handle(msg) {
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Single-user bot: the first chat to say anything becomes the owner, so
    // there is no chat id to look up by hand.
    if (!this.inbox.owner) {
      this.inbox.bind(chatId);
      this.inbox.log.ok(`bound to chat ${chatId} (@${msg.from?.username || msg.from?.first_name})`);
      await this.send(`Bound to this chat. Alerts will arrive here.\n\n${HELP}`, chatId);
      return;
    }
    if (chatId !== this.inbox.owner) {
      this.inbox.log.warn(`ignoring message from ${chatId}`);
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

      case '/pnl': {
        if (!arg) return reply(fmt.perLeader(this.db));
        const [who, ...tokenBits] = rest;
        const tokenArg = tokenBits.join(' ').trim();
        return reply(tokenArg ? fmt.oneToken(this.db, who, tokenArg) : fmt.oneLeader(this.db, who));
      }

      case '/positions':
        return reply(fmt.positions(this.db));

      case '/clusters':
        return reply(fmt.clusters(this.db));

      case '/policies':
        return reply(fmt.policies());

      case '/mute': {
        if (!arg) return reply('Usage: <code>/mute handle</code>');
        const hit = findLeader(arg);
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>. Try /leaders.`);
        this.st.mute.run(hit.handle, Date.now());
        return reply(`Muted <b>${fmt.esc(hit.handle)}</b>. No alerts and no new shadow positions from them. Their trades are still recorded.`);
      }

      case '/unmute': {
        if (!arg) return reply('Usage: <code>/unmute handle</code>');
        const hit = findLeader(arg);
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>.`);
        this.st.unmute.run(hit.handle);
        return reply(`Unmuted <b>${fmt.esc(hit.handle)}</b>.`);
      }

      case '/muted': {
        const rows = this.st.listMuted.all();
        return reply(rows.length ? `Muted: ${fmt.named(rows)}` : 'Nobody is muted.');
      }

      case '/focus': {
        if (!arg) return reply('Usage: <code>/focus handle</code>');
        const hit = findLeader(arg);
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>. Try /leaders.`);
        this.st.focus.run(hit.handle, Date.now());
        const quiet = this.state.focus;
        const dest = quiet?.username ? `@${quiet.username}` : 'the quiet bot';
        return reply(
          `${icon(hit.handle)} <b>${fmt.esc(hit.handle)}</b> will also alert on ${dest}.` +
            (quiet?.bound ? '' : '\nOpen that bot and send /start once so it can write to you.')
        );
      }

      case '/unfocus': {
        if (!arg) return reply('Usage: <code>/unfocus handle</code>');
        const hit = findLeader(arg);
        if (!hit) return reply(`No leader called <b>${fmt.esc(arg)}</b>.`);
        this.st.unfocus.run(hit.handle);
        return reply(`${icon(hit.handle)} <b>${fmt.esc(hit.handle)}</b> dropped from the quiet bot.`);
      }

      case '/focused': {
        const rows = this.st.listFocused.all();
        if (!rows.length) return reply('Nobody is focused. <code>/focus handle</code> to pick one.');
        return reply(`Focused: ${fmt.named(rows)}`);
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
    const focused = this.st.listFocused.all();
    const lines = [
      '<b>Status</b>',
      `Shadow mode, nothing executed. Up ${up < 1 ? `${Math.round(up * 60)}m` : `${up.toFixed(1)}h`}.`,
      '',
    ];
    // A watcher can be "connected" and still be subscribed to nothing, which
    // looks exactly like a quiet market until you check. Say it plainly.
    for (const w of this.state.watchers) {
      const cursor = this.st.getCursor.get(w.chain.id)?.block;
      const last = this.st.lastEventAt?.get(w.chain.id)?.ts;
      const quiet = last ? `last trade ${fmt.ago(last)} ago` : 'no trades yet';
      lines.push(
        `${w.healthy ? '🟢' : '🔴'} <b>${fmt.esc(w.chain.name)}</b> · block ${cursor ?? '-'} · ${quiet}` +
          (w.healthy ? '' : '\n<b>Not subscribed.</b> Sweep is still polling, so nothing is lost, but alerts are delayed.')
      );
    }
    lines.push('', fmt.overview(this.db));
    if (this.state.focus) {
      const dest = this.state.focus.username ? `@${this.state.focus.username}` : 'quiet bot';
      lines.push(
        '',
        this.state.focus.bound
          ? `${dest} is bound. ${focused.length ? `Focused: ${fmt.named(focused)}` : 'Nobody focused yet.'}`
          : `${dest} is running. Send it /start once so it can write to you.`
      );
    }
    if (muted) lines.push('', `${muted} leader(s) muted.`);
    if (this.paused) lines.push('', '<b>Alerts are paused.</b>');
    return lines.join('\n');
  }
}

module.exports = { Bot, HELP, chunk, findLeader };
