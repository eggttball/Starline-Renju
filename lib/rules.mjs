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
  let reason = extras.reason ?? reasons[kind];
  if (kind === 'double-four' && (extras.threes ?? 0) >= 1) {
    reason = '黑方禁手：四四三（同時形成兩個四與活三），請另選落點。';
  } else if (kind === 'double-three' && (extras.fours ?? 0) >= 1) {
    reason = '黑方禁手：四三三（同時形成四與兩個活三），請另選落點。';
  }
  return { legal, reason, win: false, kind, winningLine: [], fours: 0, threes: 0, ...extras };
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

function analyzePlaced(board, index, color, memo, isRoot = false) {
  // Recursive calls always add an empty stone: this is a finite DAG, with no
  // heuristic recursion cutoff. Memoization shares repeated continuations.
  const key = `${color}:${index}:${board.join('')}`;
  if (!isRoot && memo.has(key)) return memo.get(key);
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
      const threes = isRoot ? threeCount(board, index, color, memo) : 0;
      result = outcome('double-four', false, { fours, threes });
    } else {
      const threes = threeCount(board, index, color, memo);
      result = color === BLACK && threes >= 2
        ? outcome('double-three', false, { fours, threes })
        : outcome('normal', true, { fours, threes });
    }
  }
  if (!isRoot) memo.set(key, result);
  return result;
}

export function analyzeMove(board, row, col, color) {
  if (!validBoard(board) || !Number.isInteger(row) || !Number.isInteger(col)
      || !inBounds(row, col) || (color !== BLACK && color !== WHITE)) return outcome('invalid');
  const index = row * SIZE + col;
  if (board[index] !== 0) return outcome('occupied');
  const position = [...board];
  position[index] = color;
  return analyzePlaced(position, index, color, new Map(), true);
}

// --- KataGomo-style 88-line 16-bit bitmask prefilter & fast in-place Renju forbidden detector ---

const LINE_MASK_COUNT = 88;
const VALID_LINE_MASKS = new Uint16Array(LINE_MASK_COUNT);
const CELL_LINE_INFO = Array.from({ length: SIZE * SIZE }, () => new Array(4));

for (let row = 0; row < SIZE; row++) {
  for (let col = 0; col < SIZE; col++) {
    const idx = row * SIZE + col;
    const infos = [
      { lineIndex: row, bit: col },
      { lineIndex: 15 + col, bit: row },
      { lineIndex: 30 + (col - row + 14), bit: col },
      { lineIndex: 59 + col + row, bit: col },
    ];
    for (let d = 0; d < 4; d++) {
      VALID_LINE_MASKS[infos[d].lineIndex] |= (1 << infos[d].bit);
      CELL_LINE_INFO[idx][d] = {
        lineIndex: infos[d].lineIndex,
        candidateBit: 1 << infos[d].bit,
        six: [],
        sixEndpoints: [],
        five: [],
      };
    }
  }
}

for (let row = 0; row < SIZE; row++) {
  for (let col = 0; col < SIZE; col++) {
    const idx = row * SIZE + col;
    for (let d = 0; d < 4; d++) {
      const info = CELL_LINE_INFO[idx][d];
      const valid = VALID_LINE_MASKS[info.lineIndex];
      const candidateBit = d === 1 ? row : col;
      for (let start = Math.max(0, candidateBit - 5); start <= Math.min(candidateBit, 9); start++) {
        const win = (0x3f << start) & 0xffff;
        if ((win & valid) !== win) continue;
        info.six.push(win);
        info.sixEndpoints.push((1 << start) | (1 << (start + 5)));
      }
      for (let start = Math.max(0, candidateBit - 4); start <= Math.min(candidateBit, 10); start++) {
        const win = (0x1f << start) & 0xffff;
        if ((win & valid) === win) info.five.push(win);
      }
    }
  }
}

function popcount16(v) {
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  return (((v + (v >> 4)) & 0x0f0f) * 0x0101) >> 8;
}

function hasStrictWindowPotential15(index, blackLineMasks, blockedLineMasks) {
  const dirs = CELL_LINE_INFO[index];
  let threeDirections = 0;
  let fourContributions = 0;
  for (let d = 0; d < 4; d++) {
    const g = dirs[d];
    const black = blackLineMasks[g.lineIndex];
    const blocked = blockedLineMasks[g.lineIndex];

    let threePotential = false;
    for (let i = 0; i < g.six.length; i++) {
      const win = g.six[i];
      if ((win & blocked) !== 0) continue;
      const blackCount = popcount16(win & black);
      if (blackCount >= 5) return true;
      if (!threePotential && (g.candidateBit & g.sixEndpoints[i]) === 0 && blackCount === 2 && ((black | blocked) & g.sixEndpoints[i]) === 0) {
        threePotential = true;
      }
    }

    let winningCompletions = 0;
    for (let i = 0; i < g.five.length; i++) {
      const win = g.five[i];
      if ((win & blocked) !== 0 || popcount16(win & black) !== 3) continue;
      winningCompletions |= (win & ~(black | g.candidateBit));
    }

    fourContributions += Math.min(2, popcount16(winningCompletions));
    if (fourContributions >= 2) return true;
    if (threePotential && ++threeDirections >= 2) return true;
  }
  return false;
}

function hasExactFiveFast(board, index) {
  const lines = MOVE_LINES[index];
  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = lines[d];
    let start = pivot;
    let end = pivot;
    while (start > 0 && board[cells[start - 1]] === BLACK) start--;
    while (end + 1 < cells.length && board[cells[end + 1]] === BLACK) end++;
    if (end - start + 1 === 5) return true;
  }
  return false;
}

function hasOverlineFast(board, index) {
  const lines = MOVE_LINES[index];
  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = lines[d];
    let start = pivot;
    let end = pivot;
    while (start > 0 && board[cells[start - 1]] === BLACK) start--;
    while (end + 1 < cells.length && board[cells[end + 1]] === BLACK) end++;
    if (end - start + 1 > 5) return true;
  }
  return false;
}

function countFoursFast(board, index) {
  let count = 0;
  const lines = MOVE_LINES[index];
  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = lines[d];
    const len = cells.length;
    const minStart = Math.max(0, pivot - 4);
    const maxStart = Math.min(pivot, len - 5);
    let lastSig = -1;
    let dirFours = 0;
    for (let start = minStart; start <= maxStart; start++) {
      let stones = 0;
      let empties = 0;
      let sig = 0;
      let ok = true;
      for (let offset = 0; offset < 5; offset++) {
        const cell = cells[start + offset];
        const v = board[cell];
        if (v === BLACK) {
          stones++;
          sig = sig * 256 + cell;
        } else if (v === 0) {
          empties++;
        } else {
          ok = false;
          break;
        }
      }
      if (!ok || stones !== 4 || empties !== 1) continue;
      if ((start > 0 && board[cells[start - 1]] === BLACK) || (start + 5 < len && board[cells[start + 5]] === BLACK)) continue;
      if (sig === lastSig) continue;
      lastSig = sig;
      dirFours++;
    }
    count += dirFours;
    if (count >= 2) return count;
  }
  return count;
}

function isBlackForbiddenPlacedMutable(board, index) {
  if (hasExactFiveFast(board, index)) return false;
  if (hasOverlineFast(board, index)) return true;
  if (countFoursFast(board, index) >= 2) return true;

  let threes = 0;
  const lines = MOVE_LINES[index];
  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = lines[d];
    const len = cells.length;
    const minStart = Math.max(1, pivot - 3);
    const maxStart = Math.min(pivot, len - 5);
    let foundDirThree = false;
    for (let start = minStart; start <= maxStart; start++) {
      if (board[cells[start - 1]] !== 0 || board[cells[start + 4]] !== 0) continue;
      let stones = 0;
      let empties = 0;
      let extension = -1;
      let ok = true;
      for (let offset = 0; offset < 4; offset++) {
        const cell = cells[start + offset];
        const v = board[cell];
        if (v === BLACK) {
          stones++;
        } else if (v === 0) {
          empties++;
          extension = cell;
        } else {
          ok = false;
          break;
        }
      }
      if (!ok || stones !== 3 || empties !== 1) continue;
      if ((start >= 2 && board[cells[start - 2]] === BLACK) || (start + 5 < len && board[cells[start + 5]] === BLACK)) continue;
      board[extension] = BLACK;
      let extIllegalOrWin = false;
      try {
        extIllegalOrWin = hasExactFiveFast(board, extension) || isBlackForbiddenPlacedMutable(board, extension);
      } finally {
        board[extension] = 0;
      }
      if (!extIllegalOrWin) {
        foundDirThree = true;
        break;
      }
    }
    if (foundDirThree) {
      threes++;
      if (threes >= 2) return true;
    }
  }
  return false;
}

const NEARBY_16_OFFSETS = [
  [-2, -2], [-2, 0], [-2, 2],
  [0, -2],           [0, 2],
  [2, -2],  [2, 0],  [2, 2],
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

/**
 * Fast in-place Black forbidden check on a mutable board (Array or Uint8Array).
 * Mutates and restores board[index] via try/finally; caller must pass a mutable board.
 */
export function isBlackForbiddenMutable(board, index) {
  if (board[index] !== 0) return false;
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  let nearbyBlack = 0;
  for (let i = 0; i < 16; i++) {
    const r = row + NEARBY_16_OFFSETS[i][0];
    const c = col + NEARBY_16_OFFSETS[i][1];
    if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === BLACK) {
      nearbyBlack++;
      if (nearbyBlack >= 2) break;
    }
  }
  if (nearbyBlack < 2) return false;
  board[index] = BLACK;
  try {
    return isBlackForbiddenPlacedMutable(board, index);
  } finally {
    board[index] = 0;
  }
}

/**
 * Safe fast Black forbidden check that never mutates the caller's board (even if frozen).
 */
export function isBlackForbiddenFast(board, index) {
  if (!board || board.length !== SIZE * SIZE || index < 0 || index >= SIZE * SIZE || board[index] !== 0) {
    return false;
  }
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  let nearbyBlack = 0;
  for (let i = 0; i < 16; i++) {
    const r = row + NEARBY_16_OFFSETS[i][0];
    const c = col + NEARBY_16_OFFSETS[i][1];
    if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === BLACK) {
      nearbyBlack++;
      if (nearbyBlack >= 2) break;
    }
  }
  if (nearbyBlack < 2) return false;
  const scratch = Uint8Array.from(board);
  scratch[index] = BLACK;
  return isBlackForbiddenPlacedMutable(scratch, index);
}

/**
 * KataGomo-style bulk forbidden-point map using 88-line 16-bit bitmasks.
 * Returns Uint8Array(225) where 1 means Black is forbidden at that empty cell.
 */
export function computeForbiddenMap(board) {
  const map = new Uint8Array(SIZE * SIZE);
  const scratch = Uint8Array.from(board);
  const blackLineMasks = new Uint16Array(LINE_MASK_COUNT);
  const blockedLineMasks = new Uint16Array(LINE_MASK_COUNT);
  const nearby = new Uint8Array(SIZE * SIZE);

  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const idx = row * SIZE + col;
      const stone = scratch[idx];
      if (stone === 0) continue;
      const masks = stone === BLACK ? blackLineMasks : blockedLineMasks;
      const xBit = 1 << col;
      const yBit = 1 << row;
      masks[row] |= xBit;
      masks[15 + col] |= yBit;
      masks[30 + (col - row + 14)] |= xBit;
      masks[59 + col + row] |= xBit;
      if (stone === BLACK) {
        for (let i = 0; i < 16; i++) {
          const nr = row + NEARBY_16_OFFSETS[i][0];
          const nc = col + NEARBY_16_OFFSETS[i][1];
          if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) {
            nearby[nr * SIZE + nc]++;
          }
        }
      }
    }
  }

  for (let idx = 0; idx < SIZE * SIZE; idx++) {
    if (scratch[idx] !== 0 || nearby[idx] < 2) continue;
    if (!hasStrictWindowPotential15(idx, blackLineMasks, blockedLineMasks)) continue;
    scratch[idx] = BLACK;
    if (isBlackForbiddenPlacedMutable(scratch, idx)) map[idx] = 1;
    scratch[idx] = 0;
  }
  return map;
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
  const forbiddenMap = color === BLACK ? computeForbiddenMap(board) : null;
  const moves = [];
  for (const index of [...candidates].sort((a, b) => a - b)) {
    if (board[index] !== 0) continue;
    if (forbiddenMap && forbiddenMap[index] !== 0) continue;
    moves.push({ row: Math.floor(index / SIZE), col: index % SIZE });
  }
  return moves;
}
