import { OPENINGS } from './openings.mjs';
import { equivalentFifths } from './game.mjs';

export const STORAGE_KEY = 'renju.archive.v1';
const VERSION = 1;
const MODES = new Set(['black', 'white', 'both']);
const PHASES = new Set(['setup', 'swap', 'fourth', 'offer-fifth', 'choose-fifth', 'playing', 'finished']);
const NORMAL_ENDINGS = new Set(['five', 'forbidden', 'agreement', 'full-board']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = value => typeof value === 'string' && value.length <= 128
  && (UUID.test(value) || /^renju-[a-z0-9]+-[a-z0-9]+$/.test(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const coordinate = value => isObject(value) && Number.isInteger(value.row) && Number.isInteger(value.col)
  && value.row >= 0 && value.row < 15 && value.col >= 0 && value.col < 15;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const emptyArchive = () => ({ active: null, history: [] });

function validResult(game) {
  const result = game.result;
  if (!isObject(result) || !NORMAL_ENDINGS.has(result.reason) || !Array.isArray(result.winningLine)
    || !result.winningLine.every(coordinate)) return false;
  if (result.reason === 'agreement') return result.winner === null && result.winningLine.length === 0;
  if (result.reason === 'full-board') return result.winner === null && result.winningLine.length === 0 && game.moves.length === 225;
  if (result.reason === 'forbidden') {
    const last = game.moves.at(-1);
    return result.winner === 2 && result.winningLine.length === 0 && game.turn === 1 && last?.color === 1
      && ['overline', 'double-four', 'double-three'].includes(result.forbiddenKind) && coordinate(result.attemptedMove)
      && result.attemptedMove.row === last.row && result.attemptedMove.col === last.col;
  }
  if (![1, 2].includes(result.winner) || result.winner !== game.turn || result.winner !== game.moves.at(-1)?.color
    || result.winningLine.length < 5 || result.winner === 1 && result.winningLine.length !== 5) return false;
  const line = result.winningLine;
  const dr = line[1].row - line[0].row;
  const dc = line[1].col - line[0].col;
  if (Math.abs(dr) > 1 || Math.abs(dc) > 1 || dr === 0 && dc === 0) return false;
  return line.every((point, index) => game.board[point.row * 15 + point.col] === result.winner
    && point.row === line[0].row + dr * index && point.col === line[0].col + dc * index)
    && line.some(point => point.row === game.moves.at(-1).row && point.col === game.moves.at(-1).col);
}

function snapshot(game) {
  if (!isObject(game) || !validId(game.id)
    || !validDate(game.createdAt) || !validDate(game.updatedAt) || Date.parse(game.updatedAt) < Date.parse(game.createdAt)
    || !MODES.has(game.mode) || !PHASES.has(game.phase) || ![1, 2].includes(game.turn)
    || typeof game.swapped !== 'boolean' || !isObject(game.players)
    || Object.keys(game.players).length !== 2 || !Array.isArray(game.board) || game.board.length !== 225
    || !Array.isArray(game.moves) || game.moves.length > 225 || !Array.isArray(game.fifthCandidates)) return null;

  const base = game.mode === 'both' ? ['player1', 'player2'] : game.mode === 'black' ? ['human', 'computer'] : ['computer', 'human'];
  const players = game.swapped ? [...base].reverse() : base;
  if (game.players[1] !== players[0] || game.players[2] !== players[1]) return null;

  const rebuilt = Array(225).fill(0);
  for (let index = 0; index < game.moves.length; index++) {
    const move = game.moves[index];
    if (!coordinate(move) || move.color !== (index % 2 === 0 ? 1 : 2) || move.number !== index + 1
      || rebuilt[move.row * 15 + move.col] !== 0) return null;
    rebuilt[move.row * 15 + move.col] = move.color;
  }
  for (let index = 0; index < 225; index++) {
    if (![0, 1, 2].includes(game.board[index]) || game.board[index] !== rebuilt[index]) return null;
  }

  if (game.phase === 'setup') {
    if (game.moves.length !== 0 || game.turn !== 1 || game.openingId !== null || game.swapped || game.fifthCandidates.length) return null;
  } else {
    const opening = OPENINGS.find(value => value.id === game.openingId);
    if (!opening || game.moves.length < 3 || opening.stones.some((stone, index) => {
      const move = game.moves[index];
      return move.row !== stone.row || move.col !== stone.col || move.color !== stone.color;
    })) return null;
  }

  const count = game.moves.length;
  if (game.phase === 'swap' && (count !== 3 || game.turn !== 2 || game.swapped)) return null;
  if (game.phase === 'fourth' && (count !== 3 || game.turn !== 2)) return null;
  if (game.phase === 'offer-fifth' && (count !== 4 || game.turn !== 1 || game.fifthCandidates.length > 1)) return null;
  if (game.phase === 'choose-fifth' && (count !== 4 || game.turn !== 2 || game.fifthCandidates.length !== 2)) return null;
  if (game.phase === 'playing' && (count < 5 || game.turn !== (count % 2 === 0 ? 1 : 2))) return null;
  if (!['offer-fifth', 'choose-fifth', 'finished'].includes(game.phase) && game.fifthCandidates.length) return null;
  if (game.fifthCandidates.length > 2 || game.fifthCandidates.some(point => !coordinate(point) || game.board[point.row * 15 + point.col] !== 0)) return null;
  if (game.fifthCandidates.length === 2 && equivalentFifths(game.board, ...game.fifthCandidates)) return null;
  if (game.phase === 'finished' ? !validResult(game) : game.result !== null) return null;

  try {
    // Preserve the current game schema, including outcome details, but return an
    // independent plain snapshot rather than retaining caller-owned objects.
    return JSON.parse(JSON.stringify(game));
  } catch { return null; }
}

function latestFirst(history) {
  return history.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

function withWarnings(archive, warnings) {
  return warnings.length ? { ...archive, warnings } : archive;
}

function readArchive(storage, strictRead = false) {
  let text;
  try { text = storage.getItem(STORAGE_KEY); } catch {
    const message = '無法讀取瀏覽器的對局紀錄。請允許本機儲存後重試。';
    if (strictRead) throw new Error(message);
    return withWarnings(emptyArchive(), [message]);
  }
  if (text === null) return emptyArchive();
  let payload;
  try { payload = JSON.parse(text); } catch {
    return withWarnings(emptyArchive(), ['瀏覽器的對局紀錄已損壞，無法還原。']);
  }
  if (!isObject(payload) || payload.version !== VERSION) {
    return withWarnings(emptyArchive(), ['對局紀錄版本不相容，無法還原。']);
  }

  const warnings = [];
  const histories = new Map();
  if (!Array.isArray(payload.history)) warnings.push('部分歷史對局資料損壞，已略過。');
  for (const entry of Array.isArray(payload.history) ? payload.history : []) {
    const game = snapshot(entry);
    if (!game || game.phase !== 'finished') { warnings.push('一筆歷史對局資料損壞，已略過。'); continue; }
    const existing = histories.get(game.id);
    if (!existing || Date.parse(game.updatedAt) >= Date.parse(existing.updatedAt)) histories.set(game.id, game);
    if (existing) warnings.push('重複的歷史對局已合併。');
  }
  let active = payload.active === null ? null : snapshot(payload.active);
  if (payload.active !== null && (!active || active.phase === 'finished')) {
    active = null;
    warnings.push('未完成對局資料損壞，無法繼續；有效歷史對局已保留。');
  }
  if (active && histories.has(active.id)) {
    active = null;
    warnings.push('這局已正常結束，已保留歷史紀錄並略過過期的續局資料。');
  }
  return withWarnings({ active, history: latestFirst([...histories.values()]) }, warnings);
}

export function loadArchive(storage) {
  return readArchive(storage);
}

function writeArchive(storage, archive) {
  try {
    // Web Storage setItem is atomic: if quota or permissions reject this single
    // write, the previously durable payload remains intact.
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, active: archive.active, history: archive.history }));
  } catch {
    throw new Error('無法儲存對局紀錄。請檢查瀏覽器儲存權限與可用空間；先前紀錄仍保留。');
  }
  return archive;
}

export function saveGame(storage, game) {
  const saved = snapshot(game);
  if (!saved) throw new Error('對局資料無效，未寫入儲存紀錄。');
  const archive = readArchive(storage, true);
  if (saved.phase !== 'finished') {
    if (archive.active && archive.active.id !== saved.id) throw new Error('已有另一局未完成對局。請先繼續或明確放棄，再開始新局。');
    if (archive.history.some(entry => entry.id === saved.id)) throw new Error('這局已正常結束，不能覆寫歷史紀錄為未完成對局。');
    return writeArchive(storage, { ...archive, active: saved });
  }
  const history = latestFirst([saved, ...archive.history.filter(entry => entry.id !== saved.id)]);
  return writeArchive(storage, { ...archive, active: archive.active?.id === saved.id ? null : archive.active, history });
}

export function abandonGame(storage, id) {
  if (!validId(id)) throw new Error('對局識別資料無效，無法放棄對局。');
  const archive = readArchive(storage, true);
  return writeArchive(storage, { ...archive, active: archive.active?.id === id ? null : archive.active });
}
