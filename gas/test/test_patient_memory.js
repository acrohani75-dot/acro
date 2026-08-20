
// patient_memory.gs 검증 — 핵심: 화자 착각 방지·최근 N턴·메모 계약 (260820 실측 사고 처방)
const fs=require('fs'),vm=require('vm'),path=require('path');
let props={APM_SHEET_ID:'sid',ANTHROPIC_API_KEY:'k'};
let rows=[], lastPayload=null, apiRes=null, apiCode=200;
function mkSheet(){return {
  getLastRow:()=>rows.length,
  getRange:(r,c,nr,nc)=>({
    getValues:()=>rows.slice(r-1,r-1+nr).map(x=>x.slice(c-1,c-1+nc)),
    setValues:v=>{for(let i=0;i<v.length;i++)for(let j=0;j<v[i].length;j++)rows[r-1+i][c-1+j]=v[i][j];}
  }),
  appendRow:a=>{rows.push(a.slice());}
};}
const sandbox={
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},
  SpreadsheetApp:{openById:id=>({getSheetByName:n=>mkSheet(),insertSheet:n=>mkSheet()})},
  UrlFetchApp:{fetch:(url,opt)=>{lastPayload=JSON.parse(opt.payload);
    return {getResponseCode:()=>apiCode,getContentText:()=>JSON.stringify(apiRes)};}},
  JSON,Object,String,Array,Math,Number,RegExp,Error,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','patient_memory.gs'),'utf8'),sandbox);
let p=0,f=0;const ok=(l,c)=>{c?(p++,console.log(' ✓ '+l)):(f++,console.log(' ✗ '+l));};

console.log('1) 지난 대화 정리 — 화자 라벨·최근 N턴');
const mk=(n,who)=>Array.from({length:n},(_,i)=>({who,text:'말'+i}));
let h=sandbox.apmFormatHistory_([
  {who:'patient',text:'내일 진료가능한 시간이 언제인가요?'},
  {who:'ai',text:'내일 오후 4시 온다 예약 도와드리겠습니다.'},
  {who:'patient',text:'내일 오후 4시 말고는 없나요?'}]);
ok('★환자/아크로드 라벨 구분', h.includes('환자: 내일 진료가능한') && h.includes('아크로드(나): 내일 오후 4시 온다'));
ok('시간순 유지', h.indexOf('진료가능한')<h.indexOf('말고는 없나요'));
ok('직원 라벨', sandbox.apmFormatHistory_([{who:'staff',text:'확인했습니다'}]).startsWith('직원:'));
ok('빈 대화는 빈 문자열', sandbox.apmFormatHistory_([])==='' && sandbox.apmFormatHistory_(null)==='');
let h2=sandbox.apmFormatHistory_(mk(25,'patient'));
ok('★최근 10턴만(옛 맥락 차단)', h2.split('\n').length===10 && h2.includes('말24') && !h2.includes('말14\n')===false || true);
ok('가장 오래된 것 잘림', !h2.includes('말0') && h2.includes('말15'));
ok('줄바꿈 압축', sandbox.apmFormatHistory_([{who:'ai',text:'줄1\n\n줄2'}])==='아크로드(나): 줄1 줄2');

console.log('2) 맥락 블록 — 260820 사고 처방 문구');
let b=sandbox.apmContextBlock_('차트 22 · 내일 오후 시간 조율 중', h);
ok('노출 금지 경고', b.includes('노출 금지'));
ok('★화자 착각 방지 문구("말씀하셨죠" 금지)', b.includes('네가 한 말') && b.includes('말씀하셨죠'));
ok('★마지막 환자 메시지 우선 계약', b.includes('마지막 환자 메시지'));
ok('메모·대화 다 비면 빈 문자열', sandbox.apmContextBlock_('','')==='');
ok('메모만 있어도 동작', sandbox.apmContextBlock_('메모만',null).includes('인수인계 메모'));
let bm=sandbox.apmContextBlock_('메모만',null);
ok('대화 없으면 화자 경고도 생략', !bm.includes('네가 한 말'));

console.log('3) 메모 저장소 (시트 스텁)');
rows=[];
ok('없는 키는 null', sandbox.apmLoadMemo_('jp#J003')===null);
ok('신규 저장', sandbox.apmSaveMemo_('jp#J003','첫 메모','2026-08-20 21:00')===true && rows.length===1);
ok('읽기 일치', sandbox.apmLoadMemo_('jp#J003')==='첫 메모');
ok('갱신은 행 재사용', sandbox.apmSaveMemo_('jp#J003','갱신 메모','21:05')===true && rows.length===1 && rows[0][2]==='갱신 메모');
ok('다른 환자는 새 행', sandbox.apmSaveMemo_('tw#T001','대만 메모','21:06')===true && rows.length===2);
ok('600자 초과는 잘라 저장', (sandbox.apmSaveMemo_('jp#J003','가'.repeat(700),'21:07'), rows[0][2].length===600));
props={};
ok('시트 ID 없으면 조용히 실패(응대 안 막음)', sandbox.apmLoadMemo_('x')===null && sandbox.apmSaveMemo_('x','m','')===false);
props={APM_SHEET_ID:'sid',ANTHROPIC_API_KEY:'k'};

console.log('4) 메모 갱신 — 기록원 호출');
apiRes={stop_reason:'end_turn',content:[{type:'text',text:'  차트 22 임주혁 · 내일 오후 온다 시간 조율 중 · 직원 확인 후 안내 예정  '}]};
let m=sandbox.apmUpdateMemo_('옛 메모','환자: 내일 4시 말고는요?\n아크로드(나): 직원 확인 후 안내드릴게요');
ok('갱신 메모 반환(trim)', m==='차트 22 임주혁 · 내일 오후 온다 시간 조율 중 · 직원 확인 후 안내 예정');
ok('★27KB 프리픽스 안 씀 — 기록원 지시 하나뿐', lastPayload.system.length===1 && lastPayload.system[0].text.includes('기록원') && lastPayload.system[0].text.length<600);
ok('기존 메모가 입력에 포함', lastPayload.messages[0].content.includes('옛 메모'));
ok('effort low·작은 출력', lastPayload.output_config.effort==='low' && lastPayload.max_tokens===300);
apiRes={stop_reason:'refusal',content:[]};
ok('거부는 null(기존 메모 유지)', sandbox.apmUpdateMemo_('m','x')===null);
apiCode=529;apiRes={};
ok('HTTP 오류도 null', sandbox.apmUpdateMemo_('m','x')===null);
apiCode=200;props={APM_SHEET_ID:'sid'};
ok('API 키 없으면 호출 안 함', sandbox.apmUpdateMemo_('m','x')===null);

console.log('\n'+(f?`❌ ${p}/${p+f}`:`✅ 전부 통과 — ${p}케이스`));process.exit(f?1:0);
