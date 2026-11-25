import { BLACK } from './rules.mjs';
import { estimatedBlackProbability } from './openings.mjs';
import { equivalentFifths } from './game.mjs';
import { rankMoves, searchBestMove, chooseBalancedFifths, chooseBestFifthIndex } from './engine.mjs';

export function computerShouldSwap(opening) {
  return estimatedBlackProbability(opening) > 0.5;
}

export function rankLocalMoves(board, color, options = {}) {
  return rankMoves(board, color, options);
}

export function chooseLocalMove(board, color, options = {}) {
  const result = searchBestMove(board, color, {
    timeBudgetMs: 80,
    maxDepth: 6,
    ...options,
  });
  return { row: result.move.row, col: result.move.col };
}

export function chooseLocalFifths(game) {
  return chooseBalancedFifths(game.board, equivalentFifths);
}

export function chooseLocalFifth(game) {
  return chooseBestFifthIndex(game.board, game.fifthCandidates);
}
