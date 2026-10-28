import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, normalizeConfig, publicConfig, requestAgent } from './lib/agent.mjs';
import { BookError, createBook } from './lib/book.mjs';
import { BLACK, WHITE, analyzeMove, getLegalMoves } from './lib/rules.mjs';
import { rankLocalMoves } from './lib/local-ai.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/rules.mjs', ['lib/rules.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/game.mjs', ['lib/game.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/openings.mjs', ['lib/openings.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/local-ai.mjs', ['lib/local-ai.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/persistence.mjs', ['lib/persistence.mjs', 'text/javascript; charset=utf-8']],
]);

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0) continue;
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

export function loadConfig({ envPath = path.join(ROOT, '.env'), env = process.env } = {}) {
  let file = {};
  try { file = parseDotenv(readFileSync(envPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('無法讀取 renju/.env；請檢查檔案權限。');
  }
  const values = { ...file, ...env };
  const port = Number(values.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必須是 1 到 65535 的整數。');
  const host = values.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('HOST 必須是 127.0.0.1、localhost 或 ::1。');
  return {
    ...normalizeConfig({ apiKey: values.AI_API_KEY, endpoint: values.AI_API_ENDPOINT, model: values.AI_API_MODEL, format: values.AI_API_FORMAT }),
    host,
    port,
  };
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function json(response, status, body, method) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

function isSameOrigin(request) {
  const host = request.headers.host;
  const port = request.socket.localPort;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (port === 80) for (const name of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(name);
  if (!hosts.has(host)) return false;
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return origin.protocol === 'http:' && origin.host === host && origin.origin === request.headers.origin;
  } catch { return false; }
}

function routePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) throw new AgentError('invalid-path', '無效的檔案路徑。', 400);
  const original = url.split('?')[0];
  if (/%(?:2f|5c)/i.test(original)) throw new AgentError('invalid-path', '無效的檔案路徑。', 400);
  let pathname;
  try { pathname = decodeURIComponent(original); } catch { throw new AgentError('invalid-path', '無效的檔案路徑。', 400); }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((segment) => segment.startsWith('.'))) {
    throw new AgentError('not-found', '找不到此資源。', 404);
  }
  return pathname;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] || '')) {
    throw new AgentError('unsupported-media-type', '請以 application/json 傳送盤面。', 415);
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) {
    request.resume();
    throw new AgentError('body-too-large', '請求內容超過 64 KiB 限制。', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new AgentError('body-too-large', '請求內容超過 64 KiB 限制。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch {
    throw new AgentError('invalid-json', '請求內容不是有效 JSON。', 400);
  }
}

function hasCompletedLine(board) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
    const color = board[row * 15 + col];
    if (!color) continue;
    for (const [dr, dc] of directions) {
      const beforeRow = row - dr;
      const beforeCol = col - dc;
      if (beforeRow >= 0 && beforeRow < 15 && beforeCol >= 0 && beforeCol < 15 && board[beforeRow * 15 + beforeCol] === color) continue;
      let length = 0;
      for (let r = row, c = col; r >= 0 && r < 15 && c >= 0 && c < 15 && board[r * 15 + c] === color; r += dr, c += dc) length++;
      if (length >= 5) return true;
    }
  }
  return false;
}

function validateState(input, color = BLACK) {
  const fail = (message) => { throw new AgentError('invalid-state', message, 400); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.board) || input.board.length !== 225
    || input.board.some((cell) => cell !== 0 && cell !== 1 && cell !== 2)) fail('盤面必須是 225 個 0、1、2 組成的一維陣列。');
  const blackCount = input.board.filter((cell) => cell === 1).length;
  const whiteCount = input.board.filter((cell) => cell === 2).length;
  if (color === BLACK && (blackCount !== whiteCount || blackCount < 3)) fail('只有完成六手開局後、輪到黑方的盤面可請求黑棋 API。');
  if (color === WHITE && (blackCount !== whiteCount + 1 || whiteCount < 3 || blackCount + whiteCount < 7)) fail('只有正式對局第七手之後、輪到白方的盤面可請求白棋。');
  if (!Array.isArray(input.moves) || input.moves.length !== blackCount + whiteCount) fail('棋譜手數必須與盤面一致。');
  const rebuilt = Array(225).fill(0);
  const moves = [];
  for (let i = 0; i < input.moves.length; i++) {
    const move = input.moves[i];
    const color = move?.color === 'black' ? 1 : move?.color === 'white' ? 2 : move?.color;
    if (!move || !Number.isInteger(move.row) || !Number.isInteger(move.col) || move.row < 0 || move.row >= 15 || move.col < 0 || move.col >= 15
      || color !== (i % 2 === 0 ? 1 : 2)) fail('棋譜必須由黑白交替的有效零起算座標組成。');
    const index = move.row * 15 + move.col;
    if (rebuilt[index]) fail('棋譜不能重複落在同一點。');
    rebuilt[index] = color;
    moves.push({ row: move.row, col: move.col, color });
  }
  if (rebuilt.some((cell, index) => cell !== input.board[index])) fail('棋譜落點與盤面不一致。');
  if (hasCompletedLine(input.board)) fail('盤面已有勝負或非法長連，對局已結束，不能再請求落子。');
  const legalMoves = getLegalMoves(input.board, color);
  if (!legalMoves.length) throw new AgentError('no-legal-moves', '目前行動方已沒有合法落點。', 409);
  return { board: input.board, moves, legalMoves };
}

function localWhiteMove(state, policy) {
  const allowed = new Set(policy.legalMoves.map((move) => move.row * 15 + move.col));
  const candidate = policy.preferredMove ?? rankLocalMoves(state.board, WHITE).find((move) => allowed.has(move.row * 15 + move.col))
    ?? [...policy.legalMoves].sort((a, b) => (Math.abs(a.row - 7) + Math.abs(a.col - 7)) - (Math.abs(b.row - 7) + Math.abs(b.col - 7)) || a.row - b.row || a.col - b.col)[0];
  if (!candidate) throw new AgentError('no-legal-moves', '白方已沒有合法落點。', 409);
  const move = { row: candidate.row, col: candidate.col };
  const analysis = analyzeMove(state.board, move.row, move.col, WHITE);
  if (!analysis.legal) throw new AgentError('invalid-local-move', '白棋戰術落點無效；盤面已保留，請重試。', 500);
  return { move, reason: analysis.win ? '白棋完成五連，取得勝利。' : '白棋依目前盤面使用本地戰術選擇落點。', winRate: analysis.win ? 1 : null };
}

export function createServer({ config = loadConfig(), fetchImpl = fetch, book, bookPath } = {}) {
  const privateConfig = normalizeConfig(config);
  const privateBook = book ?? config.book ?? createBook({ filePath: bookPath !== undefined ? bookPath : config.bookPath !== undefined ? config.bookPath : path.join(ROOT, '.renju-data', 'ai-book.json') });
  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (!isSameOrigin(request)) throw new AgentError('forbidden-origin', '此服務只接受本機同來源請求。', 403);
      const pathname = routePath(request.url);
      if (pathname === '/api/config' && (request.method === 'GET' || request.method === 'HEAD')) {
        return json(response, 200, publicConfig(privateConfig), request.method);
      }
      if (pathname === '/api/openings' && (request.method === 'GET' || request.method === 'HEAD')) {
        let rates;
        try { rates = JSON.parse(await readFile(path.join(ROOT, 'data/opening-rates.json'), 'utf8')); } catch {
          throw new AgentError('openings-unavailable', '開局資料暫時無法讀取；請檢查 data/opening-rates.json。', 503);
        }
        return json(response, 200, rates, request.method);
      }
      if ((pathname === '/api/agent' || pathname === '/api/white') && request.method === 'POST') {
        const cancellation = new AbortController();
        const onDisconnect = () => {
          if (!response.writableFinished) cancellation.abort();
        };
        response.once('close', onDisconnect);
        try {
          const color = pathname === '/api/agent' ? BLACK : WHITE;
          const state = validateState(await readJson(request), color);
          const policy = await privateBook.query({ ...state, color });
          if (cancellation.signal.aborted) return;
          const useRemote = color === BLACK || publicConfig(privateConfig).configured;
          const result = useRemote
            ? await requestAgent({ ...state, color, legalMoves: policy.legalMoves, preferredMove: policy.preferredMove }, { config: privateConfig, fetchImpl, signal: cancellation.signal })
            : localWhiteMove(state, policy);
          if (cancellation.signal.aborted) return;
          if (result.winRate !== null) await privateBook.record({ ...state, color, move: result.move, winRate: result.winRate, source: useRemote ? 'agent-estimate' : 'tactical-win' });
          if (!response.destroyed && !cancellation.signal.aborted) return json(response, 200, result);
          return;
        } finally {
          response.removeListener('close', onDisconnect);
        }
      }
      if (pathname.startsWith('/api/')) throw new AgentError('not-found', '找不到此 API 或不支援此方法。', 404);
      const asset = STATIC_FILES.get(pathname);
      if (!asset || !['GET', 'HEAD'].includes(request.method)) throw new AgentError('not-found', '找不到此資源。', 404);
      const filename = path.join(ROOT, asset[0]);
      let content;
      try {
        if (await realpath(filename) !== filename) throw new Error('symlink');
        content = await readFile(filename);
      } catch { throw new AgentError('not-found', '找不到此資源。', 404); }
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      const safeError = error instanceof AgentError || error instanceof BookError ? error : new AgentError('server-error', '伺服器暫時無法處理此請求；請重試。', 500);
      json(response, safeError.status, { error: { code: safeError.code, message: safeError.message } }, request.method);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const server = createServer({ config });
    server.once('error', () => {
      console.error('連珠伺服器無法啟動；請檢查埠號是否已使用。');
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      const host = config.host === '::1' ? '[::1]' : config.host;
      console.log(`連珠遊戲：http://${host}:${config.port}`);
      if (!publicConfig(config).configured) console.log('黑棋 API 尚未設定；請填寫 renju/.env 後重新啟動。');
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
