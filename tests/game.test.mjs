import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth, resignGame, finishDraw, currentActor, equivalentFifths } from '../lib/game.mjs';
import { OPENINGS, swapScore, selectComputerOpening } from '../lib/openings.mjs';
import { chooseLocalMove, computerShouldSwap, chooseLocalFifths } from '../lib/local-ai.mjs';

function normalGame(mode='black') {
  let game = decideSwap(proposeOpening(createGame(mode), 'd4'), false);
  game = placeStone(game, 8, 8);
  game = offerFifth(offerFifth(game, 5, 5), 9, 7);
  game = chooseFifth(game, 1);
  return placeStone(game, 8, 7);
}

function blackPosition(stones) {
  let game = normalGame();
  const whiteMoves = [[0,0],[0,2],[0,4],[2,0],[2,2],[2,4],[4,0],[4,2],[4,4]];
  for (let index=0;index<stones.length;index++) {
    game = placeStone(game, ...stones[index]);
    game = placeStone(game, ...whiteMoves[index]);
  }
  assert.equal(game.phase, 'playing');
  assert.equal(game.turn, 1);
  return game;
}

test('human provisional white can take black after computer proposes three stones', () => {
  const initial = createGame('white');
  const offered = proposeOpening(initial, 'd4');
  assert.equal(initial.moves.length, 0);
  assert.deepEqual(offered.moves.map(m => [m.row,m.col,m.color]), [[7,7,1],[6,7,2],[6,8,1]]);
  assert.equal(offered.phase, 'swap');
  assert.equal(currentActor(offered), 'human');
  const swapped = decideSwap(offered, true);
  assert.equal(swapped.players[1], 'human');
  assert.equal(swapped.players[2], 'computer');
  assert.equal(swapped.phase, 'fourth');
  assert.equal(currentActor(swapped), 'computer');
  assert.equal(swapped.turn, 2);
});

test('RIF fourth, two fifth choices, white selection, then white sixth', () => {
  let game = decideSwap(proposeOpening(createGame('both'), 'd4'), false);
  game = placeStone(game, 8, 8);
  assert.equal(game.phase, 'offer-fifth');
  game = offerFifth(game, 5, 5);
  assert.equal(game.moves.length, 4);
  assert.equal(game.board[5*15+5], 0);
  game = offerFifth(game, 9, 7);
  assert.equal(game.phase, 'choose-fifth');
  assert.equal(game.turn, 2);
  game = chooseFifth(game, 1);
  assert.equal(game.moves.length, 5);
  assert.equal(game.board[9*15+7], 1);
  assert.equal(game.board[5*15+5], 0);
  assert.equal(game.turn, 2);
  game = placeStone(game, 8, 7);
  assert.equal(game.moves.length, 6);
  assert.equal(game.turn, 1);
  assert.equal(game.phase, 'playing');
});

test('fifth choices symmetric under the existing four stones are rejected', () => {
  let game = decideSwap(proposeOpening(createGame('both'), 'd1'), false);
  game = placeStone(game, 8, 7);
  assert.equal(equivalentFifths(game.board, {row:6,col:6}, {row:6,col:8}), true);
  game = offerFifth(game, 6, 6);
  assert.throws(() => offerFifth(game, 6, 8), /等價|對稱/);
  assert.throws(() => offerFifth(game, 6, 6), /不同|重複/);
});

test('occupied moves and actions from the wrong phase never change the board', () => {
  const game = proposeOpening(createGame('black'), 'i7');
  assert.throws(() => placeStone(game, 8, 8));
  const ready = decideSwap(game, false);
  assert.throws(() => placeStone(ready, 7, 7), /棋子|占/);
  assert.equal(ready.moves.length, 3);
});

test('swap-aware opening selection avoids a theoretical 100% black win', () => {
  const openings = [{id:'d4',blackWinRate:1,rateKind:'theoretical'}, {id:'d3',blackWinRate:.52,rateKind:'empirical'}, {id:'i7',blackWinRate:.9,rateKind:'empirical'}];
  assert.equal(swapScore(1), 0);
  assert.equal(swapScore(.52), .48);
  assert.equal(selectComputerOpening(openings, () => 0).id, 'd3');
  assert.equal(computerShouldSwap({blackWinRate:1}), true);
  assert.equal(computerShouldSwap({blackWinRate:.4}), false);
});

test('26 standard openings are distinct and direct/indirect center placements are correct', () => {
  assert.equal(OPENINGS.length, 26);
  const ids = new Set(OPENINGS.map(o => o.id));
  assert.equal(ids.size, 26);
  assert.deepEqual(OPENINGS.find(o=>o.id==='i7').stones.map(m=>[m.row,m.col]), [[7,7],[6,8],[8,8]]);
  assert.equal(OPENINGS.find(o=>o.id==='d3').name, '疏星');
});

test('local white chooses a winning move before positional improvements', () => {
  const board = Array(225).fill(0);
  for (const col of [4,5,6,7]) board[7*15+col]=2;
  board[6*15+6]=1;
  const move = chooseLocalMove(board,2);
  assert.equal(move.row,7);
  assert.ok(move.col===3 || move.col===8);
});

test('local fifth proposals are distinct, non-equivalent and legal in opening phase', () => {
  const game = placeStone(decideSwap(proposeOpening(createGame('both'),'d1'),false),8,7);
  const pair = chooseLocalFifths(game);
  assert.equal(pair.length,2);
  assert.equal(equivalentFifths(game.board,pair[0],pair[1]),false);
  const offered = offerFifth(offerFifth(game,pair[0].row,pair[0].col),pair[1].row,pair[1].col);
  assert.equal(offered.phase,'choose-fifth');
});

test('resignation awards opponent and both sides can explicitly agree draw', () => {
  const game = decideSwap(proposeOpening(createGame('both'),'d3'),false);
  const ended = resignGame(game,2);
  assert.equal(ended.result.winner,1);
  assert.equal(ended.phase,'finished');
  assert.equal(finishDraw(game).result.winner,null);
});

test('games have distinct stable identities and ISO creation and update times', () => {
  const first = createGame();
  const second = createGame();
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0);
  assert.notEqual(first.id, second.id);
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);
  assert.equal(new Date(first.updatedAt).toISOString(), first.updatedAt);
  assert.equal(first.updatedAt, first.createdAt);
});

test('successful opening, play and ending transitions preserve identity and creation time and refresh update time', () => {
  let game = {...createGame('both'), createdAt:'2020-01-01T00:00:00.000Z', updatedAt:'2020-01-01T00:00:00.000Z'};
  const id = game.id;
  const createdAt = game.createdAt;
  const steps = [
    game => proposeOpening(game, 'd4'),
    game => decideSwap(game, false),
    game => placeStone(game, 8, 8),
    game => offerFifth(game, 5, 5),
    game => offerFifth(game, 9, 7),
    game => chooseFifth(game, 1),
    game => placeStone(game, 8, 7),
  ];
  for (const step of steps) {
    const previous = {...game, updatedAt:'2020-01-01T00:00:00.000Z'};
    game = step(previous);
    assert.equal(game.id, id);
    assert.equal(game.createdAt, createdAt);
    assert.ok(Date.parse(game.updatedAt) > Date.parse(previous.updatedAt));
    assert.equal(new Date(game.updatedAt).toISOString(), game.updatedAt);
    assert.equal(previous.updatedAt, '2020-01-01T00:00:00.000Z');
  }
  for (const end of [resignGame, finishDraw]) {
    const previous = {...game, updatedAt:'2020-01-01T00:00:00.000Z'};
    const ended = end(previous);
    assert.equal(ended.id, id);
    assert.equal(ended.createdAt, createdAt);
    assert.ok(Date.parse(ended.updatedAt) > Date.parse(previous.updatedAt));
  }
});

test('an actual human black double-three move is committed and immediately loses', () => {
  const game = blackPosition([[10,9],[10,11],[9,10],[11,10]]);
  const original = structuredClone(game);
  const ended = placeStone(game, 10, 10);
  assert.equal(currentActor(game), 'human');
  assert.equal(ended.phase, 'finished');
  assert.deepEqual(ended.result, {
    winner:2,reason:'forbidden',forbiddenKind:'double-three',attemptedMove:{row:10,col:10},winningLine:[],
  });
  assert.equal(ended.board[10*15+10], 1);
  assert.equal(ended.moves.length, game.moves.length + 1);
  assert.deepEqual(ended.moves.at(-1), {row:10,col:10,color:1,number:game.moves.length+1});
  assert.equal(ended.id, game.id);
  assert.equal(ended.createdAt, game.createdAt);
  assert.deepEqual(game, original);
});

test('actual black double-four and overline moves also commit the losing stone', () => {
  const fixtures = [
    {stones:[[10,7],[10,8],[10,9],[7,10],[8,10],[9,10]],move:[10,10],kind:'double-four'},
    {stones:[[10,5],[10,6],[10,7],[10,9],[10,10]],move:[10,8],kind:'overline'},
  ];
  for (const {stones,move,kind} of fixtures) {
    const game = blackPosition(stones);
    const original = structuredClone(game);
    const ended = placeStone(game, ...move);
    assert.equal(ended.phase, 'finished');
    assert.equal(ended.result.winner, 2);
    assert.equal(ended.result.reason, 'forbidden');
    assert.equal(ended.result.forbiddenKind, kind);
    assert.deepEqual(ended.result.attemptedMove, {row:move[0],col:move[1]});
    assert.equal(ended.board[move[0]*15+move[1]], 1);
    assert.deepEqual(game, original);
  }
});

test('invalid or occupied normal-game moves still throw and preserve the game', () => {
  const game = normalGame();
  const original = structuredClone(game);
  assert.throws(() => placeStone(game, -1, 7));
  assert.throws(() => placeStone(game, 7.5, 7));
  assert.throws(() => placeStone(game, 7, 7));
  assert.deepEqual(game, original);
});

test('an exact black five wins normally even when the attempted stone also makes an overline', () => {
  const game = blackPosition([[10,6],[10,7],[10,8],[10,9],[7,10],[8,10],[9,10],[11,10],[12,10]]);
  const original = structuredClone(game);
  const ended = placeStone(game, 10, 10);
  assert.equal(ended.phase, 'finished');
  assert.equal(ended.result.winner, 1);
  assert.equal(ended.result.reason, 'five');
  assert.deepEqual(ended.result.winningLine, [6,7,8,9,10].map(col=>({row:10,col})));
  assert.deepEqual(game, original);
});

test('white overline wins normally and commits its winning stone', () => {
  let game = normalGame();
  const blackMoves = [[0,0],[0,2],[0,4],[2,0],[2,2],[2,4]];
  for (const [index,col] of [5,6,7,9,10].entries()) {
    game = placeStone(game, ...blackMoves[index]);
    game = placeStone(game, 12, col);
  }
  game = placeStone(game, ...blackMoves[5]);
  const original = structuredClone(game);
  const ended = placeStone(game, 12, 8);
  assert.equal(ended.phase, 'finished');
  assert.equal(ended.result.winner, 2);
  assert.equal(ended.result.reason, 'five');
  assert.equal(ended.result.winningLine.length, 6);
  assert.equal(ended.board[12*15+8], 2);
  assert.deepEqual(game, original);
});
