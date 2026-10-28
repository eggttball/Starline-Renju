import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

let createBook;
test('private position book exports an async load/query/record interface', async () => {
  await assert.doesNotReject(async () => { ({ createBook } = await import('../lib/book.mjs')); });
  const book = createBook();
  assert.equal(typeof book.load, 'function');
  assert.equal(typeof book.query, 'function');
  assert.equal(typeof book.record, 'function');
});

const move = { row: 5, col: 8 };
const alternate = { row: 4, col: 5 };
function board() {
  const value = Array(225).fill(0);
  for (const [row, col, color] of [[7, 7, 1], [6, 7, 2], [6, 9, 1], [5, 5, 2], [9, 6, 1], [8, 10, 2]]) value[row * 15 + col] = color;
  return value;
}
function pointTransform(point, symmetry) {
  let row = point.row, col = point.col;
  if (symmetry >= 4) col = 14 - col;
  for (let turn = 0; turn < symmetry % 4; turn++) [row, col] = [col, 14 - row];
  return { row, col };
}
function boardTransform(value, symmetry) {
  const result = Array(225).fill(0);
  for (let index = 0; index < 225; index++) {
    const target = pointTransform({ row: Math.floor(index / 15), col: index % 15 }, symmetry);
    result[target.row * 15 + target.col] = value[index];
  }
  return result;
}
const position = (value = board(), color = 1) => ({ board: value, color, legalMoves: [move, alternate] });

test('thresholds store exceptional new rates and always overwrite an existing rate with its newest value', async () => {
  const book = createBook();
  const state = position();
  assert.equal((await book.record({ ...state, move, winRate: .65 })).stored, false);
  assert.equal((await book.query(state)).knownMoves.length, 0);
  assert.equal((await book.record({ ...state, move, winRate: .8 })).stored, true);
  assert.deepEqual((await book.query(state)).preferredMove, { ...move, winRate: .8 });
  await book.record({ ...state, move, winRate: .65 });
  let policy = await book.query(state);
  assert.equal(policy.preferredMove, null);
  assert.equal(policy.knownMoves[0].winRate, .65);
  await book.record({ ...state, move, winRate: .35 });
  policy = await book.query(state);
  assert.equal(policy.knownMoves[0].winRate, .35);
  assert.deepEqual(policy.legalMoves, [alternate]);
  await book.record({ ...state, move, winRate: .7 });
  assert.equal((await book.query(state)).preferredMove.winRate, .7);
  assert.equal((await book.record({ ...state, move: alternate, winRate: .4 })).stored, false);
  assert.equal((await book.record({ ...state, move: alternate, winRate: .399 })).stored, true);
});

test('all eight rotations/reflections reuse one canonical position and map remembered moves to the current board', async () => {
  const book = createBook();
  await book.record({ board: board(), color: 1, move, winRate: .9 });
  for (let symmetry = 0; symmetry < 8; symmetry++) {
    const transformedMove = pointTransform(move, symmetry);
    const transformedBoard = boardTransform(board(), symmetry);
    const policy = await book.query({ board: transformedBoard, color: 1, legalMoves: [transformedMove, pointTransform(alternate, symmetry)] });
    assert.deepEqual(policy.preferredMove, { ...transformedMove, winRate: symmetry === 0 ? .9 : Number((.7 + (symmetry - 1) / 100).toFixed(2)) }, `symmetry ${symmetry}`);
    await book.record({ board: transformedBoard, color: 1, move: transformedMove, winRate: Number((.7 + symmetry / 100).toFixed(2)) });
  }
  assert.deepEqual(await book.load(), { positions: 1, moves: 1 });
  assert.equal((await book.query(position())).knownMoves[0].winRate, .77);
  assert.equal((await book.query(position(board(), 2))).knownMoves.length, 0, 'black and white memories are separate');
});

test('symmetric boards also share symmetry-equivalent move entries', async () => {
  const book = createBook();
  const value = Array(225).fill(0); value[112] = 1;
  const first = { row: 7, col: 8 }, reflected = { row: 7, col: 6 };
  await book.record({ board: value, color: 2, move: first, winRate: .8 });
  assert.deepEqual((await book.query({ board: value, color: 2, legalMoves: [reflected] })).preferredMove, { ...reflected, winRate: .8 });
  await book.record({ board: value, color: 2, move: reflected, winRate: .55 });
  assert.deepEqual(await book.load(), { positions: 1, moves: 1 });
  assert.equal((await book.query({ board: value, color: 2, legalMoves: [first] })).knownMoves[0].winRate, .55);
});

test('highest remembered high move is preferred, low moves are excluded only when an alternative exists', async () => {
  const book = createBook();
  const state = position();
  await book.record({ ...state, move, winRate: .71 });
  await book.record({ ...state, move: alternate, winRate: .88 });
  assert.deepEqual((await book.query(state)).preferredMove, { ...alternate, winRate: .88 });
  await book.record({ ...state, move, winRate: .25 });
  await book.record({ ...state, move: alternate, winRate: .15 });
  let policy = await book.query(state);
  assert.equal(policy.preferredMove, null);
  assert.deepEqual(policy.legalMoves, state.legalMoves, 'all low choices remain available when there is no alternative');
  const unknown = { row: 0, col: 0 };
  policy = await book.query({ ...state, legalMoves: [...state.legalMoves, unknown] });
  assert.deepEqual(policy.legalMoves, [unknown]);
  assert.equal(policy.avoidedMoves.length, 2);
});

test('record validation rejects impossible boards, occupied points, and invalid probabilities', async () => {
  const book = createBook();
  const sparse = board(); delete sparse[0];
  for (const invalid of [
    { board: Array(224).fill(0), color: 1, move, winRate: .9 },
    { board: sparse, color: 1, move, winRate: .9 },
    { board: board(), color: 3, move, winRate: .9 },
    { board: board(), color: 1, move: { row: 7, col: 7 }, winRate: .9 },
    { board: board(), color: 1, move: { row: 15, col: 0 }, winRate: .9 },
    { board: board(), color: 1, move, winRate: '0.9' },
    { board: board(), color: 1, move, winRate: NaN },
    { board: board(), color: 1, move, winRate: 1.1 },
  ]) await assert.rejects(book.record(invalid), /盤面|顏色|落點|勝率/);
  assert.deepEqual(await book.load(), { positions: 0, moves: 0 });
});

test('atomic persistent updates survive reload and serialize concurrent newest-rate writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'renju-book-'));
  const filePath = path.join(directory, 'private', 'ai-book.json');
  try {
    const book = createBook({ filePath });
    await book.record({ ...position(), move, winRate: .8 });
    await Promise.all([.75, .9, .65, .35].map((winRate) => book.record({ ...position(), move, winRate })));
    const reloaded = createBook({ filePath });
    assert.equal((await reloaded.query(position())).knownMoves[0].winRate, .35);
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(payload.version, 1);
    assert.ok(!JSON.stringify(payload).includes('maxWinRate'));
    assert.deepEqual(await readdir(path.dirname(filePath)), ['ai-book.json']);
    await reloaded.record({ ...position(), move, winRate: .65 });
    assert.equal((await createBook({ filePath }).query(position())).knownMoves[0].winRate, .65);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt persistent memory is reported and never silently overwritten', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'renju-book-corrupt-'));
  const filePath = path.join(directory, 'ai-book.json');
  try {
    await writeFile(filePath, 'not valid JSON');
    const book = createBook({ filePath });
    await assert.rejects(book.load(), /記憶|資料/);
    await assert.rejects(book.record({ ...position(), move, winRate: .9 }), /記憶|資料/);
    assert.equal(await readFile(filePath, 'utf8'), 'not valid JSON');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
