import { BLACK, WHITE, createBoard, analyzeMove } from './rules.mjs';
import { OPENINGS } from './openings.mjs';

export function createGame(mode='white') {
  if (!['black','white','both'].includes(mode)) throw new Error('請選擇持黑、持白或雙人模式。');
  const timestamp = new Date().toISOString();
  const id = typeof globalThis.crypto?.randomUUID==='function'
    ? globalThis.crypto.randomUUID()
    : `renju-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    id,createdAt:timestamp,updatedAt:timestamp,
    mode,board:createBoard(),moves:[],phase:'setup',turn:BLACK,
    players:mode==='both'?{1:'player1',2:'player2'}:mode==='black'?{1:'human',2:'computer'}:{1:'computer',2:'human'},
    openingId:null,fifthCandidates:[],swapped:false,result:null,
  };
}

function transition(game,changes) {
  return {...game,...changes,updatedAt:new Date().toISOString()};
}

export function currentActor(game) { return game.players[game.turn]; }

export function proposeOpening(game,id) {
  if (game.phase!=='setup') throw new Error('開局已提出，請開始新對局再選擇。');
  const opening = OPENINGS.find(o=>o.id===id);
  if (!opening) throw new Error('請選擇標準 RIF 開局。');
  const board = createBoard();
  const moves = opening.stones.map((stone,index)=>({...stone,number:index+1}));
  for (const m of moves) board[m.row*15+m.col]=m.color;
  return transition(game,{board,moves,openingId:id,phase:'swap',turn:WHITE});
}

export function decideSwap(game,swap) {
  if (game.phase!=='swap') throw new Error('目前不是交換階段。');
  if (typeof swap!=='boolean') throw new Error('請決定交換或保持。');
  return transition(game,{players:swap?{1:game.players[2],2:game.players[1]}:{...game.players},swapped:swap,phase:'fourth',turn:WHITE});
}

function addStone(game,row,col,color,finishOnForbidden=false) {
  const analysis = analyzeMove(game.board,row,col,color);
  const forbidden = finishOnForbidden && color===BLACK && !analysis.legal
    && ['overline','double-four','double-three'].includes(analysis.kind);
  if (!analysis.legal && !forbidden) throw new Error(analysis.reason);
  const board = [...game.board];
  board[row*15+col]=color;
  const moves = [...game.moves,{row,col,color,number:game.moves.length+1}];
  const result = forbidden
    ? {winner:WHITE,reason:'forbidden',forbiddenKind:analysis.kind,attemptedMove:{row,col},winningLine:[]}
    : analysis.win?{winner:color,reason:'five',winningLine:analysis.winningLine}:moves.length===225?{winner:null,reason:'full-board',winningLine:[]}:null;
  return {...game,board,moves,result};
}

export function placeStone(game,row,col) {
  if (!['fourth','playing'].includes(game.phase)) throw new Error('請先完成目前的 RIF 開局步驟。');
  const next = addStone(game,row,col,game.turn,game.phase==='playing');
  if (next.result) return transition(next,{phase:'finished'});
  if (game.phase==='fourth') return transition(next,{phase:'offer-fifth',turn:BLACK,fifthCandidates:[]});
  return transition(next,{turn:game.turn===BLACK?WHITE:BLACK});
}

function transform(row,col,index) {
  let r=row-7,c=col-7;
  if (index>=4) c=-c;
  for (let n=0;n<index%4;n++) [r,c]=[c,-r];
  return {row:r+7,col:c+7};
}

export function equivalentFifths(board,a,b) {
  for (let symmetry=0;symmetry<8;symmetry++) {
    const target = transform(a.row,a.col,symmetry);
    if (target.row!==b.row||target.col!==b.col) continue;
    let preserves = true;
    for (let index=0;index<225;index++) {
      if (!board[index]) continue;
      const moved = transform(Math.floor(index/15),index%15,symmetry);
      if (board[moved.row*15+moved.col]!==board[index]) {preserves=false;break;}
    }
    if (preserves) return true;
  }
  return false;
}

export function offerFifth(game,row,col) {
  if (game.phase!=='offer-fifth') throw new Error('目前不是提出第五手的階段。');
  if (game.fifthCandidates.some(p=>p.row===row&&p.col===col)) throw new Error('請提出兩個不同的第五手，不能重複。');
  const analysis = analyzeMove(game.board,row,col,BLACK);
  if (!analysis.legal) throw new Error(analysis.reason);
  const candidate = {row,col};
  if (game.fifthCandidates.some(p=>equivalentFifths(game.board,p,candidate))) throw new Error('兩個第五手在目前盤面下對稱等價，請選另一點。');
  const fifthCandidates = [...game.fifthCandidates,candidate];
  return transition(game,{fifthCandidates,phase:fifthCandidates.length===2?'choose-fifth':'offer-fifth',turn:fifthCandidates.length===2?WHITE:BLACK});
}

export function chooseFifth(game,index) {
  if (game.phase!=='choose-fifth'||!Number.isInteger(index)||index<0||index>1) throw new Error('請選擇 A 或 B 第五手。');
  const {row,col} = game.fifthCandidates[index];
  const next = addStone(game,row,col,BLACK);
  return transition(next,{phase:'playing',turn:WHITE,fifthCandidates:[]});
}

export function resignGame(game,color=game.turn) {
  if (['setup','finished'].includes(game.phase)||![BLACK,WHITE].includes(color)) throw new Error('目前無法認輸。');
  return transition(game,{phase:'finished',result:{winner:color===BLACK?WHITE:BLACK,reason:'resignation',winningLine:[]}});
}

export function finishDraw(game) {
  if (['setup','finished'].includes(game.phase)) throw new Error('目前無法和棋。');
  return transition(game,{phase:'finished',result:{winner:null,reason:'agreement',winningLine:[]}});
}
