// 역빌드 검증 — 정본에서 빌드한 결과 vs 현행 답변KB 시트 스냅샷
// 통과 조건: 차이가 "우리가 의도한 변경"으로 100% 설명될 것. 설명 안 되는 차이 = 0
const fs=require('fs'), vm=require('vm');
const sb={PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},Logger:{log(){}},
 UrlFetchApp:{fetch:()=>({})},Utilities:{formatDate:()=>'x'},DriveApp:{},SpreadsheetApp:{},
 JSON,Object,String,Array,Math,Date,RegExp,Error,console};
vm.createContext(sb); vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),sb);

const items=sb.parseCanon_(fs.readFileSync(process.argv[3],'utf8')).items;
sb.normalizeAll_(items);
const built={}; items.forEach(it=>{ built[it['원본ID']]={
  id:it['원본ID'],code:it['원본코드']||'',cat:it['태그']||'',q:it['질문']||'',a:it['답변_KO']||'',diff:it['난이도']||'',KB:it['KB']}; });

const rows=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
const hdr=rows[0], sheet={};
for(let r=1;r<rows.length;r++){ const o={}; hdr.forEach((h,i)=>o[h]=String(rows[r][i]??''));
  if(o.id) sheet[o.id]=o; }

const bi=Object.keys(built), si=Object.keys(sheet);
console.log(`정본 빌드 ${bi.length}건 · 시트 ${si.length}건`);

const onlyBuilt=bi.filter(k=>!sheet[k]), onlySheet=si.filter(k=>!built[k]);
console.log(`\n[정본에만 있음] ${onlyBuilt.length}건: ${onlyBuilt.join(', ')}`);
console.log(`[시트에만 있음] ${onlySheet.length}건: ${onlySheet.join(', ') || '없음'}`);

// 의도한 변경 목록 — 이 ID들의 차이는 설명된 것으로 본다
// 의도한 변경 — **KB-ID 기준**으로 적는다(원본ID는 Q/O/K/F가 섞여 헷갈린다)
const EXPECTED_KB={
  주차:['KB-0011','KB-0092'],
  D캡슐:['KB-0077','KB-0078'],
  이모지:['KB-0019','KB-0066','KB-0077','KB-0083','KB-0259','KB-0318','KB-0380','KB-0381'],
  죽은링크_walla:['KB-0276','KB-0277','KB-0279','KB-0282','KB-0283','KB-0286','KB-0288','KB-0290','KB-0293','KB-0294'],
  죽은링크_forms:['KB-0049','KB-0050','KB-0085','KB-0321'],
};
const kb2id={}; items.forEach(it=>kb2id[it['KB']]=it['원본ID']);
const EXPECTED={};
for(const k in EXPECTED_KB) EXPECTED[k]=EXPECTED_KB[k].map(x=>{
  if(!kb2id[x]) throw new Error('예상 목록의 '+x+'가 정본에 없다');
  return kb2id[x];
});
const explained=new Set(); Object.values(EXPECTED).forEach(a=>a.forEach(x=>explained.add(x)));

const FIELDS=['code','cat','q','a','diff'];
const diffs=[];
bi.filter(k=>sheet[k]).forEach(k=>{
  const bad=FIELDS.filter(f=>String(built[k][f]).replace(/\s+/g,'')!==String(sheet[k][f]).replace(/\s+/g,''));
  if(bad.length) diffs.push({id:k,KB:built[k].KB,fields:bad});
});
console.log(`\n[공통 ID 중 값이 다른 항목] ${diffs.length}건`);
const unexplained=diffs.filter(d=>!explained.has(d.id));
const okd=diffs.filter(d=>explained.has(d.id));
console.log(`  설명됨(의도한 변경)   ${okd.length}건: ${okd.map(d=>d.id).join(', ')}`);
console.log(`  설명 안 됨            ${unexplained.length}건`);
unexplained.slice(0,15).forEach(d=>{
  console.log(`  ── ${d.id} (${d.KB}) 필드: ${d.fields.join(',')}`);
  d.fields.forEach(f=>{
    console.log(`     정본: ${JSON.stringify(String(built[d.id][f]).slice(0,150))}`);
    console.log(`     시트: ${JSON.stringify(String(sheet[d.id][f]).slice(0,150))}`);
  });
});
const pass = unexplained.length===0 && onlySheet.length===0;
console.log('\n' + (pass?'✅ 역빌드 검증 통과 — 설명 안 되는 차이 0':'❌ 미통과'));
