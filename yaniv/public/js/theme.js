/*
 * Card themes.
 *
 * The game never draws a card directly: it asks the active theme for a face or a back.
 * That is the seam for custom art. A theme is:
 *
 *   {
 *     id, name,
 *     face(card) -> HTML string   // card = {id:'7H', suit:'H', rank:7}
 *     back()     -> HTML string
 *   }
 *
 * Two kinds ship today:
 *   - 'classic': drawn in SVG, no image files, crisp at any size.
 *   - image themes: one picture per card, keyed by card id (AS, 2S ... 10S, JS, QS, KS,
 *     same for H, D, C) plus 'back'. Missing pictures fall back to the classic face,
 *     so a half-finished custom deck still plays.
 *
 * Custom decks can be loaded in the app (Settings > Card art > Load images) and are kept in
 * IndexedDB on that device, or baked in by adding an entry to BUILT_IN_IMAGE_THEMES with URLs.
 * Card images look best at 5:7 (e.g. 500x700 px).
 */
(function (root) {
  'use strict';

  var SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
  var RED = { H: true, D: true };
  function rankLabel(r) { return ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[r] || String(r); }
  function rankName(r) { return ({ 1: 'Ace', 11: 'Jack', 12: 'Queen', 13: 'King' })[r] || String(r); }
  function label(card) { return rankName(card.rank) + ' of ' + SUIT_NAME[card.suit]; }

  // Pip positions on a 100 x 140 card, [x, y, flipped]
  var L = 30, M = 50, R = 70;
  var PIPS = {
    1: [[M, 70]],
    2: [[M, 28], [M, 112, 1]],
    3: [[M, 28], [M, 70], [M, 112, 1]],
    4: [[L, 28], [R, 28], [L, 112, 1], [R, 112, 1]],
    5: [[L, 28], [R, 28], [M, 70], [L, 112, 1], [R, 112, 1]],
    6: [[L, 28], [R, 28], [L, 70], [R, 70], [L, 112, 1], [R, 112, 1]],
    7: [[L, 28], [R, 28], [M, 49], [L, 70], [R, 70], [L, 112, 1], [R, 112, 1]],
    8: [[L, 28], [R, 28], [M, 49], [L, 70], [R, 70], [M, 91, 1], [L, 112, 1], [R, 112, 1]],
    9: [[L, 28], [R, 28], [L, 56], [R, 56], [M, 70], [L, 84, 1], [R, 84, 1], [L, 112, 1], [R, 112, 1]],
    10: [[L, 28], [R, 28], [M, 42], [L, 56], [R, 56], [L, 84, 1], [R, 84, 1], [M, 98, 1], [L, 112, 1], [R, 112, 1]]
  };

  function classicFace(card) {
    var color = RED[card.suit] ? 'var(--card-red)' : 'var(--card-black)';
    var sym = SUIT_SYMBOL[card.suit];
    var lab = rankLabel(card.rank);
    var body = '';
    if (card.rank <= 10) {
      var size = card.rank === 1 ? 46 : 19;
      PIPS[card.rank].forEach(function (p) {
        body += '<text x="' + p[0] + '" y="' + p[1] + '" font-size="' + size + '" text-anchor="middle" dominant-baseline="central"' +
          (p[2] ? ' transform="rotate(180 ' + p[0] + ' ' + p[1] + ')"' : '') + '>' + sym + '</text>';
      });
    } else {
      body = '<rect x="22" y="22" width="56" height="96" rx="6" fill="none" stroke="' + color + '" stroke-width="1.5" opacity=".55"/>' +
        '<text x="50" y="62" font-size="40" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="Georgia, serif">' + lab + '</text>' +
        '<text x="50" y="94" font-size="22" text-anchor="middle" dominant-baseline="central">' + sym + '</text>';
    }
    var corner = '<text x="9" y="17" font-size="17" font-weight="700" text-anchor="middle" font-family="system-ui, sans-serif">' + lab + '</text>' +
      '<text x="9" y="31" font-size="13" text-anchor="middle">' + sym + '</text>';
    return '<svg class="card-svg" viewBox="0 0 100 140" role="img" aria-label="' + label(card) + '" fill="' + color + '">' +
      '<rect x="0.5" y="0.5" width="99" height="139" rx="8" fill="var(--card-face)" stroke="var(--card-edge)"/>' +
      corner + '<g transform="rotate(180 50 70)">' + corner + '</g>' + body + '</svg>';
  }

  function classicBack() {
    return '<svg class="card-svg" viewBox="0 0 100 140" role="img" aria-label="Card back">' +
      '<defs><pattern id="yb" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="10" height="10" fill="var(--back-1)"/><rect width="5" height="10" fill="var(--back-2)"/></pattern></defs>' +
      '<rect x="0.5" y="0.5" width="99" height="139" rx="8" fill="var(--card-face)" stroke="var(--card-edge)"/>' +
      '<rect x="6" y="6" width="88" height="128" rx="5" fill="url(#yb)"/>' +
      '<text x="50" y="72" font-size="20" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="var(--card-face)" font-family="Georgia, serif" letter-spacing="1">Y</text></svg>';
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }

  function imageTheme(id, name, images) {
    return {
      id: id, name: name, images: images,
      face: function (card) {
        var src = images[card.id];
        return src ? '<img class="card-img" alt="' + label(card) + '" src="' + esc(src) + '" draggable="false">' : classicFace(card);
      },
      back: function () {
        return images.back ? '<img class="card-img" alt="Card back" src="' + esc(images.back) + '" draggable="false">' : classicBack();
      }
    };
  }

  var themes = {
    classic: { id: 'classic', name: 'Classic', face: classicFace, back: classicBack }
  };
  // Add hosted decks here, e.g. { id:'family', name:'Family deck', base:'cards/family/', ext:'.png' }
  var BUILT_IN_IMAGE_THEMES = [];
  BUILT_IN_IMAGE_THEMES.forEach(function (t) {
    var imgs = { back: t.base + 'back' + t.ext };
    ['S', 'H', 'D', 'C'].forEach(function (s) { for (var r = 1; r <= 13; r++) imgs[rankLabel(r) + s] = t.base + rankLabel(r) + s + t.ext; });
    themes[t.id] = imageTheme(t.id, t.name, imgs);
  });

  var active = themes.classic;

  // ---- custom decks stored on this device (IndexedDB) ----
  var DB = 'yaniv-cards', STORE = 'decks';
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('No IndexedDB'));
      var req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode); var r = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(r && r.result); }; t.onerror = function () { reject(t.error); };
      });
    });
  }

  // Map a file name to a card id: "AS.png", "10h.jpg", "queen_of_hearts.png", "back.png"
  function idFromFileName(fileName) {
    var base = fileName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[\s-]+/g, '_');
    if (/^(back|cardback|card_back)$/.test(base)) return 'back';
    var m = base.match(/^(a|ace|[2-9]|10|j|jack|q|queen|k|king|1[1-3]|1)_?(?:of_)?(s|spades?|h|hearts?|d|diamonds?|c|clubs?)$/);
    if (!m) return null;
    var rk = { a: 'A', ace: 'A', '1': 'A', j: 'J', jack: 'J', '11': 'J', q: 'Q', queen: 'Q', '12': 'Q', k: 'K', king: 'K', '13': 'K' }[m[1]] || m[1];
    return rk + m[2][0].toUpperCase();
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = reject; fr.readAsDataURL(file);
    });
  }

  // Returns {matched:[ids], skipped:[names]}
  function importDeck(name, files) {
    var images = {}, skipped = [];
    var jobs = Array.prototype.map.call(files, function (f) {
      var id = idFromFileName(f.name);
      if (!id) { skipped.push(f.name); return null; }
      return readAsDataUrl(f).then(function (url) { images[id] = url; });
    });
    return Promise.all(jobs).then(function () {
      var id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      themes[id] = imageTheme(id, name, images);
      return tx('readwrite', function (s) { return s.put({ name: name, images: images }, id); })
        .catch(function () {}) // still usable this session if storage is unavailable
        .then(function () { return { id: id, matched: Object.keys(images), skipped: skipped }; });
    });
  }

  function loadSavedDecks() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var t = db.transaction(STORE, 'readonly'); var s = t.objectStore(STORE);
        var req = s.openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) return resolve();
          themes[cur.key] = imageTheme(cur.key, cur.value.name, cur.value.images);
          cur.continue();
        };
        req.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function deleteDeck(id) {
    delete themes[id];
    if (active.id === id) active = themes.classic;
    return tx('readwrite', function (s) { return s.delete(id); }).catch(function () {});
  }

  var api = {
    SUIT_SYMBOL: SUIT_SYMBOL, label: label, rankLabel: rankLabel,
    face: function (card) { return active.face(card); },
    back: function () { return active.back(); },
    list: function () { return Object.keys(themes).map(function (k) { return { id: k, name: themes[k].name }; }); },
    use: function (id) { if (themes[id]) active = themes[id]; return active.id; },
    activeId: function () { return active.id; },
    importDeck: importDeck, loadSavedDecks: loadSavedDecks, deleteDeck: deleteDeck, idFromFileName: idFromFileName
  };
  root.YanivTheme = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
