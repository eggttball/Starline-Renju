import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class BookError extends Error {
  constructor(message = '私人記憶資料無法讀取；請檢查伺服器資料檔。') {
    super(message);
    this.name = 'BookError';
    this.code = 'book-unavailable';
    this.status = 503;
  }
}

function validBoard(board, color) {
  if (!Array.isArray(board) || board.length !== 225 || Array.from(board).some((cell) => cell !== 0 && cell !== 1 && cell !== 2)) throw new TypeError('記憶盤面必須是 225 個 0、1、2。');
  if (color !== 1 && color !== 2) throw new TypeError('記憶顏色必須是黑方 1 或白方 2。');
}

function validPoint(board, move) {
  return move && Number.isInteger(move.row) && Number.isInteger(move.col) && move.row >= 0 && move.row < 15 && move.col >= 0 && move.col < 15 && board[move.row * 15 + move.col] === 0;
}

function transformIndex(index, symmetry) {
  let row = Math.floor(index / 15), col = index % 15;
  if (symmetry >= 4) col = 14 - col;
  for (let turn = 0; turn < symmetry % 4; turn++) [row, col] = [col, 14 - row];
  return row * 15 + col;
}

function canonical(board, color) {
  validBoard(board, color);
  let smallest = null;
  let symmetries = [];
  for (let symmetry = 0; symmetry < 8; symmetry++) {
    const transformed = Array(225);
    for (let index = 0; index < 225; index++) transformed[transformIndex(index, symmetry)] = board[index];
    const key = transformed.join('');
    if (smallest === null || key < smallest) { smallest = key; symmetries = [symmetry]; }
    else if (key === smallest) symmetries.push(symmetry);
  }
  return {
    key: `${color}:${smallest}`,
    // Tied transforms handle positions with their own symmetries. Equivalent
    // moves share one entry rather than depending on an arbitrary orientation.
    moveKey: (move) => String(Math.min(...symmetries.map((symmetry) => transformIndex(move.row * 15 + move.col, symmetry)))),
  };
}

function decodeFile(text) {
  const input = JSON.parse(text);
  if (!input || input.version !== 1 || !input.positions || typeof input.positions !== 'object' || Array.isArray(input.positions)) throw new BookError();
  const positions = {};
  for (const [key, position] of Object.entries(input.positions)) {
    if (!/^[12]:[012]{225}$/.test(key) || !position?.moves || typeof position.moves !== 'object' || Array.isArray(position.moves)) throw new BookError();
    const moves = {};
    for (const [index, record] of Object.entries(position.moves)) {
      if (!/^(?:0|[1-9]\d{0,2})$/.test(index) || Number(index) > 224 || key[Number(index) + 2] !== '0'
        || !record || !Number.isFinite(record.winRate) || record.winRate < 0 || record.winRate > 1) throw new BookError();
      moves[index] = { winRate: record.winRate, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '', source: record.source === 'tactical-win' ? 'tactical-win' : 'agent-estimate' };
    }
    positions[key] = { moves };
  }
  return { version: 1, positions };
}

export function createBook({ filePath = null } = {}) {
  const filename = filePath === null ? null : path.resolve(filePath);
  let data = null;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  async function ensureLoaded() {
    if (data) return;
    if (!filename) { data = { version: 1, positions: {} }; return; }
    try { data = decodeFile(await readFile(filename, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') data = { version: 1, positions: {} };
      else throw new BookError();
    }
  }
  async function persist(next) {
    if (!filename) return;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } catch {
      throw new BookError('私人記憶資料無法儲存；請檢查伺服器資料目錄權限。');
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return {
    load: () => serialize(async () => {
      await ensureLoaded();
      return { positions: Object.keys(data.positions).length, moves: Object.values(data.positions).reduce((sum, position) => sum + Object.keys(position.moves).length, 0) };
    }),
    record: ({ board, color, move, winRate, source = 'agent-estimate' }) => serialize(async () => {
      const normalized = canonical(board, color);
      if (!validPoint(board, move)) throw new TypeError('記憶落點必須是有效且未佔用的座標。');
      if (!Number.isFinite(winRate) || winRate < 0 || winRate > 1) throw new TypeError('記憶勝率必須是 0 到 1 的數值。');
      await ensureLoaded();
      const moveKey = normalized.moveKey(move);
      const previous = data.positions[normalized.key]?.moves ?? {};
      if (!previous[moveKey] && winRate >= .4 && winRate < .7) return { stored: false, winRate };
      const next = { version: 1, positions: { ...data.positions, [normalized.key]: { moves: { ...previous, [moveKey]: { winRate, updatedAt: new Date().toISOString(), source: source === 'tactical-win' ? 'tactical-win' : 'agent-estimate' } } } } };
      await persist(next);
      data = next;
      return { stored: true, winRate };
    }),
    query: ({ board, color, legalMoves }) => serialize(async () => {
      const normalized = canonical(board, color);
      if (!Array.isArray(legalMoves)) throw new TypeError('記憶查詢需要合法落點清單。');
      await ensureLoaded();
      const remembered = data.positions[normalized.key]?.moves ?? {};
      const candidates = legalMoves.filter((move) => validPoint(board, move)).map(({ row, col }) => ({ row, col }));
      const knownMoves = candidates.flatMap((move) => {
        const record = remembered[normalized.moveKey(move)];
        return record ? [{ ...move, winRate: record.winRate }] : [];
      });
      const lowKeys = new Set(knownMoves.filter((move) => move.winRate < .4).map((move) => move.row * 15 + move.col));
      const alternatives = candidates.filter((move) => !lowKeys.has(move.row * 15 + move.col));
      const preferredMove = knownMoves.filter((move) => move.winRate >= .7).sort((a, b) => b.winRate - a.winRate || a.row - b.row || a.col - b.col)[0] ?? null;
      return {
        preferredMove,
        legalMoves: alternatives.length ? alternatives : candidates,
        avoidedMoves: alternatives.length ? knownMoves.filter((move) => move.winRate < .4) : [],
        knownMoves,
      };
    }),
  };
}
