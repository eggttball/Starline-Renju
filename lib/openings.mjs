const names = {
  direct: ['寒星','溪月','疏星','花月','殘月','雨月','金星','松月','丘月','新月','瑞星','山月','遊星'],
  indirect: ['長星','峽月','恆星','水月','流星','雲月','浦月','嵐月','銀月','明星','斜月','名月','彗星'],
};
const positions = {
  direct: [[0,-2],[1,-2],[2,-2],[1,-1],[2,-1],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
  indirect: [[2,-2],[2,-1],[2,0],[2,1],[2,2],[1,0],[1,1],[1,2],[0,1],[0,2],[-1,1],[-1,2],[-2,2]],
};
const balanced = new Set(['d3','d8','d9','i11']);
const blackAdvantage = new Set(['d4','i7']);
export const OPENINGS = Object.entries(names).flatMap(([category,list]) => list.map((name,index) => {
  const id = `${category==='direct'?'d':'i'}${index+1}`;
  const [dx,dy] = positions[category][index];
  return {
    id,name,category,number:index+1,
    stones:[{row:7,col:7,color:1},{row:6,col:category==='direct'?7:8,color:2},{row:7+dy,col:7+dx,color:1}],
    blackWinRate:null,rateKind:'unknown',sampleSize:null,
    assessment:balanced.has(id)?'balanced':blackAdvantage.has(id)?'black-advantage':'unknown',
    source:balanced.has(id)?'https://www.renju.net/article/39/':blackAdvantage.has(id)?'https://en.wikipedia.org/wiki/Renju_opening_pattern':'https://www.renju.net/openings/',
  };
}));

export function mergeOpeningRates(data) {
  const records = new Map((data?.openings ?? []).map(record=>[record.id,record]));
  return OPENINGS.map(opening=>{
    const record = records.get(opening.id);
    if (!record) return {...opening};
    const rate = record.blackWinRate;
    const validRate = typeof rate==='number' && Number.isFinite(rate) && rate>=0 && rate<=1;
    return {...opening,...record,id:opening.id,name:opening.name,category:opening.category,stones:opening.stones,
      blackWinRate:validRate?rate:null,rateKind:validRate?record.rateKind??'empirical':'unknown'};
  });
}

export function estimatedBlackProbability(opening) {
  if (typeof opening?.blackWinRate==='number' && Number.isFinite(opening.blackWinRate) && opening.blackWinRate>=0 && opening.blackWinRate<=1) return opening.blackWinRate;
  // These are selection priors only, not measured win rates. Unknown openings
  // are explicitly lower priority than the sourced historical shortlist.
  if (opening?.assessment==='black-win') return 1;
  if (opening?.assessment==='white-win') return 0;
  if (opening?.assessment==='black-advantage') return .9;
  if (opening?.assessment==='white-advantage') return .1;
  return .5;
}

export function swapScore(probability) {
  if (!Number.isFinite(probability) || probability<0 || probability>1) throw new Error('勝率必須介於 0 與 1。');
  return Math.min(probability,1-probability);
}

export function selectComputerOpening(openings=OPENINGS,random=Math.random) {
  if (!openings.length) throw new Error('沒有可用的開局。');
  const known = openings.filter(o=>typeof o.blackWinRate==='number'||o.assessment==='balanced');
  const pool = known.length?known:openings;
  const scores = pool.map(o=>swapScore(estimatedBlackProbability(o)));
  const best = Math.max(...scores);
  const choices = pool.filter((o,i)=>Math.abs(scores[i]-best)<1e-9);
  return choices[Math.min(choices.length-1,Math.floor(Math.max(0,random())*choices.length))];
}

export function rateDescription(opening) {
  if (opening.blackWinRate!==null && typeof opening.blackWinRate==='number') {
    const percentage = Math.round(opening.blackWinRate*100);
    return opening.rateKind==='theoretical'?`理論黑勝 ${percentage}%`:`樣本黑勝 ${percentage}%${opening.sampleSize?` · ${opening.sampleSize} 局`:''}`;
  }
  return {balanced:'接近平衡 · 歷史評述','black-advantage':'黑方優勢 · 暫定評估','white-advantage':'白方優勢 · 暫定評估','black-win':'理論黑勝','white-win':'理論白勝',unknown:'勝率資料未收錄'}[opening.assessment]??'勝率資料未收錄';
}
