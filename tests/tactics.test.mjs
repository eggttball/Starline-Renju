import test from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, SIZE, createBoard, analyzeMove } from '../lib/rules.mjs';

function position(black = [], white = []) {
  const board = createBoard();
  for (const [row, col] of black) board[row * SIZE + col] = BLACK;
  for (const [row, col] of white) board[row * SIZE + col] = WHITE;
  return board;
}

async function tactics() {
  try {
    return await import('../lib/tactics.mjs');
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('the shared tactical selector has not been implemented');
    throw error;
  }
}

function expectTactic(result, move, decision, winRate) {
  assert.ok(result, 'a forced tactic should be selected');
  assert.deepEqual(result.move, move);
  assert.equal(result.decision, decision);
  assert.equal(result.winRate, winRate);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

test('Black takes a legal immediate five before defending White', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[7, 3], [7, 4], [7, 5], [7, 6]], [[3, 3], [3, 4], [3, 5], [3, 6]]);
  expectTactic(findTacticalMove(board, BLACK), { row: 7, col: 2 }, 'win', 1);
});

test('White takes an immediate five before defending Black', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[3, 3], [3, 4], [3, 5], [3, 6]], [[7, 3], [7, 4], [7, 5], [7, 6]]);
  expectTactic(findTacticalMove(board, WHITE), { row: 7, col: 2 }, 'win', 1);
});

test('White wins by completing six while the same Black pattern has no legal winning move', async () => {
  const { findTacticalMove, findWinningMoves } = await tactics();
  const stones = [[7, 2], [7, 3], [7, 4], [7, 6], [7, 7]];
  expectTactic(findTacticalMove(position([], stones), WHITE), { row: 7, col: 5 }, 'win', 1);
  assert.deepEqual(findWinningMoves(position(stones), BLACK), []);
  assert.equal(findTacticalMove(position(stones), BLACK), null);
  assert.equal(findTacticalMove(position(stones), WHITE), null, 'White must not defend an overline-only Black four');
});

test('Black blocks the only completion of White straight four', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[7, 2]], [[7, 3], [7, 4], [7, 5], [7, 6]]);
  expectTactic(findTacticalMove(board, BLACK), { row: 7, col: 7 }, 'defense', null);
});

test('White blocks the only exact-five completion of Black straight four', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[7, 3], [7, 4], [7, 5], [7, 6]], [[7, 2]]);
  expectTactic(findTacticalMove(board, WHITE), { row: 7, col: 7 }, 'defense', null);
});

test('both colors block a broken four at its gap', async () => {
  const { findTacticalMove } = await tactics();
  const stones = [[7, 3], [7, 4], [7, 6], [7, 7]];
  expectTactic(findTacticalMove(position([[7, 2]], stones), BLACK), { row: 7, col: 5 }, 'defense', null);
  expectTactic(findTacticalMove(position(stones, [[7, 2]]), WHITE), { row: 7, col: 5 }, 'defense', null);
});

test('winning scans find vertical and both diagonal gaps', async () => {
  const { findTacticalMove } = await tactics();
  for (const { stones, move } of [
    { stones: [[3, 5], [4, 5], [6, 5], [7, 5]], move: { row: 5, col: 5 } },
    { stones: [[3, 3], [4, 4], [6, 6], [7, 7]], move: { row: 5, col: 5 } },
    { stones: [[3, 8], [4, 7], [6, 5], [7, 4]], move: { row: 5, col: 6 } },
  ]) {
    expectTactic(findTacticalMove(position(stones), BLACK), move, 'win', 1);
    expectTactic(findTacticalMove(position(stones), WHITE), move, 'defense', null);
  }
});

test('an exact five remains a tactical win when it also makes an overline elsewhere', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[7, 3], [7, 4], [7, 5], [7, 6], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]], [[7, 2]]);
  expectTactic(findTacticalMove(board, BLACK), { row: 7, col: 7 }, 'win', 1);
});

test('multiple independent completions still produce a relevant defense with unknown win rate', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([], [[7, 4], [7, 5], [7, 6], [7, 7], [3, 4], [3, 5], [3, 6], [3, 7]]);
  expectTactic(findTacticalMove(board, BLACK), { row: 3, col: 3 }, 'defense', null);
});

test('Black skips a forbidden endpoint when another immediate defense is legal', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[6, 3], [8, 3], [6, 2], [8, 4]], [[7, 4], [7, 5], [7, 6], [7, 7]]);
  assert.equal(analyzeMove(board, 7, 3, BLACK).kind, 'double-three');
  assert.equal(analyzeMove(board, 7, 8, BLACK).legal, true);
  expectTactic(findTacticalMove(board, BLACK), { row: 7, col: 8 }, 'defense', null);
});

test('Black does not select a forbidden sole defensive square', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([[7, 2], [6, 7], [8, 7], [6, 6], [8, 8]], [[7, 3], [7, 4], [7, 5], [7, 6]]);
  assert.equal(analyzeMove(board, 7, 7, BLACK).kind, 'double-three');
  assert.equal(findTacticalMove(board, BLACK), null);
});

const forbiddenFourBlack = [[7, 3], [6, 8], [8, 8], [6, 7], [8, 9]];
const forbiddenFourWhite = [[7, 4], [7, 5], [7, 6]];

test('White forms a single-completion four whose only Black defense is forbidden', async () => {
  const { findTacticalMove, findWinningMoves } = await tactics();
  const board = position(forbiddenFourBlack, forbiddenFourWhite);
  const result = findTacticalMove(board, WHITE);
  expectTactic(result, { row: 7, col: 7 }, 'forbidden-four', 1);
  const after = [...board];
  after[7 * SIZE + 7] = WHITE;
  assert.equal(analyzeMove(board, 7, 7, WHITE).win, false, 'the selected move has not already ended the game');
  assert.deepEqual(findWinningMoves(after, WHITE), [{ row: 7, col: 8 }]);
  assert.equal(analyzeMove(after, 7, 8, BLACK).kind, 'double-three');
});

test('White defends an existing Black exact-five counterwin before considering a forbidden four', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([...forbiddenFourBlack, [2, 2], [2, 3], [2, 4], [2, 5]], forbiddenFourWhite);
  expectTactic(findTacticalMove(board, WHITE), { row: 2, col: 1 }, 'defense', null);
});

test('an exact-five Black defense cannot be mistaken for a forbidden defensive square', async () => {
  const { findTacticalMove } = await tactics();
  const board = position([...forbiddenFourBlack, [5, 8], [9, 8]], forbiddenFourWhite);
  assert.equal(analyzeMove(board, 7, 8, BLACK).win, true);
  expectTactic(findTacticalMove(board, WHITE), { row: 7, col: 8 }, 'defense', null);
});

test('one forbidden endpoint of an open four is insufficient for the single-completion trap', async () => {
  const { findTacticalMove } = await tactics();
  const board = position(forbiddenFourBlack.filter(([row, col]) => row !== 7 || col !== 3), forbiddenFourWhite);
  assert.equal(findTacticalMove(board, WHITE), null);
});

test('ordinary positions and invalid inputs have no forced tactical selection', async () => {
  const { findTacticalMove, findWinningMoves } = await tactics();
  for (const color of [BLACK, WHITE]) {
    assert.equal(findTacticalMove(createBoard(), color), null);
    assert.equal(findTacticalMove(position([[7, 7]], [[7, 8]]), color), null);
  }
  assert.equal(findTacticalMove([0], BLACK), null);
  assert.equal(findTacticalMove(Array(225), BLACK), null);
  assert.equal(findTacticalMove(createBoard(), 3), null);
  assert.deepEqual(findWinningMoves(createBoard(), 3), []);
});

test('tactical selection is deterministic and preserves a frozen caller board', async () => {
  const { findTacticalMove, findWinningMoves } = await tactics();
  const board = Object.freeze(position(forbiddenFourBlack, forbiddenFourWhite));
  const before = [...board];
  const first = findTacticalMove(board, WHITE);
  assert.deepEqual(findTacticalMove(board, WHITE), first);
  assert.deepEqual(findWinningMoves(board, BLACK), []);
  assert.deepEqual(board, before);
});
