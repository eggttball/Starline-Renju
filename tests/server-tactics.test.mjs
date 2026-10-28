import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BookError, createBook } from '../lib/book.mjs';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth } from '../lib/game.mjs';
import { createServer } from '../server.mjs';

const config = {
  apiKey: 'tactical-test-key',
  endpoint: 'https://api.example.test/v1/chat/completions',
  model: 'test-model',
  format: 'agent-json',
};
const preferred = { row: 14, col: 14 };

// Every fixture completes the actual RIF opening, including two fifth offers.
function position(sequence) {
  let game = decideSwap(proposeOpening(createGame('both'), 'd3'), false);
  game = placeStone(game, 6, 8);
  game = offerFifth(game, 8, 6);
  game = offerFifth(game, 8, 7);
  game = chooseFifth(game, 0);
  game = placeStone(game, 9, 7);
  for (const [row, col] of sequence) {
    game = placeStone(game, row, col);
    assert.equal(game.result, null, 'fixture history must contain only legal, unfinished moves');
  }
  return { board: game.board, moves: game.moves };
}

const wins = [
  { color: 1, route: '/api/agent', sequence: [[2, 3], [12, 3], [2, 4], [12, 5], [2, 5], [12, 7], [2, 6], [2, 2]] },
  { color: 2, route: '/api/white', sequence: [[12, 3], [2, 3], [12, 5], [2, 4], [12, 7], [2, 5], [2, 2], [2, 6], [12, 9]] },
];
const defenses = [
  { color: 1, route: '/api/agent', kind: 'straight', move: { row: 2, col: 7 }, rate: .2, sequence: [[2, 2], [2, 3], [12, 3], [2, 4], [12, 5], [2, 5], [12, 7], [2, 6]] },
  { color: 1, route: '/api/agent', kind: 'broken', move: { row: 2, col: 5 }, rate: .82, sequence: [[2, 2], [2, 3], [12, 3], [2, 4], [12, 5], [2, 6], [12, 7], [2, 7]] },
  { color: 2, route: '/api/white', kind: 'straight', move: { row: 2, col: 7 }, rate: .2, sequence: [[2, 3], [2, 2], [2, 4], [12, 3], [2, 5], [12, 5], [2, 6], [12, 7], [12, 9]] },
  { color: 2, route: '/api/white', kind: 'broken', move: { row: 2, col: 5 }, rate: .82, sequence: [[2, 3], [2, 2], [2, 4], [12, 3], [2, 6], [12, 5], [2, 7], [12, 7], [12, 9]] },
];

async function withServer(options, fn) {
  const server = createServer({ ...options, book: options.book ?? createBook() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function post(origin, route, state) {
  return fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
}

for (const fixture of wins) {
  test(`${fixture.route} completes its own five before preferred and avoided book moves, even without API configuration`, async () => {
    const state = position(fixture.sequence), move = { row: 2, col: 7 };
    for (const activeConfig of [config, {}]) {
      const book = createBook();
      await book.record({ ...state, color: fixture.color, move: preferred, winRate: .95 });
      await book.record({ ...state, color: fixture.color, move, winRate: .2 });
      let upstreamCalls = 0;
      await withServer({ config: activeConfig, book, fetchImpl: async () => {
        upstreamCalls++;
        return Response.json({ move: preferred, reason: 'remembered remote preference', winRate: .95 });
      } }, async (origin) => {
        const response = await post(origin, fixture.route, state);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.move, move);
        assert.equal(data.decision, 'win');
        assert.equal(data.winRate, 1);
        assert.ok(data.reason.length > 0);
        assert.equal(upstreamCalls, 0, 'a proven completion must not incur a remote request');
        const policy = await book.query({ ...state, color: fixture.color, legalMoves: [move, preferred] });
        assert.equal(policy.knownMoves.find((point) => point.row === 2 && point.col === 7).winRate, 1);
      });
    }
  });
}

for (const fixture of defenses) {
  test(`${fixture.route} blocks a ${fixture.kind} four before memory and preserves the remembered defense rate`, async () => {
    const state = position(fixture.sequence);
    for (const activeConfig of [config, {}]) {
      const book = createBook();
      await book.record({ ...state, color: fixture.color, move: preferred, winRate: .95 });
      await book.record({ ...state, color: fixture.color, move: fixture.move, winRate: fixture.rate });
      let upstreamCalls = 0;
      await withServer({ config: activeConfig, book, fetchImpl: async () => {
        upstreamCalls++;
        return Response.json({ move: preferred, reason: 'remembered remote preference', winRate: .95 });
      } }, async (origin) => {
        const response = await post(origin, fixture.route, state);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.move, fixture.move);
        assert.equal(data.decision, 'defense');
        assert.equal(data.winRate, null, 'a required block alone proves no winning probability');
        assert.equal(upstreamCalls, 0);
        const policy = await book.query({ ...state, color: fixture.color, legalMoves: [fixture.move, preferred] });
        assert.equal(policy.knownMoves.find((point) => point.row === fixture.move.row && point.col === fixture.move.col).winRate, fixture.rate);
        assert.deepEqual(await book.load(), { positions: 1, moves: 2 });
      });
    }
  });
}

test('White proves and remembers a forbidden-block four without ending the current board or contacting the API', async () => {
  const state = position([[2, 3], [2, 4], [1, 8], [2, 5], [3, 8], [2, 6], [1, 7], [0, 0], [3, 9]]);
  const move = { row: 2, col: 7 }, before = [...state.board];
  const directory = await mkdtemp(path.join(tmpdir(), 'renju-tactical-book-'));
  const filePath = path.join(directory, 'book.json');
  const book = createBook({ filePath });
  try {
    await book.record({ ...state, color: 2, move: preferred, winRate: .95 });
    await book.record({ ...state, color: 2, move, winRate: .2 });
    for (const activeConfig of [config, {}]) {
      let upstreamCalls = 0;
      await withServer({ config: activeConfig, book, fetchImpl: async () => {
        upstreamCalls++;
        return Response.json({ move: preferred, reason: 'remote preference', winRate: .95 });
      } }, async (origin) => {
        const response = await post(origin, '/api/white', state);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.move, move);
        assert.equal(data.decision, 'forbidden-four');
        assert.equal(data.winRate, 1);
        assert.equal(upstreamCalls, 0);
        assert.equal(data.result, undefined, 'the forced continuation still belongs to the game');
        assert.deepEqual(state.board, before);
      });
    }
    const reloaded = createBook({ filePath });
    const policy = await reloaded.query({ ...state, color: 2, legalMoves: [move] });
    assert.equal(policy.preferredMove.winRate, 1);
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    const records = Object.values(stored.positions).flatMap((entry) => Object.values(entry.moves));
    assert.ok(records.some((entry) => entry.winRate === 1 && entry.source === 'tactical-win'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tactical opportunities do not bypass history, turn, or completed-game validation', async () => {
  const state = position(wins[0].sequence), book = createBook();
  const finished = { board: [...state.board], moves: [...state.moves, { row: 2, col: 7, color: 1 }] };
  finished.board[2 * 15 + 7] = 1;
  let upstreamCalls = 0;
  await withServer({ config: {}, book, fetchImpl: async () => { upstreamCalls++; throw new Error('invalid history'); } }, async (origin) => {
    for (const [route, input] of [
      ['/api/agent', { ...state, moves: state.moves.slice(1) }],
      ['/api/white', state],
      ['/api/white', finished],
    ]) {
      const response = await post(origin, route, input);
      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(data.error.code, 'invalid-state');
      assert.equal(data.move, undefined);
    }
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(await book.load(), { positions: 0, moves: 0 });
  });
});

for (const fixture of [
  ...wins.map((fixture) => ({ ...fixture, decision: 'win' })),
  { color: 2, route: '/api/white', decision: 'forbidden-four', sequence: [[2, 3], [2, 4], [1, 8], [2, 5], [3, 8], [2, 6], [1, 7], [0, 0], [3, 9]] },
]) {
  test(`${fixture.route} returns its proven ${fixture.decision} with a safe warning when book persistence fails`, async () => {
    const state = position(fixture.sequence);
    for (const activeConfig of [config, {}]) {
      let recordAttempts = 0, recordSettled = false, bookQueries = 0, upstreamCalls = 0;
      const book = {
        async query() { bookQueries++; throw new BookError('private query failure'); },
        async record() {
          recordAttempts++;
          await new Promise((resolve) => setTimeout(resolve, 1));
          recordSettled = true;
          throw new BookError('private filesystem detail must not reach the browser');
        },
      };
      await withServer({ config: activeConfig, book, fetchImpl: async () => { upstreamCalls++; throw new Error('must stay tactical'); } }, async (origin) => {
        const response = await post(origin, fixture.route, state);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.move, { row: 2, col: 7 });
        assert.equal(data.winRate, 1);
        assert.equal(data.decision, fixture.decision);
        assert.equal(data.memoryWarning, '電腦勝率棋譜暫時無法更新。');
        assert.ok(!JSON.stringify(data).includes('private'));
        assert.equal(recordAttempts, 1);
        assert.equal(recordSettled, true, 'the persistence attempt still completes before responding');
        assert.equal(bookQueries, 0);
        assert.equal(upstreamCalls, 0);
      });
    }
  });
}

test('unexpected tactical record errors remain server failures without leaking their details', async () => {
  const state = position(wins[0].sequence);
  await withServer({ config: {}, book: {
    async record() { throw new TypeError('private programming error'); },
  } }, async (origin) => {
    const response = await post(origin, '/api/agent', state);
    assert.equal(response.status, 500);
    const data = await response.json();
    assert.equal(data.error.code, 'server-error');
    assert.equal(data.move, undefined);
    assert.ok(!JSON.stringify(data).includes('private programming error'));
  });
});

test('ordinary remote estimates still pause on book persistence errors', async () => {
  const state = position([]), healthyBook = createBook();
  let upstreamCalls = 0;
  await withServer({ config, book: {
    query: healthyBook.query,
    async record() { throw new BookError('private remote record failure'); },
  }, fetchImpl: async () => {
    upstreamCalls++;
    return Response.json({ move: preferred, reason: 'ordinary remote estimate', winRate: .8 });
  } }, async (origin) => {
    const response = await post(origin, '/api/agent', state);
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.error.code, 'book-unavailable');
    assert.equal(data.move, undefined);
    assert.equal(data.memoryWarning, undefined);
    assert.equal(upstreamCalls, 1);
  });
});
