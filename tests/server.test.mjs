import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestAgent } from '../lib/agent.mjs';
import { createBook } from '../lib/book.mjs';

let implementation = await import('../server.mjs');
test('the HTTP server exports a configurable server factory and dotenv loader', async () => {
  await assert.doesNotReject(async () => {
    implementation = await import('../server.mjs');
  });
  assert.equal(typeof implementation.createServer, 'function');
  assert.equal(typeof implementation.loadConfig, 'function');
});

const API_KEY = 'private-test-key-never-expose';
const config = {
  apiKey: API_KEY,
  endpoint: 'https://api.example.test/v1/chat/completions',
  model: 'test-model',
  format: 'agent-json',
  timeoutMs: 500,
};

function position() {
  const moves = [
    { row: 7, col: 7, color: 1 },
    { row: 7, col: 8, color: 2 },
    { row: 8, col: 8, color: 1 },
    { row: 6, col: 8, color: 2 },
    { row: 8, col: 6, color: 1 },
    { row: 9, col: 7, color: 2 },
  ];
  const board = Array(225).fill(0);
  for (const move of moves) board[move.row * 15 + move.col] = move.color;
  return { board, moves };
}

async function withServer(options, fn) {
  assert.ok(implementation, 'server implementation must be available');
  const testingOptions = { ...options };
  if (!('book' in options) && !('bookPath' in options)) testingOptions.book = createBook();
  const server = implementation.createServer(testingOptions);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(origin, server);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function post(origin, body, headers = {}) {
  return fetch(`${origin}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function rawRequest(origin, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: pathname, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('config status discloses no key or endpoint and unavailable API never falls back', async () => {
  await withServer({ config: {} }, async (origin) => {
    const status = await fetch(`${origin}/api/config`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false, format: 'openai-chat' });
    const result = await post(origin, position());
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.error.code, 'not-configured');
    assert.equal(body.move, undefined);
    assert.match(body.error.message, /AI_API/);
  });
  await withServer({ config }, async (origin) => {
    const response = await fetch(`${origin}/api/config`);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { configured: true, format: 'agent-json', model: 'test-model' });
    assert.ok(!text.includes(API_KEY));
    assert.ok(!text.includes(config.endpoint));
  });
});

test('dotenv parsing uses server-only values with environment overrides', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'renju-env-'));
  const envPath = path.join(directory, '.env');
  try {
    await writeFile(envPath, '# secret remains server-side\nAI_API_KEY="file-key"\nAI_API_ENDPOINT=https://example.test/complete\nAI_API_MODEL=sample-model # comment\nAI_API_FORMAT=agent-json\nPORT=3210\n');
    const loaded = implementation.loadConfig({ envPath, env: { AI_API_KEY: 'override-key' } });
    assert.equal(loaded.apiKey, 'override-key');
    assert.equal(loaded.endpoint, 'https://example.test/complete');
    assert.equal(loaded.model, 'sample-model');
    assert.equal(loaded.format, 'agent-json');
    assert.equal(loaded.port, 3210);
    assert.equal(loaded.host, '127.0.0.1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent-json sends validated legal moves and returns an unoccupied legal black move', async () => {
  let captured;
  await withServer({ config, fetchImpl: async (endpoint, options) => {
    captured = { endpoint, options, body: JSON.parse(options.body) };
    return Response.json({ move: { row: 6, col: 6 }, reason: '建立下一步威脅。' });
  } }, async (origin) => {
    const state = position();
    const response = await post(origin, state);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { move: { row: 6, col: 6 }, reason: '建立下一步威脅。', winRate: null });
    assert.equal(captured.endpoint, config.endpoint);
    assert.equal(captured.options.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(captured.body.rules, 'RIF');
    assert.equal(captured.body.color, 'black');
    assert.deepEqual(captured.body.board, state.board);
    assert.deepEqual(captured.body.moves, state.moves);
    assert.ok(captured.body.legalMoves.some(({ row, col }) => row === 6 && col === 6));
    assert.ok(!captured.body.legalMoves.some(({ row, col }) => row === 7 && col === 7));
    assert.ok(captured.body.legalMoves.length > 200, 'all legal points, including distant points, are supplied');
  });
});

test('chat and responses adapters extract bounded JSON content from real protocol shapes', async () => {
  const cases = [
    { format: 'openai-chat', response: { choices: [{ message: { content: '```json\n{"move":{"row":6,"col":6},"reason":"chat"}\n```' } }] }, reason: 'chat' },
    { format: 'openai-responses', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"move":{"row":6,"col":6},"reason":"responses"}' }] }] }, reason: 'responses' },
    { format: 'openai-responses', response: { output_text: '{"move":{"row":6,"col":6},"reason":"output_text"}' }, reason: 'output_text' },
  ];
  for (const entry of cases) {
    let payload;
    await withServer({ config: { ...config, format: entry.format }, fetchImpl: async (_endpoint, options) => {
      payload = JSON.parse(options.body);
      return Response.json(entry.response);
    } }, async (origin) => {
      const response = await post(origin, position());
      assert.equal(response.status, 200);
      assert.equal((await response.json()).reason, entry.reason);
      assert.equal(payload.model, 'test-model');
      assert.ok(entry.format === 'openai-chat' ? Array.isArray(payload.messages) : typeof payload.instructions === 'string');
      assert.match(JSON.stringify(payload), /legalMoves/);
    });
  }
});

test('invalid or inconsistent game states never reach the paid upstream', async () => {
  let calls = 0;
  await withServer({ config, fetchImpl: async () => { calls++; throw new Error('should not call'); } }, async (origin) => {
    const invalid = [];
    invalid.push({ ...position(), board: Array(224).fill(0) });
    const invalidCell = position(); invalidCell.board[0] = '0'; invalid.push(invalidCell);
    const wrongCount = position(); wrongCount.board[0] = 1; invalid.push(wrongCount);
    const missingHistory = position(); delete missingHistory.moves; invalid.push(missingHistory);
    const wrongHistory = position(); wrongHistory.moves[0].col = 0; invalid.push(wrongHistory);
    const swappedHistory = position(); swappedHistory.moves[0].color = 2; invalid.push(swappedHistory);
    const beforeOpening = { board: Array(225).fill(0), moves: [] }; invalid.push(beforeOpening);
    for (const state of invalid) {
      const response = await post(origin, state);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid-state');
    }
    assert.equal(calls, 0);
  });
});

test('finished boards are rejected before asking an agent', async () => {
  const moves = [];
  for (let col = 0; col < 5; col++) {
    moves.push({ row: 7, col, color: 1 }, { row: 0, col: col * 2, color: 2 });
  }
  const board = Array(225).fill(0);
  for (const move of moves) board[move.row * 15 + move.col] = move.color;
  await withServer({ config, fetchImpl: async () => { throw new Error('must not call'); } }, async (origin) => {
    const response = await post(origin, { board, moves });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /勝|結束/);
  });
});

test('occupied, out-of-bounds, malformed and forbidden agent moves never become success responses', async () => {
  const forbidden = { board: Array(225).fill(0), moves: [] };
  const black = [[7, 5], [7, 6], [7, 8], [7, 9], [7, 10]];
  const white = [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8]];
  for (let i = 0; i < black.length; i++) {
    forbidden.moves.push({ row: black[i][0], col: black[i][1], color: 1 }, { row: white[i][0], col: white[i][1], color: 2 });
  }
  for (const move of forbidden.moves) forbidden.board[move.row * 15 + move.col] = move.color;
  const cases = [
    { move: { row: 7, col: 7 }, reason: 'occupied', state: position() },
    { move: { row: -1, col: 6 }, reason: 'outside', state: position() },
    { move: { row: '6', col: 6 }, reason: 'wrong type', state: position() },
    { move: { row: 6, col: 6 }, reason: 'x'.repeat(1001), state: position() },
    { move: { row: 7, col: 7 }, reason: 'overline', state: forbidden },
  ];
  for (const entry of cases) {
    await withServer({ config, fetchImpl: async () => Response.json({ move: entry.move, reason: entry.reason }) }, async (origin) => {
      const response = await post(origin, entry.state);
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error.code, 'invalid-agent-response');
      assert.equal(body.move, undefined);
    });
  }
});

test('remote failures are helpful but do not disclose upstream text or credentials', async () => {
  for (const fetchImpl of [
    async () => new Response(`upstream leaked ${API_KEY}`, { status: 401 }),
    async () => { throw new Error(`network failure ${API_KEY} ${config.endpoint}`); },
    async () => new Response('not json', { status: 200 }),
  ]) {
    await withServer({ config, fetchImpl }, async (origin) => {
      const response = await post(origin, position());
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.ok(!body.includes(API_KEY));
      assert.ok(!body.includes(config.endpoint));
      assert.equal(JSON.parse(body).move, undefined);
      assert.ok(JSON.parse(body).error.message.length > 5);
    });
  }
});

test('timeout covers a stalled response body and leaves the game without a fallback move', async () => {
  let observedSignal;
  await withServer({ config: { ...config, timeoutMs: 30 }, fetchImpl: async (_endpoint, options) => {
    observedSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  } }, async (origin) => {
    const start = Date.now();
    const response = await post(origin, position());
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.code, 'api-timeout');
    assert.equal(body.move, undefined);
    assert.ok(observedSignal.aborted);
    assert.ok(Date.now() - start < 1500);
  });
});

test('aborting an HTTP browser request cancels its upstream API signal', async () => {
  let upstreamSignal;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  let reportAborted;
  const upstreamAborted = new Promise((resolve) => { reportAborted = resolve; });
  await withServer({ config: { ...config, timeoutMs: 2000 }, fetchImpl: async (_endpoint, options) => {
    upstreamSignal = options.signal;
    upstreamSignal.addEventListener('abort', () => reportAborted(upstreamSignal.reason), { once: true });
    reportStarted();
    return new Promise(() => {});
  } }, async (origin) => {
    const client = new AbortController();
    const pending = fetch(`${origin}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(position()), signal: client.signal });
    const browserAborted = assert.rejects(pending, { name: 'AbortError' });
    await started;
    client.abort();
    await browserAborted;
    let timer;
    try {
      const reason = await Promise.race([
        upstreamAborted,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('client disconnect did not cancel upstream within 400ms')), 400); }),
      ]);
      assert.ok(upstreamSignal.aborted);
      assert.equal(reason.name, 'AbortError');
    } finally { clearTimeout(timer); }
  });
});

test('direct agent cancellation rejects promptly when fetch ignores AbortSignal and suppresses a late move', async () => {
  const client = new AbortController();
  let upstreamSignal;
  let finishFetch;
  let cancelledLateBody = false;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const state = { ...position(), legalMoves: [{ row: 6, col: 6 }] };
  const pending = requestAgent(state, { config: { ...config, timeoutMs: 2000 }, signal: client.signal, fetchImpl: async (_endpoint, options) => {
    upstreamSignal = options.signal;
    reportStarted();
    return new Promise((resolve) => { finishFetch = resolve; });
  } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  client.abort(new Error('caller-specific detail must not become a timeout'));
  let timer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('agent cancellation did not settle within 200ms')), 200); }),
    ]);
    assert.ok(upstreamSignal.aborted);
    assert.equal(getEventListeners(client.signal, 'abort').length, 0, 'caller listener must be removed after cancellation');
  } finally {
    clearTimeout(timer);
    const lateResponse = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ move: { row: 6, col: 6 }, reason: 'stale move' }))); },
      cancel() { cancelledLateBody = true; },
    }));
    finishFetch(lateResponse);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelledLateBody, true, 'a late response is cancelled instead of being parsed into a move');
  assert.equal(state.board[6 * 15 + 6], 0);
});

test('direct agent cancellation also interrupts a stalled response body', async () => {
  const client = new AbortController();
  let bodyCancelled = false;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const pending = requestAgent({ ...position(), legalMoves: [{ row: 6, col: 6 }] }, {
    config: { ...config, timeoutMs: 2000 }, signal: client.signal,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); reportStarted(); }, cancel() { bodyCancelled = true; } })),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.abort();
  let timer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('body cancellation did not settle within 200ms')), 200); }),
    ]);
    assert.equal(bodyCancelled, true);
    assert.equal(getEventListeners(client.signal, 'abort').length, 0);
  } finally { clearTimeout(timer); }
});

test('request size and JSON media type are enforced without contacting the upstream', async () => {
  await withServer({ config, fetchImpl: async () => { throw new Error('must not call'); } }, async (origin) => {
    const large = await post(origin, ' '.repeat(65537));
    assert.equal(large.status, 413);
    const malformed = await post(origin, '{');
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid-json');
    const wrongMedia = await post(origin, position(), { 'content-type': 'text/plain' });
    assert.equal(wrongMedia.status, 415);
  });
});

test('chunked oversized requests receive a JSON error without a connection reset', async () => {
  await withServer({ config }, async (origin) => {
    const url = new URL(origin);
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: '/api/agent', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.write(' '.repeat(40_000));
      req.end(' '.repeat(40_000));
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.body).error.code, 'body-too-large');
  });
});

test('an upstream explanation cannot echo the server API key or endpoint to the browser', async () => {
  await withServer({ config, fetchImpl: async () => Response.json({ move: { row: 6, col: 6 }, reason: `debug ${API_KEY} ${config.endpoint}` }) }, async (origin) => {
    const response = await post(origin, position());
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes(API_KEY));
    assert.ok(!body.includes(config.endpoint));
  });
});

test('cross-origin and hostile host requests are rejected', async () => {
  await withServer({ config, fetchImpl: async () => { throw new Error('must not call'); } }, async (origin) => {
    const attack = await post(origin, position(), { origin: 'https://hostile.example' });
    assert.equal(attack.status, 403);
    const readAttack = await fetch(`${origin}/api/config`, { headers: { origin: 'null' } });
    assert.equal(readAttack.status, 403);
    const hostAttack = await rawRequest(origin, '/api/config', { host: 'hostile.example' });
    assert.equal(hostAttack.status, 403);
    const safeRead = await fetch(`${origin}/api/config`, { headers: { origin } });
    assert.equal(safeRead.status, 200);
  });
});

test('static routes cannot reveal dotenv, server source, test source, or traversal paths', async () => {
  await withServer({ config }, async (origin) => {
    for (const pathname of ['/.env', '/.env.example', '/server.mjs', '/package.json', '/tests/server.test.mjs', '/lib/agent.mjs', '/data/opening-rates.json', '/../package.json', '/%2e%2e/package.json', '/lib/../../.env', '/%2eenv', '/lib%2fagent.mjs', '/lib/rules.mjs.map']) {
      const result = await rawRequest(origin, pathname);
      assert.ok(result.status === 400 || result.status === 404, `${pathname} must be blocked: ${result.status}`);
      assert.ok(!result.body.includes(API_KEY));
    }
    const configResponse = await fetch(`${origin}/api/config`);
    assert.equal(configResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(configResponse.headers.get('access-control-allow-origin'), null);
  });
});

test('the real page, stylesheet, application, and all public modules are served with correct MIME types', async () => {
  const assets = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/app.mjs', 'app.mjs', 'text/javascript; charset=utf-8'],
    ['/lib/rules.mjs', 'lib/rules.mjs', 'text/javascript; charset=utf-8'],
    ['/lib/game.mjs', 'lib/game.mjs', 'text/javascript; charset=utf-8'],
    ['/lib/openings.mjs', 'lib/openings.mjs', 'text/javascript; charset=utf-8'],
    ['/lib/local-ai.mjs', 'lib/local-ai.mjs', 'text/javascript; charset=utf-8'],
    ['/lib/persistence.mjs', 'lib/persistence.mjs', 'text/javascript; charset=utf-8'],
  ];
  await withServer({ config }, async (origin) => {
    for (const [route, filename, mime] of assets) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('content-type'), mime, route);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(await response.text(), await readFile(new URL(`../${filename}`, import.meta.url), 'utf8'), route);
    }
    const head = await fetch(`${origin}/app.mjs`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 0);
  });
});

test('opening API serves the actual 26 sourced records while config exposes only public status', async () => {
  await withServer({ config }, async (origin) => {
    const response = await fetch(`${origin}/api/openings`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const data = await response.json();
    assert.deepEqual(data, JSON.parse(await readFile(new URL('../data/opening-rates.json', import.meta.url), 'utf8')));
    assert.equal(data.openings.length, 26);
    assert.equal(new Set(data.openings.map((entry) => entry.id)).size, 26);
    assert.deepEqual(new Set(data.openings.map((entry) => entry.id)), new Set(['d', 'i'].flatMap((prefix) => Array.from({ length: 13 }, (_, index) => `${prefix}${index + 1}`))));
    assert.equal(typeof data.updatedAt, 'string');
    assert.ok(Array.isArray(data.sources) && data.sources.length > 0);
    assert.ok(Array.isArray(data.notes));
    for (const entry of data.openings) {
      assert.ok(entry.blackWinRate === null || (Number.isFinite(entry.blackWinRate) && entry.blackWinRate >= 0 && entry.blackWinRate <= 1));
      assert.ok(['empirical', 'theoretical', 'unknown'].includes(entry.rateKind));
      assert.ok(entry.sampleSize === null || (Number.isInteger(entry.sampleSize) && entry.sampleSize > 0));
      assert.equal(typeof entry.assessment, 'string');
      assert.ok(['https:', 'http:'].includes(new URL(entry.source).protocol));
    }
    const publicResponse = await fetch(`${origin}/api/config`);
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    const settings = JSON.parse(publicText);
    assert.deepEqual(settings, { configured: true, format: 'agent-json', model: 'test-model' });
    assert.ok(!publicText.includes(API_KEY));
    assert.ok(!publicText.includes(config.endpoint));
    assert.equal(settings.apiKey, undefined);
    assert.equal(settings.endpoint, undefined);
  });
});

test('black book preference is reevaluated remotely every turn and uses each newest winRate', async () => {
  const book = createBook();
  const state = position(), remembered = { row: 6, col: 6 }, alternate = { row: 6, col: 7 };
  await book.record({ ...state, color: 1, move: remembered, winRate: .8 });
  const payloads = [];
  const outputs = [
    { move: remembered, reason: '更新為中等估計', winRate: .65 },
    { move: remembered, reason: '更新為低估計', winRate: .35 },
    { move: alternate, reason: '選擇其他落點', winRate: .75 },
  ];
  await withServer({ config, book, fetchImpl: async (_endpoint, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json(outputs[payloads.length - 1]);
  } }, async (origin) => {
    for (let index = 0; index < 3; index++) {
      const response = await post(origin, state);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), outputs[index]);
    }
    assert.deepEqual(payloads[0].preferredMove, remembered);
    assert.match(payloads[0].request, /winRate/);
    assert.equal(payloads[1].preferredMove, undefined, 'new .65 removes automatic preference');
    assert.ok(payloads[1].legalMoves.some((point) => point.row === 6 && point.col === 6));
    assert.ok(!payloads[2].legalMoves.some((point) => point.row === 6 && point.col === 6), 'new .35 excludes the old move');
    const policy = await book.query({ ...state, color: 1, legalMoves: [remembered, alternate] });
    assert.equal(policy.knownMoves.find((point) => point.row === 6 && point.col === 6).winRate, .35);
    assert.deepEqual(policy.preferredMove, { ...alternate, winRate: .75 });
  });
});

test('a high remembered black move cannot bypass missing API configuration or be substituted by the agent', async () => {
  const book = createBook(), state = position(), move = { row: 6, col: 6 };
  await book.record({ ...state, color: 1, move, winRate: .9 });
  await withServer({ config: {}, book }, async (origin) => {
    const response = await post(origin, state);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).move, undefined);
  });
  await withServer({ config, book, fetchImpl: async () => Response.json({ move: { row: 6, col: 7 }, reason: 'different legal move', winRate: .95 }) }, async (origin) => {
    const response = await post(origin, state);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid-agent-response');
    assert.deepEqual(await book.load(), { positions: 1, moves: 1 });
  });
});

test('black API rejects avoided low moves and invalid estimated winRate without changing private memory', async () => {
  const book = createBook(), state = position(), lowMove = { row: 6, col: 6 };
  await book.record({ ...state, color: 1, move: lowMove, winRate: .2 });
  await withServer({ config, book, fetchImpl: async () => Response.json({ move: lowMove, reason: 'ignored exclusion', winRate: .99 }) }, async (origin) => {
    const response = await post(origin, state);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid-agent-response');
    assert.equal((await book.query({ ...state, color: 1, legalMoves: [lowMove] })).knownMoves[0].winRate, .2);
  });
  for (const winRate of [-.1, 1.1, '0.8']) {
    await withServer({ config, fetchImpl: async () => Response.json({ move: { row: 6, col: 7 }, reason: 'invalid estimate', winRate }) }, async (origin) => {
      const response = await post(origin, state);
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'invalid-agent-response');
    });
  }
});

test('legacy agents with no winRate still return a legal move and do not create invented memory', async () => {
  const book = createBook();
  await withServer({ config, book, fetchImpl: async () => Response.json({ move: { row: 6, col: 6 }, reason: 'legacy agent' }) }, async (origin) => {
    const response = await post(origin, position());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).winRate, null);
    assert.deepEqual(await book.load(), { positions: 0, moves: 0 });
  });
});

function whitePosition() {
  const state = position();
  state.moves.push({ row: 5, col: 7, color: 1 });
  state.board[5 * 15 + 7] = 1;
  return state;
}
function postWhite(origin, state) {
  return fetch(`${origin}/api/white`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
}

test('white normal turns respect remembered preferred/avoided moves without making any remote API call', async () => {
  const book = createBook(), state = whitePosition(), preferred = { row: 4, col: 4 };
  await book.record({ ...state, color: 2, move: preferred, winRate: .8 });
  await withServer({ config: {}, book, fetchImpl: async () => { throw new Error('unconfigured white must remain local'); } }, async (origin) => {
    let response = await postWhite(origin, state);
    assert.equal(response.status, 200);
    let data = await response.json();
    assert.deepEqual(data.move, preferred);
    assert.equal(data.winRate, null, 'local pattern scores are never invented probabilities');
    await book.record({ ...state, color: 2, move: preferred, winRate: .2 });
    response = await postWhite(origin, state);
    assert.equal(response.status, 200);
    data = await response.json();
    assert.notDeepEqual(data.move, preferred);
    assert.equal(state.board[data.move.row * 15 + data.move.col], 0);
    const openingResponse = await postWhite(origin, position());
    assert.equal(openingResponse.status, 400, 'white fourth/sixth hands stay in the opening client logic');
  });
});

test('white learns probability one only for an objectively immediate winning move', async () => {
  const moves = [];
  for (let index = 0; index < 4; index++) moves.push({ row: 0, col: index * 2, color: 1 }, { row: 7, col: index + 5, color: 2 });
  moves.push({ row: 0, col: 8, color: 1 });
  const board = Array(225).fill(0);
  for (const move of moves) board[move.row * 15 + move.col] = move.color;
  const state = { board, moves }, book = createBook();
  await withServer({ config: {}, book }, async (origin) => {
    const response = await postWhite(origin, state);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.winRate, 1);
    assert.equal(data.move.row, 7);
    assert.ok([4, 9].includes(data.move.col));
    const policy = await book.query({ board, color: 2, legalMoves: [data.move] });
    assert.equal(policy.preferredMove.winRate, 1);
  });
});

test('persistent black memory survives server recreation but cannot be served through HTTP', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'renju-server-book-'));
  const bookPath = path.join(directory, '.renju-data', 'ai-book.json'), state = position(), move = { row: 6, col: 6 };
  try {
    await withServer({ config, bookPath, fetchImpl: async () => Response.json({ move, reason: 'first estimate', winRate: .85 }) }, async (origin) => {
      assert.equal((await post(origin, state)).status, 200);
    });
    let requested;
    await withServer({ config, bookPath, fetchImpl: async (_endpoint, options) => {
      requested = JSON.parse(options.body);
      return Response.json({ move, reason: 'newest estimate', winRate: .65 });
    } }, async (origin) => {
      assert.equal((await post(origin, state)).status, 200);
      assert.deepEqual(requested.preferredMove, move);
      for (const route of ['/api/book', '/.renju-data/ai-book.json', '/lib/book.mjs']) assert.equal((await rawRequest(origin, route)).status, 404);
      const status = await (await fetch(`${origin}/api/config`)).json();
      assert.equal(status.book, undefined);
      assert.equal(status.positions, undefined);
    });
    assert.equal((await createBook({ filePath: bookPath }).query({ ...state, color: 1, legalMoves: [move] })).knownMoves[0].winRate, .65);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configured white evaluates and downclassifies remembered moves using its own newest winning probability', async () => {
  const book = createBook(), state = whitePosition(), move = { row: 4, col: 4 }, alternate = { row: 4, col: 5 };
  const payloads = [], outputs = [
    { move, reason: 'white estimate', winRate: .85 },
    { move, reason: 'white newest middle estimate', winRate: .65 },
    { move, reason: 'white newest low estimate', winRate: .35 },
    { move: alternate, reason: 'white different option', winRate: .75 },
  ];
  await withServer({ config, book, fetchImpl: async (_endpoint, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json(outputs[payloads.length - 1]);
  } }, async (origin) => {
    for (let index = 0; index < outputs.length; index++) {
      const response = await postWhite(origin, state);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), outputs[index]);
    }
    assert.equal(payloads[0].color, 'white');
    assert.match(payloads[0].request, /white wins/);
    assert.deepEqual(payloads[1].preferredMove, move);
    assert.equal(payloads[2].preferredMove, undefined);
    assert.ok(!payloads[3].legalMoves.some((point) => point.row === move.row && point.col === move.col));
    const policy = await book.query({ ...state, color: 2, legalMoves: [move, alternate] });
    assert.equal(policy.knownMoves.find((point) => point.col === move.col).winRate, .35);
    assert.deepEqual(policy.preferredMove, { ...alternate, winRate: .75 });
  });
});

test('configured white demands its preferred move and pauses on upstream failure without local substitution', async () => {
  const book = createBook(), state = whitePosition(), move = { row: 4, col: 4 };
  await book.record({ ...state, color: 2, move, winRate: .8 });
  for (const fetchImpl of [
    async () => Response.json({ move: { row: 4, col: 5 }, reason: 'substituted preferred move', winRate: .9 }),
    async () => { throw new Error(`private upstream detail ${API_KEY}`); },
  ]) {
    await withServer({ config, book, fetchImpl }, async (origin) => {
      const response = await postWhite(origin, state);
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.move, undefined);
      assert.ok(!JSON.stringify(body).includes(API_KEY));
      assert.equal((await book.query({ ...state, color: 2, legalMoves: [move] })).knownMoves[0].winRate, .8);
    });
  }
});

test('white adapter checks white legality at a point that would be forbidden for black', async () => {
  const board = Array(225).fill(0);
  for (const [row, col] of [[7, 6], [7, 8], [6, 7], [8, 7]]) board[row * 15 + col] = 1;
  const move = { row: 7, col: 7 };
  const result = await requestAgent({ board, color: 2, moves: [], legalMoves: [move] }, {
    config,
    fetchImpl: async () => Response.json({ move, reason: 'white may play here', winRate: .8 }),
  });
  assert.deepEqual(result, { move, reason: 'white may play here', winRate: .8 });
  assert.equal(board[112], 0);
});
