import { BLACK, WHITE, analyzeMove, getLegalMoves } from './rules.mjs';
import { estimatedBlackProbability } from './openings.mjs';
import { equivalentFifths } from './game.mjs';

export function computerShouldSwap(opening) { return estimatedBlackProbability(opening)>.5; }

const axes = [[0,1],[1,0],[1,1],[1,-1]];
function patternScore(board,row,col,color) {
  let score=0;
  for (const [dr,dc] of axes) {
    let count=1,open=0;
    for (const sign of [-1,1]) {
      let r=row+dr*sign,c=col+dc*sign;
      while (r>=0&&r<15&&c>=0&&c<15&&board[r*15+c]===color) { count++;r+=dr*sign;c+=dc*sign; }
      if (r>=0&&r<15&&c>=0&&c<15&&!board[r*15+c]) open++;
    }
    if (count>=5) score+=1000000;
    else score+=([0,2,14,140,1800][count]??0)*(open===2?4:open===1?1:0);
  }
  return score;
}

export function rankLocalMoves(board,color) {
  const opponent=color===BLACK?WHITE:BLACK;
  return getLegalMoves(board,color,{nearby:true}).map(move=>{
    const own=analyzeMove(board,move.row,move.col,color);
    const defense=analyzeMove(board,move.row,move.col,opponent);
    const score=(own.win?1e9:0)+(defense.legal&&defense.win?1e8:0)+
      patternScore(board,move.row,move.col,color)+patternScore(board,move.row,move.col,opponent)*.85+
      (own.fours??0)*5000+(own.threes??0)*450-
      (Math.abs(move.row-7)+Math.abs(move.col-7))*.3;
    return {...move,score};
  }).sort((a,b)=>b.score-a.score||a.row-b.row||a.col-b.col);
}

export function chooseLocalMove(board,color) {
  const move=rankLocalMoves(board,color)[0];
  if (!move) throw new Error('沒有可落子的合法位置。');
  return {row:move.row,col:move.col};
}

export function chooseLocalFifths(game) {
  const ranked=rankLocalMoves(game.board,BLACK);
  const first=ranked[0];
  const second=ranked.find(move=>!equivalentFifths(game.board,first,move));
  if (!first||!second) throw new Error('找不到兩個不等價的第五手。');
  return [first,second].map(({row,col})=>({row,col}));
}

export function chooseLocalFifth(game) {
  // White keeps the candidate with the weaker immediate black threats.
  const scores=game.fifthCandidates.map(({row,col})=>patternScore(game.board,row,col,BLACK));
  return scores[0]<=scores[1]?0:1;
}
