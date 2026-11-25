import {
  BLACK,
  WHITE,
  SIZE,
  toCoordinate,
  isBlackForbiddenMutable,
  computeForbiddenMap,
} from './rules.mjs';

const AREA = SIZE * SIZE;
const MATE = 30000;
const EVAL_CLAMP = 14000;
const TEMPO_BONUS = 45;
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

// 11-cell (±5) directional pattern codes
export const PAT = {
  NONE: 0,
  SLEEP_TWO: 1,
  WIDE_TWO: 2,
  OPEN_TWO: 3,
  SLEEP_THREE: 4,
  JUMP_THREE: 5,
  OPEN_THREE: 6,
  SLEEP_FOUR: 7,
  OPEN_FOUR: 8,
  DOUBLE_FOUR_LINE: 9,
  FIVE: 10,
  OVERLINE: 11,
};

// Back-compat THREAT export
export const THREAT = {
  NONE: 0,
  SLEEP_TWO: 1,
  OPEN_TWO: 2,
  SLEEP_THREE: 3,
  OPEN_THREE: 4,
  SLEEP_FOUR: 5,
  OPEN_FOUR: 6,
  FIVE: 7,
};

// Compound square classification (Embryo Square::SquareCombination style)
export const COMBO = {
  NONE: 0,
  DOUBLE_TWO: 1,
  THREE_TWO: 2,
  DOUBLE_THREE: 3,
  FOUR_THREE: 4,
  DOUBLE_FOUR: 5,
  OPEN_FOUR: 6,
  FIVE: 7,
};

// Global empty-cell pattern weights: active side vs passive side (Embryo asymmetric ratio)
// Index: [NONE, SLEEP_TWO, WIDE_TWO, OPEN_TWO, SLEEP_THREE, JUMP_THREE, OPEN_THREE, SLEEP_FOUR, OPEN_FOUR, DBL_FOUR_LINE, FIVE, OVERLINE]
const ACT_PAT_W = new Int32Array([0, 12, 32, 72, 95, 290, 380, 680, 1800, 2200, 3200, 0]);
const PAS_PAT_W = new Int32Array([0, 4, 11, 24, 34, 96, 125, 195, 680, 820, 1800, 0]);

// Center-proximity positional table
const POS_SCORE = new Int32Array(AREA);
for (let r = 0; r < SIZE; r++) {
  for (let c = 0; c < SIZE; c++) {
    const d = Math.max(Math.abs(r - 7), Math.abs(c - 7));
    POS_SCORE[r * SIZE + c] = (7 - d) * 5;
  }
}

// Precomputed lines passing through each cell
const MOVE_LINES = Array.from({ length: AREA }, (_, index) => {
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  return DIRECTIONS.map(([dr, dc]) => {
    let r0 = row;
    let c0 = col;
    while (r0 - dr >= 0 && r0 - dr < SIZE && c0 - dc >= 0 && c0 - dc < SIZE) {
      r0 -= dr;
      c0 -= dc;
    }
    const cells = [];
    let pivot = 0;
    for (let r = r0, c = c0; r >= 0 && r < SIZE && c >= 0 && c < SIZE; r += dr, c += dc) {
      if (r === row && c === col) pivot = cells.length;
      cells.push(r * SIZE + c);
    }
    return { cells: Int16Array.from(cells), pivot };
  });
});

// Precomputed Chebyshev-2 neighborhood (<= 24 neighbors)
const NEIGHBORHOOD_2 = Array.from({ length: AREA }, (_, index) => {
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  const out = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) out.push(nr * SIZE + nc);
    }
  }
  return Int16Array.from(out);
});

// Precomputed Chebyshev-1 (3x3) neighborhood for local cohesion
const NEIGHBORHOOD_1 = Array.from({ length: AREA }, (_, index) => {
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) out.push(nr * SIZE + nc);
    }
  }
  return Int16Array.from(out);
});

// Precomputed ray neighbors within distance 4
const RAY_NEIGHBORS_4 = Array.from({ length: AREA }, (_, index) => {
  const set = new Set();
  for (const { cells, pivot } of MOVE_LINES[index]) {
    const lo = Math.max(0, pivot - 4);
    const hi = Math.min(cells.length - 1, pivot + 4);
    for (let i = lo; i <= hi; i++) {
      if (i !== pivot) set.add(cells[i]);
    }
  }
  return Int16Array.from([...set]);
});

// --- Precomputed 10-neighbor (±5) base-3 LUTs (59049 entries each) ---
const LUT_SIZE = 59049; // 3^10
const POW3 = Int32Array.from({ length: 10 }, (_, i) => 3 ** i);
const LUT_BLACK = new Uint8Array(LUT_SIZE);
const LUT_WHITE = new Uint8Array(LUT_SIZE);

function classifyLine11(line, isBlack) {
  let l = 5;
  while (l > 0 && line[l - 1] === 1) l--;
  let r = 5;
  while (r < 10 && line[r + 1] === 1) r++;
  const runLen = r - l + 1;

  if (isBlack) {
    if (runLen === 5) return PAT.FIVE;
    if (runLen > 5) return PAT.OVERLINE;
  } else if (runLen >= 5) {
    return PAT.FIVE;
  }

  // Fours in 5-cell windows containing index 5 (start = 1..5)
  let fourMask = 0;
  let fourCount = 0;
  for (let start = 1; start <= 5; start++) {
    let stones = 1;
    let emptyPos = -1;
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const pos = start + k;
      if (pos === 5) continue;
      const v = line[pos];
      if (v === 1) stones++;
      else if (v === 0) {
        if (emptyPos !== -1) { ok = false; break; }
        emptyPos = pos;
      } else { ok = false; break; }
    }
    if (!ok || stones !== 4 || emptyPos === -1) continue;
    if (isBlack && (line[start - 1] === 1 || line[start + 5] === 1)) continue;
    const bit = 1 << emptyPos;
    if ((fourMask & bit) === 0) {
      fourMask |= bit;
      fourCount++;
    }
  }

  if (fourCount >= 2) {
    if (
      runLen === 4
      && line[l - 1] === 0
      && line[r + 1] === 0
      && (!isBlack || ((l < 2 || line[l - 2] !== 1) && (r > 8 || line[r + 2] !== 1)))
    ) {
      return PAT.OPEN_FOUR;
    }
    return PAT.DOUBLE_FOUR_LINE;
  }
  if (fourCount === 1) return PAT.SLEEP_FOUR;

  // Open threes / jump threes in 6-cell windows (start = 1..4)
  let hasOpen3 = false;
  let hasJump3 = false;
  for (let start = 1; start <= 4; start++) {
    if (line[start] !== 0 || line[start + 5] !== 0) continue;
    if (isBlack && (line[start - 1] === 1 || line[start + 6] === 1)) continue;
    let stones = 1;
    let gap = -1;
    let ok = true;
    for (let k = 1; k <= 4; k++) {
      const pos = start + k;
      if (pos === 5) continue;
      const v = line[pos];
      if (v === 1) stones++;
      else if (v === 0) {
        if (gap !== -1) { ok = false; break; }
        gap = pos;
      } else { ok = false; break; }
    }
    if (!ok || stones !== 3 || gap === -1) continue;
    if (gap === start + 1 || gap === start + 4) hasOpen3 = true;
    else hasJump3 = true;
  }
  if (hasOpen3) return PAT.OPEN_THREE;
  if (hasJump3) return PAT.JUMP_THREE;

  // Sleep 3 / Open 2 / Wide 2 / Sleep 2
  let hasSleep3 = false;
  let hasOpen2 = false;
  let hasWide2 = false;
  let hasSleep2 = false;
  for (let start = 1; start <= 5; start++) {
    let stones = 1;
    let otherPos = -1;
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const pos = start + k;
      if (pos === 5) continue;
      const v = line[pos];
      if (v === 1) {
        stones++;
        otherPos = pos;
      } else if (v !== 0) { ok = false; break; }
    }
    if (!ok) continue;
    if (isBlack && (line[start - 1] === 1 || line[start + 5] === 1)) continue;
    if (stones === 3) hasSleep3 = true;
    else if (stones === 2) {
      if (line[start - 1] === 0 && line[start + 5] === 0) {
        if (Math.abs(otherPos - 5) <= 2) hasOpen2 = true;
        else hasWide2 = true;
      } else {
        hasSleep2 = true;
      }
    }
  }
  if (hasSleep3) return PAT.SLEEP_THREE;
  if (hasOpen2) return PAT.OPEN_TWO;
  if (hasWide2) return PAT.WIDE_TWO;
  if (hasSleep2) return PAT.SLEEP_TWO;
  return PAT.NONE;
}

{
  const line = new Uint8Array(11);
  line[5] = 1;
  for (let code = 0; code < LUT_SIZE; code++) {
    let tmp = code;
    for (let i = 0; i < 10; i++) {
      const pos = i < 5 ? i : i + 1;
      line[pos] = tmp % 3;
      tmp = (tmp / 3) | 0;
    }
    LUT_BLACK[code] = classifyLine11(line, true);
    LUT_WHITE[code] = classifyLine11(line, false);
  }
}

// Deterministic 64-bit Zobrist hash tables
const ZOB_HI = [new Uint32Array(AREA), new Uint32Array(AREA), new Uint32Array(AREA)];
const ZOB_LO = [new Uint32Array(AREA), new Uint32Array(AREA), new Uint32Array(AREA)];
let zSeed = 0x9e3779b9;
function nextRand32() {
  zSeed ^= zSeed << 13;
  zSeed ^= zSeed >>> 17;
  zSeed ^= zSeed << 5;
  return zSeed >>> 0;
}
for (let color = 1; color <= 2; color++) {
  for (let i = 0; i < AREA; i++) {
    ZOB_HI[color][i] = nextRand32();
    ZOB_LO[color][i] = nextRand32();
  }
}
const SIDE_HI = nextRand32();
const SIDE_LO = nextRand32();

// Fixed-size Transposition Tables (PVS, VCF, VCT)
const TT_SIZE = 1 << 16;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

const ttHi = new Uint32Array(TT_SIZE);
const ttLo = new Uint32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttBest = new Int16Array(TT_SIZE);
const ttGen = new Uint16Array(TT_SIZE);
let currentGen = 1;

const VCF_TT_SIZE = 1 << 16;
const VCF_TT_MASK = VCF_TT_SIZE - 1;
const vcfTtHi = new Uint32Array(VCF_TT_SIZE);
const vcfTtLo = new Uint32Array(VCF_TT_SIZE);
const vcfTtRes = new Int8Array(VCF_TT_SIZE); // 0=empty, 1=win, 2=loss
const vcfTtMove = new Int16Array(VCF_TT_SIZE);
const vcfTtBound = new Uint8Array(VCF_TT_SIZE);
const vcfTtGen = new Uint16Array(VCF_TT_SIZE);
let vcfGen = 1;

const VCT_TT_SIZE = 1 << 15;
const VCT_TT_MASK = VCT_TT_SIZE - 1;
const vctTtHi = new Uint32Array(VCT_TT_SIZE);
const vctTtLo = new Uint32Array(VCT_TT_SIZE);
const vctTtRes = new Int8Array(VCT_TT_SIZE); // 0=empty, 1=win, 2=loss
const vctTtMove = new Int16Array(VCT_TT_SIZE);
const vctTtDepth = new Uint8Array(VCT_TT_SIZE);
const vctTtGen = new Uint16Array(VCT_TT_SIZE);
let vctGen = 1;

function oppOf(color) {
  return color === BLACK ? WHITE : BLACK;
}

function toCoordObj(index) {
  return { row: (index / SIZE) | 0, col: index % SIZE };
}

/**
 * Incremental BoardState maintaining O(1) LUT directional patterns,
 * 64-bit Zobrist hashes, and Chebyshev-2 candidate counts.
 */
export class BoardState {
  constructor(board) {
    this.board = Uint8Array.from(board);
    this.nearby = new Uint8Array(AREA);
    this.patB = new Uint8Array(AREA * 4);
    this.patW = new Uint8Array(AREA * 4);
    this.cntB = new Int16Array(12);
    this.cntW = new Int16Array(12);
    this.hHi = 0;
    this.hLo = 0;
    this.stoneCount = 0;
    this.history = [];

    for (let i = 0; i < AREA; i++) {
      const v = this.board[i];
      if (v !== 0) {
        this.stoneCount++;
        this.hHi = (this.hHi ^ ZOB_HI[v][i]) >>> 0;
        this.hLo = (this.hLo ^ ZOB_LO[v][i]) >>> 0;
        const nbrs = NEIGHBORHOOD_2[i];
        for (let k = 0; k < nbrs.length; k++) {
          this.nearby[nbrs[k]]++;
        }
      }
    }

    for (let i = 0; i < AREA; i++) {
      if (this.board[i] === 0 && this.nearby[i] > 0) {
        for (let d = 0; d < 4; d++) {
          this.recomputeDir(i, d, true);
        }
      }
    }
  }

  recomputeDir(idx, d, isInit = false) {
    const { cells, pivot } = MOVE_LINES[idx][d];
    const len = cells.length;
    const b = this.board;
    let codeB = 0;
    let codeW = 0;

    for (let step = 0; step < 5; step++) {
      const pL = pivot - 5 + step;
      let valB = 2;
      let valW = 2;
      if (pL >= 0) {
        const s = b[cells[pL]];
        if (s === 0) { valB = 0; valW = 0; }
        else if (s === BLACK) { valB = 1; valW = 2; }
        else { valB = 2; valW = 1; }
      }
      codeB += valB * POW3[step];
      codeW += valW * POW3[step];

      const pR = pivot + 1 + step;
      let vRB = 2;
      let vRW = 2;
      if (pR < len) {
        const s = b[cells[pR]];
        if (s === 0) { vRB = 0; vRW = 0; }
        else if (s === BLACK) { vRB = 1; vRW = 2; }
        else { vRB = 2; vRW = 1; }
      }
      codeB += vRB * POW3[5 + step];
      codeW += vRW * POW3[5 + step];
    }

    const pB = LUT_BLACK[codeB];
    const pW = LUT_WHITE[codeW];
    const slot = (idx << 2) + d;
    if (!isInit) {
      const oldB = this.patB[slot];
      const oldW = this.patW[slot];
      if (oldB !== 0) this.cntB[oldB]--;
      if (oldW !== 0) this.cntW[oldW]--;
    }
    this.patB[slot] = pB;
    this.patW[slot] = pW;
    if (pB !== 0) this.cntB[pB]++;
    if (pW !== 0) this.cntW[pW]++;
  }

  clearCellPatterns(idx) {
    const base = idx << 2;
    for (let d = 0; d < 4; d++) {
      const oldB = this.patB[base + d];
      const oldW = this.patW[base + d];
      if (oldB !== 0) { this.cntB[oldB]--; this.patB[base + d] = 0; }
      if (oldW !== 0) { this.cntW[oldW]--; this.patW[base + d] = 0; }
    }
  }

  play(idx, color) {
    this.board[idx] = color;
    this.stoneCount++;
    this.hHi = (this.hHi ^ ZOB_HI[color][idx]) >>> 0;
    this.hLo = (this.hLo ^ ZOB_LO[color][idx]) >>> 0;
    this.history.push(idx);
    this.clearCellPatterns(idx);

    const nbrs = NEIGHBORHOOD_2[idx];
    for (let k = 0; k < nbrs.length; k++) {
      const nIdx = nbrs[k];
      const wasZero = this.nearby[nIdx] === 0;
      this.nearby[nIdx]++;
      if (wasZero && this.board[nIdx] === 0) {
        for (let d = 0; d < 4; d++) {
          this.recomputeDir(nIdx, d, false);
        }
      }
    }

    for (let d = 0; d < 4; d++) {
      const { cells, pivot } = MOVE_LINES[idx][d];
      const lo = Math.max(0, pivot - 5);
      const hi = Math.min(cells.length - 1, pivot + 5);
      for (let i = lo; i <= hi; i++) {
        if (i === pivot) continue;
        const c = cells[i];
        if (this.board[c] === 0 && this.nearby[c] > 0) {
          this.recomputeDir(c, d, false);
        }
      }
    }
  }

  undo(idx) {
    const color = this.board[idx];
    this.board[idx] = 0;
    this.stoneCount--;
    this.hHi = (this.hHi ^ ZOB_HI[color][idx]) >>> 0;
    this.hLo = (this.hLo ^ ZOB_LO[color][idx]) >>> 0;
    this.history.pop();

    const nbrs = NEIGHBORHOOD_2[idx];
    for (let k = 0; k < nbrs.length; k++) {
      const nIdx = nbrs[k];
      this.nearby[nIdx]--;
      if (this.nearby[nIdx] === 0 && this.board[nIdx] === 0) {
        this.clearCellPatterns(nIdx);
      }
    }

    if (this.nearby[idx] > 0) {
      for (let d = 0; d < 4; d++) {
        this.recomputeDir(idx, d, false);
      }
    }

    for (let d = 0; d < 4; d++) {
      const { cells, pivot } = MOVE_LINES[idx][d];
      const lo = Math.max(0, pivot - 5);
      const hi = Math.min(cells.length - 1, pivot + 5);
      for (let i = lo; i <= hi; i++) {
        if (i === pivot) continue;
        const c = cells[i];
        if (this.board[c] === 0 && this.nearby[c] > 0) {
          this.recomputeDir(c, d, false);
        }
      }
    }
  }
}

function summarizeCell(patArr, idx) {
  const base = idx << 2;
  let fives = 0;
  let openFours = 0;
  let doubleLineFours = 0;
  let sleepFours = 0;
  let openThrees = 0;
  let jumpThrees = 0;
  let sleepThrees = 0;
  let openTwos = 0;
  let wideTwos = 0;
  let sleepTwos = 0;

  for (let d = 0; d < 4; d++) {
    const p = patArr[base + d];
    if (p === PAT.FIVE) fives++;
    else if (p === PAT.OPEN_FOUR) openFours++;
    else if (p === PAT.DOUBLE_FOUR_LINE) doubleLineFours++;
    else if (p === PAT.SLEEP_FOUR) sleepFours++;
    else if (p === PAT.OPEN_THREE) openThrees++;
    else if (p === PAT.JUMP_THREE) jumpThrees++;
    else if (p === PAT.SLEEP_THREE) sleepThrees++;
    else if (p === PAT.OPEN_TWO) openTwos++;
    else if (p === PAT.WIDE_TWO) wideTwos++;
    else if (p === PAT.SLEEP_TWO) sleepTwos++;
  }

  const allThrees = openThrees + jumpThrees;
  const allFours = sleepFours + openFours * 2 + doubleLineFours * 2;
  let combo = COMBO.NONE;
  if (fives > 0) combo = COMBO.FIVE;
  else if (doubleLineFours > 0 || sleepFours >= 2 || (openFours >= 1 && sleepFours >= 1) || openFours >= 2) {
    combo = COMBO.DOUBLE_FOUR;
  } else if (openFours === 1) {
    combo = COMBO.OPEN_FOUR;
  } else if (sleepFours === 1 && allThrees >= 1) {
    combo = COMBO.FOUR_THREE;
  } else if (allThrees >= 2) {
    combo = COMBO.DOUBLE_THREE;
  } else if (allThrees === 1 && openTwos >= 1) {
    combo = COMBO.THREE_TWO;
  } else if (openTwos >= 2) {
    combo = COMBO.DOUBLE_TWO;
  }

  return {
    fives,
    openFours,
    doubleLineFours,
    sleepFours,
    allFours,
    openThrees,
    jumpThrees,
    allThrees,
    sleepThrees,
    openTwos,
    wideTwos,
    sleepTwos,
    combo,
  };
}

function getActiveCandidates(state) {
  if (state.stoneCount === 0) return [7 * SIZE + 7];
  const out = [];
  const b = state.board;
  const nb = state.nearby;
  for (let i = 0; i < AREA; i++) {
    if (b[i] === 0 && nb[i] > 0) out.push(i);
  }
  return out;
}

function findFiveCompletions(state, color) {
  const cnt = color === BLACK ? state.cntB : state.cntW;
  if (cnt[PAT.FIVE] === 0) return [];
  const pat = color === BLACK ? state.patB : state.patW;
  const b = state.board;
  const nb = state.nearby;
  const out = [];
  for (let i = 0; i < AREA; i++) {
    if (b[i] !== 0 || nb[i] === 0) continue;
    const base = i << 2;
    if (pat[base] === PAT.FIVE || pat[base + 1] === PAT.FIVE || pat[base + 2] === PAT.FIVE || pat[base + 3] === PAT.FIVE) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Find exact 5-completion squares created by the stone already placed at `placedIndex`.
 */
function findFivesCreatedByMove(board, placedIndex, color) {
  const isBlack = color === BLACK;
  const completions = [];
  const seen = new Uint8Array(AREA);
  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = MOVE_LINES[placedIndex][d];
    const len = cells.length;
    const min5 = Math.max(0, pivot - 4);
    const max5 = Math.min(pivot, len - 5);
    for (let start = min5; start <= max5; start++) {
      let stones = 0;
      let emptyCell = -1;
      let ok = true;
      for (let k = 0; k < 5; k++) {
        const c = cells[start + k];
        const v = board[c];
        if (v === color) stones++;
        else if (v === 0) {
          if (emptyCell !== -1) { ok = false; break; }
          emptyCell = c;
        } else { ok = false; break; }
      }
      if (!ok || stones !== 4 || emptyCell === -1) continue;
      if (isBlack) {
        if ((start > 0 && board[cells[start - 1]] === BLACK)
          || (start + 5 < len && board[cells[start + 5]] === BLACK)) continue;
      }
      if (!seen[emptyCell]) {
        seen[emptyCell] = 1;
        completions.push(emptyCell);
      }
    }
  }
  return completions;
}

/**
 * Find all defensive squares for an open-3 / jump-3 formed by placing `placedIndex`,
 * plus defender's counter-fours and counter-5s.
 */
function findThreeDefenses(state, placedIndex, attacker) {
  const b = state.board;
  const defender = oppOf(attacker);
  const isAttackerBlack = attacker === BLACK;
  const defenses = [];
  const seen = new Uint8Array(AREA);

  for (let d = 0; d < 4; d++) {
    const { cells, pivot } = MOVE_LINES[placedIndex][d];
    const len = cells.length;
    const min6 = Math.max(0, pivot - 4);
    const max6 = Math.min(pivot - 1, len - 6);
    for (let start = min6; start <= max6; start++) {
      if (b[cells[start]] !== 0 || b[cells[start + 5]] !== 0) continue;
      if (isAttackerBlack) {
        if ((start > 0 && b[cells[start - 1]] === BLACK)
          || (start + 6 < len && b[cells[start + 6]] === BLACK)) continue;
      }
      let stones = 0;
      let gap = -1;
      let ok = true;
      for (let k = 1; k <= 4; k++) {
        const c = cells[start + k];
        const v = b[c];
        if (v === attacker) stones++;
        else if (v === 0) {
          if (gap !== -1) { ok = false; break; }
          gap = c;
        } else { ok = false; break; }
      }
      if (!ok || stones !== 3 || gap === -1) continue;
      const blockCandidates = [cells[start], gap, cells[start + 5]];
      if (start > 0 && b[cells[start - 1]] === 0) blockCandidates.push(cells[start - 1]);
      if (start + 6 < len && b[cells[start + 6]] === 0) blockCandidates.push(cells[start + 6]);
      for (const c of blockCandidates) {
        if (b[c] === 0 && !seen[c]) {
          seen[c] = 1;
          defenses.push(c);
        }
      }
    }
  }

  // Defender can also play any counter-4 or counter-5
  const defPat = defender === BLACK ? state.patB : state.patW;
  const nb = state.nearby;
  for (let i = 0; i < AREA; i++) {
    if (b[i] !== 0 || nb[i] === 0 || seen[i]) continue;
    const base = i << 2;
    for (let d = 0; d < 4; d++) {
      const p = defPat[base + d];
      if (p >= PAT.SLEEP_FOUR && p <= PAT.FIVE) {
        seen[i] = 1;
        defenses.push(i);
        break;
      }
    }
  }
  return defenses;
}

/**
 * Ultra-fast O(1) Black forbidden check backed by incremental state.patB,
 * falling back to recursive isBlackForbiddenMutable ONLY when 2+ 3s exist (for false-3).
 */
function isBlackForbiddenState(state, idx) {
  const base = idx << 2;
  const patB = state.patB;
  let fours = 0;
  let threes = 0;
  let overline = false;
  for (let d = 0; d < 4; d++) {
    const p = patB[base + d];
    if (p === PAT.FIVE) return false; // Exact-5 overrides all fouls (RIF 9.2)
    if (p === PAT.OVERLINE) overline = true;
    else if (p === PAT.DOUBLE_FOUR_LINE) fours += 2;
    else if (p === PAT.OPEN_FOUR || p === PAT.SLEEP_FOUR) fours++;
    else if (p === PAT.OPEN_THREE || p === PAT.JUMP_THREE) threes++;
  }
  if (overline || fours >= 2) return true;
  if (threes < 2) return false;
  return isBlackForbiddenMutable(state.board, idx);
}

/**
 * Exact mathematical static-win check (never returns unverified heuristic mates).
 */
function checkStaticWin(state, sideToMove) {
  const opp = oppOf(sideToMove);
  const myFives = findFiveCompletions(state, sideToMove);
  if (myFives.length > 0) {
    return { score: MATE, move: myFives[0] };
  }
  const oppFives = findFiveCompletions(state, opp);
  if (oppFives.length >= 2) {
    return { score: -MATE + 1, move: oppFives[0] };
  }
  if (oppFives.length === 1) {
    return null;
  }

  const pat = sideToMove === BLACK ? state.patB : state.patW;
  const cnt = sideToMove === BLACK ? state.cntB : state.cntW;
  if (cnt[PAT.OPEN_FOUR] > 0 || cnt[PAT.DOUBLE_FOUR_LINE] > 0 || cnt[PAT.SLEEP_FOUR] > 0) {
    const b = state.board;
    const nb = state.nearby;
    for (let i = 0; i < AREA; i++) {
      if (b[i] !== 0 || nb[i] === 0) continue;
      if (sideToMove === BLACK && isBlackForbiddenState(state, i)) continue;
      const info = summarizeCell(pat, i);
      if (info.openFours > 0 || (sideToMove === WHITE && info.combo === COMBO.DOUBLE_FOUR)) {
        return { score: MATE - 2, move: i };
      }
      if (sideToMove === WHITE && info.sleepFours === 1) {
        b[i] = WHITE;
        const comps = findFivesCreatedByMove(b, i, WHITE);
        let trap = false;
        if (comps.length === 1 && isBlackForbiddenMutable(b, comps[0])) trap = true;
        b[i] = 0;
        if (trap) return { score: MATE - 2, move: i };
      }
    }
  }
  return null;
}

/**
 * Multi-scale Embryo + KataGomo-inspired positional & tactical evaluation.
 * Strictly clamped to [-EVAL_CLAMP, +EVAL_CLAMP] — never triggers false MATE cutoffs!
 */
function evaluateState(state, sideToMove) {
  const opp = oppOf(sideToMove);
  const myCnt = sideToMove === BLACK ? state.cntB : state.cntW;
  const opCnt = opp === BLACK ? state.cntB : state.cntW;
  const myPat = sideToMove === BLACK ? state.patB : state.patW;
  const opPat = opp === BLACK ? state.patB : state.patW;
  const b = state.board;
  const nb = state.nearby;

  let score = TEMPO_BONUS;

  // 1. Global incremental line-pattern totals (Embryo asymmetric active-side multiplier)
  for (let p = 1; p <= PAT.FIVE; p++) {
    score += myCnt[p] * ACT_PAT_W[p] - opCnt[p] * PAS_PAT_W[p];
  }

  // 2. Cross-ray intersection synergy, 3x3 cohesion, dual-purpose points, & Renju foul attack
  let myBestCombo = 0;
  let opBestCombo = 0;
  let myForkSeeds = 0;
  let opForkSeeds = 0;

  for (let i = 0; i < AREA; i++) {
    if (b[i] !== 0) {
      // 3x3 local stone cohesion (reward connected shapes, penalize isolated dead stones)
      const n1 = NEIGHBORHOOD_1[i];
      let friendlyAdj = 0;
      for (let k = 0; k < n1.length; k++) {
        if (b[n1[k]] === b[i]) friendlyAdj++;
      }
      const coh = (friendlyAdj === 0 ? -12 : Math.min(3, friendlyAdj) * 14) + (POS_SCORE[i] >> 1);
      score += b[i] === sideToMove ? coh : -coh;
      continue;
    }
    if (nb[i] === 0) continue;

    const myForb = sideToMove === BLACK && isBlackForbiddenState(state, i);
    const opForb = opp === BLACK && isBlackForbiddenState(state, i);

    let myCellSynergy = 0;
    if (!myForb) {
      const m = summarizeCell(myPat, i);
      if (m.combo > myBestCombo) myBestCombo = m.combo;
      if (m.combo === COMBO.OPEN_FOUR || (sideToMove === WHITE && m.combo === COMBO.DOUBLE_FOUR)) {
        myCellSynergy += 6200;
      } else if (m.combo === COMBO.FOUR_THREE) {
        myCellSynergy += 3600;
      } else if (m.combo === COMBO.DOUBLE_THREE && sideToMove === WHITE) {
        myCellSynergy += 2900;
      } else if (m.combo === COMBO.THREE_TWO) {
        myCellSynergy += 580;
        myForkSeeds++;
      } else if (m.combo === COMBO.DOUBLE_TWO) {
        myCellSynergy += 290;
        myForkSeeds++;
      }
      if (m.sleepFours > 0 && m.sleepThrees > 0) myCellSynergy += 220;
      if (m.allThrees > 0 && m.wideTwos > 0) myCellSynergy += 110;
      score += myCellSynergy + (myCellSynergy > 0 ? POS_SCORE[i] : 0);
    } else {
      // Black's key intersection is poisoned by forbidden rule
      score -= 130;
    }

    let opCellSynergy = 0;
    if (!opForb) {
      const o = summarizeCell(opPat, i);
      if (o.combo > opBestCombo) opBestCombo = o.combo;
      if (o.combo === COMBO.OPEN_FOUR || (opp === WHITE && o.combo === COMBO.DOUBLE_FOUR)) {
        opCellSynergy += 2600;
      } else if (o.combo === COMBO.FOUR_THREE) {
        opCellSynergy += 1450;
      } else if (o.combo === COMBO.DOUBLE_THREE && opp === WHITE) {
        opCellSynergy += 1100;
      } else if (o.combo === COMBO.THREE_TWO) {
        opCellSynergy += 210;
        opForkSeeds++;
      } else if (o.combo === COMBO.DOUBLE_TWO) {
        opCellSynergy += 95;
        opForkSeeds++;
      }
      score -= opCellSynergy + (opCellSynergy > 0 ? (POS_SCORE[i] >> 1) : 0);
    } else {
      // Embryo FoulAttackScore: opponent (Black) is forbidden here
      score += 170;
    }

    // Dual-purpose critical point ("敵之要點即我之要點")
    if (myCellSynergy >= 250 && opCellSynergy >= 200) {
      score += 180;
    }
  }

  // Threat-dominance bonus (tempo control)
  if (myForkSeeds >= 2 && opForkSeeds === 0) score += 260;
  if (opForkSeeds >= 2 && myForkSeeds === 0) score -= 140;
  if (myBestCombo >= COMBO.FOUR_THREE && opBestCombo < COMBO.FOUR_THREE) score += 700;

  if (score > EVAL_CLAMP) return EVAL_CLAMP;
  if (score < -EVAL_CLAMP) return -EVAL_CLAMP;
  return score;
}

/**
 * KataGomo VCFsolver_NNUE-style Cost-Bounded Iterative-Widening VCF Solver.
 * Prioritizes connected four-attacks (NormalDecrease=1, NoThreeDecrease=3, NoTwoDecrease=10).
 */
export function solveVCF(boardOrState, attacker, options = {}) {
  const maxDepth = options.maxDepth ?? 20;
  const maxNodes = options.maxNodes ?? 15000;
  const state = boardOrState instanceof BoardState ? boardOrState : new BoardState(boardOrState);
  const b = state.board;
  const nb = state.nearby;
  const defender = oppOf(attacker);
  const pat = attacker === BLACK ? state.patB : state.patW;
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const immediateFives = findFiveCompletions(state, attacker);
  for (const idx of immediateFives) {
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (attacker === BLACK && isBlackForbiddenMutable(b, idx)) continue;
    return { win: true, move: toCoordObj(idx), index: idx, depth: 1, nodes: 1, threatCells: [idx] };
  }

  if (findFiveCompletions(state, defender).length > 0) {
    return { win: false, move: null, index: -1, depth: 0, nodes: 1, threatCells: [] };
  }

  let nodes = 0;
  const threatPath = [];

  function vcfSearch(depth, costLeft, isRoot) {
    if (nodes >= maxNodes || depth > maxDepth || costLeft < 0) return -1;
    nodes++;

    const hHi = (state.hHi ^ (attacker === WHITE ? SIDE_HI : 0)) >>> 0;
    const hLo = (state.hLo ^ (attacker === WHITE ? SIDE_LO : 0)) >>> 0;
    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCF_TT_MASK;
      if (vcfTtGen[slot] === vcfGen && vcfTtHi[slot] === hHi && vcfTtLo[slot] === hLo) {
        if (vcfTtRes[slot] === 1) return vcfTtMove[slot];
        if (vcfTtRes[slot] === 2 && vcfTtBound[slot] >= costLeft) return -1;
      }
    }

    // Collect four-attack candidates using O(1) incremental patterns
    const candidates = [];
    const cnt = attacker === BLACK ? state.cntB : state.cntW;
    if (
      cnt[PAT.FIVE] === 0
      && cnt[PAT.OPEN_FOUR] === 0
      && cnt[PAT.DOUBLE_FOUR_LINE] === 0
      && cnt[PAT.SLEEP_FOUR] === 0
    ) {
      return -1;
    }

    for (let idx = 0; idx < AREA; idx++) {
      if (b[idx] !== 0 || nb[idx] === 0) continue;
      if (isRoot && allowedSet && !allowedSet.has(idx)) continue;
      if (attacker === BLACK && isBlackForbiddenMutable(b, idx)) continue;
      const info = summarizeCell(pat, idx);
      if (info.fives > 0) return idx;
      if (info.openFours > 0 || (attacker === WHITE && info.combo === COMBO.DOUBLE_FOUR)) {
        candidates.push({ idx, cost: 0, prio: 100 });
      } else if (info.sleepFours > 0) {
        // KataGomo VCFsolver_NNUE connectedness cost:
        // 4-3 or 4+jump3 -> cost 1; 4+sleep3/open2 -> cost 3; isolated 4 -> cost 8
        const cost = info.allThrees > 0 ? 1 : (info.sleepThrees > 0 || info.openTwos > 0) ? 3 : 8;
        if (cost <= costLeft) {
          const prio = info.allThrees * 20 + info.openTwos * 8 + info.sleepThrees * 5;
          candidates.push({ idx, cost, prio });
        }
      }
    }

    candidates.sort((a, b2) => a.cost - b2.cost || b2.prio - a.prio || a.idx - b2.idx);

    for (let i = 0; i < candidates.length; i++) {
      const { idx: atkIdx, cost } = candidates[i];
      state.play(atkIdx, attacker);

      const completions = findFivesCreatedByMove(b, atkIdx, attacker);
      if (completions.length >= 2) {
        state.undo(atkIdx);
        threatPath.push(atkIdx, ...completions);
        if (!isRoot) {
          const slot = (hHi ^ hLo) & VCF_TT_MASK;
          vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
          vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx; vcfTtBound[slot] = costLeft;
        }
        return atkIdx;
      }

      if (completions.length === 1) {
        const defIdx = completions[0];
        if (defender === BLACK && isBlackForbiddenMutable(b, defIdx)) {
          state.undo(atkIdx);
          threatPath.push(atkIdx, defIdx);
          if (!isRoot) {
            const slot = (hHi ^ hLo) & VCF_TT_MASK;
            vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
            vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx; vcfTtBound[slot] = costLeft;
          }
          return atkIdx;
        }

        state.play(defIdx, defender);
        const defFives = findFiveCompletions(state, defender);
        let won = false;
        if (defFives.length === 0) {
          // Check if defender created a counter-four
          const counterFours = findFivesCreatedByMove(b, defIdx, defender);
          if (counterFours.length === 0) {
            if (vcfSearch(depth + 2, costLeft - cost, false) !== -1) won = true;
          } else if (counterFours.length === 1) {
            const cf = counterFours[0];
            if (!(attacker === BLACK && isBlackForbiddenMutable(b, cf))) {
              const cfInfo = summarizeCell(pat, cf);
              if (cfInfo.fives > 0 || cfInfo.openFours > 0 || cfInfo.sleepFours > 0) {
                if (vcfSearch(depth + 2, costLeft - cost, false) !== -1) won = true;
              }
            }
          }
        } else if (defFives.length === 1) {
          const must = defFives[0];
          if (!(attacker === BLACK && isBlackForbiddenMutable(b, must))) {
            if (summarizeCell(pat, must).fives > 0) won = true;
          }
        }

        state.undo(defIdx);
        state.undo(atkIdx);

        if (won) {
          threatPath.push(atkIdx, defIdx);
          if (!isRoot) {
            const slot = (hHi ^ hLo) & VCF_TT_MASK;
            vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
            vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx; vcfTtBound[slot] = costLeft;
          }
          return atkIdx;
        }
      } else {
        state.undo(atkIdx);
      }
    }

    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCF_TT_MASK;
      vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
      vcfTtRes[slot] = 2; vcfTtMove[slot] = -1; vcfTtBound[slot] = costLeft;
    }
    return -1;
  }

  // Iterative bound widening (KataGomo bound_n schedule: 2, 8, 16, 28)
  vcfGen = (vcfGen + 1) & 0xffff || 1;
  const bounds = maxDepth <= 8 ? [8, 24] : [3, 9, 18, 32];
  let bestIdx = -1;
  for (let bi = 0; bi < bounds.length; bi++) {
    if (nodes >= maxNodes) break;
    bestIdx = vcfSearch(0, bounds[bi], true);
    if (bestIdx !== -1) break;
  }

  if (bestIdx !== -1) {
    const pathSet = new Set(threatPath);
    pathSet.add(bestIdx);
    const nbrs = RAY_NEIGHBORS_4[bestIdx];
    for (let i = 0; i < nbrs.length; i++) {
      if (b[nbrs[i]] === 0) pathSet.add(nbrs[i]);
    }
    return {
      win: true,
      move: toCoordObj(bestIdx),
      index: bestIdx,
      depth: threatPath.length + 1,
      nodes,
      threatCells: [...pathSet],
    };
  }
  return { win: false, move: null, index: -1, depth: 0, nodes, threatCells: [] };
}

/**
 * TT-backed VCT (Victory by Continuous Threats) Solver using incremental BoardState + solveVCF.
 */
export function solveVCT(boardOrState, attacker, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 4500;
  const state = boardOrState instanceof BoardState ? boardOrState : new BoardState(boardOrState);
  const b = state.board;
  const nb = state.nearby;
  const defender = oppOf(attacker);
  const pat = attacker === BLACK ? state.patB : state.patW;
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const immediateFives = findFiveCompletions(state, attacker);
  for (const idx of immediateFives) {
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (attacker === BLACK && isBlackForbiddenMutable(b, idx)) continue;
    return { win: true, move: toCoordObj(idx), index: idx, depth: 1, nodes: 1, threatCells: [idx] };
  }
  if (findFiveCompletions(state, defender).length > 0) {
    return { win: false, move: null, index: -1, depth: 0, nodes: 1, threatCells: [] };
  }

  vctGen = (vctGen + 1) & 0xffff || 1;
  let nodes = 0;
  const threatPath = [];

  function vctAttack(depth, isRoot) {
    if (nodes >= maxNodes || depth > maxDepth) return -1;
    nodes++;

    const hHi = (state.hHi ^ (attacker === WHITE ? SIDE_HI : 0)) >>> 0;
    const hLo = (state.hLo ^ (attacker === WHITE ? SIDE_LO : 0)) >>> 0;
    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCT_TT_MASK;
      if (vctTtGen[slot] === vctGen && vctTtHi[slot] === hHi && vctTtLo[slot] === hLo) {
        if (vctTtRes[slot] === 1) return vctTtMove[slot];
        if (vctTtRes[slot] === 2 && vctTtDepth[slot] >= maxDepth - depth) return -1;
      }
    }

    if (!isRoot && depth <= maxDepth - 2) {
      const vcf = solveVCF(state, attacker, { maxDepth: 14, maxNodes: 1600 });
      if (vcf.win) return vcf.index;
    }

    const threats = [];
    for (let idx = 0; idx < AREA; idx++) {
      if (b[idx] !== 0 || nb[idx] === 0) continue;
      if (isRoot && allowedSet && !allowedSet.has(idx)) continue;
      if (attacker === BLACK && isBlackForbiddenMutable(b, idx)) continue;
      const info = summarizeCell(pat, idx);
      if (info.fives > 0) return idx;
      if (info.openFours > 0 || (attacker === WHITE && info.combo === COMBO.DOUBLE_FOUR)) return idx;
      if (info.combo === COMBO.FOUR_THREE) threats.push({ idx, prio: 100, isFour: true });
      else if (info.sleepFours > 0) threats.push({ idx, prio: 70 + info.allThrees * 5 + info.openTwos, isFour: true });
      else if (info.combo === COMBO.DOUBLE_THREE && attacker === WHITE) threats.push({ idx, prio: 60, isFour: false });
      else if (info.allThrees > 0) threats.push({ idx, prio: 20 + info.openThrees * 4 + info.jumpThrees * 2 + Math.min(10, info.openTwos), isFour: false });
    }

    threats.sort((a, b2) => b2.prio - a.prio || a.idx - b2.idx);
    const branchCap = isRoot ? 16 : 9;

    for (let i = 0; i < threats.length && i < branchCap; i++) {
      const { idx, isFour } = threats[i];
      state.play(idx, attacker);

      if (isFour) {
        const comps = findFivesCreatedByMove(b, idx, attacker);
        if (comps.length >= 2) {
          state.undo(idx);
          threatPath.push(idx, ...comps);
          return idx;
        }
        if (comps.length === 1) {
          const defIdx = comps[0];
          if (defender === BLACK && isBlackForbiddenMutable(b, defIdx)) {
            state.undo(idx);
            threatPath.push(idx, defIdx);
            return idx;
          }
          state.play(defIdx, defender);
          let won = false;
          if (findFiveCompletions(state, defender).length === 0 && findFivesCreatedByMove(b, defIdx, defender).length === 0) {
            if (vctAttack(depth + 2, false) !== -1) won = true;
          }
          state.undo(defIdx);
          state.undo(idx);
          if (won) {
            threatPath.push(idx, defIdx);
            if (!isRoot) {
              const slot = (hHi ^ hLo) & VCT_TT_MASK;
              vctTtGen[slot] = vctGen; vctTtHi[slot] = hHi; vctTtLo[slot] = hLo;
              vctTtRes[slot] = 1; vctTtMove[slot] = idx; vctTtDepth[slot] = maxDepth - depth;
            }
            return idx;
          }
        } else {
          state.undo(idx);
        }
      } else if (depth + 2 <= maxDepth) {
        const defMoves = findThreeDefenses(state, idx, attacker);
        let allDefensesBeaten = defMoves.length > 0;
        for (let d = 0; d < defMoves.length; d++) {
          const defIdx = defMoves[d];
          if (defender === BLACK && isBlackForbiddenMutable(b, defIdx)) continue;
          state.play(defIdx, defender);
          const oppFive = findFiveCompletions(state, defender);
          if (oppFive.length > 0) {
            let counterWin = false;
            if (oppFive.length === 1) {
              const must = oppFive[0];
              if (!(attacker === BLACK && isBlackForbiddenMutable(b, must))) {
                if (summarizeCell(pat, must).fives > 0) counterWin = true;
              }
            }
            state.undo(defIdx);
            if (!counterWin) { allDefensesBeaten = false; break; }
            continue;
          }
          if (findFivesCreatedByMove(b, defIdx, defender).length > 0) {
            const subVcf = solveVCF(state, attacker, { maxDepth: 12, maxNodes: 900 });
            state.undo(defIdx);
            if (!subVcf.win) { allDefensesBeaten = false; break; }
            continue;
          }
          const sub = vctAttack(depth + 2, false);
          state.undo(defIdx);
          if (sub === -1) {
            allDefensesBeaten = false;
            break;
          }
        }
        state.undo(idx);
        if (allDefensesBeaten) {
          threatPath.push(idx, ...defMoves.slice(0, 4));
          if (!isRoot) {
            const slot = (hHi ^ hLo) & VCT_TT_MASK;
            vctTtGen[slot] = vctGen; vctTtHi[slot] = hHi; vctTtLo[slot] = hLo;
            vctTtRes[slot] = 1; vctTtMove[slot] = idx; vctTtDepth[slot] = maxDepth - depth;
          }
          return idx;
        }
      } else {
        state.undo(idx);
      }
    }

    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCT_TT_MASK;
      vctTtGen[slot] = vctGen; vctTtHi[slot] = hHi; vctTtLo[slot] = hLo;
      vctTtRes[slot] = 2; vctTtMove[slot] = -1; vctTtDepth[slot] = maxDepth - depth;
    }
    return -1;
  }

  const winIdx = vctAttack(0, true);
  if (winIdx !== -1) {
    const pathSet = new Set(threatPath);
    pathSet.add(winIdx);
    const nbrs = RAY_NEIGHBORS_4[winIdx];
    for (let i = 0; i < nbrs.length; i++) {
      if (b[nbrs[i]] === 0) pathSet.add(nbrs[i]);
    }
    return { win: true, move: toCoordObj(winIdx), index: winIdx, depth: 2, nodes, threatCells: [...pathSet] };
  }
  return { win: false, move: null, index: -1, depth: 0, nodes, threatCells: [] };
}

/**
 * Compute intersection priority score for move ordering and MCTS policy prior.
 */
function scoreCandidateCell(state, idx, color) {
  const b = state.board;
  const opp = oppOf(color);
  const myPat = color === BLACK ? state.patB : state.patW;
  const opPat = opp === BLACK ? state.patB : state.patW;
  const my = summarizeCell(myPat, idx);
  const opForb = opp === BLACK && isBlackForbiddenState(state, idx);
  const op = opForb ? null : summarizeCell(opPat, idx);

  let s = POS_SCORE[idx];
  if (my.fives > 0) s += 1e7;
  if (op && op.fives > 0) s += 5e6;
  if (my.openFours > 0 || (color === WHITE && my.combo === COMBO.DOUBLE_FOUR)) s += 800000;
  else if (op && (op.openFours > 0 || (opp === WHITE && op.combo === COMBO.DOUBLE_FOUR))) s += 350000;
  else if (my.combo === COMBO.FOUR_THREE) s += 180000;
  else if (op && op.combo === COMBO.FOUR_THREE) s += 120000;
  else if (color === WHITE && my.combo === COMBO.DOUBLE_THREE) s += 85000;
  else if (op && opp === WHITE && op.combo === COMBO.DOUBLE_THREE) s += 65000;

  s += my.sleepFours * 5200 + my.openThrees * 3100 + my.jumpThrees * 2400 + my.sleepThrees * 420
    + my.openTwos * 360 + my.wideTwos * 150 + my.sleepTwos * 55;
  if (op) {
    s += op.sleepFours * 2900 + op.openThrees * 2500 + op.jumpThrees * 1950 + op.sleepThrees * 300
      + op.openTwos * 270 + op.wideTwos * 110 + op.sleepTwos * 40;
  }

  // Dual-purpose bonus & synergy
  if (my.combo === COMBO.THREE_TWO) s += 1400;
  if (my.combo === COMBO.DOUBLE_TWO) s += 650;
  if (op && op.combo === COMBO.THREE_TWO) s += 950;
  if (op && op.combo === COMBO.DOUBLE_TWO) s += 420;
  if (color === WHITE && opForb) s += 380;

  // Last-move locality bonus
  if (state.history.length > 0) {
    const last = state.history[state.history.length - 1];
    const dr = Math.abs(((idx / SIZE) | 0) - ((last / SIZE) | 0));
    const dc = Math.abs((idx % SIZE) - (last % SIZE));
    const dist = Math.max(dr, dc);
    if (dist <= 2) s += 240 - dist * 60;
  }

  return { s, my, op };
}

function generateOrderedMoves(state, color, ttMove, killer1, killer2, history, allowedSet) {
  const opp = oppOf(color);
  const b = state.board;
  const nb = state.nearby;

  const myFives = findFiveCompletions(state, color);
  for (const idx of myFives) {
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (color === BLACK && isBlackForbiddenMutable(b, idx)) continue;
    return [idx];
  }

  const oppFives = findFiveCompletions(state, opp);
  if (oppFives.length > 0) {
    const evasions = [];
    for (const idx of oppFives) {
      if (allowedSet && !allowedSet.has(idx)) continue;
      if (color === BLACK && isBlackForbiddenMutable(b, idx)) continue;
      evasions.push(idx);
    }
    if (evasions.length > 0) return evasions;
  }

  const candidates = state.stoneCount === 0 ? [7 * SIZE + 7] : [];
  if (candidates.length === 0) {
    for (let i = 0; i < AREA; i++) {
      if (b[i] === 0 && nb[i] > 0) candidates.push(i);
    }
  }

  const scored = [];
  let oppUrgent = false;

  for (let i = 0; i < candidates.length; i++) {
    const idx = candidates[i];
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (color === BLACK && isBlackForbiddenState(state, idx)) continue;

    const { s: baseScore, my, op } = scoreCandidateCell(state, idx, color);
    if (op && (op.openFours > 0 || op.combo === COMBO.FOUR_THREE || op.allThrees > 0)) oppUrgent = true;

    let s = baseScore;
    if (idx === ttMove) s += 2e7;
    if (idx === killer1) s += 2200;
    else if (idx === killer2) s += 1500;
    s += Math.min(1200, history[idx] >> 2);

    scored.push({
      idx,
      s,
      isCheck: my.sleepFours > 0 || my.openFours > 0 || (op !== null && op.openFours > 0),
    });
  }

  scored.sort((a, b2) => b2.s - a.s || a.idx - b2.idx);

  const maxBranch = oppUrgent ? 20 : 18;
  const out = [];
  for (let i = 0; i < scored.length && i < maxBranch; i++) {
    out.push(scored[i].idx);
  }
  return out;
}

/**
 * Public fast move ranking (compatible with rankLocalMoves).
 */
export function rankMoves(board, color, options = {}) {
  const state = board instanceof BoardState ? board : new BoardState(board);
  const b = state.board;
  const forbiddenMap = color === BLACK ? computeForbiddenMap(b) : null;
  const active = getActiveCandidates(state);
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const ranked = [];
  for (let i = 0; i < active.length; i++) {
    const idx = active[i];
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (forbiddenMap && forbiddenMap[idx] !== 0) continue;

    const { s, my } = scoreCandidateCell(state, idx, color);
    let score = s;
    if (my.fives > 0) score += 1e9;

    if (color === WHITE && my.sleepFours > 0) {
      b[idx] = WHITE;
      const comps = findFivesCreatedByMove(b, idx, WHITE);
      if (comps.length === 1 && isBlackForbiddenMutable(b, comps[0])) score += 5e6;
      b[idx] = 0;
    }
    ranked.push({ row: (idx / SIZE) | 0, col: idx % SIZE, score });
  }

  if (ranked.length === 0 && allowedSet) {
    for (const idx of allowedSet) {
      if (b[idx] !== 0) continue;
      if (forbiddenMap && forbiddenMap[idx] !== 0) continue;
      ranked.push({ row: (idx / SIZE) | 0, col: idx % SIZE, score: POS_SCORE[idx] });
    }
  }

  ranked.sort((a, b2) => b2.score - a.score || a.row - b2.row || a.col - b2.col);
  return ranked;
}

function scoreToWinRate(score) {
  if (score >= MATE - 500) return 1;
  if (score <= -MATE + 500) return 0;
  const raw = 1 / (1 + Math.exp(-score / 1500));
  return Math.round(Math.min(0.99, Math.max(0.01, raw)) * 1000) / 1000;
}

/**
 * Iterative Deepening Incremental PVS + Threat Quiescence Search.
 * Returns { bestMove, score, depth, nodes, rootMoveScores }.
 */
function runPVSSearch(state, rootColor, allowedSet, maxDepth, timeBudgetMs, startMs) {
  currentGen = (currentGen + 1) & 0xffff || 1;
  const killer1 = new Int16Array(64).fill(-1);
  const killer2 = new Int16Array(64).fill(-1);
  const history = new Int32Array(AREA);

  let nodes = 0;
  let timedOut = false;

  const rootMoves = generateOrderedMoves(state, rootColor, -1, -1, -1, history, allowedSet);
  if (rootMoves.length === 0) {
    return { bestMove: -1, score: 0, depth: 0, nodes: 0, rootMoveScores: new Map() };
  }
  if (rootMoves.length === 1) {
    state.play(rootMoves[0], rootColor);
    const val = -evaluateState(state, oppOf(rootColor));
    state.undo(rootMoves[0]);
    const map = new Map([[rootMoves[0], val]]);
    return { bestMove: rootMoves[0], score: val, depth: 1, nodes: 1, rootMoveScores: map };
  }

  let completedBest = rootMoves[0];
  let completedScore = 0;
  let completedDepth = 1;
  let rootMoveScores = new Map();

  function qsearch(ply, alpha, beta, color) {
    if ((nodes & 255) === 0 && Date.now() - startMs >= timeBudgetMs) {
      timedOut = true;
      return 0;
    }
    nodes++;

    const staticWin = checkStaticWin(state, color);
    if (staticWin) {
      return staticWin.score > 0 ? staticWin.score - ply : staticWin.score + ply;
    }

    const opp = oppOf(color);
    const oppFives = findFiveCompletions(state, opp);
    if (oppFives.length === 0 || ply >= 32) {
      return evaluateState(state, color);
    }

    // Only extend forced 5-evasions in quiescence search
    for (let i = 0; i < oppFives.length; i++) {
      const idx = oppFives[i];
      if (color === BLACK && isBlackForbiddenState(state, idx)) continue;
      state.play(idx, color);
      const score = -qsearch(ply + 1, -beta, -alpha, opp);
      state.undo(idx);
      if (timedOut) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function pvs(depth, ply, alpha, beta, color, allowNull) {
    if ((nodes & 255) === 0 && Date.now() - startMs >= timeBudgetMs) {
      timedOut = true;
      return 0;
    }
    nodes++;

    if (ply > 0) {
      const staticWin = checkStaticWin(state, color);
      if (staticWin) {
        return staticWin.score > 0 ? staticWin.score - ply : staticWin.score + ply;
      }
    }

    if (depth <= 0 || ply >= 48) {
      return qsearch(ply, alpha, beta, color);
    }

    const opp = oppOf(color);
    const hHi = (state.hHi ^ (color === WHITE ? SIDE_HI : 0)) >>> 0;
    const hLo = (state.hLo ^ (color === WHITE ? SIDE_LO : 0)) >>> 0;
    const slot = (hHi ^ hLo) & TT_MASK;
    let ttMove = -1;
    if (ttGen[slot] === currentGen && ttHi[slot] === hHi && ttLo[slot] === hLo) {
      ttMove = ttBest[slot];
      if (ply > 0 && ttDepth[slot] >= depth) {
        const s = ttScore[slot];
        if (ttFlag[slot] === TT_EXACT) return s;
        if (ttFlag[slot] === TT_LOWER && s >= beta) return s;
        if (ttFlag[slot] === TT_UPPER && s <= alpha) return s;
      }
    }

    const oppFives = findFiveCompletions(state, opp);
    const inThreat = oppFives.length > 0;

    if (allowNull && ply > 0 && depth >= 3 && !inThreat && beta < MATE - 500) {
      const staticEval = evaluateState(state, color);
      if (staticEval >= beta) {
        const nullScore = -pvs(depth - 3, ply + 1, -beta, -beta + 1, opp, false);
        if (timedOut) return 0;
        if (nullScore >= beta) return beta;
      }
    }

    const moves = generateOrderedMoves(
      state,
      color,
      ttMove,
      killer1[ply],
      killer2[ply],
      history,
      ply === 0 ? allowedSet : null,
    );
    if (moves.length === 0) return -MATE + ply;

    let bestMove = moves[0];
    let bestScore = -MATE - 100;
    const origAlpha = alpha;
    const pat = color === BLACK ? state.patB : state.patW;
    const iterRootScores = ply === 0 ? new Map() : null;

    for (let i = 0; i < moves.length; i++) {
      const idx = moves[i];
      const info = summarizeCell(pat, idx);
      if (info.fives > 0) {
        bestMove = idx;
        bestScore = MATE - ply;
        if (iterRootScores) iterRootScores.set(idx, bestScore);
        break;
      }

      const ext = (info.sleepFours > 0 || (inThreat && moves.length === 1)) && ply < 16 ? 1 : 0;
      const nextDepth = depth - 1 + ext;

      state.play(idx, color);
      let score;
      if (i === 0) {
        score = -pvs(nextDepth, ply + 1, -beta, -alpha, opp, true);
      } else {
        let reduction = 0;
        if (i >= 4 && depth >= 3 && ext === 0 && info.allThrees === 0 && !inThreat) {
          reduction = i >= 9 ? 2 : 1;
        }
        score = -pvs(Math.max(0, nextDepth - reduction), ply + 1, -alpha - 1, -alpha, opp, true);
        if (!timedOut && reduction > 0 && score > alpha) {
          score = -pvs(nextDepth, ply + 1, -alpha - 1, -alpha, opp, true);
        }
        if (!timedOut && score > alpha && score < beta) {
          score = -pvs(nextDepth, ply + 1, -beta, -alpha, opp, true);
        }
      }
      state.undo(idx);
      if (timedOut) return 0;

      if (iterRootScores) iterRootScores.set(idx, score);

      if (score > bestScore) {
        bestScore = score;
        bestMove = idx;
      }
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) {
          if (killer1[ply] !== idx) {
            killer2[ply] = killer1[ply];
            killer1[ply] = idx;
          }
          history[idx] += depth * depth;
          break;
        }
      }
    }

    if (iterRootScores && !timedOut) {
      rootMoveScores = iterRootScores;
    }

    ttGen[slot] = currentGen;
    ttHi[slot] = hHi;
    ttLo[slot] = hLo;
    ttDepth[slot] = depth;
    ttBest[slot] = bestMove;
    ttScore[slot] = bestScore;
    ttFlag[slot] = bestScore <= origAlpha ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;

    return bestScore;
  }

  for (let depth = 2; depth <= maxDepth; depth++) {
    let alpha = -MATE;
    let beta = MATE;
    if (depth >= 4 && Math.abs(completedScore) < MATE - 500) {
      alpha = completedScore - 220;
      beta = completedScore + 220;
    }

    let score = pvs(depth, 0, alpha, beta, rootColor, true);
    if (!timedOut && (score <= alpha || score >= beta)) {
      score = pvs(depth, 0, -MATE, MATE, rootColor, true);
    }
    if (timedOut) break;

    const hHi = (state.hHi ^ (rootColor === WHITE ? SIDE_HI : 0)) >>> 0;
    const hLo = (state.hLo ^ (rootColor === WHITE ? SIDE_LO : 0)) >>> 0;
    const rootSlot = (hHi ^ hLo) & TT_MASK;
    if (ttGen[rootSlot] === currentGen && ttHi[rootSlot] === hHi && ttLo[rootSlot] === hLo && ttBest[rootSlot] >= 0) {
      completedBest = ttBest[rootSlot];
    }
    completedScore = score;
    completedDepth = depth;
    if (Math.abs(score) >= MATE - 500) break;
    if (Date.now() - startMs >= timeBudgetMs * 0.8) break;
  }

  return { bestMove: completedBest, score: completedScore, depth: completedDepth, nodes, rootMoveScores };
}

/**
 * KataGomo-style PUCT MCTS with Policy Priors, FPU Reduction,
 * Exact Proof Propagation (WIN/LOSE), and LCB Root Selection.
 */
export function runMCTSSearch(boardOrState, rootColor, options = {}) {
  const state = boardOrState instanceof BoardState ? boardOrState : new BoardState(boardOrState);
  const timeBudgetMs = options.timeBudgetMs ?? 400;
  const maxPlayouts = options.maxPlayouts ?? 600;
  const startMs = Date.now();
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;
  const pvsRootScores = options.pvsRootScores ?? null;

  const SURE_UNCERTAIN = 0;
  const SURE_WIN = 1;
  const SURE_LOSE = -1;

  function createNode(color, isRoot) {
    const b = state.board;
    const staticWin = checkStaticWin(state, color);
    if (staticWin) {
      return {
        color,
        sureResult: staticWin.score > 0 ? SURE_WIN : SURE_LOSE,
        visits: 1,
        valueSum: staticWin.score > 0 ? 1 : -1,
        valueSqSum: 1,
        children: [],
        bestWinMove: staticWin.move,
      };
    }

    if (!isRoot) {
      const fastVcf = solveVCF(state, color, { maxDepth: 8, maxNodes: 240 });
      if (fastVcf.win) {
        return {
          color,
          sureResult: SURE_WIN,
          visits: 1,
          valueSum: 1,
          valueSqSum: 1,
          children: [],
          bestWinMove: fastVcf.index,
        };
      }
    }

    const opp = oppOf(color);
    const oppFives = findFiveCompletions(state, opp);
    let candIndices;
    if (oppFives.length > 0) {
      candIndices = oppFives.filter((idx) => {
        if (isRoot && allowedSet && !allowedSet.has(idx)) return false;
        return !(color === BLACK && isBlackForbiddenMutable(b, idx));
      });
    } else {
      candIndices = [];
      const nb = state.nearby;
      if (state.stoneCount === 0) {
        if (!isRoot || !allowedSet || allowedSet.has(112)) candIndices.push(112);
      } else {
        for (let i = 0; i < AREA; i++) {
          if (b[i] !== 0 || nb[i] === 0) continue;
          if (isRoot && allowedSet && !allowedSet.has(i)) continue;
          if (color === BLACK && isBlackForbiddenMutable(b, i)) continue;
          candIndices.push(i);
        }
      }
    }

    if (candIndices.length === 0) {
      return {
        color,
        sureResult: SURE_LOSE,
        visits: 1,
        valueSum: -1,
        valueSqSum: 1,
        children: [],
        bestWinMove: -1,
      };
    }

    // Policy logits from multi-scale intersection scores + PVS tactical guidance at root
    const scored = [];
    for (let i = 0; i < candIndices.length; i++) {
      const idx = candIndices[i];
      const { s } = scoreCandidateCell(state, idx, color);
      let logit = Math.log1p(Math.max(0, s)) * 0.9;
      if (isRoot && pvsRootScores && pvsRootScores.has(idx)) {
        const ps = pvsRootScores.get(idx);
        if (ps <= -MATE + 500) logit -= 10; // Avoid PVS-proven losing moves
        else logit += Math.tanh(ps / 1500) * 3.5;
      }
      scored.push({ idx, logit });
    }
    scored.sort((a, b2) => b2.logit - a.logit || a.idx - b2.idx);

    const maxChildren = isRoot ? 20 : 12;
    const kept = scored.slice(0, maxChildren);
    const maxLogit = kept[0].logit;
    let sumExp = 0;
    for (let i = 0; i < kept.length; i++) {
      const e = Math.exp((kept[i].logit - maxLogit) / 1.1);
      kept[i].prior = e;
      sumExp += e;
    }
    const children = kept.map((item) => ({
      move: item.idx,
      prior: item.prior / sumExp,
      node: null,
    }));

    const leafValue = Math.tanh(evaluateState(state, color) / 2200);
    return {
      color,
      sureResult: SURE_UNCERTAIN,
      visits: 1,
      valueSum: leafValue,
      valueSqSum: leafValue * leafValue,
      children,
      bestWinMove: -1,
    };
  }

  const root = createNode(rootColor, true);
  if (root.sureResult === SURE_WIN && root.bestWinMove >= 0) {
    return {
      move: toCoordObj(root.bestWinMove),
      index: root.bestWinMove,
      winRate: 1,
      playouts: 1,
      provenWin: true,
    };
  }
  if (root.children.length === 0) {
    return { move: null, index: -1, winRate: 0.5, playouts: 0, provenWin: false };
  }

  function playout(node, depth) {
    if (node.sureResult !== SURE_UNCERTAIN) {
      return node.sureResult === SURE_WIN ? 1 : -1;
    }

    const totalVisits = node.visits;
    const cpuct = 1.25 + 0.4 * Math.log((totalVisits + 500) / 500);
    const exploreScale = cpuct * Math.sqrt(totalVisits + 0.01);
    const parentMean = node.valueSum / node.visits;
    const fpuValue = Math.max(-1, parentMean - 0.18);

    let bestChild = null;
    let bestPuct = -1e18;

    for (let i = 0; i < node.children.length; i++) {
      const ch = node.children[i];
      if (ch.node && ch.node.sureResult === SURE_WIN) {
        // Child's side-to-move wins -> terrible for parent
        continue;
      }
      if (ch.node && ch.node.sureResult === SURE_LOSE) {
        // Child's side-to-move loses -> immediate proven WIN for parent!
        node.sureResult = SURE_WIN;
        node.bestWinMove = ch.move;
        return 1;
      }
      const chVisits = ch.node ? ch.node.visits : 0;
      const q = ch.node ? (-ch.node.valueSum / ch.node.visits) : fpuValue;
      const u = exploreScale * ch.prior / (1 + chVisits);
      const puct = q + u;
      if (puct > bestPuct) {
        bestPuct = puct;
        bestChild = ch;
      }
    }

    if (!bestChild) {
      // Every child leads to opponent SURE_WIN -> parent SURE_LOSE
      node.sureResult = SURE_LOSE;
      return -1;
    }

    let childVal;
    state.play(bestChild.move, node.color);
    if (!bestChild.node) {
      bestChild.node = createNode(oppOf(node.color), false);
      childVal = bestChild.node.valueSum / bestChild.node.visits;
    } else if (depth < 24) {
      childVal = playout(bestChild.node, depth + 1);
    } else {
      childVal = bestChild.node.valueSum / bestChild.node.visits;
    }
    state.undo(bestChild.move);

    const val = -childVal;
    if (bestChild.node.sureResult === SURE_LOSE) {
      node.sureResult = SURE_WIN;
      node.bestWinMove = bestChild.move;
    }

    node.visits++;
    node.valueSum += val;
    node.valueSqSum += val * val;
    return val;
  }

  let playouts = 0;
  while (playouts < maxPlayouts && root.sureResult === SURE_UNCERTAIN) {
    if ((playouts & 7) === 0 && Date.now() - startMs >= timeBudgetMs) break;
    playout(root, 0);
    playouts++;
  }

  if (root.sureResult === SURE_WIN && root.bestWinMove >= 0) {
    return {
      move: toCoordObj(root.bestWinMove),
      index: root.bestWinMove,
      winRate: 1,
      playouts,
      provenWin: true,
    };
  }

  // KataGomo LCB selection (searchresults.cpp)
  let maxVisits = 0;
  for (const ch of root.children) {
    if (ch.node && ch.node.visits > maxVisits) maxVisits = ch.node.visits;
  }

  let bestMove = root.children[0].move;
  let bestLcb = -1e18;
  let bestMean = 0;
  const minVisits = Math.max(1, maxVisits * 0.15);

  for (const ch of root.children) {
    if (!ch.node) continue;
    if (ch.node.sureResult === SURE_WIN) continue; // Opponent wins after this move
    if (ch.node.visits < minVisits) continue;
    const n = ch.node.visits;
    const mean = -ch.node.valueSum / n;
    const variance = Math.max(0.01, (ch.node.valueSqSum / n) - mean * mean);
    const lcb = mean - 1.5 * Math.sqrt(variance / n);
    if (lcb > bestLcb) {
      bestLcb = lcb;
      bestMove = ch.move;
      bestMean = mean;
    }
  }

  const rootQ = root.valueSum / root.visits;
  const calibrated = Math.max(bestMean, rootQ * 0.5 + bestMean * 0.5);
  const winRate = Math.round(Math.min(0.99, Math.max(0.01, (calibrated + 1) * 0.5)) * 1000) / 1000;
  return {
    move: toCoordObj(bestMove),
    index: bestMove,
    winRate,
    playouts,
    provenWin: false,
  };
}

/**
 * Fused KataGomo (LUT + Cost-Bounded VCF + PUCT MCTS + LCB) + Embryo + Yixin (PVS + VCT + SearchDefend) Engine.
 */
export function searchBestMove(board, color, options = {}) {
  const timeBudgetMs = options.timeBudgetMs ?? 700;
  const maxDepth = options.maxDepth ?? 10;
  const startMs = Date.now();
  const state = new BoardState(board);
  const b = state.board;
  const opp = oppOf(color);

  const allowedMoves = options.allowedMoves ?? null;
  const allowedSet = allowedMoves
    ? new Set(allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const isAllowed = (idx) => {
    if (b[idx] !== 0) return false;
    if (allowedSet && !allowedSet.has(idx)) return false;
    if (color === BLACK && isBlackForbiddenMutable(b, idx)) return false;
    return true;
  };

  // Explicit preferredMove re-evaluation (book policy)
  if (options.preferredMove) {
    const pIdx = options.preferredMove.row * SIZE + options.preferredMove.col;
    if (isAllowed(pIdx)) {
      const pat = color === BLACK ? state.patB : state.patW;
      if (summarizeCell(pat, pIdx).fives > 0) {
        return {
          move: { row: options.preferredMove.row, col: options.preferredMove.col },
          score: MATE,
          winRate: 1,
          depth: 1,
          nodes: 1,
          decision: 'win',
          provenWin: true,
          reason: `${toCoordinate(options.preferredMove.row, options.preferredMove.col)}：立即五連獲勝。`,
        };
      }
      state.play(pIdx, color);
      const oppSearch = runPVSSearch(state, opp, null, Math.min(maxDepth - 1, 6), Math.min(timeBudgetMs, 300), startMs);
      state.undo(pIdx);
      const score = -oppSearch.score;
      return {
        move: { row: options.preferredMove.row, col: options.preferredMove.col },
        score,
        winRate: scoreToWinRate(score),
        depth: oppSearch.depth + 1,
        nodes: oppSearch.nodes + 1,
        decision: 'preferred',
        provenWin: score >= MATE - 500,
        reason: `${toCoordinate(options.preferredMove.row, options.preferredMove.col)}：重新評估指定候選點（深度 ${oppSearch.depth + 1}）。`,
      };
    }
  }

  // 1. Immediate 1-ply win
  const myFives = findFiveCompletions(state, color);
  for (const idx of myFives) {
    if (!isAllowed(idx)) continue;
    const mv = toCoordObj(idx);
    return {
      move: mv,
      score: MATE,
      winRate: 1,
      depth: 1,
      nodes: 1,
      decision: 'win',
      provenWin: true,
      reason: `${toCoordinate(mv.row, mv.col)}：立即完成五連獲勝。`,
    };
  }

  // 2. Immediate 1-ply forced defense against opponent's 5-threat
  const oppFives = findFiveCompletions(state, opp).filter(isAllowed);
  if (oppFives.length === 1) {
    const defIdx = oppFives[0];
    const mv = toCoordObj(defIdx);
    state.play(defIdx, color);
    const oppRes = runPVSSearch(state, opp, null, Math.min(maxDepth - 1, 6), Math.min(timeBudgetMs, 260), startMs);
    state.undo(defIdx);
    const score = -oppRes.score;
    return {
      move: mv,
      score,
      winRate: scoreToWinRate(score),
      depth: oppRes.depth + 1,
      nodes: oppRes.nodes + 1,
      decision: 'defense',
      provenWin: false,
      reason: `${toCoordinate(mv.row, mv.col)}：唯一合法防點，封鎖對手立即五連。`,
    };
  }
  if (oppFives.length > 1) {
    const ranked = rankMoves(state, color, { allowedMoves: oppFives.map(toCoordObj) });
    const mv = ranked[0] ? { row: ranked[0].row, col: ranked[0].col } : toCoordObj(oppFives[0]);
    return {
      move: mv,
      score: -MATE + 2,
      winRate: 0.01,
      depth: 1,
      nodes: 1,
      decision: 'defense',
      provenWin: false,
      reason: `${toCoordinate(mv.row, mv.col)}：優先封鎖對手五連威脅點。`,
    };
  }

  // 3. Static open-4 / White double-4 / White forbidden-four trap
  const staticCheck = checkStaticWin(state, color);
  if (staticCheck && staticCheck.score >= MATE - 5 && isAllowed(staticCheck.move)) {
    const mv = toCoordObj(staticCheck.move);
    return {
      move: mv,
      score: staticCheck.score,
      winRate: 1,
      depth: 2,
      nodes: 1,
      decision: 'win',
      provenWin: true,
      reason: `${toCoordinate(mv.row, mv.col)}：形成不可防禦的活四／禁手必勝著手。`,
    };
  }

  // 4. KataGomo Cost-Bounded Connected VCF Solver (bounded by time)
  const vcf = solveVCF(state, color, {
    maxDepth: 20,
    maxNodes: timeBudgetMs >= 200 ? 12000 : 3000,
    allowedMoves,
  });
  if (vcf.win && isAllowed(vcf.index)) {
    return {
      move: vcf.move,
      score: MATE - vcf.depth,
      winRate: 1,
      depth: vcf.depth,
      nodes: vcf.nodes,
      decision: 'vcf',
      provenWin: true,
      reason: `${toCoordinate(vcf.move.row, vcf.move.col)}：KataGomo VCF 連續衝四算殺成功（${vcf.nodes} 節點）。`,
    };
  }

  // 5. Yixin SearchDefend: strictly time-capped so PVS + MCTS always retain >= 60% of budget!
  let defenseFilterSet = null;
  let defenseTag = null;
  const defendDeadline = startMs + Math.floor(timeBudgetMs * 0.28);

  const oppVcf = solveVCF(state, opp, {
    maxDepth: 16,
    maxNodes: timeBudgetMs >= 200 ? 4500 : 1200,
  });

  if (oppVcf.win) {
    const candList = [];
    const seenCand = new Uint8Array(AREA);
    for (const idx of oppVcf.threatCells) {
      if (isAllowed(idx) && !seenCand[idx]) {
        seenCand[idx] = 1;
        candList.push({ idx, s: scoreCandidateCell(state, idx, color).s + 5000 });
      }
    }
    for (let idx = 0; idx < AREA; idx++) {
      if (seenCand[idx] || !isAllowed(idx) || state.nearby[idx] === 0) continue;
      const my = summarizeCell(color === BLACK ? state.patB : state.patW, idx);
      const op = summarizeCell(opp === BLACK ? state.patB : state.patW, idx);
      if (my.sleepFours > 0 || my.allThrees > 0 || op.sleepFours > 0 || op.allThrees > 0) {
        seenCand[idx] = 1;
        candList.push({ idx, s: scoreCandidateCell(state, idx, color).s });
      }
    }
    candList.sort((a, b2) => b2.s - a.s);

    const refuters = [];
    let checkedAll = true;
    for (let ci = 0; ci < candList.length && ci < 14; ci++) {
      if (Date.now() >= defendDeadline) { checkedAll = false; break; }
      const idx = candList[ci].idx;
      state.play(idx, color);
      const myComps = findFivesCreatedByMove(b, idx, color);
      let refutes = false;
      if (myComps.length === 0) {
        refutes = !solveVCF(state, opp, { maxDepth: 14, maxNodes: 1000 }).win;
      } else if (myComps.length === 1) {
        const oppBlock = myComps[0];
        if (opp === BLACK && isBlackForbiddenMutable(b, oppBlock)) {
          refutes = true;
        } else {
          state.play(oppBlock, opp);
          refutes = !solveVCF(state, opp, { maxDepth: 14, maxNodes: 1000 }).win;
          state.undo(oppBlock);
        }
      } else {
        refutes = true;
      }
      state.undo(idx);
      if (refutes) refuters.push(idx);
    }
    if (checkedAll && refuters.length > 0) {
      defenseFilterSet = new Set(refuters);
      defenseTag = 'SearchDefend 反制對手連續衝四';
    } else if (refuters.length > 0) {
      // Partial check found solid refuters; prefer them when we also include top threatCells
      for (const idx of oppVcf.threatCells) {
        if (isAllowed(idx)) refuters.push(idx);
      }
      defenseFilterSet = new Set(refuters);
      defenseTag = 'SearchDefend 反制對手連續衝四';
    }
  } else if (timeBudgetMs >= 160 && Date.now() < defendDeadline) {
    const oppVct = solveVCT(state, opp, {
      maxDepth: 6,
      maxNodes: timeBudgetMs >= 400 ? 1500 : 700,
    });
    if (oppVct.win) {
      const candList = [];
      const seenCand = new Uint8Array(AREA);
      for (const idx of oppVct.threatCells) {
        if (isAllowed(idx) && !seenCand[idx]) {
          seenCand[idx] = 1;
          candList.push({ idx, s: scoreCandidateCell(state, idx, color).s + 5000 });
        }
      }
      for (let idx = 0; idx < AREA; idx++) {
        if (seenCand[idx] || !isAllowed(idx) || state.nearby[idx] === 0) continue;
        const my = summarizeCell(color === BLACK ? state.patB : state.patW, idx);
        const op = summarizeCell(opp === BLACK ? state.patB : state.patW, idx);
        if (my.sleepFours > 0 || my.allThrees > 0 || op.sleepFours > 0 || op.allThrees > 0) {
          seenCand[idx] = 1;
          candList.push({ idx, s: scoreCandidateCell(state, idx, color).s });
        }
      }
      candList.sort((a, b2) => b2.s - a.s);

      const refuters = [];
      for (let ci = 0; ci < candList.length && ci < 12; ci++) {
        if (Date.now() >= defendDeadline) break;
        const idx = candList[ci].idx;
        state.play(idx, color);
        const myComps = findFivesCreatedByMove(b, idx, color);
        let refutes = false;
        if (myComps.length === 0) {
          refutes = !solveVCT(state, opp, { maxDepth: 6, maxNodes: 600 }).win;
        } else if (myComps.length === 1) {
          const oppBlock = myComps[0];
          if (opp === BLACK && isBlackForbiddenMutable(b, oppBlock)) {
            refutes = true;
          } else {
            state.play(oppBlock, opp);
            refutes = !solveVCT(state, opp, { maxDepth: 6, maxNodes: 600 }).win;
            state.undo(oppBlock);
          }
        } else {
          refutes = true;
        }
        state.undo(idx);
        if (refutes) refuters.push(idx);
      }
      if (refuters.length > 0) {
        defenseFilterSet = new Set(refuters);
        defenseTag = 'SearchDefend 破解對手連續活三攻殺';
      }
    }
  }

  // 6. Own VCT Solver (only if enough time remains so PVS/MCTS never starve)
  if (!defenseFilterSet && timeBudgetMs >= 160 && Date.now() - startMs < timeBudgetMs * 0.35) {
    const vct = solveVCT(state, color, {
      maxDepth: timeBudgetMs >= 450 ? 8 : 6,
      maxNodes: timeBudgetMs >= 450 ? 2500 : 1000,
      allowedMoves,
    });
    if (vct.win && isAllowed(vct.index)) {
      return {
        move: vct.move,
        score: MATE - 20,
        winRate: 1,
        depth: vct.depth,
        nodes: vct.nodes,
        decision: 'vct',
        provenWin: true,
        reason: `${toCoordinate(vct.move.row, vct.move.col)}：VCT 連續威脅算殺成功（${vct.nodes} 節點）。`,
      };
    }
  }

  // 7. Hybrid Phase A: Iterative-Deepening Incremental PVS (~50% remaining budget)
  const searchAllowed = defenseFilterSet ?? allowedSet;
  const elapsed = Date.now() - startMs;
  const remaining = Math.max(20, timeBudgetMs - elapsed);
  const useMCTS = timeBudgetMs >= 150 && remaining >= 60;
  const pvsBudget = useMCTS ? Math.floor(remaining * 0.52) : remaining;

  const pvsRes = runPVSSearch(state, color, searchAllowed, maxDepth, pvsBudget, Date.now());
  if (pvsRes.score >= MATE - 500 && isAllowed(pvsRes.bestMove)) {
    const mv = toCoordObj(pvsRes.bestMove);
    return {
      move: mv,
      score: pvsRes.score,
      winRate: 1,
      depth: pvsRes.depth,
      nodes: pvsRes.nodes,
      decision: defenseFilterSet ? 'search-defend' : 'search',
      provenWin: true,
      reason: `${toCoordinate(mv.row, mv.col)}：PVS 深度 ${pvsRes.depth} 算殺獲勝（節點 ${pvsRes.nodes}）。`,
    };
  }

  // 8. Hybrid Phase B: KataGomo PUCT-MCTS with LCB & PVS guidance (~48% remaining budget)
  let finalMoveIdx = pvsRes.bestMove;
  let winRate = scoreToWinRate(pvsRes.score);
  let playouts = 0;

  if (useMCTS) {
    const mctsBudget = Math.max(25, timeBudgetMs - (Date.now() - startMs));
    const mcts = runMCTSSearch(state, color, {
      timeBudgetMs: mctsBudget,
      maxPlayouts: 600,
      allowedMoves: searchAllowed ? [...searchAllowed].map(toCoordObj) : allowedMoves,
      pvsRootScores: pvsRes.rootMoveScores,
    });
    playouts = mcts.playouts;
    if (mcts.provenWin && isAllowed(mcts.index)) {
      return {
        move: mcts.move,
        score: MATE - 30,
        winRate: 1,
        depth: pvsRes.depth,
        nodes: pvsRes.nodes + playouts,
        decision: 'mcts-win',
        provenWin: true,
        reason: `${toCoordinate(mcts.move.row, mcts.move.col)}：KataGomo MCTS＋PVS 算殺獲勝（${playouts} 次模擬）。`,
      };
    }
    if (mcts.index >= 0 && isAllowed(mcts.index)) {
      const mctsPvsScore = pvsRes.rootMoveScores.get(mcts.index);
      // Do not override PVS's best move with a move PVS proved is losing or drastically worse
      if (mctsPvsScore === undefined || mctsPvsScore > -MATE + 500) {
        finalMoveIdx = mcts.index;
        winRate = Math.round(((mcts.winRate + scoreToWinRate(pvsRes.score)) * 0.5) * 1000) / 1000;
      }
    }
  }

  if (finalMoveIdx === -1 || !isAllowed(finalMoveIdx)) {
    const fallback = rankMoves(state, color, { allowedMoves });
    if (fallback.length === 0) throw new Error('沒有可落子的合法位置。');
    finalMoveIdx = fallback[0].row * SIZE + fallback[0].col;
  }

  const mv = toCoordObj(finalMoveIdx);
  const modeLabel = defenseTag
    ? `${defenseTag}（深度 ${pvsRes.depth}，${playouts} 次 MCTS）`
    : playouts > 0
      ? `KataGomo PUCT-MCTS（${playouts} 模擬）＋PVS 深度 ${pvsRes.depth}`
      : `混合引擎深度 ${pvsRes.depth} 搜尋`;

  return {
    move: mv,
    score: pvsRes.score,
    winRate,
    depth: pvsRes.depth,
    nodes: pvsRes.nodes + playouts,
    decision: defenseFilterSet ? 'search-defend' : 'search',
    provenWin: false,
    reason: `${toCoordinate(mv.row, mv.col)}：${modeLabel}（評估 ${pvsRes.score}）。`,
  };
}

/**
 * Yixin BALANCE-inspired 5th-move pair selection using shallow PVS evaluations.
 */
export function chooseBalancedFifths(board, equivalentFn) {
  const state = new BoardState(board);
  const ranked = rankMoves(state, BLACK);
  if (ranked.length < 2) throw new Error('找不到兩個不等價的第五手。');

  const distinct = [];
  for (const cand of ranked) {
    if (distinct.every((prev) => !equivalentFn(board, prev, cand))) {
      distinct.push({ row: cand.row, col: cand.col });
      if (distinct.length >= 6) break;
    }
  }
  if (distinct.length < 2) throw new Error('找不到兩個不等價的第五手。');

  const evaluated = distinct.map((mv) => {
    const idx = mv.row * SIZE + mv.col;
    state.play(idx, BLACK);
    const whiteRes = runPVSSearch(state, WHITE, null, 3, 18, Date.now());
    state.undo(idx);
    return { mv, blackScore: -whiteRes.score };
  }).sort((a, b) => b.blackScore - a.blackScore);

  return [evaluated[0].mv, evaluated[1].mv];
}

/**
 * Evaluates each 5th-move candidate by placing it as Black and running White PVS search.
 */
export function chooseBestFifthIndex(board, candidates) {
  const state = new BoardState(board);
  const scores = candidates.map(({ row, col }) => {
    const idx = row * SIZE + col;
    state.play(idx, BLACK);
    const res = runPVSSearch(state, WHITE, null, 4, 30, Date.now());
    state.undo(idx);
    return res.score;
  });
  return scores[0] >= scores[1] ? 0 : 1;
}
