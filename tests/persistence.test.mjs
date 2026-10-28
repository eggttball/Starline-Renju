import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth, finishDraw } from '../lib/game.mjs';

let persistence = {};
try { persistence = await import('../lib/persistence.mjs'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
function api() {
  for (const name of ['loadArchive', 'saveGame', 'abandonGame']) assert.equal(typeof persistence[name], 'function', `${name} must implement the archive contract`);
  assert.equal(typeof persistence.STORAGE_KEY, 'string');
  return persistence;
}

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const EARLY = '2026-10-28T01:00:00.000Z';
const LATE = '2026-10-28T02:00:00.000Z';
class Storage {
  constructor(entries = []) { this.entries = new Map(entries); this.failWrite = false; this.failRead = false; }
  getItem(key) { if (this.failRead) throw new Error('blocked'); return this.entries.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new Error('quota'); this.entries.set(key, String(value)); }
}
function fresh(mode = 'white', id = FIRST) {
  return { ...createGame(mode), id, createdAt: EARLY, updatedAt: EARLY };
}
function fourth(id = FIRST) { return decideSwap(proposeOpening(fresh('black', id), 'd3'), true); }
function playing(id = FIRST) {
  let game = placeStone(fourth(id), 0, 0);
  game = offerFifth(offerFifth(game, 7, 5), 8, 5);
  game = chooseFifth(game, 0);
  return placeStone(game, 0, 1);
}
function ended(id = FIRST, date = EARLY) { return { ...finishDraw(playing(id)), updatedAt: date }; }

test('an empty archive has no active game or historical games', () => {
  const { loadArchive } = api();
  assert.deepEqual(loadArchive(new Storage()), { active: null, history: [] });
});

test('started setup survives serialization into a fresh storage instance', () => {
  const { saveGame, loadArchive, STORAGE_KEY } = api();
  const storage = new Storage();
  const game = fresh();
  assert.deepEqual(saveGame(storage, game).active, game);
  const payload = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(payload.version, 1);
  assert.equal(storage.entries.size, 1, 'one key contains the entire archive');
  const restored = loadArchive(new Storage([...storage.entries]));
  assert.deepEqual(restored.active, game);
  restored.active.board[0] = 1;
  assert.equal(loadArchive(storage).active.board[0], 0, 'loaded snapshots are independent');
});

test('every unfinished opening phase preserves swaps and fifth candidates', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  let game = fresh('black');
  const phases = [game, proposeOpening(game, 'd3')];
  game = decideSwap(phases.at(-1), true); phases.push(game);
  game = placeStone(game, 0, 0); phases.push(game);
  game = offerFifth(game, 7, 5); phases.push(game);
  game = offerFifth(game, 8, 5); phases.push(game);
  game = chooseFifth(game, 1); phases.push(game);
  game = placeStone(game, 0, 1); phases.push(game);
  for (const phase of phases) {
    saveGame(storage, phase);
    assert.deepEqual(loadArchive(storage).active, phase, phase.phase);
  }
  assert.equal(game.players[1], 'computer');
  assert.equal(game.players[2], 'human');
});

test('a normal ended game clears active and survives in latest-first history without duplicates', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  saveGame(storage, playing());
  saveGame(storage, ended());
  assert.equal(loadArchive(storage).active, null);
  saveGame(storage, ended(SECOND, LATE));
  saveGame(storage, ended(FIRST, '2026-10-28T03:00:00.000Z'));
  const archive = loadArchive(storage);
  assert.deepEqual(archive.history.map(game => game.id), [FIRST, SECOND]);
  assert.equal(archive.history[0].updatedAt, '2026-10-28T03:00:00.000Z');
});

test('finishing a different historical game cannot erase the current unfinished game', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  saveGame(storage, fresh());
  saveGame(storage, ended(SECOND));
  assert.equal(loadArchive(storage).active.id, FIRST);
  assert.equal(loadArchive(storage).history[0].id, SECOND);
});

test('a new unfinished game cannot overwrite another active game or revive a historical game', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  saveGame(storage, fresh());
  assert.throws(() => saveGame(storage, fresh('both', SECOND)), /未完成|進行中/);
  assert.equal(loadArchive(storage).active.id, FIRST);
  saveGame(storage, ended());
  assert.throws(() => saveGame(storage, fresh()), /結束|歷史/);
});

test('abandoning unfinished play removes it without creating history', () => {
  const { saveGame, abandonGame, loadArchive } = api();
  const storage = new Storage();
  saveGame(storage, ended(SECOND));
  const active = playing(); saveGame(storage, active);
  assert.deepEqual(abandonGame(storage, THIRD).active, active);
  abandonGame(storage, FIRST);
  assert.equal(loadArchive(storage).active, null);
  assert.deepEqual(loadArchive(storage).history.map(game => game.id), [SECOND]);
  saveGame(storage, fresh('both', THIRD));
  assert.equal(loadArchive(storage).active.id, THIRD);
});

test('resignation or abandonment result cannot be archived as a normal game', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  saveGame(storage, playing());
  for (const reason of ['resignation', 'abandoned']) {
    const game = { ...playing(), phase: 'finished', result: { winner: 2, reason, winningLine: [] } };
    assert.throws(() => saveGame(storage, game), /正常|資料|有效/);
  }
  assert.equal(loadArchive(storage).active.id, FIRST);
  assert.equal(loadArchive(storage).history.length, 0);
});

test('corrupt active data is rejected while valid history and metadata survive', () => {
  const { saveGame, loadArchive, STORAGE_KEY } = api();
  const storage = new Storage();
  saveGame(storage, ended(SECOND));
  const payload = JSON.parse(storage.getItem(STORAGE_KEY));
  payload.active = { ...playing(), board: Array(224).fill(0) };
  storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  const result = loadArchive(storage);
  assert.equal(result.active, null);
  assert.deepEqual(result.history, [ended(SECOND)]);
  assert.ok(result.warnings?.length);
  saveGame(storage, fresh());
  assert.equal(loadArchive(storage).history[0].id, SECOND);
});

test('invalid archived records, duplicate history IDs, malformed JSON and unsupported versions are handled safely', () => {
  const { loadArchive, STORAGE_KEY } = api();
  for (const raw of ['{bad json', JSON.stringify({ version: 99, active: fresh(), history: [ended()] })]) {
    const result = loadArchive(new Storage([[STORAGE_KEY, raw]]));
    assert.equal(result.active, null);
    assert.deepEqual(result.history, []);
    assert.ok(result.warnings?.length);
  }
  const storage = new Storage([[STORAGE_KEY, JSON.stringify({ version: 1, active: null, history: [ended(FIRST), { nope: true }, ended(FIRST, LATE), fresh('both', SECOND)] })]]);
  const archive = loadArchive(storage);
  assert.equal(archive.history.length, 1);
  assert.equal(archive.history[0].updatedAt, LATE);
  assert.ok(archive.warnings?.length);
});

test('invalid game identity, dates, board, moves, players, phase, turn and result never overwrite storage', () => {
  const { saveGame, STORAGE_KEY } = api();
  const storage = new Storage();
  saveGame(storage, playing());
  const before = storage.getItem(STORAGE_KEY);
  const invalid = [
    { ...playing(), id: '' }, { ...playing(), createdAt: 'yesterday' }, { ...playing(), updatedAt: '2026-10-27T00:00:00.000Z' },
    { ...playing(), mode: 'robot' }, { ...playing(), phase: 'unknown' }, { ...playing(), turn: 2 },
    { ...playing(), players: { 1: 'human', 2: 'human' } }, { ...playing(), result: { winner: 1, reason: 'five', winningLine: [] } },
  ];
  const badBoard = playing(); badBoard.board[0] = 9; invalid.push(badBoard);
  const badMoves = playing(); badMoves.moves[5] = { ...badMoves.moves[0], number: 6, color: 2 }; invalid.push(badMoves);
  const mismatch = playing(); mismatch.moves[5].col = 2; invalid.push(mismatch);
  const badCandidate = fourth(); badCandidate.phase = 'choose-fifth'; badCandidate.fifthCandidates = [{ row: 7, col: 7 }, { row: 7, col: 7 }]; invalid.push(badCandidate);
  for (const game of invalid) {
    assert.throws(() => saveGame(storage, game), /資料|有效|盤面/);
    assert.equal(storage.getItem(STORAGE_KEY), before);
  }
});

test('write failures report a helpful error and retain the previously durable game', () => {
  const { saveGame, abandonGame, loadArchive, STORAGE_KEY } = api();
  const storage = new Storage();
  saveGame(storage, fresh());
  const before = storage.getItem(STORAGE_KEY);
  storage.failWrite = true;
  assert.throws(() => saveGame(storage, fourth()), /儲存|空間|瀏覽器/);
  assert.throws(() => abandonGame(storage, FIRST), /儲存|空間|瀏覽器/);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  storage.failWrite = false;
  assert.deepEqual(loadArchive(storage).active, fresh());
});

test('unreadable storage warns on load and cannot be overwritten by save or abandon', () => {
  const { loadArchive, saveGame, abandonGame, STORAGE_KEY } = api();
  const storage = new Storage();
  saveGame(storage, fresh());
  const before = storage.getItem(STORAGE_KEY);
  storage.failRead = true;
  assert.ok(loadArchive(storage).warnings?.length);
  assert.throws(() => saveGame(storage, fourth()), /讀取|儲存|瀏覽器/);
  assert.throws(() => abandonGame(storage, FIRST), /讀取|儲存|瀏覽器/);
  storage.failRead = false;
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test('all normal outcomes including five, forbidden loss and full-board draw are durable history', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  let victory = playing();
  for (const [row, col] of [[7, 6], [0, 2], [7, 8], [0, 3], [7, 9]]) victory = placeStone(victory, row, col);
  assert.equal(victory.result.reason, 'five');
  saveGame(storage, victory);

  const forbidden = playing(SECOND);
  forbidden.moves.push({ row: 7, col: 6, color: 1, number: 7 });
  forbidden.board[7 * 15 + 6] = 1;
  forbidden.phase = 'finished';
  forbidden.result = { winner: 2, reason: 'forbidden', forbiddenKind: 'double-three', attemptedMove: { row: 7, col: 6 }, winningLine: [] };
  saveGame(storage, forbidden);

  const full = proposeOpening(fresh('both', THIRD), 'd3');
  for (let index = 0; index < 225; index++) {
    if (full.board[index]) continue;
    const color = full.moves.length % 2 === 0 ? 1 : 2;
    full.board[index] = color;
    full.moves.push({ row: Math.floor(index / 15), col: index % 15, color, number: full.moves.length + 1 });
  }
  full.phase = 'finished'; full.turn = 1; full.result = { winner: null, reason: 'full-board', winningLine: [] };
  saveGame(storage, full);
  const history = loadArchive(new Storage([...storage.entries])).history;
  assert.deepEqual(new Set(history.map(game => game.result.reason)), new Set(['five', 'forbidden', 'full-board']));
  assert.deepEqual(history.find(game => game.id === SECOND).result, forbidden.result);
});

test('sparse boards and corrupt forbidden outcome details are rejected before a write', () => {
  const { saveGame, STORAGE_KEY } = api();
  const storage = new Storage(); saveGame(storage, playing());
  const before = storage.getItem(STORAGE_KEY);
  const sparse = playing(); delete sparse.board[11];
  assert.throws(() => saveGame(storage, sparse), /資料|有效|盤面/);
  const forbidden = playing();
  forbidden.moves.push({ row: 7, col: 6, color: 1, number: 7 }); forbidden.board[7 * 15 + 6] = 1; forbidden.phase = 'finished';
  for (const result of [
    { winner: 2, reason: 'forbidden', winningLine: [] },
    { winner: 2, reason: 'forbidden', forbiddenKind: 'unknown', attemptedMove: { row: 7, col: 6 }, winningLine: [] },
    { winner: 2, reason: 'forbidden', forbiddenKind: 'double-three', attemptedMove: { row: 0, col: 0 }, winningLine: [] },
  ]) assert.throws(() => saveGame(storage, { ...forbidden, result }), /資料|有效|盤面/);
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test('the game module fallback ID remains restorable when UUID generation is unavailable', () => {
  const { saveGame, loadArchive } = api();
  const storage = new Storage();
  const game = fresh('both', 'renju-mhbtz6yo-abcd1234');
  saveGame(storage, game);
  assert.deepEqual(loadArchive(storage).active, game);
});
