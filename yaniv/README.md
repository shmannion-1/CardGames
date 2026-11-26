# Yaniv

A digital Yaniv card game for game nights. Runs in any browser and installs on iPhone as a home-screen app. Three ways to play:

- **Vs computer** (easy / normal / hard bots)
- **Pass and play** on one phone or laptop (the screen hides your hand between people)
- **Online**: everyone on their own phone, joining with a 4-letter room code. Computer players can fill empty seats.

Not monetised, no accounts, no tracking.

## Run it

```bash
npm install
npm start            # http://localhost:8080  (set PORT to change)
npm test             # rules engine + bot simulations
npm run build:offline  # dist/yaniv-offline.html, one file, no server needed (no online play)
```

On iPhone: open the site in Safari → Share → **Add to Home Screen**. It then opens full-screen like an app, and vs-computer games work without signal.

## How it's built

```
public/
  js/engine.js    Rules engine. Pure functions over a plain JSON state, no DOM.
  js/ai.js        Computer players.
  js/theme.js     Card art (the seam for custom decks).
  js/session.js   LocalSession (game runs in the browser) / OnlineSession (game runs on the server).
  js/ui.js        Screens and the table. Renders from a session payload; never touches game rules.
  sw.js           Service worker for offline play.
server/server.js  Static files + WebSocket rooms. Server-authoritative.
test/             node:test suite.
```

**One engine everywhere.** `engine.js` is a UMD file that runs unchanged in the browser and in Node. The server owns the real state and calls the same `applyAction(state, seat, action)` the local game uses. Clients only send intents (`{type:'play', cards:['7H','7S'], source:'deck'}`), so a modified client can't cheat by editing its state.

**Hidden information.** `viewFor(state, seat)` builds what one player may see: their own hand, everyone's hand *size*, the top of the discard pile, and cards others were seen taking from the pile. Other hands and the deck order never leave the server. The same function feeds the local UI, so pass-and-play and online look identical.

**Deterministic randomness.** Shuffles use a seeded PRNG (mulberry32) whose position lives in the state, so a saved game resumes identically and tests are reproducible.

**Computer players** use only public information. For each legal discard and each draw option they score the resulting hand: points, minus a bonus for pairs/near-runs they can dump next turn, minus a reward if the hand would be at or under the Yaniv limit. Deck draws are averaged over all 13 ranks. Without that Yaniv-reachability reward, two bots would trade the same 5s and 6s forever (the simulation tests caught this). Calling Yaniv weighs their total against a cautious estimate of each opponent's minimum (known pile pickups + ~2 per unknown card). Over 100 simulated 3-bot games, hard beat normal 62–38 and easy won none.

**Online robustness.** Each seat gets a secret token stored on the phone, and the room code stays in the URL, so refreshing or reopening the app drops you back into your seat. If a player's phone dies, a bot plays their turns after 25 seconds until they return. Moves lock the UI until the server answers, so a double tap can't send twice.

## Rules (defaults, all adjustable under House rules)

- Card points: A = 1, 2–10 face value, J/Q/K = 10. Standard 52-card deck, no jokers.
- 5 cards each. On your turn throw one card, a set of one rank, or a same-suit run of 3+ (Ace low). Then take the top of the deck, or one card the previous player threw (only an end card of a run).
- Slap-down: if you draw from the deck the same rank you just threw, you may throw it immediately.
- Call **Yaniv** at the start of your turn with 7 or less. Lowest hand scores 0, others add their hand.
- **Assaf**: if someone ties or beats the caller, they score 0 and the caller adds their hand + 30.
- Land exactly on 50/100/150… and 50 comes off. Over 200 and you're out. Last player in wins.

## Custom card art

In the app: **Card art → Choose images**. Name files by card: `AS.png`, `10H.png`, `QD.jpg`, `KC.png` (or `queen_of_hearts.png`), plus `back.png`. Portrait 5:7 (e.g. 500×700) looks best. Missing cards fall back to the classic face. Decks are stored on that device (IndexedDB).

To ship a deck to everyone, put the images in `public/cards/<name>/` and add an entry to `BUILT_IN_IMAGE_THEMES` in `public/js/theme.js`.

## Hosting

Any host that runs a Node process with WebSockets works (Render, Railway, Fly.io, a home server). A `Dockerfile` is included. Rooms are kept in memory, so restarting the server ends running games.
