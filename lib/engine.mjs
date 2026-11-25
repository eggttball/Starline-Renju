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
const TEMPO_BONUS = 42;
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

// Threat categories per direction (in order 0..7)
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

// Embryo-calibrated asymmetric pattern weights (0x273db0 vs 0x273c00):
// Index: [NONE, SLEEP_TWO, OPEN_TWO, SLEEP_THREE, OPEN_THREE, SLEEP_FOUR, OPEN_FOUR, FIVE]
const OWN_WEIGHTS = new Int32Array([0, 45, 170, 200, 1176, 1512, 2419, 10000]);
const OPP_WEIGHTS = new Int32Array([0, 15, 55, 70, 330, 384, 576, 4500]);

// Center-proximity positional table (Embryo PrepareCoordsScoreTable)
const POS_SCORE = new Int32Array(AREA);
for (let r = 0; r < SIZE; r++) {
  for (let c = 0; c < SIZE; c++) {
    const dist = Math.max(Math.abs(r - 7), Math.abs(c - 7));
    POS_SCORE[r * SIZE + c] = (7 - dist) * 4;
  }
}

// Precomputed lines passing through each cell (each entry: { cells, pivot })
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
    return { cells, pivot };
  });
});

// Precomputed 2-ring neighborhood indices for every cell (Chebyshev distance <= 2)
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

// Precomputed line-ray neighbors within distance 4 (for tactical defense & foul checks)
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

// Deterministic 64-bit Zobrist hash tables (two 32-bit halves per key, zero BigInt overhead)
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

function computeHash(board, side) {
  let hi = side === WHITE ? SIDE_HI : 0;
  let lo = side === WHITE ? SIDE_LO : 0;
  for (let i = 0; i < AREA; i++) {
    const v = board[i];
    if (v !== 0) {
      hi = (hi ^ ZOB_HI[v][i]) >>> 0;
      lo = (lo ^ ZOB_LO[v][i]) >>> 0;
    }
  }
  return { hi, lo };
}

// Fixed-size Transposition Tables (PVS + VCF)
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

const VCF_TT_SIZE = 1 << 15;
const VCF_TT_MASK = VCF_TT_SIZE - 1;
const vcfTtHi = new Uint32Array(VCF_TT_SIZE);
const vcfTtLo = new Uint32Array(VCF_TT_SIZE);
const vcfTtRes = new Int8Array(VCF_TT_SIZE); // 0=empty, 1=win, 2=loss
const vcfTtMove = new Int16Array(VCF_TT_SIZE);
const vcfTtGen = new Uint16Array(VCF_TT_SIZE);
let vcfGen = 1;

function oppOf(color) {
  return color === BLACK ? WHITE : BLACK;
}

function toCoordObj(index) {
  return { row: (index / SIZE) | 0, col: index % SIZE };
}

/**
 * Analyze a single direction line when `color` would be placed at empty `index`.
 * Temporarily assumes board[index] = color (without mutating if caller hasn't).
 * Returns threat code THREAT.* plus completion squares when relevant.
 */
function analyzeDirectionAt(board, index, dirIdx, color) {
  const { cells, pivot } = MOVE_LINES[index][dirIdx];
  const len = cells.length;
  const isBlack = color === BLACK;

  // Count contiguous run passing through pivot
  let left = pivot;
  while (left > 0 && board[cells[left - 1]] === color) left--;
  let right = pivot;
  while (right + 1 < len && board[cells[right + 1]] === color) right++;
  const runLen = right - left + 1;

  if (isBlack) {
    if (runLen === 5) return THREAT.FIVE;
    if (runLen > 5) return THREAT.NONE;
  } else if (runLen >= 5) {
    return THREAT.FIVE;
  }

  // Scan all 5-cell windows containing pivot for fours (consecutive and jump-4)
  let fourCompletions = 0;
  let lastFourMask = 0;
  const min5 = Math.max(0, pivot - 4);
  const max5 = Math.min(pivot, len - 5);
  for (let start = min5; start <= max5; start++) {
    let stones = 1; // pivot itself
    let emptyPos = -1;
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const pos = start + k;
      if (pos === pivot) continue;
      const v = board[cells[pos]];
      if (v === color) stones++;
      else if (v === 0) {
        if (emptyPos !== -1) { ok = false; break; }
        emptyPos = pos;
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || stones !== 4 || emptyPos === -1) continue;
    if (isBlack) {
      if ((start > 0 && board[cells[start - 1]] === BLACK)
        || (start + 5 < len && board[cells[start + 5]] === BLACK)) continue;
    }
    const bit = 1 << emptyPos;
    if ((lastFourMask & bit) === 0) {
      lastFourMask |= bit;
      fourCompletions++;
    }
  }
  if (fourCompletions >= 2) return THREAT.OPEN_FOUR;
  if (fourCompletions === 1) return THREAT.SLEEP_FOUR;

  // Scan 6-cell open windows (.XXXX. patterns where pivot is inside inner 4) for open threes (consecutive and jump-3)
  const min6 = Math.max(0, pivot - 4);
  const max6 = Math.min(pivot - 1, len - 6);
  for (let start = min6; start <= max6; start++) {
    if (board[cells[start]] !== 0 || board[cells[start + 5]] !== 0) continue;
    if (isBlack) {
      if ((start > 0 && board[cells[start - 1]] === BLACK)
        || (start + 6 < len && board[cells[start + 6]] === BLACK)) continue;
    }
    let stones = 1; // pivot is inside start+1..start+4
    let gap = -1;
    let ok = true;
    for (let k = 1; k <= 4; k++) {
      const pos = start + k;
      if (pos === pivot) continue;
      const v = board[cells[pos]];
      if (v === color) stones++;
      else if (v === 0) {
        if (gap !== -1) { ok = false; break; }
        gap = pos;
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || stones !== 3 || gap === -1) continue;
    return THREAT.OPEN_THREE;
  }

  // Scan 5-cell windows for sleep-3 and open-2, sleep-2
  let hasSleep3 = false;
  let openTwoCount = 0;
  let hasSleep2 = false;
  for (let start = min5; start <= max5; start++) {
    let stones = 1;
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const pos = start + k;
      if (pos === pivot) continue;
      const v = board[cells[pos]];
      if (v === color) stones++;
      else if (v !== 0) { ok = false; break; }
    }
    if (!ok) continue;
    if (isBlack) {
      if ((start > 0 && board[cells[start - 1]] === BLACK)
        || (start + 5 < len && board[cells[start + 5]] === BLACK)) continue;
    }
    if (stones === 3) hasSleep3 = true;
    else if (stones === 2) {
      const leftOpen = start > 0 && board[cells[start - 1]] === 0;
      const rightOpen = start + 5 < len && board[cells[start + 5]] === 0;
      if (leftOpen && rightOpen) openTwoCount++;
      else hasSleep2 = true;
    }
  }
  if (hasSleep3) return THREAT.SLEEP_THREE;
  if (openTwoCount > 0) return THREAT.OPEN_TWO;
  if (hasSleep2) return THREAT.SLEEP_TWO;
  return THREAT.NONE;
}

/**
 * Evaluate all 4 directions for placing `color` at empty `index`.
 * Also handles same-line double-four (e.g. X.XMX.X -> OPEN_FOUR / DOUBLE_FOUR).
 */
function evaluatePointDirs(board, index, color) {
  let fives = 0;
  let openFours = 0;
  let sleepFours = 0;
  let openThrees = 0;
  let sleepThrees = 0;
  let openTwos = 0;
  let sleepTwos = 0;
  let weightSum = 0;

  for (let d = 0; d < 4; d++) {
    const t = analyzeDirectionAt(board, index, d, color);
    if (t === THREAT.FIVE) fives++;
    else if (t === THREAT.OPEN_FOUR) openFours++;
    else if (t === THREAT.SLEEP_FOUR) sleepFours++;
    else if (t === THREAT.OPEN_THREE) openThrees++;
    else if (t === THREAT.SLEEP_THREE) sleepThrees++;
    else if (t === THREAT.OPEN_TWO) openTwos++;
    else if (t === THREAT.SLEEP_TWO) sleepTwos++;
    weightSum += t;
  }

  // Classify compound intersection (Embryo Square::SquareCombination)
  let combo = COMBO.NONE;
  if (fives > 0) combo = COMBO.FIVE;
  else if (sleepFours >= 2 || (openFours >= 1 && (sleepFours >= 1 || openFours >= 2))) combo = COMBO.DOUBLE_FOUR;
  else if (openFours === 1) combo = COMBO.OPEN_FOUR;
  else if (sleepFours === 1 && openThrees >= 1) combo = COMBO.FOUR_THREE;
  else if (openThrees >= 2) combo = COMBO.DOUBLE_THREE;
  else if (openThrees === 1 && openTwos >= 1) combo = COMBO.THREE_TWO;
  else if (openTwos >= 2) combo = COMBO.DOUBLE_TWO;

  return {
    fives,
    openFours,
    sleepFours,
    openThrees,
    sleepThrees,
    openTwos,
    sleepTwos,
    combo,
    weightSum,
  };
}

/**
 * Find exact five-completion cells for `color` on `board` (excluding Black overlines).
 */
function findFiveCompletions(board, color, out = []) {
  out.length = 0;
  const isBlack = color === BLACK;
  const seen = new Uint8Array(AREA);
  for (let idx = 0; idx < AREA; idx++) {
    if (board[idx] !== 0) continue;
    for (let d = 0; d < 4; d++) {
      const { cells, pivot } = MOVE_LINES[idx][d];
      let l = pivot;
      while (l > 0 && board[cells[l - 1]] === color) l--;
      let r = pivot;
      while (r + 1 < cells.length && board[cells[r + 1]] === color) r++;
      const runLen = r - l + 1;
      if (isBlack ? runLen === 5 : runLen >= 5) {
        if (!seen[idx]) {
          seen[idx] = 1;
          out.push(idx);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Find all single-cell completion points of existing fours for `color` after `placedIndex` was played,
 * or across the whole board. Returns array of cell indices that complete a 5.
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
 * Find all defensive cells for an open-3 formed along `placedIndex` by `attacker`.
 * Includes both outer ends AND internal gap for jump-3, plus any counter-fours for defender.
 */
function findThreeDefenses(board, placedIndex, attacker) {
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
      if (board[cells[start]] !== 0 || board[cells[start + 5]] !== 0) continue;
      if (isAttackerBlack) {
        if ((start > 0 && board[cells[start - 1]] === BLACK)
          || (start + 6 < len && board[cells[start + 6]] === BLACK)) continue;
      }
      let stones = 0;
      let gap = -1;
      let ok = true;
      for (let k = 1; k <= 4; k++) {
        const c = cells[start + k];
        const v = board[c];
        if (v === attacker) stones++;
        else if (v === 0) {
          if (gap !== -1) { ok = false; break; }
          gap = c;
        } else { ok = false; break; }
      }
      if (!ok || stones !== 3 || gap === -1) continue;
      // Candidate blocks: gap, left end, right end, plus outer ends if consecutive-3
      const blockCandidates = [cells[start], gap, cells[start + 5]];
      // If consecutive 3 (gap is at start+1 or start+4), also check adjacent outer extension
      if (start > 0 && board[cells[start - 1]] === 0) blockCandidates.push(cells[start - 1]);
      if (start + 6 < len && board[cells[start + 6]] === 0) blockCandidates.push(cells[start + 6]);
      for (const c of blockCandidates) {
        if (board[c] === 0 && !seen[c]) {
          seen[c] = 1;
          defenses.push(c);
        }
      }
    }
  }

  // Defender can also counter with any 4-attack (or 5-win) anywhere
  for (let idx = 0; idx < AREA; idx++) {
    if (board[idx] !== 0 || seen[idx]) continue;
    const { fives, openFours, sleepFours } = evaluatePointDirs(board, idx, defender);
    if (fives > 0 || openFours > 0 || sleepFours > 0) {
      seen[idx] = 1;
      defenses.push(idx);
    }
  }
  return defenses;
}

/**
 * Compute active candidate cells (within Chebyshev distance 2 of any stone).
 */
function getActiveCandidates(board) {
  const marked = new Uint8Array(AREA);
  let hasStone = false;
  for (let i = 0; i < AREA; i++) {
    if (board[i] === 0) continue;
    hasStone = true;
    const nbrs = NEIGHBORHOOD_2[i];
    for (let k = 0; k < nbrs.length; k++) {
      const idx = nbrs[k];
      if (board[idx] === 0) marked[idx] = 1;
    }
  }
  if (!hasStone) return [7 * SIZE + 7];
  const list = [];
  for (let i = 0; i < AREA; i++) {
    if (marked[i]) list.push(i);
  }
  return list;
}

/**
 * Embryo-inspired static win check + KataGomo ResultsBeforeNN tactical check.
 */
function checkStaticWin(board, sideToMove) {
  const opp = oppOf(sideToMove);
  const myFives = findFiveCompletions(board, sideToMove);
  if (myFives.length > 0) {
    return { score: MATE, move: myFives[0] };
  }
  const oppFives = findFiveCompletions(board, opp);
  if (oppFives.length >= 2) {
    return { score: -MATE + 1, move: oppFives[0] };
  }
  if (oppFives.length === 1) {
    return null; // Must defend, not a static win/loss yet
  }

  // Check if sideToMove has an immediate winning move (open-4, White double-4, or White forbidden-four trap)
  const candidates = getActiveCandidates(board);
  for (let i = 0; i < candidates.length; i++) {
    const idx = candidates[i];
    if (sideToMove === BLACK && isBlackForbiddenMutable(board, idx)) continue;
    const info = evaluatePointDirs(board, idx, sideToMove);
    if (info.openFours > 0 || (sideToMove === WHITE && info.combo === COMBO.DOUBLE_FOUR)) {
      return { score: MATE - 2, move: idx };
    }
    if (sideToMove === WHITE && info.sleepFours === 1) {
      board[idx] = WHITE;
      const comps = findFivesCreatedByMove(board, idx, WHITE);
      let trap = false;
      if (comps.length === 1 && isBlackForbiddenMutable(board, comps[0])) {
        trap = true;
      }
      board[idx] = 0;
      if (trap) return { score: MATE - 2, move: idx };
    }
  }
  return null;
}

/**
 * Embryo-style asymmetric tempo-aware static evaluation + FoulAttackScore.
 */
function evaluateBoard(board, sideToMove) {
  const opp = oppOf(sideToMove);
  const candidates = getActiveCandidates(board);
  let score = TEMPO_BONUS;
  let myFourThree = false;
  let oppOpenFour = false;
  let oppFourCount = 0;
  let myThreeScore = 0;
  let oppThreeScore = 0;

  for (let i = 0; i < candidates.length; i++) {
    const idx = candidates[i];
    const posBonus = POS_SCORE[idx];

    const myForb = sideToMove === BLACK && isBlackForbiddenMutable(board, idx);
    if (!myForb) {
      const my = evaluatePointDirs(board, idx, sideToMove);
      if (my.openFours > 0) return MATE - 2;
      if (my.sleepFours > 0 && my.openThrees > 0) myFourThree = true;
      const myVal = my.sleepFours * OWN_WEIGHTS[THREAT.SLEEP_FOUR]
        + my.openThrees * OWN_WEIGHTS[THREAT.OPEN_THREE]
        + my.sleepThrees * OWN_WEIGHTS[THREAT.SLEEP_THREE]
        + my.openTwos * OWN_WEIGHTS[THREAT.OPEN_TWO]
        + my.sleepTwos * OWN_WEIGHTS[THREAT.SLEEP_TWO];
      if (myVal > 0) {
        score += myVal + posBonus;
        if (my.combo === COMBO.DOUBLE_THREE && sideToMove === WHITE) score += 900;
        if (my.combo === COMBO.THREE_TWO) score += 260;
        if (my.combo === COMBO.DOUBLE_TWO) score += 110;
        myThreeScore += my.openThrees;
      }
      // Embryo FoulAttackScore: White gets extra bonus for threatening squares near Black forbidden points
      if (sideToMove === WHITE && (my.sleepFours > 0 || my.openThrees > 0)) {
        board[idx] = WHITE;
        const comps = findFivesCreatedByMove(board, idx, WHITE);
        if (comps.length === 1 && isBlackForbiddenMutable(board, comps[0])) {
          board[idx] = 0;
          return MATE - 2;
        }
        board[idx] = 0;
      }
    } else {
      // Black forbidden point nearby hurts Black and helps White (Embryo FoulAttackScore)
      score -= 180;
    }

    const oppForb = opp === BLACK && isBlackForbiddenMutable(board, idx);
    if (!oppForb) {
      const op = evaluatePointDirs(board, idx, opp);
      if (op.openFours > 0) oppOpenFour = true;
      if (op.sleepFours > 0) oppFourCount++;
      const opVal = op.sleepFours * OPP_WEIGHTS[THREAT.SLEEP_FOUR]
        + op.openThrees * OPP_WEIGHTS[THREAT.OPEN_THREE]
        + op.sleepThrees * OPP_WEIGHTS[THREAT.SLEEP_THREE]
        + op.openTwos * OPP_WEIGHTS[THREAT.OPEN_TWO]
        + op.sleepTwos * OPP_WEIGHTS[THREAT.SLEEP_TWO];
      if (opVal > 0) {
        score -= opVal + posBonus;
        if (op.combo === COMBO.FOUR_THREE) score -= 750;
        if (op.combo === COMBO.DOUBLE_THREE && opp === WHITE) score -= 520;
        if (op.combo === COMBO.THREE_TWO) score -= 120;
        oppThreeScore += op.openThrees;
      }
    } else {
      // Opponent (Black) is forbidden here: White gains FoulAttackScore
      score += 220;
    }
  }

  if (oppOpenFour && oppFourCount >= 1) return -MATE + 3;
  if (myFourThree && oppFourCount === 0) return MATE - 4;
  if (myThreeScore > 0 && oppFourCount === 0 && oppThreeScore === 0) score += 280;
  return score;
}

/**
 * KataGomo-inspired Renju VCF (Victory by Continuous Fours) Solver.
 * Searches forced four sequences up to `maxDepth` plies and `maxNodes` nodes.
 * Returns { win: boolean, move: {row,col}|null, index: number, depth: number, nodes: number, threatCells: number[] }.
 */
export function solveVCF(board, attacker, options = {}) {
  const maxDepth = options.maxDepth ?? 18;
  const maxNodes = options.maxNodes ?? 12000;
  const u8 = board instanceof Uint8Array ? board : Uint8Array.from(board);
  const defender = oppOf(attacker);
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  vcfGen = (vcfGen + 1) & 0xffff || 1;
  const hash = computeHash(u8, attacker);
  let nodes = 0;

  // Quick check: immediate 5
  const immediateFives = findFiveCompletions(u8, attacker);
  for (const idx of immediateFives) {
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (attacker === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
    return { win: true, move: toCoordObj(idx), index: idx, depth: 1, nodes: 1, threatCells: [idx] };
  }

  // If defender already has an immediate 5, attacker can only win if one of our 5-completions blocks it
  // (already checked above), or our 4 cannot outrace defender's immediate 5.
  const oppImmediateFives = findFiveCompletions(u8, defender);
  if (oppImmediateFives.length >= 1) {
    return { win: false, move: null, index: -1, depth: 0, nodes: 1, threatCells: [] };
  }

  const threatPath = [];

  function vcfSearch(depth, hHi, hLo, isRoot) {
    if (nodes >= maxNodes || depth > maxDepth) return -1;
    nodes++;

    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCF_TT_MASK;
      if (vcfTtGen[slot] === vcfGen && vcfTtHi[slot] === hHi && vcfTtLo[slot] === hLo) {
        if (vcfTtRes[slot] === 1) return vcfTtMove[slot];
        if (vcfTtRes[slot] === 2) return -1;
      }
    }

    // Generate candidate four-attacks for attacker
    const candidates = [];
    const active = getActiveCandidates(u8);
    for (let i = 0; i < active.length; i++) {
      const idx = active[i];
      if (isRoot && allowedSet && !allowedSet.has(idx)) continue;
      if (attacker === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
      const info = evaluatePointDirs(u8, idx, attacker);
      if (info.fives > 0) return idx;
      if (info.openFours > 0 || (attacker === WHITE && info.combo === COMBO.DOUBLE_FOUR)) {
        candidates.unshift({ idx, priority: 3 });
      } else if (info.sleepFours > 0) {
        candidates.push({ idx, priority: info.openThrees > 0 ? 2 : 1 });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority || a.idx - b.idx);

    for (let i = 0; i < candidates.length; i++) {
      const atkIdx = candidates[i].idx;
      const pHi = (hHi ^ ZOB_HI[attacker][atkIdx]) >>> 0;
      const pLo = (hLo ^ ZOB_LO[attacker][atkIdx]) >>> 0;
      u8[atkIdx] = attacker;

      const completions = findFivesCreatedByMove(u8, atkIdx, attacker);
      if (completions.length >= 2) {
        // Open-4 or White Double-4 -> guaranteed win
        u8[atkIdx] = 0;
        threatPath.push(atkIdx, ...completions);
        if (!isRoot) {
          const slot = (hHi ^ hLo) & VCF_TT_MASK;
          vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
          vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx;
        }
        return atkIdx;
      }

      if (completions.length === 1) {
        const defIdx = completions[0];
        // White forbidden-four trap: Black's only defense is forbidden!
        if (defender === BLACK && isBlackForbiddenMutable(u8, defIdx)) {
          u8[atkIdx] = 0;
          threatPath.push(atkIdx, defIdx);
          if (!isRoot) {
            const slot = (hHi ^ hLo) & VCF_TT_MASK;
            vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
            vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx;
          }
          return atkIdx;
        }

        // Defender plays defIdx
        u8[defIdx] = defender;
        const dHi = (pHi ^ ZOB_HI[defender][defIdx]) >>> 0;
        const dLo = (pLo ^ ZOB_LO[defender][defIdx]) >>> 0;

        // Did defender immediately complete 5?
        const defFive = findFiveCompletions(u8, defender);
        let won = false;
        if (defFive.length === 0) {
          // Check if defender's move created a counter-four!
          const counterFours = findFivesCreatedByMove(u8, defIdx, defender);
          //Wait: findFivesCreatedByMove finds 4->5 completions created by defIdx
          if (counterFours.length === 0) {
            // Did attacker gain an immediate 5 anywhere else? (rare, handled in recursion)
            const sub = vcfSearch(depth + 2, dHi, dLo, false);
            if (sub !== -1) won = true;
          } else if (counterFours.length === 1) {
            // Attacker can only continue if playing at counterFours[0] is legal and is itself a 5 or 4!
            const cf = counterFours[0];
            if (!(attacker === BLACK && isBlackForbiddenMutable(u8, cf))) {
              const cfInfo = evaluatePointDirs(u8, cf, attacker);
              if (cfInfo.fives > 0 || cfInfo.openFours > 0 || cfInfo.sleepFours > 0) {
                const sub = vcfSearch(depth + 2, dHi, dLo, false);
                if (sub !== -1) won = true;
              }
            }
          }
        } else {
          // Check if defender only has 1 five and attacker can win ON that exact square immediately
          if (defFive.length === 1) {
            const must = defFive[0];
            if (!(attacker === BLACK && isBlackForbiddenMutable(u8, must))) {
              const mustInfo = evaluatePointDirs(u8, must, attacker);
              if (mustInfo.fives > 0) won = true;
            }
          }
        }

        u8[defIdx] = 0;
        u8[atkIdx] = 0;

        if (won) {
          threatPath.push(atkIdx, defIdx);
          if (!isRoot) {
            const slot = (hHi ^ hLo) & VCF_TT_MASK;
            vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
            vcfTtRes[slot] = 1; vcfTtMove[slot] = atkIdx;
          }
          return atkIdx;
        }
      } else {
        u8[atkIdx] = 0;
      }
    }

    if (!isRoot) {
      const slot = (hHi ^ hLo) & VCF_TT_MASK;
      vcfTtGen[slot] = vcfGen; vcfTtHi[slot] = hHi; vcfTtLo[slot] = hLo;
      vcfTtRes[slot] = 2; vcfTtMove[slot] = -1;
    }
    return -1;
  }

  const bestIdx = vcfSearch(0, hash.hi, hash.lo, true);
  if (bestIdx !== -1) {
    // Expand threat cells along the winning move's neighborhood for SearchDefend
    const pathSet = new Set(threatPath);
    pathSet.add(bestIdx);
    const nbrs = RAY_NEIGHBORS_4[bestIdx];
    for (let i = 0; i < nbrs.length; i++) {
      if (u8[nbrs[i]] === 0) pathSet.add(nbrs[i]);
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
 * Yixin-inspired VCT (Victory by Continuous Threats) Solver.
 * Searches continuous 4/3 threats up to `maxDepth` plies and `maxNodes` nodes.
 */
export function solveVCT(board, attacker, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 3500;
  const u8 = board instanceof Uint8Array ? board : Uint8Array.from(board);
  const defender = oppOf(attacker);
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  let nodes = 0;
  const immediateFives = findFiveCompletions(u8, attacker);
  for (const idx of immediateFives) {
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (attacker === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
    return { win: true, move: toCoordObj(idx), index: idx, depth: 1, nodes: 1 };
  }
  if (findFiveCompletions(u8, defender).length > 0) {
    return { win: false, move: null, index: -1, depth: 0, nodes: 1 };
  }

  function vctAttack(depth, isRoot) {
    if (nodes >= maxNodes || depth > maxDepth) return -1;
    nodes++;

    // First try fast VCF from this node
    if (!isRoot && depth <= maxDepth - 2) {
      const vcf = solveVCF(u8, attacker, { maxDepth: 12, maxNodes: 1500 });
      if (vcf.win) return vcf.index;
    }

    const active = getActiveCandidates(u8);
    const threats = [];
    for (let i = 0; i < active.length; i++) {
      const idx = active[i];
      if (isRoot && allowedSet && !allowedSet.has(idx)) continue;
      if (attacker === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
      const info = evaluatePointDirs(u8, idx, attacker);
      if (info.fives > 0) return idx;
      if (info.openFours > 0 || (attacker === WHITE && info.combo === COMBO.DOUBLE_FOUR)) {
        return idx;
      }
      if (info.combo === COMBO.FOUR_THREE) {
        threats.push({ idx, prio: 4, isFour: true });
      } else if (info.sleepFours > 0) {
        threats.push({ idx, prio: 3, isFour: true });
      } else if (info.combo === COMBO.DOUBLE_THREE && attacker === WHITE) {
        threats.push({ idx, prio: 3, isFour: false });
      } else if (info.openThrees > 0) {
        threats.push({ idx, prio: 2, isFour: false });
      }
    }

    threats.sort((a, b) => b.prio - a.prio || a.idx - b.idx);
    const branchCap = isRoot ? 16 : 8;

    for (let i = 0; i < threats.length && i < branchCap; i++) {
      const { idx, isFour } = threats[i];
      u8[idx] = attacker;

      if (isFour) {
        const comps = findFivesCreatedByMove(u8, idx, attacker);
        if (comps.length >= 2) {
          u8[idx] = 0;
          return idx;
        }
        if (comps.length === 1) {
          const defIdx = comps[0];
          if (defender === BLACK && isBlackForbiddenMutable(u8, defIdx)) {
            u8[idx] = 0;
            return idx;
          }
          u8[defIdx] = defender;
          const oppFives = findFiveCompletions(u8, defender);
          let won = false;
          if (oppFives.length === 0 && findFivesCreatedByMove(u8, defIdx, defender).length === 0) {
            if (vctAttack(depth + 2, false) !== -1) won = true;
          }
          u8[defIdx] = 0;
          u8[idx] = 0;
          if (won) return idx;
        } else {
          u8[idx] = 0;
        }
      } else if (depth + 2 <= maxDepth) {
        // Open-3 attack: attacker wins ONLY if attacker wins against EVERY legal defense
        const defMoves = findThreeDefenses(u8, idx, attacker);
        let allDefensesBeaten = defMoves.length > 0;
        for (let d = 0; d < defMoves.length; d++) {
          const defIdx = defMoves[d];
          if (defender === BLACK && isBlackForbiddenMutable(u8, defIdx)) continue;
          u8[defIdx] = defender;
          const oppFive = findFiveCompletions(u8, defender);
          if (oppFive.length > 0) {
            // Defender achieved 4->5 threat! Attacker fails unless attacker immediately wins on oppFive[0]
            let counterWin = false;
            if (oppFive.length === 1) {
              const must = oppFive[0];
              if (!(attacker === BLACK && isBlackForbiddenMutable(u8, must))) {
                if (evaluatePointDirs(u8, must, attacker).fives > 0) counterWin = true;
              }
            }
            u8[defIdx] = 0;
            if (!counterWin) { allDefensesBeaten = false; break; }
            continue;
          }
          const counterFour = findFivesCreatedByMove(u8, defIdx, defender);
          if (counterFour.length > 0) {
            const subVcf = solveVCF(u8, attacker, { maxDepth: 10, maxNodes: 800 });
            u8[defIdx] = 0;
            if (!subVcf.win) { allDefensesBeaten = false; break; }
            continue;
          }
          const sub = vctAttack(depth + 2, false);
          u8[defIdx] = 0;
          if (sub === -1) {
            allDefensesBeaten = false;
            break;
          }
        }
        u8[idx] = 0;
        if (allDefensesBeaten) return idx;
      } else {
        u8[idx] = 0;
      }
    }
    return -1;
  }

  const winIdx = vctAttack(0, true);
  if (winIdx !== -1) {
    return { win: true, move: toCoordObj(winIdx), index: winIdx, depth: 2, nodes };
  }
  return { win: false, move: null, index: -1, depth: 0, nodes };
}

/**
 * Generate ordered tactical moves for PVS search (Embryo MovePicker style).
 */
function generateOrderedMoves(u8, color, ttMove, killer1, killer2, history, allowedSet) {
  const opp = oppOf(color);
  const oppFives = findFiveCompletions(u8, opp);
  const myFives = findFiveCompletions(u8, color);

  if (myFives.length > 0) {
    for (const idx of myFives) {
      if (allowedSet && !allowedSet.has(idx)) continue;
      if (color === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
      return [idx];
    }
  }

  // If opponent has immediate 5-threat(s), we MUST play one of them (unless blocked by allowedSet)
  if (oppFives.length > 0) {
    const evasions = [];
    for (const idx of oppFives) {
      if (allowedSet && !allowedSet.has(idx)) continue;
      if (color === BLACK && isBlackForbiddenMutable(u8, idx)) continue;
      evasions.push(idx);
    }
    if (evasions.length > 0) return evasions;
  }

  const active = getActiveCandidates(u8);
  const scored = [];
  let oppHasOpenThree = false;
  const oppThreeSpots = [];

  for (let i = 0; i < active.length; i++) {
    const idx = active[i];
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (color === BLACK && isBlackForbiddenMutable(u8, idx)) continue;

    const my = evaluatePointDirs(u8, idx, color);
    const opForb = opp === BLACK && isBlackForbiddenMutable(u8, idx);
    const op = opForb
      ? { fives: 0, openFours: 0, sleepFours: 0, openThrees: 0, sleepThrees: 0, openTwos: 0, sleepTwos: 0, combo: COMBO.NONE }
      : evaluatePointDirs(u8, idx, opp);

    if (op.openFours > 0 || op.combo === COMBO.FOUR_THREE) oppThreeSpots.push(idx);
    if (op.openThrees > 0) oppHasOpenThree = true;

    let s = POS_SCORE[idx];
    if (idx === ttMove) s += 1000000;
    if (my.openFours > 0 || (color === WHITE && my.combo === COMBO.DOUBLE_FOUR)) s += 500000;
    else if (op.openFours > 0) s += 200000;
    else if (my.combo === COMBO.FOUR_THREE) s += 120000;
    else if (op.combo === COMBO.FOUR_THREE) s += 80000;
    else if (color === WHITE && my.combo === COMBO.DOUBLE_THREE) s += 60000;
    else if (op.combo === COMBO.DOUBLE_THREE) s += 45000;

    s += my.sleepFours * 4800 + my.openThrees * 2400 + my.sleepThrees * 320 + my.openTwos * 280 + my.sleepTwos * 50;
    s += op.sleepFours * 2200 + op.openThrees * 1950 + op.sleepThrees * 220 + op.openTwos * 200 + op.sleepTwos * 35;

    // Embryo BlockToMakeForbidden bonus for White
    if (color === WHITE && opForb) s += 350;

    if (idx === killer1) s += 1800;
    else if (idx === killer2) s += 1200;
    s += Math.min(1000, history[idx] >> 2);

    scored.push({ idx, s, isTactical: my.sleepFours > 0 || my.openThrees > 0 || op.openFours > 0 || op.openThrees > 0 });
  }

  scored.sort((a, b) => b.s - a.s || a.idx - b.idx);

  // Prune low-value distant candidates at deeper search plies while keeping all critical defenses
  const maxBranch = oppHasOpenThree || oppThreeSpots.length > 0 ? 18 : 16;
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
  const u8 = Uint8Array.from(board);
  const opp = oppOf(color);
  const forbiddenMap = color === BLACK ? computeForbiddenMap(u8) : null;
  const oppForbiddenMap = opp === BLACK ? computeForbiddenMap(u8) : null;
  const active = getActiveCandidates(u8);
  const allowedSet = options.allowedMoves
    ? new Set(options.allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const ranked = [];
  for (let i = 0; i < active.length; i++) {
    const idx = active[i];
    if (allowedSet && !allowedSet.has(idx)) continue;
    if (forbiddenMap && forbiddenMap[idx] !== 0) continue;

    const my = evaluatePointDirs(u8, idx, color);
    const opForb = oppForbiddenMap && oppForbiddenMap[idx] !== 0;
    const op = opForb
      ? { fives: 0, openFours: 0, sleepFours: 0, openThrees: 0, sleepThrees: 0, openTwos: 0, sleepTwos: 0, combo: COMBO.NONE }
      : evaluatePointDirs(u8, idx, opp);

    let score = POS_SCORE[idx];
    if (my.fives > 0) score += 1e9;
    if (op.fives > 0) score += 1e8;
    if (my.openFours > 0 || (color === WHITE && my.combo === COMBO.DOUBLE_FOUR)) score += 2e6;
    if (op.openFours > 0 || (opp === WHITE && op.combo === COMBO.DOUBLE_FOUR)) score += 9e5;
    if (my.combo === COMBO.FOUR_THREE) score += 6e5;
    if (op.combo === COMBO.FOUR_THREE) score += 3e5;
    if (color === WHITE && my.combo === COMBO.DOUBLE_THREE) score += 1.5e5;
    if (opp === WHITE && op.combo === COMBO.DOUBLE_THREE) score += 8e4;

    score += my.sleepFours * 6500 + my.openThrees * 2800 + my.sleepThrees * 360 + my.openTwos * 280 + my.sleepTwos * 48;
    score += op.sleepFours * 4200 + op.openThrees * 2300 + op.sleepThrees * 260 + op.openTwos * 210 + op.sleepTwos * 36;

    // White forbidden-trap bonus
    if (color === WHITE && my.sleepFours > 0) {
      u8[idx] = WHITE;
      const comps = findFivesCreatedByMove(u8, idx, WHITE);
      if (comps.length === 1 && isBlackForbiddenMutable(u8, comps[0])) score += 5e6;
      u8[idx] = 0;
    }

    ranked.push({ row: (idx / SIZE) | 0, col: idx % SIZE, score });
  }

  if (ranked.length === 0 && allowedSet) {
    for (const idx of allowedSet) {
      if (u8[idx] !== 0) continue;
      if (forbiddenMap && forbiddenMap[idx] !== 0) continue;
      ranked.push({ row: (idx / SIZE) | 0, col: idx % SIZE, score: POS_SCORE[idx] });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
  return ranked;
}

function scoreToWinRate(score) {
  if (score >= MATE - 100) return 1;
  if (score <= -MATE + 100) return 0;
  const raw = 1 / (1 + Math.exp(-score / 1200));
  return Math.round(Math.min(0.99, Math.max(0.01, raw)) * 1000) / 1000;
}

/**
 * Fused KataGomo + Embryo + Yixin Renju Search Engine.
 * Returns { move: {row, col}, score, winRate, depth, nodes, decision, provenWin, reason }.
 */
export function searchBestMove(board, color, options = {}) {
  const timeBudgetMs = options.timeBudgetMs ?? 500;
  const maxDepth = options.maxDepth ?? 8;
  const startMs = Date.now();
  const u8 = Uint8Array.from(board);
  const opp = oppOf(color);

  const allowedMoves = options.allowedMoves ?? null;
  const allowedSet = allowedMoves
    ? new Set(allowedMoves.map((m) => m.row * SIZE + m.col))
    : null;

  const isAllowed = (idx) => {
    if (u8[idx] !== 0) return false;
    if (allowedSet && !allowedSet.has(idx)) return false;
    if (color === BLACK && isBlackForbiddenMutable(u8, idx)) return false;
    return true;
  };

  // If caller enforces a preferredMove (e.g. from book), evaluate that exact move cleanly
  if (options.preferredMove) {
    const pIdx = options.preferredMove.row * SIZE + options.preferredMove.col;
    if (isAllowed(pIdx)) {
      const staticMy = evaluatePointDirs(u8, pIdx, color);
      if (staticMy.fives > 0) {
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
      u8[pIdx] = color;
      const oppSearch = searchBestMoveInternal(u8, opp, null, Math.min(maxDepth - 1, 5), Math.min(timeBudgetMs, 250), startMs);
      u8[pIdx] = 0;
      const score = -oppSearch.score;
      return {
        move: { row: options.preferredMove.row, col: options.preferredMove.col },
        score,
        winRate: scoreToWinRate(score),
        depth: oppSearch.depth + 1,
        nodes: oppSearch.nodes + 1,
        decision: 'preferred',
        provenWin: score >= MATE - 100,
        reason: `${toCoordinate(options.preferredMove.row, options.preferredMove.col)}：重新評估指定候選點（深度 ${oppSearch.depth + 1}）。`,
      };
    }
  }

  // 1. Immediate 1-ply win
  const myFives = findFiveCompletions(u8, color);
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
  const oppFives = findFiveCompletions(u8, opp).filter(isAllowed);
  if (oppFives.length === 1) {
    const defIdx = oppFives[0];
    const mv = toCoordObj(defIdx);
    u8[defIdx] = color;
    const oppRes = searchBestMoveInternal(u8, opp, null, Math.min(maxDepth - 1, 5), Math.min(timeBudgetMs, 250), startMs);
    u8[defIdx] = 0;
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
    const ranked = rankMoves(u8, color, { allowedMoves: oppFives.map(toCoordObj) });
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
  const staticCheck = checkStaticWin(u8, color);
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

  // 4. KataGomo-style VCF Solver
  const vcf = solveVCF(u8, color, {
    maxDepth: 18,
    maxNodes: timeBudgetMs >= 150 ? 12000 : 3000,
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
      reason: `${toCoordinate(vcf.move.row, vcf.move.col)}：VCF 連續衝四算殺成功（${vcf.nodes} 節點）。`,
    };
  }

  // 5. Yixin-style SearchDefend: check if opponent has a winning VCF!
  const oppVcf = solveVCF(u8, opp, {
    maxDepth: 16,
    maxNodes: timeBudgetMs >= 150 ? 8000 : 2000,
  });

  let defenseFilterSet = null;
  if (oppVcf.win) {
    // Collect candidate refutation squares: opp threatCells + own counter-fours + active nearby
    const refutationCandidates = new Set(oppVcf.threatCells);
    const active = getActiveCandidates(u8);
    for (const idx of active) {
      if (!isAllowed(idx)) continue;
      const my = evaluatePointDirs(u8, idx, color);
      const op = evaluatePointDirs(u8, idx, opp);
      if (my.sleepFours > 0 || my.openThrees > 0 || op.sleepFours > 0 || op.openThrees > 0) {
        refutationCandidates.add(idx);
      }
    }
    const refuters = [];
    for (const idx of refutationCandidates) {
      if (!isAllowed(idx)) continue;
      u8[idx] = color;
      // If our move creates a four, defender must block it; check if opp still has VCF afterward
      const myComps = findFivesCreatedByMove(u8, idx, color);
      let refutes = false;
      if (myComps.length === 0) {
        const recheck = solveVCF(u8, opp, { maxDepth: 14, maxNodes: 2500 });
        refutes = !recheck.win;
      } else if (myComps.length === 1) {
        const oppBlock = myComps[0];
        if (opp === BLACK && isBlackForbiddenMutable(u8, oppBlock)) {
          refutes = true;
        } else {
          u8[oppBlock] = opp;
          const recheck = solveVCF(u8, opp, { maxDepth: 14, maxNodes: 2500 });
          refutes = !recheck.win;
          u8[oppBlock] = 0;
        }
      } else {
        refutes = true;
      }
      u8[idx] = 0;
      if (refutes) refuters.push(idx);
    }
    if (refuters.length > 0) {
      defenseFilterSet = new Set(refuters);
    }
  }

  // 6. Yixin-style VCT Solver (skip if we are strictly defending an opponent VCF)
  if (!defenseFilterSet && timeBudgetMs >= 100) {
    const vct = solveVCT(u8, color, {
      maxDepth: 6,
      maxNodes: timeBudgetMs >= 300 ? 3500 : 1200,
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
        reason: `${toCoordinate(vct.move.row, vct.move.col)}：VCT 連續威脅算殺成功。`,
      };
    }
  }

  // 7. Iterative Deepening PVS Search (Embryo + Yixin fusion)
  const searchAllowed = defenseFilterSet ?? allowedSet;
  const searchRes = searchBestMoveInternal(u8, color, searchAllowed, maxDepth, timeBudgetMs, startMs);

  let bestIdx = searchRes.bestMove;
  if (bestIdx === -1 || !isAllowed(bestIdx)) {
    const fallback = rankMoves(u8, color, { allowedMoves });
    if (fallback.length === 0) {
      throw new Error('沒有可落子的合法位置。');
    }
    bestIdx = fallback[0].row * SIZE + fallback[0].col;
  }

  const mv = toCoordObj(bestIdx);
  const winRate = scoreToWinRate(searchRes.score);
  const tag = defenseFilterSet ? 'SearchDefend 反制對手連續衝四' : `混合引擎深度 ${searchRes.depth} 搜尋`;
  return {
    move: mv,
    score: searchRes.score,
    winRate,
    depth: searchRes.depth,
    nodes: searchRes.nodes,
    decision: defenseFilterSet ? 'search-defend' : 'search',
    provenWin: searchRes.score >= MATE - 100,
    reason: `${toCoordinate(mv.row, mv.col)}：${tag}（評估 ${searchRes.score}，節點 ${searchRes.nodes}）。`,
  };
}

function searchBestMoveInternal(u8, rootColor, allowedSet, maxDepth, timeBudgetMs, startMs) {
  currentGen = (currentGen + 1) & 0xffff || 1;
  const killer1 = new Int16Array(64).fill(-1);
  const killer2 = new Int16Array(64).fill(-1);
  const history = new Int32Array(AREA);
  const hash = computeHash(u8, rootColor);

  let nodes = 0;
  let timedOut = false;

  const rootMoves = generateOrderedMoves(u8, rootColor, -1, -1, -1, history, allowedSet);
  if (rootMoves.length === 0) {
    return { bestMove: -1, score: 0, depth: 0, nodes: 0 };
  }
  if (rootMoves.length === 1) {
    u8[rootMoves[0]] = rootColor;
    const val = -evaluateBoard(u8, oppOf(rootColor));
    u8[rootMoves[0]] = 0;
    return { bestMove: rootMoves[0], score: val, depth: 1, nodes: 1 };
  }

  let completedBest = rootMoves[0];
  let completedScore = 0;
  let completedDepth = 1;

  function pvs(depth, ply, alpha, beta, color, hHi, hLo, allowNull) {
    if ((nodes & 255) === 0 && Date.now() - startMs >= timeBudgetMs) {
      timedOut = true;
      return 0;
    }
    nodes++;

    if (ply > 0) {
      const staticWin = checkStaticWin(u8, color);
      if (staticWin) {
        return staticWin.score > 0 ? staticWin.score - ply : staticWin.score + ply;
      }
    }

    if (depth <= 0 || ply >= 48) {
      return evaluateBoard(u8, color);
    }

    const opp = oppOf(color);
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

    const oppFives = findFiveCompletions(u8, opp);
    const inThreat = oppFives.length > 0;

    // Null-move pruning when not under immediate threat and depth >= 3
    if (allowNull && ply > 0 && depth >= 3 && !inThreat && beta < MATE - 500) {
      const staticEval = evaluateBoard(u8, color);
      if (staticEval >= beta) {
        const nullScore = -pvs(depth - 3, ply + 1, -beta, -beta + 1, opp, (hHi ^ SIDE_HI) >>> 0, (hLo ^ SIDE_LO) >>> 0, false);
        if (timedOut) return 0;
        if (nullScore >= beta) return beta;
      }
    }

    const moves = generateOrderedMoves(
      u8,
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

    for (let i = 0; i < moves.length; i++) {
      const idx = moves[i];
      const info = evaluatePointDirs(u8, idx, color);
      if (info.fives > 0) {
        bestMove = idx;
        bestScore = MATE - ply;
        break;
      }

      // Check-like extension when giving a 4-threat or facing a single evasion
      const ext = (info.sleepFours > 0 || (inThreat && moves.length === 1)) && ply < 14 ? 1 : 0;
      const nextDepth = depth - 1 + ext;

      u8[idx] = color;
      const nHi = (hHi ^ ZOB_HI[color][idx] ^ SIDE_HI) >>> 0;
      const nLo = (hLo ^ ZOB_LO[color][idx] ^ SIDE_LO) >>> 0;

      let score;
      if (i === 0) {
        score = -pvs(nextDepth, ply + 1, -beta, -alpha, opp, nHi, nLo, true);
      } else {
        // Late Move Reduction (LMR) for quiet later moves
        let reduction = 0;
        if (i >= 4 && depth >= 3 && ext === 0 && info.openThrees === 0 && !inThreat) {
          reduction = i >= 8 ? 2 : 1;
        }
        score = -pvs(Math.max(0, nextDepth - reduction), ply + 1, -alpha - 1, -alpha, opp, nHi, nLo, true);
        if (!timedOut && reduction > 0 && score > alpha) {
          score = -pvs(nextDepth, ply + 1, -alpha - 1, -alpha, opp, nHi, nLo, true);
        }
        if (!timedOut && score > alpha && score < beta) {
          score = -pvs(nextDepth, ply + 1, -beta, -alpha, opp, nHi, nLo, true);
        }
      }

      u8[idx] = 0;
      if (timedOut) return 0;

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

    ttGen[slot] = currentGen;
    ttHi[slot] = hHi;
    ttLo[slot] = hLo;
    ttDepth[slot] = depth;
    ttBest[slot] = bestMove;
    ttScore[slot] = bestScore;
    ttFlag[slot] = bestScore <= origAlpha ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;

    return bestScore;
  }

  // Iterative deepening with aspiration windows (Yixin style)
  for (let depth = 2; depth <= maxDepth; depth++) {
    let alpha = -MATE;
    let beta = MATE;
    if (depth >= 4 && Math.abs(completedScore) < MATE - 500) {
      alpha = completedScore - 180;
      beta = completedScore + 180;
    }

    let score = pvs(depth, 0, alpha, beta, rootColor, hash.hi, hash.lo, true);
    if (!timedOut && (score <= alpha || score >= beta)) {
      score = pvs(depth, 0, -MATE, MATE, rootColor, hash.hi, hash.lo, true);
    }
    if (timedOut) break;

    const rootSlot = (hash.hi ^ hash.lo) & TT_MASK;
    if (ttGen[rootSlot] === currentGen && ttHi[rootSlot] === hash.hi && ttLo[rootSlot] === hash.lo && ttBest[rootSlot] >= 0) {
      completedBest = ttBest[rootSlot];
    }
    completedScore = score;
    completedDepth = depth;
    if (Math.abs(score) >= MATE - 50) break;
    if (Date.now() - startMs >= timeBudgetMs * 0.75) break;
  }

  return { bestMove: completedBest, score: completedScore, depth: completedDepth, nodes };
}

/**
 * Yixin BALANCE-inspired 5th-move pair selection:
 * Picks two non-equivalent Black 5th moves that are strong and well-balanced.
 */
export function chooseBalancedFifths(board, equivalentFn) {
  const ranked = rankMoves(board, BLACK);
  if (ranked.length < 2) throw new Error('找不到兩個不等價的第五手。');
  const first = { row: ranked[0].row, col: ranked[0].col };
  const secondCandidate = ranked.find((m) => !equivalentFn(board, first, m));
  if (!secondCandidate) throw new Error('找不到兩個不等價的第五手。');
  return [first, { row: secondCandidate.row, col: secondCandidate.col }];
}

/**
 * Evaluates each 5th-move candidate by placing it as Black and running a short White search,
 * returning the candidate index (0 or 1) most favorable to White.
 */
export function chooseBestFifthIndex(board, candidates) {
  const u8 = Uint8Array.from(board);
  const scores = candidates.map(({ row, col }) => {
    const idx = row * SIZE + col;
    u8[idx] = BLACK;
    const res = searchBestMoveInternal(u8, WHITE, null, 3, 25, Date.now());
    u8[idx] = 0;
    return res.score; // Higher White score is better for White
  });
  return scores[0] >= scores[1] ? 0 : 1;
}
