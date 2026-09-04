'use strict';

// A stable emoji per leader so a handle is recognisable at a glance in a fast
// scrolling alert feed, where reading names is slower than seeing a shape.
//
// Deliberately picked to be visually distinct from each other: no near-identical
// faces, no flags, and no sequences needing a variation selector, since those
// render at inconsistent widths and break the column alignment in <pre> blocks.
const PALETTE = [
  '🦊', '🐺', '🦁', '🐯', '🐸', '🐵', '🐼', '🐨', '🐮', '🐷',
  '🐔', '🦉', '🦅', '🦆', '🐝', '🦋', '🐙', '🦈', '🐬', '🐳',
  '🦀', '🐢', '🦎', '🐍', '🦄', '🐴', '🦓', '🦒', '🐘', '🦏',
  '🦌', '🐫', '🦔', '🦇', '🐌', '🐜', '🦕', '🦖', '🐡', '🦑',
  '🍀', '🌵', '🌻', '🍄', '🍋', '🍉', '🍇', '🍒', '🥑', '🌽',
  '🥕', '🍕', '🍔', '🌮', '🍩', '🍪', '🎂', '🍭', '☕', '🍺',
  '⚡', '🔥', '💧', '⭐', '🌙', '🌈', '🎈', '🎯', '🎲', '🎸',
  '🎺', '🥁', '🚀', '🛸', '🚁', '🏆', '💎', '🔑', '🔔', '🧲',
];

// FNV-1a. Any stable hash works; this one is short and has no dependencies.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Forty handles into eighty slots collides almost every time by the birthday
// problem, so a bare hash is not enough. Probing forward from the hash keeps
// the result deterministic while guaranteeing every leader is distinct.
function assign(handles) {
  const used = new Set();
  const map = new Map();
  for (const handle of handles) {
    let i = hash(handle.toLowerCase()) % PALETTE.length;
    while (used.has(i)) i = (i + 1) % PALETTE.length;
    used.add(i);
    map.set(handle, PALETTE[i]);
  }
  return map;
}

module.exports = { assign, PALETTE };
