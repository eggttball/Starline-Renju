import assert from 'node:assert/strict';
import test from 'node:test';
import { BLACK, WHITE, SIZE, createBoard, analyzeMove } from '../lib/rules.mjs';
import { solveVCF, solveVCT, searchBestMove, rankMoves } from '../lib/engine.mjs';
import { chooseLocalMove } from '../lib/local-ai.mjs';
import { createBook } from '../lib/book.mjs';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth } from '../lib/game.mjs';
import { createServer } from '../server.mjs';

function position(black = [], white = []) {
  const board = createBoard();
  for (const [r, c] of black) board[r * SIZE + c] = BLACK;
  for (const [r, c] of white) board[r * SIZE + c] = WHITE;
  return board;
}

test('solveVCF finds a multi-step forced four win including jump-fours', () => {
  // Black can play (7,7) making vertical jump-4 (4,7),(5,7),(7,7),(8,7) -> forced block (6,7),
  // wait: let's build a clean 2-step VCF for Black:
  // Black has (7,4),(7,5),(7,6) [open-3? no, blocked at (7,3) by white], wait:
  // Step 1: Black plays (7,7) making sleep-4 at (7,4)-(7,8) with White at (7,3) -> forced block (7,8).
  // Step 2: Black already has (5,7),(6,7),(9,7) -> after (7,7), Black plays (8,7) making open-4 along col 7!
  const board = position(
    [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7], [9, 7]],
    [[7, 3], [4, 7]],
  );
  // Wait: if White is at (4,7) and Black at (5,7),(6,7),(7,7),(9,7), playing (8,7) makes 5 immediately!
  // Let's make Step 2 an open-4 at col 7: White blocks nothing at (4,7), Black has (5,7),(6,7) and plays (7,7) -> 3 in col 7, then (8,7) -> open 4!
  const vcfBoard = position(
    [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7]],
    [[7, 3], [0, 0]],
  );
  const res = solveVCF(vcfBoard, BLACK, { maxDepth: 10 });
  assert.equal(res.win, true);
  assert.deepEqual(res.move, { row: 7, col: 7 });
});

test('solveVCF recognizes White forbidden-four trap where Black forced defense is 3-3', () => {
  const board = position(
    [[7, 3], [6, 8], [8, 8], [6, 7], [8, 9]],
    [[7, 4], [7, 5], [7, 6]],
  );
  const res = solveVCF(board, WHITE, { maxDepth: 6 });
  assert.equal(res.win, true);
  assert.deepEqual(res.move, { row: 7, col: 7 });
});

test('solveVCF prevents Black from using a forbidden move as part of VCF', () => {
  // Playing (7,7) would be Black double-four (forbidden).
  // (7,8) and (8,7) are jump-fours whose forced defense is (7,7) by White, leaving Black with no VCF.
  const board = position(
    [[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]],
    [[7, 3], [3, 7], [7, 9], [9, 7]],
  );
  assert.equal(analyzeMove(board, 7, 7, BLACK).kind, 'double-four');
  const res = solveVCF(board, BLACK, { maxDepth: 6 });
  assert.equal(res.win, false);
});

test('solveVCT detects a winning 4-3 fork and continuous open-3 threats', () => {
  // Black plays (7,7) to form jump-4 + open-3 (wait: (7,7) makes sleep-4 on row 7 and open-3 on col 7 -> 4-3 win!)
  const board = position(
    [[7, 4], [7, 5], [7, 6], [6, 7], [8, 7]],
    [[7, 3], [0, 0]],
  );
  const res = solveVCT(board, BLACK, { maxDepth: 4 });
  assert.equal(res.win, true);
  assert.deepEqual(res.move, { row: 7, col: 7 });
});

test('searchBestMove blocks opponent open-3 / jump-3 threats and wins immediately when available', () => {
  // White has jump-3 at (7,4), (7,5), (7,7) -> Black must block one of (7,3), (7,6), (7,8)
  const defendJump3 = position([[2, 2], [2, 4], [3, 3]], [[7, 4], [7, 5], [7, 7]]);
  const move = searchBestMove(defendJump3, BLACK, { timeBudgetMs: 120, maxDepth: 4 }).move;
  assert.equal(move.row, 7);
  assert.ok([3, 6, 8].includes(move.col), `expected block on jump-3 line, got ${JSON.stringify(move)}`);

  // Exact-5 priority over overline for Black (White blocks [7,2], so [7,7] is the sole exact-5 win)
  const exact5 = position([[7, 3], [7, 4], [7, 5], [7, 6], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]], [[7, 2]]);
  const winMove = searchBestMove(exact5, BLACK, { timeBudgetMs: 100 }).move;
  assert.deepEqual(winMove, { row: 7, col: 7 });
});

test('searchBestMove SearchDefend refutes opponent VCF instead of making irrelevant moves', () => {
  // White threatens immediate 2-step VCF starting at (7,7) (White has (7,4),(7,5),(7,6) blocked at (7,3), plus (5,7),(6,7)).
  // Wait: if Black blocks (7,7), White cannot play (7,7)!
  const board = position(
    [[7, 3], [1, 1], [1, 3]],
    [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7]],
  );
  const res = searchBestMove(board, BLACK, { timeBudgetMs: 250, maxDepth: 5 });
  assert.equal(analyzeMove(board, res.move.row, res.move.col, BLACK).legal, true);
  // After Black plays res.move, White must NOT still have a trivial 2-step VCF at (7,7)
  const after = [...board];
  after[res.move.row * SIZE + res.move.col] = BLACK;
  const oppVcfAfter = solveVCF(after, WHITE, { maxDepth: 6 });
  assert.equal(oppVcfAfter.win, false, `Black move ${JSON.stringify(res.move)} should refute White VCF`);
});

test('Black AI never returns a forbidden move even when surrounded by tempting 4-4-3 / 4-3-3 / 3-3 traps', () => {
  const board = Object.freeze(position(
    [[7, 3], [7, 4], [7, 6], [6, 7], [8, 7], [5, 5], [8, 8]],
    [[2, 2], [2, 4], [12, 12]],
  ));
  const res = searchBestMove(board, BLACK, { timeBudgetMs: 120, maxDepth: 4 });
  assert.equal(analyzeMove(board, res.move.row, res.move.col, BLACK).legal, true);
  const local = chooseLocalMove(board, BLACK);
  assert.equal(analyzeMove(board, local.row, local.col, BLACK).legal, true);
  const ranked = rankMoves(board, BLACK);
  assert.equal(ranked.some((m) => m.row === 7 && m.col === 7), false);
});

test('default zero-config server uses local fused engine for both Black and White without any API key or model', async () => {
  let game = decideSwap(proposeOpening(createGame('both'), 'd3'), false);
  game = placeStone(game, 6, 8);
  game = offerFifth(offerFifth(game, 8, 6), 8, 7);
  game = chooseFifth(game, 0);
  game = placeStone(game, 9, 7);

  const book = createBook();
  const server = createServer({ config: {}, book });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${origin}/api/config`)).json();
    assert.deepEqual(cfg, { configured: true, format: 'local-engine', model: 'starline-fusion' });

    const resBlack = await fetch(`${origin}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: game.board, moves: game.moves }),
    });
    assert.equal(resBlack.status, 200);
    const dataBlack = await resBlack.json();
    assert.equal(analyzeMove(game.board, dataBlack.move.row, dataBlack.move.col, BLACK).legal, true);
    assert.ok(dataBlack.winRate >= 0 && dataBlack.winRate <= 1);
    assert.ok(dataBlack.reason.length > 0);

    game = placeStone(game, dataBlack.move.row, dataBlack.move.col);
    const resWhite = await fetch(`${origin}/api/white`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: game.board, moves: game.moves }),
    });
    assert.equal(resWhite.status, 200);
    const dataWhite = await resWhite.json();
    assert.equal(analyzeMove(game.board, dataWhite.move.row, dataWhite.move.col, WHITE).legal, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
