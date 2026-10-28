export const SIZE = 15;
export const BLACK = 1;
export const WHITE = 2;

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const inBounds = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
const validBoard = board => Array.isArray(board) && board.length === SIZE * SIZE
  && Array.from(board).every(cell => cell === 0 || cell === BLACK || cell === WHITE);

// Every move examines only its four lines; unrelated existing threats do not
// become new fours or threes when a stone is played elsewhere.
const MOVE_LINES = Array.from({ length: SIZE * SIZE }, (_, index) => {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  return DIRECTIONS.map(([dr, dc]) => {
    let firstRow = row;
    let firstCol = col;
    while (inBounds(firstRow - dr, firstCol - dc)) {
      firstRow -= dr;
      firstCol -= dc;
    }
    const cells = [];
    let pivot = 0;
    for (let r = firstRow, c = firstCol; inBounds(r, c); r += dr, c += dc) {
      if (r === row && c === col) pivot = cells.length;
      cells.push(r * SIZE + c);
    }
    return { cells, pivot };
  });
});

export function createBoard() {
  return Array(SIZE * SIZE).fill(0);
}

export function toCoordinate(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || !inBounds(row, col)) return '—';
  return `${String.fromCharCode(65 + col)}${SIZE - row}`;
}

function outcome(kind, legal = false, extras = {}) {
  const reasons = {
    invalid: '無效的棋盤、座標或棋子顏色。',
    occupied: '這個交叉點已有棋子，請選擇空位。',
    overline: '黑方禁手：長連（六子以上），請另選落點。',
    'double-four': '黑方禁手：四四（同時形成兩個四），請另選落點。',
    'double-three': '黑方禁手：三三（同時形成兩個活三），請另選落點。',
    normal: '可以落子。',
    five: '達成五連，獲勝！',
  };
  return { legal, reason: reasons[kind], win: false, kind, winningLine: [], fours: 0, threes: 0, ...extras };
}

function runsThrough(board, index, color) {
  return MOVE_LINES[index].map(({ cells, pivot }) => {
    let start = pivot;
    let end = pivot;
    while (start > 0 && board[cells[start - 1]] === color) start--;
    while (end + 1 < cells.length && board[cells[end + 1]] === color) end++;
    return cells.slice(start, end + 1);
  });
}

function coordinates(indices) {
  return indices.map(index => ({ row: Math.floor(index / SIZE), col: index % SIZE }));
}

function fourCount(board, index, color) {
  const fours = new Set();
  for (const { cells, pivot } of MOVE_LINES[index]) {
    for (let start = Math.max(0, pivot - 4); start <= Math.min(pivot, cells.length - 5); start++) {
      const stones = [];
      let empties = 0;
      for (let offset = 0; offset < 5; offset++) {
        const cell = cells[start + offset];
        if (board[cell] === color) stones.push(cell);
        else if (board[cell] === 0) empties++;
        else break;
      }
      if (stones.length !== 4 || empties !== 1) continue;
      // A black four must be completable to EXACT five in this direction.
      // An exact five has RIF 9.2 priority over restrictions in other lines.
      if (color === BLACK && (board[cells[start - 1]] === BLACK || board[cells[start + 5]] === BLACK)) continue;
      // An open straight four has two completions, but one set of four stones.
      fours.add(stones.join(','));
    }
  }
  return fours.size;
}

function threeCount(board, index, color, memo) {
  const threes = new Set();
  for (const { cells, pivot } of MOVE_LINES[index]) {
    for (let start = Math.max(1, pivot - 3); start <= Math.min(pivot, cells.length - 5); start++) {
      if (board[cells[start - 1]] !== 0 || board[cells[start + 4]] !== 0) continue;
      const stones = [];
      let extension = -1;
      let empties = 0;
      for (let offset = 0; offset < 4; offset++) {
        const cell = cells[start + offset];
        if (board[cell] === color) stones.push(cell);
        else if (board[cell] === 0) {
          empties++;
          extension = cell;
        } else break;
      }
      if (stones.length !== 3 || empties !== 1) continue;
      const key = stones.join(',');
      if (threes.has(key)) continue;
      // Both ends of the resulting straight four must complete an exact five.
      if (color === BLACK && (board[cells[start - 2]] === BLACK || board[cells[start + 5]] === BLACK)) continue;
      board[extension] = color;
      let next;
      try {
        next = analyzePlaced(board, extension, color, memo);
      } finally {
        board[extension] = 0;
      }
      // RIF 9.3: the extension must not attain five or be any forbidden move.
      // Checking its own threes recursively is what excludes false threes.
      if (next.legal && !next.win) threes.add(key);
    }
  }
  return threes.size;
}

function analyzePlaced(board, index, color, memo) {
  // Recursive calls always add an empty stone: this is a finite DAG, with no
  // heuristic recursion cutoff. Memoization shares repeated continuations.
  const key = `${color}:${index}:${board.join('')}`;
  if (memo.has(key)) return memo.get(key);
  const runs = runsThrough(board, index, color);
  const winning = runs.find(run => color === BLACK ? run.length === 5 : run.length >= 5);
  let result;
  if (winning) {
    result = outcome('five', true, {
      win: true,
      reason: color === BLACK ? '黑方達成五連，獲勝！' : '白方達成五連或長連，獲勝！',
      winningLine: coordinates(winning),
    });
  } else if (color === BLACK && runs.some(run => run.length > 5)) {
    result = outcome('overline');
  } else {
    const fours = fourCount(board, index, color);
    if (color === BLACK && fours >= 2) {
      result = outcome('double-four', false, { fours });
    } else {
      const threes = threeCount(board, index, color, memo);
      result = color === BLACK && threes >= 2
        ? outcome('double-three', false, { fours, threes })
        : outcome('normal', true, { fours, threes });
    }
  }
  memo.set(key, result);
  return result;
}

export function analyzeMove(board, row, col, color) {
  if (!validBoard(board) || !Number.isInteger(row) || !Number.isInteger(col)
      || !inBounds(row, col) || (color !== BLACK && color !== WHITE)) return outcome('invalid');
  const index = row * SIZE + col;
  if (board[index] !== 0) return outcome('occupied');
  const position = [...board];
  position[index] = color;
  return analyzePlaced(position, index, color, new Map());
}

export function getLegalMoves(board, color, { nearby = false } = {}) {
  if (!validBoard(board) || (color !== BLACK && color !== WHITE)) return [];
  const candidates = new Set();
  if (nearby) {
    const stones = board.flatMap((cell, index) => cell ? [index] : []);
    if (stones.length === 0) candidates.add(7 * SIZE + 7);
    for (const index of stones) {
      const row = Math.floor(index / SIZE);
      const col = index % SIZE;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        if (inBounds(row + dr, col + dc)) candidates.add((row + dr) * SIZE + col + dc);
      }
    }
  } else {
    for (let index = 0; index < board.length; index++) candidates.add(index);
  }
  const position = [...board];
  const memo = new Map();
  const moves = [];
  for (const index of [...candidates].sort((a, b) => a - b)) {
    if (position[index] !== 0) continue;
    position[index] = color;
    let legal;
    try {
      legal = color === WHITE || analyzePlaced(position, index, color, memo).legal;
    } finally {
      position[index] = 0;
    }
    if (legal) moves.push({ row: Math.floor(index / SIZE), col: index % SIZE });
  }
  return moves;
}
