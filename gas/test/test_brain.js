// brain_daily.gs 순수 로직 검증 — GAS API는 스텁
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
const logs=[], posted=[], fetches=[];
let anthropicResponse=null, propsStore={}, feedFile=null; // {content:base64} 또는 null(404)
const sandbox={
  PropertiesService:{getScriptProperties:()=>({
    getProperty:k=>propsStore[k]||null,
    setProperty:(k,v)=>{propsStore[k]=v;},
    deleteProperty:k=>{delete propsStore[k];}
  })},
  UrlFetchApp:{fetch:(url,opt)=>{fetches.push(url);
    if(url.includes('feed/okchart_daily.json')) return feedFile
      ? {getResponseCode:()=>200,getContentText:()=>JSON.stringify(feedFile)}
      : {getResponseCode:()=>404,getContentText:()=>'{}'};
    if(url.includes('api.github.com')) return {getResponseCode:()=>200,getContentText:()=>JSON.stringify([
      {name:'L0_헌법_v0_2_260806.md',download_url:'dl://v02'},
      {name:'L0_헌법_v1_1_260806.md',download_url:'dl://v11'},
      {name:'L0_헌법_v1_0_260806.md',download_url:'dl://v10'},
      {name:'L2_응대KB_v2_18_260806.md',download_url:'dl://kb'},
      {name:'L2_응대KB_v2_19_260813.md',download_url:'dl://kb19'},
      {name:'L2_응대KB_v2_9_260730.md',download_url:'dl://kb9'}]) };
    if(url==='dl://v11') return {getResponseCode:()=>200,getContentText:()=>'# 아크로드 헌법 v1.1 — 확정\n핵심 한 줄...'};
    if(url.includes('conversations.history')) return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,messages:[
      {ts:'1754500000',text:'김철수 님 010-1234-5678 로 연락드렸습니다'},
      {ts:'1754490000',text:'오늘 결산 제출했습니다'}]})};
    if(url.includes('api.anthropic.com')) return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(anthropicResponse)};
    if(url.includes('chat.postMessage')){posted.push(JSON.parse(opt.payload));return {getResponseCode:()=>200,getContentText:()=>'{"ok":true}'};}
    return {getResponseCode:()=>404,getContentText:()=>''};
  }},
  Utilities:{formatDate:(d,tz,fmt)=>fmt==='yyyy-MM-dd'?'2026-08-06':'12:34',
    base64Decode:s=>Buffer.from(s,'base64'),
    newBlob:b=>({getDataAsString:()=>Buffer.from(b).toString('utf8')})},
  ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({atHour:()=>({everyDays:()=>({create:()=>{}})})})})},
  JSON,Object,String,Array,Math,Date,RegExp,Error,Number,encodeURIComponent,console
};
vm.createContext(sandbox);
// 의존 함수 로드: acdParseVer_(build_kb.gs), arnMask_(rainy_hook.gs)
const bk=fs.readFileSync(G('build_kb.gs'),'utf8');
const ver=bk.match(/function acdParseVer_[\s\S]*?\n}/);
if(!ver){console.log('acdParseVer_ 추출 실패');process.exit(1);}
vm.runInContext(ver[0],sandbox);
const rh=fs.readFileSync(G('rainy_hook.gs'),'utf8');
vm.runInContext(rh.match(/function arnMask_[\s\S]*?\n}/)[0],sandbox);
vm.runInContext(fs.readFileSync(G('brain_daily.gs'),'utf8'),sandbox);

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};

console.log('1) L0 로딩 — 최신 버전 선택');
propsStore={CANON_REPO:'x/acro_canon',GH_TOKEN:'t'};
let l0=sandbox.acbLoadL0_();
ok('v0_2·v1_0·v1_1 중 v1_1을 선택', l0.text.includes('v1.1'));
ok('L2 파일은 후보에서 제외', !fetches.some(u=>u==='dl://kb'));
ok('캐시 저장됨', !!propsStore.BRAIN_L0_CACHE);
ok('stale 아님', l0.stale===false);

console.log('2) L0 로딩 실패 → 캐시 폴백');
propsStore={BRAIN_L0_CACHE:'캐시된 헌법'};  // 토큰 없음 → 실패 경로
l0=sandbox.acbLoadL0_();
ok('캐시본 사용 + stale 표시', l0.text==='캐시된 헌법' && l0.stale===true);
propsStore={};
let threw=false; try{sandbox.acbLoadL0_();}catch(e){threw=true;}
ok('캐시도 없으면 명시적 실패', threw);

console.log('3) 슬랙 다이제스트 — 마스킹·시간순');
propsStore={SLACK_TOKEN:'x',BRAIN_READ_CHANNELS:'C001'};
let d=sandbox.acbReadChannels_();
ok('전화번호 마스킹됨', d.text.includes('[전화]') && !d.text.includes('010-1234'));
ok('시간순 정렬(결산이 먼저)', d.text.indexOf('결산 제출')<d.text.indexOf('연락드렸'));

console.log('4) Claude 호출 — 정상·refusal·빈 응답');
propsStore={ANTHROPIC_API_KEY:'k'};
anthropicResponse={stop_reason:'end_turn',content:[{type:'text',text:'🌙 하루 마무리 — 2026-08-06\n· 특이사항 없음'}]};
ok('텍스트 추출', sandbox.acbAsk_('s','u').includes('하루 마무리'));
anthropicResponse={stop_reason:'refusal',content:[]};
threw=false; try{sandbox.acbAsk_('s','u');}catch(e){threw=String(e).includes('refusal');}
ok('refusal은 조용히 넘기지 않고 실패', threw);

console.log('5) 전체 흐름 — 시스템 프롬프트에 헌법이 최상단');
propsStore={CANON_REPO:'x/c',GH_TOKEN:'t',SLACK_TOKEN:'x',BRAIN_READ_CHANNELS:'C001',
            ANTHROPIC_API_KEY:'k',BRAIN_POST_CHANNEL:'CMEET'};
anthropicResponse={stop_reason:'end_turn',content:[{type:'text',text:'🌙 하루 마무리 — 2026-08-06\n· 결산: 제출됨'}]};
// acbAsk_에 들어간 system 캡처
const origAsk=sandbox.acbAsk_; let capturedSystem='';
sandbox.acbAsk_=function(s,u){capturedSystem=s;return origAsk(s,u);};
posted.length=0;
sandbox.acbDaily();
ok('헌법이 시스템 최상단(0번 위치)', capturedSystem.indexOf('아크로드 헌법')>=0 && capturedSystem.indexOf('아크로드 헌법')<10);
ok('작업 지시가 헌법 뒤에', capturedSystem.indexOf('하루 마무리')>capturedSystem.indexOf('아크로드 헌법'));
ok('#회의_프로그램에 게시됨', posted.length===1 && posted[0].channel==='CMEET');
ok('게시문에 마무리 내용', posted[0].text.includes('하루 마무리'));
ok('오류 상태 클리어', !propsStore.BRAIN_LAST_ERR);

console.log('5b) OK차트 실측 feed — 로딩·날짜검증·다이제스트 결합');
const mkFeed=o=>({content:Buffer.from(JSON.stringify(o),'utf8').toString('base64')});
const todayFeed={v:1,date:'2026-08-06',visits:23,pay_by_method:[{method:'카드',cnt:12,sum:1234000}],misu_today:50000,resv_tomorrow:17,resv_tomorrow_first:'10:00'};
propsStore={CANON_REPO:'x/c',GH_TOKEN:'t'};
feedFile=mkFeed(todayFeed);
let f=sandbox.acbLoadFeed_();
ok('오늘 feed 로딩', !!f && f.visits===23);
ok('실측 블록 문구·천단위', sandbox.acbFeedText_(f).includes('카드 12건 1,234,000원') && sandbox.acbFeedText_(f).includes('내일 예약 17건 (첫 10:00)'));
feedFile=mkFeed({v:1,date:'2026-08-05',visits:9});
ok('어제 feed는 무시(null)', sandbox.acbLoadFeed_()===null);
feedFile=null;
ok('feed 없음(404)도 null — 조용한 생략', sandbox.acbLoadFeed_()===null);

console.log('5b2) 정본 현황 — 최신 KB 판별·적체 감시');
propsStore={CANON_REPO:'x/c',GH_TOKEN:'t'};
let kb=sandbox.acbLoadKbState_();
ok('최신 KB 선택(v2_19 > v2_18 > v2_9)', kb && kb.ver==='2.19');
ok('등재 날짜 파싱', kb && kb.ymd==='260813');
propsStore={};
ok('속성 없으면 null(조용한 생략)', sandbox.acbLoadKbState_()===null);

console.log('5c) 전체 흐름 — feed가 사용자 입력에 결합');
feedFile=mkFeed(todayFeed);
propsStore={CANON_REPO:'x/c',GH_TOKEN:'t',SLACK_TOKEN:'x',BRAIN_READ_CHANNELS:'C001',
            ANTHROPIC_API_KEY:'k',BRAIN_POST_CHANNEL:'CMEET'};
anthropicResponse={stop_reason:'end_turn',content:[{type:'text',text:'🌙 하루 마무리 — 2026-08-06\n· 결산: 실측 23명'}]};
const origAsk3=sandbox.acbAsk_; let capturedUser='';
sandbox.acbAsk_=function(s,u){capturedUser=u;return origAsk3(s,u);};
posted.length=0;
sandbox.acbDaily();
ok('실측 블록이 다이제스트 뒤에 결합', capturedUser.includes('## OK차트 실측(전산)') && capturedUser.indexOf('채널')<capturedUser.indexOf('OK차트 실측'));
ok('게시 정상', posted.length===1);
ok('정본 현황 블록도 결합', capturedUser.includes('## 정본 현황') && capturedUser.includes('v2.19'));
ok('작업 지시에 적체 항목', sandbox.acbTaskPrompt_().includes('정본 적체'));
// 원장 지시 260820 — 원내 채널이므로 이름을 가리지 않는다
const TP=sandbox.acbTaskPrompt_();
ok('★이니셜 축약 금지 지시 있음', TP.includes('이름은 그대로 쓴다'));
ok('★"이름 언급 금지" 옛 지시 제거됨', !TP.includes('환자 이름·차트번호 언급'));
ok('이니셜 예시로 무엇이 문제인지 명시', TP.includes('H님') && TP.includes('업무를 방해'));
ok('차트번호도 함께 쓰라고 지시', TP.includes('차트번호가 보이면'));
ok('추측 금지·영업성 금지는 유지', TP.includes('추측으로 채우기') && TP.includes('영업성 문구'));
// 슬랙이 비어도 feed만으로 돈다
propsStore={CANON_REPO:'x/c',GH_TOKEN:'t',SLACK_TOKEN:'x',
            ANTHROPIC_API_KEY:'k',BRAIN_POST_CHANNEL:'CMEET'};  // BRAIN_READ_CHANNELS 없음
posted.length=0;
sandbox.acbDaily();
ok('슬랙 0건+feed 있음 → 실측만으로 게시', posted.length===1 && !posted[0].text.includes('채널 메시지가 없습니다'));
feedFile=null;

console.log('6) 실패 시 — 경보하되 같은 오류 반복 억제');
propsStore={SLACK_TOKEN:'x',BRAIN_POST_CHANNEL:'CMEET'};  // 헌법 로딩 실패 유도
posted.length=0;
try{sandbox.acbDaily();}catch(e){}
ok('실패 경보 1회 게시', posted.length===1 && posted[0].text.includes('🔺'));
try{sandbox.acbDaily();}catch(e){}
ok('같은 오류 재발 시 침묵', posted.length===1);

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
