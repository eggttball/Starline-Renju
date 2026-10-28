import { BLACK, WHITE, analyzeMove, toCoordinate } from './lib/rules.mjs';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth, currentActor, finishDraw } from './lib/game.mjs';
import { loadArchive, saveGame, abandonGame } from './lib/persistence.mjs';
import { OPENINGS, mergeOpeningRates, selectComputerOpening, rateDescription } from './lib/openings.mjs';
import { chooseLocalMove, computerShouldSwap, chooseLocalFifths, chooseLocalFifth } from './lib/local-ai.mjs';

const colorName = color => color===BLACK?'黑':'白';
const phases = {
  setup:['提出三子開局','暫定黑方從 26 種標準局型提出開局。'],
  swap:['選擇交換或保持','暫定白方可改持黑棋，或繼續持白。'],
  fourth:['白方下第四手','顏色已確定，請白方選擇第四手。'],
  'offer-fifth':['黑方提出兩個第五手','在棋盤上依序選兩點，兩點不可對稱等價。'],
  'choose-fifth':['白方選擇第五手','保留 A 或 B 黑子，接著由白方下第六手。'],
  playing:['正式對局','黑方精確五連、白方五連以上獲勝。'],
};

export function mountApp(doc,{fetchImpl,delay=350,storage}={}) {
  const win=doc.defaultView;
  const request=fetchImpl??win.fetch.bind(win);
  const $=id=>doc.getElementById(id);
  let game=createGame('white'),selectedMode='white',selectedOpening='d3',openings=OPENINGS.map(o=>({...o}));
  let started=false,busy=false,api={configured:false},apiLoaded=false,agentError=false,message='',isError=false,generation=0,controller=null,destroyed=false;
  let focusedIndex=112,configReady,openingReady;
  let browserStorage,archive={active:null,history:[]};
  try {
    browserStorage=storage??win.localStorage;
    archive=loadArchive(browserStorage);
    if (archive.active) {game=archive.active;started=true;selectedMode=game.mode;selectedOpening=game.openingId??game.selectedOpeningId??'d3';message='已自動載入未完成的賽局，從上一手繼續。';}
    if (archive.warnings?.length) {message=archive.warnings.join(' ');isError=true;}
  } catch(error) {message=`無法讀取瀏覽器賽局：${error.message}`;isError=true;}
  const timers=new Set();
  const sleep=ms=>new Promise(resolve=>{const timer=win.setTimeout(()=>{timers.delete(timer);resolve();},ms);timers.add(timer);});

  doc.querySelector('.axis-top').innerHTML=Array.from({length:15},(_,i)=>`<span>${String.fromCharCode(65+i)}</span>`).join('');
  doc.querySelector('.axis-left').innerHTML=Array.from({length:15},(_,i)=>`<span>${15-i}</span>`).join('');
  $('board-lines').innerHTML=Array.from({length:15},(_,i)=>`<line class="${i===0||i===14?'edge':''}" x1="16" y1="${16+i*32}" x2="464" y2="${16+i*32}"/><line class="${i===0||i===14?'edge':''}" x1="${16+i*32}" y1="16" x2="${16+i*32}" y2="464"/>`).join('')+[[3,3],[3,11],[7,7],[11,3],[11,11]].map(([r,c])=>`<circle cx="${16+c*32}" cy="${16+r*32}" r="3"/>`).join('');
  const cells=Array.from({length:225},(_,index)=>{
    const cell=doc.createElement('button');
    cell.className='cell empty';cell.type='button';cell.dataset.index=index;cell.tabIndex=index===112?0:-1;
    const row=Math.floor(index/15),col=index%15;
    cell.addEventListener('click',()=>handleBoard(row,col));
    cell.addEventListener('mouseenter',()=>hover(row,col));
    cell.addEventListener('focus',()=>{focusedIndex=index;cells.forEach((c,i)=>c.tabIndex=i===index?0:-1);hover(row,col);});
    cell.addEventListener('keydown',event=>{
      let target=index;
      if (event.key==='ArrowLeft') target=row*15+Math.max(0,col-1);
      else if (event.key==='ArrowRight') target=row*15+Math.min(14,col+1);
      else if (event.key==='ArrowUp') target=Math.max(0,row-1)*15+col;
      else if (event.key==='ArrowDown') target=Math.min(14,row+1)*15+col;
      else return;
      event.preventDefault();cells[target].focus();
    });
    $('board-cells').append(cell);return cell;
  });
  $('board').addEventListener('mouseleave',()=>{$('hover-info').textContent='黑棋禁手：三三・四四・長連';});
  for (const category of ['direct','indirect']) {
    const group=doc.createElement('optgroup');group.label=category==='direct'?'直指開局 · 13 種':'斜指開局 · 13 種';
    OPENINGS.filter(o=>o.category===category).forEach(o=>{const option=doc.createElement('option');option.value=o.id;option.textContent=`${o.name} · ${o.id.toUpperCase()}`;group.append(option);});
    $('opening-select').append(group);
  }

  function currentOpening() { return openings.find(o=>o.id===(game.openingId??selectedOpening))??openings[2]; }
  function actorLabel(actor) { return {human:'你',computer:'電腦',player1:'玩家一',player2:'玩家二'}[actor]??actor; }
  function isHumanTurn() { return started&&!busy&&currentActor(game)!=='computer'&&game.phase!=='finished'; }
  function canPlace() { return isHumanTurn()&&['fourth','offer-fifth','choose-fifth','playing'].includes(game.phase); }
  function persist(next) {archive=saveGame(browserStorage,next);return next;}
  function resultLabel(record) {
    if (record.result?.reason==='forbidden') return `黑方禁手敗 · ${{overline:'長連','double-four':'四四','double-three':'三三'}[record.result.forbiddenKind]??'禁手'}`;
    if (!record.result?.winner) return '雙方和棋';
    return record.result.winner===BLACK?'黑方連五勝':record.result.winningLine?.length>5?'白方長連勝':'白方連五勝';
  }
  function dateLabel(record) {return new Date(record.updatedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
  function renderArchive() {
    $('archive-count').textContent=`${archive.history.length} 局`;
    $('archive-list').replaceChildren();
    if (!archive.history.length) {const p=doc.createElement('p');p.className='empty-archive';p.textContent='尚無完成的賽局。未完成的對局會自動續接。';$('archive-list').append(p);}
    for (const record of archive.history) {
      const button=doc.createElement('button');button.type='button';button.className='archive-card';
      const name=doc.createElement('strong');name.textContent=OPENINGS.find(o=>o.id===record.openingId)?.name??'連珠對局';
      const result=doc.createElement('span');result.className='archive-result';result.textContent=resultLabel(record);
      const meta=doc.createElement('span');meta.className='archive-meta';meta.textContent=`${dateLabel(record)} · ${record.moves.length} 手 · ${record.mode==='both'?'雙人':'人機'}`;
      button.append(name,result,meta);button.addEventListener('click',()=>showArchive(record));$('archive-list').append(button);
    }
  }

  function renderOpening() {
    const opening=currentOpening();
    $('opening-select').value=opening.id;
    $('opening-select').disabled=started&&(game.phase!=='setup'||currentActor(game)==='computer');
    $('opening-name').textContent=opening.name;
    $('opening-category').textContent=opening.category==='direct'?'DIRECT / 直指':'INDIRECT / 斜指';
    $('opening-rate').textContent=rateDescription(opening);
    const source=$('opening-source');
    let safeSource='https://www.renju.net/openings/';
    try {const url=new URL(opening.source);if (['https:','http:'].includes(url.protocol)) safeSource=url.href;} catch {}
    source.href=safeSource;
    $('mini-board').replaceChildren();
    for (let row=0;row<5;row++) for (let col=0;col<5;col++) {
      const cell=doc.createElement('div');cell.className='mini-cell';
      const i=opening.stones.findIndex(m=>m.row===row+5&&m.col===col+5);
      if (i>=0) {const stone=doc.createElement('span');stone.className=`stone ${opening.stones[i].color===BLACK?'black':'white'}`;stone.textContent=i+1;cell.append(stone);}
      $('mini-board').append(cell);
    }
    $('opening-caption').textContent=typeof opening.blackWinRate==='number'?`已考慮交換：電腦以 min(p, 1−p) 評估提案。${opening.rateKind==='theoretical'?'理論結果不等同實測勝率。':''}`:'未收錄可靠實測勝率。電腦參考有來源的歷史均衡局型。';
  }

  function addAction(label,action) {
    const button=doc.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',action);$('phase-actions').append(button);
  }

  function render() {
    if (destroyed) return;
    doc.querySelectorAll('[data-mode]').forEach(button=>{const active=button.dataset.mode===selectedMode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.disabled=started&&game.phase!=='finished';});
    $('start-button').hidden=started;
    $('players').hidden=!started;
    $('black-player').textContent=`黑方 · ${actorLabel(game.players[BLACK])}`;
    $('white-player').textContent=`白方 · ${actorLabel(game.players[WHITE])}`;
    $('turn-stone').className=`turn-dot ${game.turn===BLACK?'black':'white'}`;
    $('move-counter').innerHTML=`第 <b>${String(game.moves.length).padStart(2,'0')}</b> 手`;
    if (!started) {$('turn-title').textContent='準備開局';$('turn-subtitle').textContent='選擇持棋方式，開始一局連珠';}
    else if (game.phase==='finished') {
      $('turn-title').textContent=game.result.winner?`${colorName(game.result.winner)}方勝利`:'和棋';
      $('turn-subtitle').textContent=game.result.reason==='forbidden'?resultLabel(game):game.result.reason==='agreement'?'雙方同意和棋。':'本局結束，已加入歷史賽局。';
    } else {
      $('turn-title').textContent=`${colorName(game.turn)}方 · ${actorLabel(currentActor(game))}${busy?'思考中':''}`;
      $('turn-subtitle').textContent=phases[game.phase][0];
    }
    const last=game.moves.at(-1),numbers=$('show-numbers').checked;
    const winning=new Set((game.result?.winningLine??[]).map(m=>m.row*15+m.col));
    const forbiddenIndex=game.result?.reason==='forbidden'?game.result.attemptedMove.row*15+game.result.attemptedMove.col:-1;
    const moveNumbers=new Map(game.moves.map(m=>[m.row*15+m.col,m.number]));
    cells.forEach((cell,index)=>{
      const row=Math.floor(index/15),col=index%15,color=game.board[index];
      const candidate=game.fifthCandidates.findIndex(p=>p.row===row&&p.col===col);
      cell.className=`cell ${color?'occupied':'empty'}${winning.has(index)?' winning':''}${index===forbiddenIndex?' forbidden':''}`;
      cell.setAttribute('aria-label',`${toCoordinate(row,col)}${color?`，${colorName(color)}棋，第 ${moveNumbers.get(index)} 手`:candidate>=0?`，第五手候選 ${candidate===0?'A':'B'}`:'，空位'}`);
      cell.tabIndex=index===focusedIndex?0:-1;
      if (color) cell.innerHTML=`<span class="stone ${color===BLACK?'black':'white'}${last?.row===row&&last?.col===col?' last':''}">${numbers?moveNumbers.get(index):''}</span>`;
      else if (candidate>=0) cell.innerHTML=`<span class="stone candidate">${candidate===0?'A':'B'}</span>`;
      else cell.innerHTML=`<span class="stone ghost ${game.turn===BLACK?'black':'white'}"></span>`;
    });
    $('board').classList.toggle('interactive',canPlace());
    $('phase-actions').replaceChildren();
    if (isHumanTurn()) {
      if (game.phase==='setup') addAction(`提出 ${currentOpening().name} 三子開局`,()=>act(g=>proposeOpening(g,selectedOpening),'三子開局已提出，交由暫定白方決定是否交換。'));
      if (game.phase==='swap') {
        addAction(game.mode==='both'?'交換雙方顏色':'交換 · 改持黑',()=>act(g=>decideSwap(g,true),'已交換持棋方；由確定白方下第四手。'));
        addAction(game.mode==='both'?'保持雙方顏色':'保持 · 繼續持白',()=>act(g=>decideSwap(g,false),'保持原持棋方；由白方下第四手。'));
      }
      if (game.phase==='choose-fifth') game.fifthCandidates.forEach((p,i)=>addAction(`保留 ${i===0?'A':'B'} · ${toCoordinate(p.row,p.col)}`,()=>act(g=>chooseFifth(g,i),'第五手已確定，現在由白方下第六手。')));
      if (game.phase==='offer-fifth'&&game.fifthCandidates.length) addAction('重新選擇第五手',()=>act(g=>({...g,fifthCandidates:[]}),'請重新提出兩個不等價的第五手。'));
    }
    const phaseIndex={setup:0,swap:1,fourth:2,'offer-fifth':3,'choose-fifth':3,playing:4,finished:5}[game.phase];
    [...$('opening-progress').children].forEach((step,i)=>{step.classList.toggle('current',started&&i===phaseIndex);step.classList.toggle('done',started&&i<phaseIndex);});
    $('game-message').textContent=message||(started?(game.phase==='finished'?`${resultLabel(game)}。本局已記錄到歷史賽局。`:phases[game.phase][1]):'選擇模式後點「開始對局」。棋盤可用方向鍵移動、Enter 落子。');
    $('game-message').classList.toggle('error',isError);
    const inactive=!started||game.phase==='setup'||game.phase==='finished';
    $('resign-button').disabled=!started||game.phase==='finished';
    $('draw-button').disabled=inactive||busy;
    $('new-game').disabled=started&&game.phase!=='finished';
    $('save-status').textContent=started?(game.phase==='finished'?'本局已保存於歷史賽局。':'已自動保存 · 關閉網頁或重開電腦後可續局。'):'開始後自動保存，關閉網頁也能續局。';
    $('export-button').disabled=!game.moves.length;
    $('agent-indicator').className=`status-light${agentError?' error':busy?' thinking':api.configured?' connected':''}`;
    $('agent-title').textContent=agentError?`${colorName(game.turn)}棋 AI 對局已暫停`:busy&&game.phase==='playing'&&(game.turn===BLACK||game.moves.length>=7)?`${colorName(game.turn)}棋 AI 正在思考`:!apiLoaded?'正在讀取 API 設定':api.configured?'黑棋 AI 已設定':'黑棋 AI 尚未設定';
    $('agent-detail').textContent=agentError?'保留目前盤面，設定或修復 API 後可重試。':api.configured?'黑白正式對局皆由 AI 評估；記憶會依最新勝率更新。':'未設定時白棋使用本地戰術；黑棋等待 API。';
    $('white-mode-info').textContent=api.configured?'黑白電腦棋手透過 AI 評估；勝率棋譜會持續更新。':'白棋使用本地戰術運算；黑棋正式對局透過 API。';
    $('retry-button').hidden=!agentError;
    $('retry-button').disabled=busy;
    $('move-history').replaceChildren();
    if (!game.moves.length) {const p=doc.createElement('p');p.className='empty-history';p.textContent='落下第一子，故事便開始。';$('move-history').append(p);}
    for (const move of game.moves) {
      const item=doc.createElement('div');item.className='history-move';
      item.innerHTML=`<small>${String(move.number).padStart(2,'0')}</small><span class="option-stone ${move.color===BLACK?'black':'white'}"></span><span>${toCoordinate(move.row,move.col)}</span>`;
      $('move-history').append(item);
    }
    $('move-history').scrollTop=$('move-history').scrollHeight;
    renderOpening();renderArchive();
  }

  function hover(row,col) {
    const index=row*15+col;
    if (game.board[index]) {$('hover-info').textContent=`${toCoordinate(row,col)} · ${colorName(game.board[index])}棋`;return;}
    $('hover-info').textContent=toCoordinate(row,col);
    if (!canPlace()||game.phase==='choose-fifth') return;
    const verdict=analyzeMove(game.board,row,col,game.turn);
    if (!verdict.legal) {cells[index].innerHTML='<span class="forbidden-preview">×</span>';$('hover-info').textContent=`${toCoordinate(row,col)} · ${verdict.reason}`;}
  }

  function act(change,note='') {
    try {game=persist(change(game));message=note;isError=false;agentError=false;render();void driveComputer();}
    catch (error) {message=error.message;isError=true;render();}
  }

  function handleBoard(row,col) {
    if (!canPlace()) return;
    if (game.phase==='offer-fifth') act(g=>offerFifth(g,row,col),game.fifthCandidates.length?'兩個第五手已提出，交由白方選擇。':'已標記 A；請再提出一個不等價的 B。');
    else if (game.phase==='choose-fifth') {const i=game.fifthCandidates.findIndex(p=>p.row===row&&p.col===col);if (i>=0) act(g=>chooseFifth(g,i),'第五手已保留，請白方下第六手。');}
    else act(g=>placeStone(g,row,col));
  }

  async function driveComputer() {
    if (destroyed||!started||busy||agentError||currentActor(game)!=='computer'||game.phase==='finished') return;
    const epoch=generation;
    busy=true;render();
    try {
      await sleep(delay);
      if (destroyed||epoch!==generation) return;
      if (game.phase==='setup'||game.phase==='swap') await openingReady;
      if (destroyed||epoch!==generation) return;
      let next,note='';
      if (game.phase==='setup') {
        const opening=selectComputerOpening(openings);selectedOpening=opening.id;next=proposeOpening(game,opening.id);note=`電腦提出 ${opening.name}。你可以交換改持黑棋，或繼續持白。`;
      } else if (game.phase==='swap') {
        const swap=computerShouldSwap(currentOpening());next=decideSwap(game,swap);note=swap?'電腦選擇交換並改持黑棋；你改持白棋，下第四手。':'電腦保持白棋，接著下第四手。';
      } else if (game.phase==='offer-fifth') {
        const pair=chooseLocalFifths(game);next=offerFifth(offerFifth(game,pair[0].row,pair[0].col),pair[1].row,pair[1].col);note='電腦提出 A、B 兩個第五手，請選擇要保留的黑子。';
      } else if (game.phase==='choose-fifth') {next=chooseFifth(game,chooseLocalFifth(game));note='電腦已選定第五手，接著下白棋第六手。';}
      else if (game.phase==='playing'&&(game.turn===BLACK||game.moves.length>=7)) {
        if (!apiLoaded) await configReady;
        if (destroyed||epoch!==generation) return;
        if (game.turn===BLACK&&!api.configured) throw new Error('尚未設定黑棋 AI。請在 renju/.env 填入 API endpoint 與 key，重新啟動伺服器後點「重新詢問 AI」。');
        controller=new AbortController();
        const response=await request(game.turn===BLACK?'/api/agent':'/api/white',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({board:game.board,moves:game.moves}),signal:controller.signal});
        const data=await response.json();
        if (destroyed||epoch!==generation) return;
        if (!response.ok) throw new Error(data.error?.message??'AI 服務暫時無法回應。');
        if (!data.move||!Number.isInteger(data.move.row)||!Number.isInteger(data.move.col)) throw new Error('AI 回應缺少有效落點，請重試。');
        const verdict=analyzeMove(game.board,data.move.row,data.move.col,game.turn);
        if (!verdict.legal) throw new Error(verdict.reason);
        next=placeStone(game,data.move.row,data.move.col);note=data.reason?`AI：${String(data.reason).slice(0,500)}`:`AI 選擇 ${toCoordinate(data.move.row,data.move.col)}。`;
      } else {
        const move=chooseLocalMove(game.board,game.turn);next=placeStone(game,move.row,move.col);note=`電腦白棋落在 ${toCoordinate(move.row,move.col)}。`;
      }
      if (destroyed||epoch!==generation) return;
      game=persist(next);message=note;isError=false;
    } catch (error) {
      if (destroyed||epoch!==generation||error.name==='AbortError') return;
      message=error.message;isError=true;agentError=true;
    } finally {
      if (epoch===generation&&!destroyed) {busy=false;controller=null;render();}
    }
    if (!destroyed&&epoch===generation&&!agentError) void driveComputer();
  }

  function reset(mode=selectedMode,abandoned=false) {
    if (started&&game.phase!=='finished'&&!abandoned) {message='請先完成或放棄目前賽局，再開始新對局。';isError=true;render();return false;}
    generation++;controller?.abort();controller=null;selectedMode=mode;game=createGame(mode);started=false;busy=false;agentError=false;isError=false;message='';render();
    return true;
  }
  function start(mode=selectedMode) {if (!reset(mode)) return;try {game=persist({...game,selectedOpeningId:selectedOpening});started=true;render();void driveComputer();}catch(error){message=error.message;isError=true;render();}}
  doc.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>reset(button.dataset.mode)));
  $('start-button').addEventListener('click',()=>start());
  $('new-game').addEventListener('click',()=>reset());
  $('opening-select').addEventListener('change',()=>{const selected=$('opening-select').value;try{if(started)game=persist({...game,selectedOpeningId:selected});selectedOpening=selected;render();}catch(error){message=error.message;isError=true;render();}});
  $('show-numbers').addEventListener('change',render);
  $('retry-button').addEventListener('click',async()=>{
    if (busy) return;
    const epoch=generation;
    try {const response=await request('/api/config');if (!response.ok) throw new Error();const settings=await response.json();if (epoch!==generation||destroyed) return;api=settings;apiLoaded=true;agentError=false;isError=false;message='重新讀取設定，準備詢問 AI。';render();void driveComputer();}
    catch {if (epoch===generation&&!destroyed) {message='無法讀取伺服器設定，請確認 renju 伺服器正在執行。';isError=true;render();}}
  });
  $('resign-button').addEventListener('click',()=>{try {archive=abandonGame(browserStorage,game.id);reset(selectedMode,true);message='已放棄本局；這一局不會列入歷史紀錄。';render();}catch(error){message=error.message;isError=true;render();}});

  function showDialog(html) {$('dialog-content').innerHTML=html;const dialog=$('info-dialog');if (dialog.showModal) dialog.showModal();else dialog.setAttribute('open','');}
  function closeDialog() {const dialog=$('info-dialog');if (dialog.close) dialog.close();else dialog.removeAttribute('open');}
  function showArchive(record) {
    showDialog('<h2 id="archive-dialog-title"></h2><p id="archive-dialog-meta" class="archive-dialog-meta"></p><div id="archive-dialog-board" class="archive-board" aria-label="歷史賽局棋盤"></div><p id="archive-dialog-moves" class="archive-dialog-moves"></p><div class="dialog-buttons"><button id="export-archive">匯出這局棋譜 ↓</button></div>');
    $('archive-dialog-title').textContent=`${OPENINGS.find(o=>o.id===record.openingId)?.name??'連珠'} · ${resultLabel(record)}`;
    $('archive-dialog-meta').textContent=`${dateLabel(record)} · ${record.moves.length} 手 · 黑方 ${actorLabel(record.players[BLACK])}／白方 ${actorLabel(record.players[WHITE])}`;
    const numbers=new Map(record.moves.map(m=>[m.row*15+m.col,m.number]));
    for (let i=0;i<225;i++) {const cell=doc.createElement('div');cell.className='archive-cell';const stone=record.board[i];if (stone) {const span=doc.createElement('span');span.className=stone===BLACK?'black':'white';span.textContent=numbers.get(i);cell.append(span);}if(record.result.reason==='forbidden'&&record.result.attemptedMove?.row*15+record.result.attemptedMove?.col===i)cell.classList.add('forbidden');$('archive-dialog-board').append(cell);}
    $('archive-dialog-moves').textContent=record.moves.map(m=>`${m.number}.${colorName(m.color)} ${toCoordinate(m.row,m.col)}`).join('  ');
    $('export-archive').addEventListener('click',()=>downloadRecord(record));
  }
  $('close-dialog').addEventListener('click',closeDialog);
  $('info-dialog').addEventListener('click',event=>{if (event.target===$('info-dialog')) closeDialog();});
  $('draw-button').addEventListener('click',()=>{
    const epoch=generation;
    showDialog(`<h2>雙方同意和棋</h2><p>${game.mode==='both'?'本機對局需要另一位玩家同意。請由對手選擇是否接受和棋。':'電腦接受你的和棋提議。確認後本局以和棋結束。'}</p><div class="dialog-buttons"><button id="accept-draw">同意和棋</button><button id="decline-draw">繼續對局</button></div>`);
    $('accept-draw').addEventListener('click',()=>{closeDialog();if (epoch===generation) act(finishDraw,'雙方同意和棋，本局結束。');});
    $('decline-draw').addEventListener('click',closeDialog);
  });
  $('rules-button').addEventListener('click',()=>showDialog('<h2>國際 RIF 連珠規則</h2><p>本遊戲使用傳統 RIF 開局規則，在 15 × 15 路棋盤上對弈。</p><ol><li>暫定黑方提出一種標準三子開局：黑、白、黑。</li><li>暫定白方決定交換顏色，或保持原持棋方。</li><li>確定白方下第四手；黑方提出兩個在目前盤面下不對稱等價的第五手。</li><li>白方保留一個第五手，接著下第六手，之後黑白輪流落子。</li></ol><p>黑棋只有精確五連獲勝；三三、四四及長連為禁手，實際落下禁手即判白方勝。活三需能以合法延伸形成兩端開放的直四，假三不計。依官方 §9.2，若同手已形成精確五連則優先獲勝。白棋五連或長連皆勝。雙方也可同意和棋。</p><p>每局自動保存於瀏覽器，重開網頁會續接未完成局。正常結束保存到歷史賽局；「放棄比賽」移除本局且不列入歷史。未完成局不能直接被新局覆蓋。</p><p>棋盤支援方向鍵移動、Enter 落子。開局後角色可能交換，請查看畫面持棋方。</p><p><a href="https://www.renju.net/rifrules/" target="_blank" rel="noopener noreferrer">閱讀 RIF 官方完整規則 ↗</a></p>'));
  $('setup-button').addEventListener('click',()=>showDialog('<h2>設定黑棋 AI agent</h2><p>金鑰只放在伺服器端的 <code>renju/.env</code>，不需要填入網頁。</p><ol><li>複製 <code>.env.example</code> 為 <code>.env</code>。</li><li>填入 <code>AI_API_ENDPOINT</code>、<code>AI_API_KEY</code>、<code>AI_API_MODEL</code>。</li><li>依服務選擇 <code>AI_API_FORMAT</code>：<code>openai-chat</code>、<code>openai-responses</code> 或 <code>agent-json</code>。</li><li>重新啟動 <code>npm start</code>，再按「重新詢問 AI」。</li></ol><p>Endpoint 使用完整 API URL。回應落點為零起算 <code>{"move":{"row":7,"col":7},"reason":"..."}</code>；棋盤左上角為 row 0、col 0，中心為 row 7、col 7。</p><p>黑棋 API 回應逾時或無效會暫停並保留盤面；詳細格式與設定範例請見 <code>renju/README.md</code>。</p>'));
  function downloadRecord(record) {
    const payload={rules:'RIF classic',id:record.id,createdAt:record.createdAt,updatedAt:record.updatedAt,opening:OPENINGS.find(o=>o.id===record.openingId)?.name,mode:record.mode,players:record.players,swapped:record.swapped,result:record.result,moves:record.moves.map(m=>({...m,coordinate:toCoordinate(m.row,m.col)}))};
    const blob=new win.Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=win.URL.createObjectURL(blob),link=doc.createElement('a');link.href=url;link.download=`renju-${record.openingId??'game'}-${record.moves.length}.json`;link.click();win.URL.revokeObjectURL(url);
  }
  $('export-button').addEventListener('click',()=>downloadRecord(game));

  function loadConfiguration() {
    const configTask=Promise.resolve().then(()=>request('/api/config')).then(async response=>{
      if (!response.ok) throw new Error();return response.json();
    }).then(settings=>{if (!destroyed) {api=settings;apiLoaded=true;render();}}).catch(()=>{
      if (!destroyed) {apiLoaded=true;message='無法讀取 AI 設定。請使用 renju 伺服器開啟遊戲。';isError=true;render();}
    });
    const openingTask=Promise.resolve().then(()=>request('/api/openings')).then(async response=>{
      if (!response.ok) throw new Error();return response.json();
    }).then(data=>{if (!destroyed) {openings=mergeOpeningRates(data);render();}}).catch(()=>{if(!destroyed){message='開局資料暫時無法讀取，使用內建有來源的開局評述。';render();}});
    void Promise.allSettled([configTask,openingTask]);
    return {configTask,openingTask};
  }
  render();const loading=loadConfiguration();configReady=loading.configTask;openingReady=loading.openingTask;if(started)void driveComputer();
  return {getState:()=>game,start,reset,destroy:()=>{destroyed=true;generation++;controller?.abort();for (const timer of timers) win.clearTimeout(timer);timers.clear();}};
}

if (typeof document!=='undefined') mountApp(document);
