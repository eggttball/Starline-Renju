import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  SIZE,
  createBoard,
  analyzeMove,
  getLegalMoves,
  toCoordinate,
  isBlackForbiddenFast,
  computeForbiddenMap,
} from '../lib/rules.mjs';

function position(black = [], white = []) {
  const board = createBoard();
  for (const [row, col] of black) board[row * SIZE + col] = BLACK;
  for (const [row, col] of white) board[row * SIZE + col] = WHITE;
  return board;
}

function expectMove(board, row, col, color, expected) {
  const before = [...board];
  const result = analyzeMove(board, row, col, color);
  assert.deepEqual(board, before, 'analysis must preserve the caller board');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, key);
  assert.equal(typeof result.reason, 'string');
  assert.ok(Array.isArray(result.winningLine));
  return result;
}

test('board and coordinates provide independent 15 by 15 positions', () => {
  const first = createBoard();
  first[0] = BLACK;
  assert.equal(first.length, 225);
  assert.equal(createBoard()[0], 0);
  assert.equal(toCoordinate(0, 0), 'A15');
  assert.equal(toCoordinate(14, 14), 'O1');
  assert.equal(toCoordinate(7, 7), 'H8');
});

test('invalid and occupied moves are rejected without changing the board', () => {
  const board = position([[7, 7]]);
  expectMove(board, -1, 7, BLACK, { legal: false, kind: 'invalid', win: false });
  expectMove(board, 7, 15, BLACK, { legal: false, kind: 'invalid', win: false });
  expectMove(board, 7.5, 7, BLACK, { legal: false, kind: 'invalid', win: false });
  expectMove(board, 7, 8, 3, { legal: false, kind: 'invalid', win: false });
  expectMove(board, 7, 7, WHITE, { legal: false, kind: 'occupied', win: false });
  assert.equal(analyzeMove([0], 0, 0, BLACK).kind, 'invalid');
  assert.equal(analyzeMove(Array(225), 7, 7, BLACK).kind, 'invalid', 'sparse arrays are not valid boards');
});

test('an ordinary move is legal', () => {
  expectMove(createBoard(), 7, 7, BLACK, { legal: true, kind: 'normal', win: false, fours: 0, threes: 0 });
});

test('black wins by exact five and returns the actual winning stones', () => {
  const board = position([[7, 3], [7, 4], [7, 5], [7, 6]]);
  const result = expectMove(board, 7, 7, BLACK, { legal: true, kind: 'five', win: true });
  assert.deepEqual(result.winningLine, [3, 4, 5, 6, 7].map(col => ({ row: 7, col })));
});

test('black overline is forbidden while white overline wins', () => {
  const stones = [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6]];
  expectMove(position(stones), 7, 7, BLACK, { legal: false, kind: 'overline', win: false });
  const result = expectMove(position([], stones), 7, 7, WHITE, { legal: true, kind: 'five', win: true });
  assert.equal(result.winningLine.length, 6);
});

test('RIF 9.2 exact five wins even when the same move makes an overline in another direction', () => {
  const board = position([[7, 3], [7, 4], [7, 5], [7, 6], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]]);
  expectMove(board, 7, 7, BLACK, { legal: true, kind: 'five', win: true });
});

test('one open straight four is counted once despite two winning ends', () => {
  expectMove(position([[7, 5], [7, 6], [7, 8]]), 7, 7, BLACK,
    { legal: true, kind: 'normal', win: false, fours: 1 });
});

test('two distinct fours in crossing directions are forbidden for black', () => {
  const stones = [[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]];
  expectMove(position(stones), 7, 7, BLACK, { legal: false, kind: 'double-four', fours: 2 });
  expectMove(position([], stones), 7, 7, WHITE, { legal: true, kind: 'normal', fours: 2 });
});

test('two distinct fours in the same direction are forbidden', () => {
  // XXX . move . XXX: either gap completes a different set of four stones.
  expectMove(position([[7, 3], [7, 4], [7, 5], [7, 9], [7, 10], [7, 11]]), 7, 7, BLACK,
    { legal: false, kind: 'double-four', fours: 2 });
});

test('two active threes are forbidden for black and legal for white', () => {
  const stones = [[7, 6], [7, 8], [6, 7], [8, 7]];
  expectMove(position(stones), 7, 7, BLACK, { legal: false, kind: 'double-three', threes: 2 });
  expectMove(position([], stones), 7, 7, WHITE, { legal: true, kind: 'normal', threes: 2 });
});

test('a blocked three and a board-edge three do not cause double-three', () => {
  expectMove(position([[7, 6], [7, 8], [6, 7], [8, 7]], [[7, 5], [7, 9]]), 7, 7, BLACK,
    { legal: true, kind: 'normal', threes: 1 });
  expectMove(position([[0, 0], [0, 2], [1, 1], [2, 1]]), 0, 1, BLACK,
    { legal: true, kind: 'normal', threes: 0 });
});

test('a three whose straight-four extensions both overline is a false three', () => {
  const stones = [[7, 6], [7, 8], [6, 7], [8, 7]];
  for (const col of [5, 9]) for (const row of [3, 4, 5, 6, 8]) stones.push([row, col]);
  expectMove(position(stones), 7, 7, BLACK, { legal: true, kind: 'normal', threes: 1 });
});

test('a three whose straight-four extensions both make double-four is a false three', () => {
  const stones = [[7, 6], [7, 8], [6, 7], [8, 7]];
  for (const col of [5, 9]) for (const row of [4, 5, 6]) stones.push([row, col]);
  expectMove(position(stones), 7, 7, BLACK, { legal: true, kind: 'normal', threes: 1 });
});

test('an extension that simultaneously attains five cannot activate a three', () => {
  const stones = [[7, 6], [7, 8], [6, 7], [8, 7]];
  for (const col of [5, 9]) for (const row of [3, 4, 5, 6]) stones.push([row, col]);
  expectMove(position(stones), 7, 7, BLACK, { legal: true, kind: 'normal', threes: 1 });
});

test('straight-four extensions forbidden by their own active double-three are recursively excluded', () => {
  // The broken horizontal three has just one straight-four extension, G8.
  // G8 makes both a vertical and diagonal active three, so only the centre's
  // vertical three remains active.
  const stones = [[7, 5], [7, 8], [6, 7], [8, 7], [6, 6], [8, 6], [6, 5]];
  const board = position(stones);
  board[7 * SIZE + 7] = BLACK;
  expectMove(board, 7, 6, BLACK, { legal: false, kind: 'double-three', threes: 2 });
  board[7 * SIZE + 7] = 0;
  expectMove(board, 7, 7, BLACK, { legal: true, kind: 'normal', threes: 1 });
});

test('a continuation remains legal when its own apparent double-three contains a deeper false three', () => {
  const stones = [[7, 5], [7, 8], [6, 7], [8, 7], [6, 6], [8, 6], [6, 5],
    [3, 4], [4, 5], [8, 9], [6, 9], [10, 5], [11, 4]];
  const board = position(stones);
  board[7 * SIZE + 7] = BLACK;
  board[7 * SIZE + 6] = BLACK;
  // Both extensions of G8's vertical three would overline along a diagonal.
  expectMove(board, 5, 6, BLACK, { legal: false, kind: 'overline' });
  expectMove(board, 9, 6, BLACK, { legal: false, kind: 'overline' });
  board[7 * SIZE + 6] = 0;
  expectMove(board, 7, 6, BLACK, { legal: true, kind: 'normal', fours: 1, threes: 1 });
  board[7 * SIZE + 7] = 0;
  // G8 is therefore a legal extension and the original horizontal three is active.
  expectMove(board, 7, 7, BLACK, { legal: false, kind: 'double-three', threes: 2 });
});

test('an apparent open four with one overline completion cannot activate a three', () => {
  // The isolated outer stones prevent both extensions from producing a four with two exact-five ends.
  expectMove(position([[7, 3], [7, 6], [7, 8], [7, 11], [6, 7], [8, 7]]), 7, 7, BLACK,
    { legal: true, kind: 'normal', threes: 1 });
});

test('legality is preserved under all eight board symmetries', () => {
  const stones = [[7, 3], [7, 4], [7, 5], [7, 9], [7, 10], [7, 11]];
  for (let reflection = 0; reflection < 2; reflection++) {
    for (let rotations = 0; rotations < 4; rotations++) {
      const transform = ([row, col]) => {
        if (reflection) col = 14 - col;
        for (let i = 0; i < rotations; i++) [row, col] = [col, 14 - row];
        return [row, col];
      };
      const [row, col] = transform([7, 7]);
      expectMove(position(stones.map(transform)), row, col, BLACK,
        { legal: false, kind: 'double-four', fours: 2 });
    }
  }
});

test('legal move enumeration excludes occupied and forbidden cells and preserves the board', () => {
  const board = position([[7, 6], [7, 8], [6, 7], [8, 7]]);
  const before = [...board];
  const moves = getLegalMoves(board, BLACK);
  assert.equal(moves.some(({ row, col }) => row === 7 && col === 7), false);
  assert.equal(moves.some(({ row, col }) => row === 7 && col === 6), false);
  assert.equal(moves.some(({ row, col }) => row === 0 && col === 0), true);
  assert.deepEqual(board, before);
  assert.equal(getLegalMoves(board, WHITE).length, 221);
});

test('nearby candidate enumeration starts at centre and covers distance two from existing stones', () => {
  assert.deepEqual(getLegalMoves(createBoard(), BLACK, { nearby: true }), [{ row: 7, col: 7 }]);
  const moves = getLegalMoves(position([[0, 0]]), BLACK, { nearby: true });
  assert.deepEqual(moves, [
    { row: 0, col: 1 }, { row: 0, col: 2 },
    { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 },
    { row: 2, col: 0 }, { row: 2, col: 1 }, { row: 2, col: 2 },
  ]);
  assert.equal(getLegalMoves(createBoard(), BLACK).length, 225);
});

test('Renju 4-4-3 and 4-3-3 compound fouls with straight/jump fours and live/jump threes are forbidden', () => {
  // 4-4-3: horizontal straight-4 + vertical jump-4 + diagonal jump-3
  const f443 = expectMove(
    position([[7, 4], [7, 5], [7, 6], [3, 7], [4, 7], [6, 7], [5, 5], [8, 8]]),
    7,
    7,
    BLACK,
    { legal: false, kind: 'double-four', fours: 2, threes: 1 },
  );
  assert.match(f443.reason, /四四三/);

  // 4-3-3: horizontal jump-4 + vertical straight open-3 + diagonal jump-3
  const f433 = expectMove(
    position([[7, 3], [7, 4], [7, 6], [6, 7], [8, 7], [5, 5], [8, 8]]),
    7,
    7,
    BLACK,
    { legal: false, kind: 'double-three', fours: 1, threes: 2 },
  );
  assert.match(f433.reason, /四三三/);

  // Legal 4-3: jump-4 + jump-3 is permitted for Black
  expectMove(
    position([[7, 3], [7, 4], [7, 6], [5, 7], [8, 7]]),
    7,
    7,
    BLACK,
    { legal: true, kind: 'normal', fours: 1, threes: 1 },
  );
});

test('jump-4, jump-3, same-line 4-4, 7-in-a-row overline, and exact-5 priority behave per RIF rules', () => {
  // Jump-3 + jump-3 double-three
  expectMove(position([[7, 5], [7, 8], [5, 7], [8, 7]]), 7, 7, BLACK, { legal: false, kind: 'double-three', threes: 2 });
  // Jump-4 + jump-4 double-four
  expectMove(position([[7, 3], [7, 4], [7, 6], [3, 7], [4, 7], [6, 7]]), 7, 7, BLACK, { legal: false, kind: 'double-four', fours: 2 });
  // Same-line double jump-4: X.XMX.X
  expectMove(position([[7, 4], [7, 6], [7, 8], [7, 10]]), 7, 7, BLACK, { legal: false, kind: 'double-four', fours: 2 });
  // 7-in-a-row overline
  expectMove(position([[7, 4], [7, 5], [7, 6], [7, 8], [7, 9], [7, 10]]), 7, 7, BLACK, { legal: false, kind: 'overline' });
  // Exact 5 overrides 4-3-3 / 4-4-3
  expectMove(
    position([[7, 3], [7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7], [5, 5], [8, 8]]),
    7,
    7,
    BLACK,
    { legal: true, kind: 'five', win: true },
  );
  // White has no forbidden moves for 4-4-3 or 6+
  expectMove(
    position([], [[7, 4], [7, 5], [7, 6], [3, 7], [4, 7], [6, 7], [5, 5], [8, 8]]),
    7,
    7,
    WHITE,
    { legal: true, kind: 'normal', fours: 2 },
  );
});

test('fast KataGomo-style forbidden map and checker match analyzeMove across 100 dense boards', () => {
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let b = 0; b < 100; b++) {
    const board = createBoard();
    const stones = 14 + Math.floor(rand() * 28);
    for (let i = 0; i < stones; i++) {
      const r = 3 + Math.floor(rand() * 9);
      const c = 3 + Math.floor(rand() * 9);
      if (board[r * SIZE + c] === 0) board[r * SIZE + c] = i % 3 === 0 ? WHITE : BLACK;
    }
    const frozen = Object.freeze([...board]);
    const map = computeForbiddenMap(frozen);
    for (let idx = 0; idx < SIZE * SIZE; idx++) {
      if (frozen[idx] !== 0) {
        assert.equal(map[idx], 0);
        continue;
      }
      const expected = !analyzeMove(frozen, Math.floor(idx / SIZE), idx % SIZE, BLACK).legal;
      assert.equal(map[idx] === 1, expected, `map mismatch at board ${b} idx ${idx}`);
      assert.equal(isBlackForbiddenFast(frozen, idx), expected, `fast mismatch at board ${b} idx ${idx}`);
    }
  }
});
