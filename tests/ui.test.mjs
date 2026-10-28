import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountApp } from '../app.mjs';
import { loadArchive, saveGame } from '../lib/persistence.mjs';
import { createGame, proposeOpening, decideSwap, placeStone, offerFifth, chooseFifth } from '../lib/game.mjs';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
async function waitUntil(predicate) {
  for (let n=0;n<200;n++) {if (predicate()) return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('UI state did not reach expected condition');
}
function boot(t,{configured=false,agent,storage}={}) {
  const dom=new JSDOM(html,{url:'http://127.0.0.1:3000',pretendToBeVisual:true});
  const calls=[];
  const settings={configured};
  const fetchImpl=async(url,options)=>{
    if (url==='/api/config') return Response.json({...settings,format:'agent-json'});
    if (url==='/api/openings') return Response.json({openings:[]});
    if (url==='/api/agent') {calls.push(options);return agent?agent(options):Response.json({move:{row:14,col:14},reason:'選擇安全落點'});}
    if (url==='/api/white') return Response.json({move:{row:14,col:13},reason:'本地白棋戰術'});
    throw new Error('Unexpected route');
  };
  const app=mountApp(dom.window.document,{fetchImpl,delay:0,storage});
  t.after(()=>{app.destroy();dom.window.close();});
  const doc=dom.window.document;
  const clickText=text=>{const button=[...doc.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(button,`missing ${text}`);button.click();};
  const play=(row,col)=>doc.querySelector(`[data-index="${row*15+col}"]`).click();
  return {app,doc,dom,calls,settings,clickText,play};
}

test('ready API configuration is displayed without waiting for slow opening data', async t=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:3000',pretendToBeVisual:true});
  let resolveOpenings;
  const app=mountApp(dom.window.document,{delay:0,fetchImpl:url=>url==='/api/config'?Promise.resolve(Response.json({configured:true,format:'agent-json'})):new Promise(resolve=>{resolveOpenings=resolve;})});
  t.after(()=>{app.destroy();dom.window.close();});
  await new Promise(resolve=>setTimeout(resolve,20));
  const title=dom.window.document.getElementById('agent-title').textContent;
  resolveOpenings(Response.json({openings:[]}));
  assert.equal(title,'黑棋 AI 已設定');
});
async function openAsHumanWhite(ctx) {
  ctx.doc.getElementById('start-button').click();
  await waitUntil(()=>ctx.app.getState().phase==='swap');
  ctx.clickText('保持 · 繼續持白');
  ctx.play(0,0);
  await waitUntil(()=>ctx.app.getState().phase==='choose-fifth');
  ctx.clickText('保留 A');
  ctx.play(0,1);
}

test('same-device UI completes classic opening and rejects symmetric fifth pair', async t=>{
  const ctx=boot(t);
  ctx.doc.querySelector('[data-mode="both"]').click();
  const select=ctx.doc.getElementById('opening-select');select.value='d1';select.dispatchEvent(new ctx.dom.window.Event('change'));
  ctx.doc.getElementById('start-button').click();ctx.clickText('提出 寒星');ctx.clickText('保持雙方顏色');
  ctx.play(8,7);ctx.play(6,6);ctx.play(6,8);
  assert.equal(ctx.app.getState().fifthCandidates.length,1);
  assert.match(ctx.doc.getElementById('game-message').textContent,/對稱等價/);
  ctx.play(9,8);ctx.clickText('保留 A');ctx.play(8,8);
  assert.equal(ctx.app.getState().moves.length,6);
  assert.equal(ctx.app.getState().turn,1);
  assert.match(ctx.doc.getElementById('turn-title').textContent,/玩家一/);
  assert.equal(ctx.calls.length,0);
});

test('human swaps to black and computer becomes white without asking black API', async t=>{
  const ctx=boot(t);
  ctx.doc.getElementById('start-button').click();await waitUntil(()=>ctx.app.getState().phase==='swap');
  ctx.clickText('交換 · 改持黑');await waitUntil(()=>ctx.app.getState().phase==='offer-fifth');
  assert.equal(ctx.app.getState().players[1],'human');
  assert.equal(ctx.app.getState().players[2],'computer');
  assert.match(ctx.doc.getElementById('black-player').textContent,/你/);
  assert.equal(ctx.calls.length,0);
});

test('unconfigured black API pauses at hand seven and retry resumes exactly one remote move', async t=>{
  const ctx=boot(t);
  await openAsHumanWhite(ctx);
  await waitUntil(()=>!ctx.doc.getElementById('retry-button').hidden);
  assert.equal(ctx.app.getState().moves.length,6);
  assert.equal(ctx.calls.length,0);
  assert.match(ctx.doc.getElementById('game-message').textContent,/\.env/);
  ctx.settings.configured=true;ctx.doc.getElementById('retry-button').click();
  await waitUntil(()=>ctx.app.getState().moves.length===7);
  assert.equal(ctx.calls.length,1);
  assert.equal(ctx.app.getState().board[224],1);
  assert.equal(ctx.app.getState().turn,2);
  assert.deepEqual(JSON.parse(ctx.calls[0].body).moves.map(m=>m.color),[1,2,1,2,1,2]);
});

test('invalid remote move preserves all six stones and shows retry', async t=>{
  const ctx=boot(t,{configured:true,agent:()=>Response.json({move:{row:7,col:7},reason:'occupied'})});
  await openAsHumanWhite(ctx);await waitUntil(()=>!ctx.doc.getElementById('retry-button').hidden);
  assert.equal(ctx.calls.length,1);
  assert.equal(ctx.app.getState().moves.length,6);
  assert.match(ctx.doc.getElementById('game-message').textContent,/棋子/);
});

test('abandoning a game aborts in-flight black request and late reply cannot change new board', async t=>{
  let resolveResponse;
  const ctx=boot(t,{configured:true,agent:()=>new Promise(resolve=>{resolveResponse=resolve;})});
  await openAsHumanWhite(ctx);await waitUntil(()=>ctx.calls.length===1);
  ctx.doc.getElementById('resign-button').click();
  assert.equal(ctx.calls[0].signal.aborted,true);
  resolveResponse(Response.json({move:{row:14,col:14},reason:'late'}));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(ctx.app.getState().moves.length,0);
  assert.equal(ctx.app.getState().phase,'setup');
  assert.equal(ctx.app.getState().board[224],0);
});

function memoryStorage() {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}

test('reopening restores exact unfinished fifth proposal and fixed 225-point board', async t=>{
  const storage=memoryStorage();
  const first=boot(t,{storage});first.doc.querySelector('[data-mode="both"]').click();
  const select=first.doc.getElementById('opening-select');select.value='d1';select.dispatchEvent(new first.dom.window.Event('change'));
  first.doc.getElementById('start-button').click();first.clickText('提出 寒星');first.clickText('保持雙方顏色');first.play(8,7);first.play(6,6);
  const id=first.app.getState().id;first.app.destroy();
  const second=boot(t,{storage});
  assert.equal(second.app.getState().id,id);
  assert.equal(second.app.getState().phase,'offer-fifth');
  assert.equal(second.app.getState().board.length,225);
  assert.equal(second.app.getState().moves.length,4);
  assert.deepEqual(second.app.getState().fifthCandidates,[{row:6,col:6}]);
  assert.equal(second.doc.querySelector('[data-index="96"]').textContent,'A');
  assert.match(second.doc.getElementById('save-status').textContent,/自動保存/);
  assert.equal(second.doc.querySelectorAll('.cell').length,225);
});

test('unfinished games cannot be overwritten and explicit abandonment creates no history', async t=>{
  const storage=memoryStorage();const ctx=boot(t,{storage});
  ctx.doc.querySelector('[data-mode="both"]').click();ctx.doc.getElementById('start-button').click();ctx.clickText('提出 疏星');
  const id=ctx.app.getState().id;
  assert.equal(ctx.doc.getElementById('new-game').disabled,true);
  assert.equal(ctx.doc.querySelector('[data-mode="black"]').disabled,true);
  ctx.app.start('black');assert.equal(ctx.app.getState().id,id);
  assert.equal(loadArchive(storage).active.id,id);
  ctx.doc.getElementById('resign-button').click();
  assert.equal(loadArchive(storage).active,null);
  assert.equal(loadArchive(storage).history.length,0);
  assert.equal(ctx.app.getState().phase,'setup');
});

test('normal agreed draw is archived once, visible on main screen and survives reopening', async t=>{
  const storage=memoryStorage();const ctx=boot(t,{storage});
  ctx.doc.querySelector('[data-mode="both"]').click();ctx.doc.getElementById('start-button').click();ctx.clickText('提出 疏星');ctx.clickText('保持雙方顏色');
  ctx.doc.getElementById('draw-button').click();ctx.doc.getElementById('accept-draw').click();
  assert.equal(loadArchive(storage).history.length,1);
  assert.equal(loadArchive(storage).active,null);
  assert.equal(ctx.doc.querySelectorAll('.archive-card').length,1);
  assert.match(ctx.doc.querySelector('.archive-card').textContent,/雙方和棋/);
  ctx.doc.querySelector('.archive-card').click();assert.equal(ctx.doc.querySelectorAll('.archive-cell').length,225);
  const second=boot(t,{storage});
  assert.equal(second.app.getState().phase,'setup');
  assert.equal(second.doc.querySelectorAll('.archive-card').length,1);
});

test('computer opening waits for configured rate data before applying swap-aware choice', async t=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:3000',pretendToBeVisual:true});
  let resolveOpenings;
  const app=mountApp(dom.window.document,{delay:0,storage:memoryStorage(),fetchImpl:url=>url==='/api/config'?Promise.resolve(Response.json({configured:false,format:'agent-json'})):new Promise(resolve=>{resolveOpenings=resolve;})});
  t.after(()=>{app.destroy();dom.window.close();});app.start('white');
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(app.getState().moves.length,0);
  resolveOpenings(Response.json({openings:['d3','d8','d9','i11'].map(id=>({id,blackWinRate:.9,rateKind:'empirical'})).concat([{id:'d4',blackWinRate:.5,rateKind:'empirical'}])}));
  await waitUntil(()=>app.getState().phase==='swap');assert.equal(app.getState().openingId,'d4');
});

test('actual black forbidden move loses and is persisted as a historical game', async t=>{
  const storage=memoryStorage();
  let game=decideSwap(proposeOpening(createGame('both'),'d4'),false);
  game=placeStone(game,8,8);game=offerFifth(offerFifth(game,5,5),9,7);game=chooseFifth(game,1);game=placeStone(game,8,7);
  const black=[[10,9],[10,11],[9,10],[11,10]],white=[[0,0],[0,2],[0,4],[2,0]];
  for(let i=0;i<black.length;i++){game=placeStone(game,...black[i]);game=placeStone(game,...white[i]);}
  saveGame(storage,game);
  const ctx=boot(t,{storage});ctx.play(10,10);
  assert.equal(ctx.app.getState().phase,'finished');
  assert.equal(ctx.app.getState().result.reason,'forbidden');
  assert.equal(ctx.app.getState().result.winner,2);
  assert.equal(loadArchive(storage).active,null);
  assert.equal(loadArchive(storage).history.length,1);
  assert.match(ctx.doc.querySelector('.archive-card').textContent,/黑方禁手敗.*三三/);
  assert.match(ctx.doc.getElementById('turn-title').textContent,/白方勝利/);
});

test('keyboard navigation selects adjacent coordinate without placing before Enter', async t=>{
  const ctx=boot(t);
  const centre=ctx.doc.querySelector('[data-index="112"]');centre.focus();
  centre.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal(ctx.doc.activeElement.dataset.index,'113');
  assert.equal(ctx.app.getState().moves.length,0);
  assert.match(ctx.doc.activeElement.getAttribute('aria-label'),/I8/);
});
