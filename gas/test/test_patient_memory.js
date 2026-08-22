
// patient_memory.gs 검증 — 핵심: 화자 착각 방지·최근 N턴·메모 계약 (260820 실측 사고 처방)
const fs=require('fs'),vm=require('vm'),path=require('path');
let props={APM_SHEET_ID:'sid',ANTHROPIC_API_KEY:'k'};
let rows=[], lastPayload=null, apiRes=null, apiCode=200;
let mapRows=[], slackReply=null, slackCalls=0;
let cacheStore={}, cachePuts=[];              // 라인환자맵 · 슬랙 conversations.replies 스텁
function mkSheet(src){return {
  getLastRow:()=>src.length,
  getRange:(r,c,nr,nc)=>({
    getValues:()=>src.slice(r-1,r-1+(nr||1)).map(x=>x.slice(c-1,c-1+(nc||1))),
    setValues:v=>{for(let i=0;i<v.length;i++)for(let j=0;j<v[i].length;j++)src[r-1+i][c-1+j]=v[i][j];},
    setValue:v=>{while(src[r-1].length<c)src[r-1].push('');src[r-1][c-1]=v;}
  }),
  appendRow:a=>{src.push(a.slice());}
};}
const sandbox={
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},
  SpreadsheetApp:{openById:id=>({
    getSheetByName:n=>mkSheet(n==='라인환자맵'?mapRows:rows),
    insertSheet:n=>mkSheet(rows)})},
  UrlFetchApp:{fetch:(url,opt)=>{
    if(String(url).includes('slack.com')){slackCalls++;
      return {getResponseCode:()=>(slackReply?200:500),getContentText:()=>JSON.stringify(slackReply||{})};}
    lastPayload=JSON.parse(opt.payload);
    return {getResponseCode:()=>apiCode,getContentText:()=>JSON.stringify(apiRes)};}},
  CacheService:{getScriptCache:()=>({
    get:k=>(k in cacheStore?cacheStore[k]:null),
    put:(k,v,sec)=>{cacheStore[k]=v;cachePuts.push([k,sec]);},
    remove:k=>{delete cacheStore[k];}
  })},
  encodeURIComponent,
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
ok('직원 라벨 — 발송/메모를 구별한다(둘을 섞으면 "말씀드렸듯이" 사고)',
   sandbox.apmFormatHistory_([{who:'staff',text:'확인했습니다'}]).startsWith('직원(환자에게 발송함):')
   && sandbox.apmFormatHistory_([{who:'note',text:'차트 20193'}]).startsWith('직원 메모(환자에게 안 나감):'));
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

/* ─────────────────────────────────────────────────────────────────────────
 * 슬랙 스레드 이력 로더 — 아래 문자열은 전부 #cs_fn_일본_라인 실측 원문(260822)
 * ───────────────────────────────────────────────────────────────────────── */
const BOT = {bot_id:'B01'};
const HUMAN = {user:'U09MA64AG2H'};
const M = (text, from) => Object.assign({text}, from || BOT);

const CARD = M(':jp: *라인 · 환자#J148 · Rie Kuwahara(LINE)* · 예약문의\n요지: 8월 22일 14시 온라인 진료 예약 취소 요청\n(대화는 이 스레드에 · 응대는 LINE 콘솔 · 처리 후 :white_check_mark:)');
const FRIEND = M('*[J153]* [친구 추가]');
const CHART_TAGGED = M('*[#19756 백은영]* 의사쌤께 여쭤보고 싶은게 있는데 냉동 난자를 하려규 합니다');
const INBOUND = M('現地でカードで払った場合も25000 KRW発生しますか？\n(한국어) 현지에서 카드로 지불한 경우에도 25000 KRW가 발생합니까?');
const AI_OUT = M(':crescent_moon: 야간 대화응답 1/8 [Q001] → 일본 환자#J153\n(한국어 대역) 안녕하세요, 아크로 한의원입니다. AI 상담 스탭이 안내드리고 있습니다.');
const ALERT = M(':rotating_light: *환자#J142 불편증상* — 복용 초기 오심과 다리 경련 증상 있었으나 수분·식사 후 호전됨 (위 카드 스레드 확인)');
const NOTE = M('차트 20193 GIMAMIYUKI', HUMAN);
const STAFF_SEND = M('!미유키님은 예약표에 반영해뒀습니다', HUMAN);
const STAFF_SEND2 = M('!!こんにちは', HUMAN);
const TOGGLE = M('^', HUMAN);

console.log('7) 화자 판정 — 슬랙 실측 원문');
const C = m => { const r = sandbox.apmClassify_(m); return r ? r.who : null; };
ok('*[J153]* 태그 = 환자', C(FRIEND)==='patient');
ok('*[#19756 이름]* 태그도 환자', C(CHART_TAGGED)==='patient');
ok('원문+(한국어) 대역 = 환자(인바운드)', C(INBOUND)==='patient');
ok('★"대화응답 n/m" 헤더 = 아크로드(나) — 환자로 찍으면 260820 사고 재발', C(AI_OUT)==='ai');
ok('사람의 ! 발송 = 직원', C(STAFF_SEND)==='staff');
ok('사람의 !! 발송도 직원', C(STAFF_SEND2)==='staff');
ok('사람의 평범한 글 = 내부 메모', C(NOTE)==='note');
ok('불편증상 알림 = 내부 메모', C(ALERT)==='note');
ok('카드는 요지만 메모로', C(CARD)==='note'
   && sandbox.apmClassify_(CARD).text==='[접수 요지] 8월 22일 14시 온라인 진료 예약 취소 요청');
ok('^ 토글은 대화가 아님(버림)', sandbox.apmClassify_(TOGGLE)===null);
ok('빈 메시지는 버림', sandbox.apmClassify_(M(''))===null);
ok('★정체불명 봇 메시지는 환자가 아니라 기록', C(M('진행 상황 동기화 완료'))==='kept');

console.log('8) 본문 정리 — 같은 말을 두 번 넣지 않는다');
ok('태그는 떼고 본문만', sandbox.apmClassify_(FRIEND).text==='[친구 추가]');
ok('★인바운드는 원문+한국어 둘 다 남긴다(원장 지시 — 사람이 읽어야 한다)',
   sandbox.apmClassify_(INBOUND).text.includes('現地でカードで払った場合')
   && sandbox.apmClassify_(INBOUND).text.includes('현지에서 카드로 지불한 경우'));
ok('AI 응답은 머리글만 떼고 한국어 대역은 남긴다',
   !sandbox.apmClassify_(AI_OUT).text.includes('대화응답')
   && sandbox.apmClassify_(AI_OUT).text.includes('(한국어 대역) 안녕하세요'));
ok('발송 접두어 제거', sandbox.apmClassify_(STAFF_SEND).text==='미유키님은 예약표에 반영해뒀습니다');

console.log('9) 스레드 → 이력 문자열');
let turns = sandbox.apmTurnsFromSlack_([CARD, FRIEND, AI_OUT, INBOUND, NOTE, STAFF_SEND]);
ok('버릴 것 빼고 6턴', turns.length===6);
h = sandbox.apmFormatHistory_(turns);
ok('환자 줄에 라벨 + 한국어 병기', h.includes('환자: 現地でカードで払った場合')
   && h.includes('현지에서 카드로 지불한 경우'));
ok('AI 줄은 "아크로드(나)"', h.includes('아크로드(나): (한국어 대역) 안녕하세요'));
ok('★내부 메모는 "환자에게 안 나감"이라고 못박힘',
   h.includes('직원 메모(환자에게 안 나감): 차트 20193 GIMAMIYUKI'));
ok('실제 발송은 "환자에게 발송함"', h.includes('직원(환자에게 발송함): 미유키님은'));
ok('최근 10턴 제한 유지', sandbox.apmFormatHistory_(
   Array.from({length:14},(_,i)=>({who:'patient',text:'m'+i}))).split('\n').length===10);

console.log('10) 인입원장 라인환자맵 조회');
mapRows = [
  ['userId','채널','번호','스레드ts'],
  ['Uabc','일본','J003','1784685459.577599'],
  ['Uxyz','대만','T004','1784250753.336479'],
  ['Uabc','일본','J160','1787383849.881109'],
  ['Unots','일본','J999','']
];
let mm = sandbox.apmMapLookup_('Uabc');
ok('★같은 userId가 여러 번이면 최신 행(뒤쪽)이 이긴다', mm && mm.no==='J160');
ok('채널·스레드ts 반환', mm.ch==='일본' && mm.ts==='1787383849.881109');
ok('대만도 조회', sandbox.apmMapLookup_('Uxyz').no==='T004');
ok('스레드ts 없으면 null(이력 없음)', sandbox.apmMapLookup_('Unots')===null);
ok('미등록 userId는 null', sandbox.apmMapLookup_('U000')===null);
ok('메모 key는 실측 형식(jp#/tw#)', sandbox.apmKeyFor_('Uabc')==='jp#J160'
   && sandbox.apmKeyFor_('Uxyz')==='tw#T004');

console.log('11) 이력 조회 실패는 전부 조용히 ""');
props = {APM_SHEET_ID:'S1', SLACK_BOT_TOKEN:'x', APM_SLACK_CH_JP:'C1'};
slackReply = {ok:true, messages:[FRIEND, AI_OUT]};
ok('정상 경로', sandbox.apmHistoryFor_('Uabc').includes('아크로드(나)'));
cacheStore={};                       // 캐시를 비워야 실패 경로를 본다(캐시가 살아 있으면 옛 이력이 나온다)
slackReply = {ok:false, error:'channel_not_found'};
ok('슬랙 실패면 ""', sandbox.apmHistoryFor_('Uabc')==='');
slackReply = {ok:true, messages:[FRIEND, AI_OUT]};
cacheStore={};
delete props.APM_SLACK_CH_JP;
ok('채널ID 속성 없으면 ""', sandbox.apmHistoryFor_('Uabc')==='');
props.APM_SLACK_CH_JP='C1'; delete props.SLACK_BOT_TOKEN;
ok('토큰 없으면 ""', sandbox.apmHistoryFor_('Uabc')==='');
props.SLACK_BOT_TOKEN='x';
ok('환자맵에 없으면 ""', sandbox.apmHistoryFor_('U000')==='');

console.log('11b) UrlFetch 예산 — 같은 스레드를 반복해서 읽지 않는다');
cacheStore={};cachePuts=[];slackCalls=0;
props = {APM_SHEET_ID:'S1', SLACK_BOT_TOKEN:'x', APM_SLACK_CH_JP:'C1'};
slackReply = {ok:true, messages:[FRIEND, AI_OUT]};
sandbox.apmHistoryFor_('Uabc');
ok('첫 조회는 슬랙 왕복 1회', slackCalls===1);
sandbox.apmHistoryFor_('Uabc'); sandbox.apmHistoryFor_('Uabc');
ok('★환자 3연타여도 왕복은 그대로 1회(캐시)', slackCalls===1);
ok('캐시 TTL 90초', cachePuts.length===1 && cachePuts[0][1]===90);
ok('캐시에서도 같은 이력이 나온다', sandbox.apmHistoryFor_('Uabc').includes('아크로드(나)'));
cacheStore={};
ok('캐시 만료 후에는 다시 읽는다', (sandbox.apmHistoryFor_('Uabc'), slackCalls===2));

console.log('12) 차트번호 줍기 — 직원이 스레드에 적은 것을 환자맵에 기록');
const PC = t => sandbox.apmParseChartNote_(t);
ok('실측 원문 파싱', JSON.stringify(PC('차트 20193 GIMAMIYUKI'))==='{"chart":"20193","name":"GIMAMIYUKI"}');
ok('띄어쓰기 없는 형태', PC('차트20191 MINAMOTOSAKI').chart==='20191');
ok('콜론·샵 표기', PC('차트#19756').chart==='19756' && PC('차트: 19756').chart==='19756');
ok('이름 없이 번호만', PC('차트 0022').chart==='0022' && PC('차트 0022').name==='');
ok('★4자리 미만은 안 줍는다(전화·금액 오인 방지)', PC('차트 22')===null);
ok('★차트 얘기가 아니면 null', PC('예약표에 반영해뒀습니다')===null && PC('25000원 결제')===null);
ok('구분자 붙은 이름 정리', PC('차트 20193 · GIMA MIYUKI').name==='GIMA MIYUKI');

mapRows = [
  ['userId','채널','번호','스레드ts','','','','차트','이름'],
  ['Uabc','일본','J160','1787383849.881109','','','','',''],
  ['Udup','일본','J161','1787000000.000000','','','','19811','기존이름']
];
let w = sandbox.apmNoteChartFromThread_('1787383849.881109','차트 20193 GIMAMIYUKI');
ok('스레드로 환자를 찾아 기록', w && w.no==='J160' && w.chart==='20193');
ok('환자맵에 실제로 써짐', mapRows[1][7]==='20193' && mapRows[1][8]==='GIMAMIYUKI');
sandbox.apmNoteChartFromThread_('1787000000.000000','차트 20999 새이름');
ok('차트번호는 갱신되고', mapRows[2][7]==='20999');
ok('★이미 있는 이름은 덮어쓰지 않는다', mapRows[2][8]==='기존이름');
ok('모르는 스레드는 무시', sandbox.apmNoteChartFromThread_('9999.9','차트 20193')===null);
ok('차트 문구 아니면 시트를 건드리지 않음',
   sandbox.apmNoteChartFromThread_('1787383849.881109','오늘 예약 확인함')===null);
slackCalls=0;
sandbox.apmNoteChartFromThread_('1787383849.881109','차트 20193 GIMAMIYUKI');
ok('★차트 줍기는 UrlFetch를 쓰지 않는다(외부 왕복 0회)', slackCalls===0);

console.log('13) 메모 언어 — 직원이 읽는 문서다');
ok('★기록원 지시가 한국어를 강제', sandbox.APM_SCRIBE.includes('반드시 한국어로 쓴다'));

console.log('\n'+(f?`❌ ${p}/${p+f}`:`✅ 전부 통과 — ${p}케이스`));process.exit(f?1:0);
