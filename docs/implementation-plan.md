# Renju Implementation Plan

> **For agentic workers:** Use focused implementation and independent review. Steps use checkbox syntax for tracking.

**Goal:** A playable Traditional Chinese browser Renju game with classic RIF opening, black forbidden moves, color swapping, and server-side AI integration.

**Architecture:** Pure rule and state modules shared by browser and server. A standalone Node HTTP server keeps AI credentials private and verifies every requested black move. The browser renders the board and drives human/computer actions from the current RIF phase.

**Tech Stack:** Node.js 22+, HTML/CSS, ES modules, node:test. No added runtime dependencies.

**Spec:** `renju/docs/design.md`

## Global Constraints

- All files live in `renju/`; existing classroom behavior stays independent.
- Use official classic RIF opening, not Taraguchi-10 or Swap2.
- AI black normal-play turns always use the remote API; failures pause with retry.
- Credentials exist only in server environment, never browser assets or responses.
- Empirical win rates must have verifiable sources; unknown/theoretical figures must be labeled.
- Color choice is tentative until the RIF swap decision.

### Task 1: Rule engine

Files: `lib/rules.mjs`, `tests/rules.test.mjs`.
Interfaces: `SIZE=15`, `BLACK=1`, `WHITE=2`, `createBoard() => number[225]`, `analyzeMove(board,row,col,color) => {legal,reason,win,kind,winningLine}`, `getLegalMoves(board,color,{nearby}) => {row,col}[]`, `toCoordinate(row,col)`.

- [x] Write and run failing fixtures for exact black five, white overline, black overline, crossing double-four and double-three, same-line double-four, blocked fake-three, recursively forbidden extension, and exact five priority.
- [x] Implement distinct four sets and legal recursive straight-four extension checks.
- [x] Run `node --test renju/tests/rules.test.mjs` and inspect failures.

### Task 2: Openings and game state

Files: `lib/openings.mjs`, `lib/game.mjs`, `lib/local-ai.mjs`, `data/opening-rates.json`, `tests/game.test.mjs`.
Interfaces: opening records `{id,name,category,stones:[{row,col,color}],blackWinRate,rateKind,source}`; game `{board,moves,phase,players,turn,openingId,fifthCandidates,result}`. Phases `setup`, `swap`, `fourth`, `offer-fifth`, `choose-fifth`, `playing`, `finished`.

- [x] Test three-stone proposal, reassignment on swap, fourth→two fifths→white sixth, equivalent candidate rejection, and swap-aware probability score `Math.min(p,1-p)`.
- [x] Implement immutable state transitions and tactical local white/opening choices.
- [x] Run `node --test renju/tests/game.test.mjs`.

### Task 3: AI adapter and standalone server

Files: `server.mjs`, `lib/agent.mjs`, `.env.example`, `.gitignore`, `package.json`, `tests/server.test.mjs`.
Interfaces: `GET /api/config` returns readiness and format, `GET /api/openings` returns sourced opening data, `POST /api/agent` accepts `{board,moves}` and returns `{move:{row,col},reason}`; `createServer({config,fetchImpl})` permits isolated HTTP tests.

- [x] Test missing config, malformed board, occupied/forbidden moves, timeout/upstream errors, each response adapter, and inability to download `.env`/server source.
- [x] Implement environment loading, allowlisted static assets, JSON input limits and AI validation.
- [x] Run `node --test renju/tests/server.test.mjs`.

### Task 4: UI and delivery

Files: `index.html`, `styles.css`, `app.mjs`, `README.md`, `tests/ui.test.mjs`.

- [x] Build responsive board, phase actions, opening previews, mode selector, role display, retry, resignation, draw, move log and export.
- [x] Verify UI behavior with jsdom/in-app browser, including swap, fifth selection and paused unconfigured black agent.
- [x] Run `node --test renju/tests/*.test.mjs`, existing `npm test`, and inspect desktop/mobile screenshots.
- [x] Document `cd renju && npm start`, `.env` placement, formats, sourced balance data and remote verification limitation.

### Task 5: Automatic continuation and historical games

- [x] Implement versioned browser storage preserving every unfinished RIF phase and normal ending, with explicit abandonment and atomic save failures.
- [x] Show all finished games on the main page with board, move history, and export.
- [x] Verify storage tests (16) and integrated UI tests (12), including reload, forbidden loss, and active-game overwrite protection.

### Task 6: Private computer win-rate book

- [x] Implement canonical 15×15 board/color/move records with eight symmetries and atomic private server persistence.
- [x] Record new rates >=70% or <40%; always overwrite existing rates with the newest value. Automatically prefer >=70%, reevaluate40–69%, avoid<40% when alternatives exist.
- [x] Preserve black API evaluation on every normal turn, including cached preferences; configured white also uses remote evaluations.
- [x] Verify combined book/server tests (38), including thresholds, downgrades, symmetry, replay, cancellation, and private file isolation.

Final verification on 2026-10-28: 102 Renju tests and138 existing repository tests passed. Real browser RIF six-stone opening, reload continuation, agreed-draw archive, history viewing, 390px mobile layout, and empty console-error collection passed. Actual paid endpoint compatibility remains to be verified after endpoint/key are provided.
