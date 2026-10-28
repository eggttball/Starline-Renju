import { BLACK, WHITE, SIZE, analyzeMove, toCoordinate } from './rules.mjs';

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inBounds = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
const validPosition = (board, color) => Array.isArray(board) && board.length === SIZE * SIZE
  && Array.from(board).every(cell => cell === 0 || cell === BLACK || cell === WHITE)
  && (color === BLACK || color === WHITE);
const coordinate = index => ({ row: Math.floor(index / SIZE), col: index % SIZE });

// Scan each complete line once. Only five-cell windows containing the required
// stones reach the recursive rules engine; ordinary empty points do not.
const LINES = [];
for (const [dr, dc] of DIRECTIONS) {
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
    if (inBounds(row - dr, col - dc)) continue;
    const line = [];
    for (let r = row, c = col; inBounds(r, c); r += dr, c += dc) line.push(r * SIZE + c);
    if (line.length >= 5) LINES.push(line);
  }
}

function windowCandidates(board, color, stoneCount) {
  const candidates = new Set();
  for (const line of LINES) {
    for (let start = 0; start <= line.length - 5; start++) {
      let stones = 0;
      const empties = [];
      for (let offset = 0; offset < 5; offset++) {
        const index = line[start + offset];
        if (board[index] === color) stones++;
        else if (board[index] === 0) empties.push(index);
        else break;
      }
      if (stones !== stoneCount || empties.length !== 5 - stoneCount) continue;
      // Black must complete an exact five in at least one direction. Another
      // direction can still nominate this point under RIF's exact-five priority.
      if (color === BLACK && (board[line[start - 1]] === BLACK || board[line[start + 5]] === BLACK)) continue;
      for (const index of empties) candidates.add(index);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

function winningMoves(board, color) {
  const moves = [];
  for (const index of windowCandidates(board, color, 4)) {
    const move = coordinate(index);
    const outcome = analyzeMove(board, move.row, move.col, color);
    if (outcome.legal && outcome.win) moves.push(move);
  }
  return moves;
}

/** Legal one-move wins, in stable row/column order. Never changes the board. */
export function findWinningMoves(board, color) {
  return validPosition(board, color) ? winningMoves(board, color) : [];
}

/** Select a proven local tactic, or null so the caller can use its usual AI. */
export function findTacticalMove(board, color) {
  if (!validPosition(board, color)) return null;

  const ownWins = winningMoves(board, color);
  if (ownWins.length) {
    const move = ownWins[0];
    return {
      move,
      decision: 'win',
      reason: `${toCoordinate(move.row, move.col)}：${analyzeMove(board, move.row, move.col, color).reason}`,
      winRate: 1,
    };
  }

  const opponent = color === BLACK ? WHITE : BLACK;
  const opponentWins = winningMoves(board, opponent);
  if (opponentWins.length) {
    for (const move of opponentWins) {
      if (!analyzeMove(board, move.row, move.col, color).legal) continue;
      return {
        move,
        decision: 'defense',
        reason: opponentWins.length === 1
          ? `${toCoordinate(move.row, move.col)}：封鎖對手下一手的五連獲勝點。`
          : `${toCoordinate(move.row, move.col)}：優先封鎖對手的五連獲勝點；對手仍有其他立即獲勝點。`,
        winRate: null,
      };
    }
    return null;
  }

  if (color !== WHITE) return null;

  // Three White stones in a five-cell window nominate moves that can create a
  // four. Require exactly one winning completion and a genuinely forbidden
  // Black block. The preceding opponent-win check excludes exact-five
  // counterwins; adding a White stone cannot create a new Black exact five.
  const position = [...board];
  for (const index of windowCandidates(board, WHITE, 3)) {
    position[index] = WHITE;
    let completions;
    let defense;
    try {
      completions = winningMoves(position, WHITE);
      if (completions.length === 1) {
        const move = completions[0];
        defense = analyzeMove(position, move.row, move.col, BLACK);
      }
    } finally {
      position[index] = 0;
    }
    if (completions.length !== 1 || defense.legal) continue;
    const completion = completions[0];
    const forbidden = { overline: '長連', 'double-four': '四四', 'double-three': '三三' }[defense.kind];
    if (!forbidden) continue;
    return {
      move: coordinate(index),
      decision: 'forbidden-four',
      reason: `白方形成衝四；黑方唯一防點 ${toCoordinate(completion.row, completion.col)} 為${forbidden}禁手，白方可在下一手完成五連。`,
      winRate: 1,
    };
  }
  return null;
}
