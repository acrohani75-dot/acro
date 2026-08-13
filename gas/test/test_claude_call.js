// claude_call.gs 검증 — GAS API는 스텁. 핵심은 "캐시가 실제로 사는가".
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
let fetches=[], fetchAllCalls=[], cacheStore={}, propsStore={}, lastPayload=null;
let anthropicResponse=null, anthropicStatus=200, listStatus=200, dlStatus=200;
const logs=[];

const FILES=[
  {name:'L0_헌법_v1_2_260810.md',download_url:'dl://l0_12'},
  {name:'L0_헌법_v1_3_260812.md',download_url:'dl://l0_13'},
  {name:'L2_자산인덱스_v1_0_260812.md',download_url:'dl://idx'},
  {name:'L2_응대예시_v1_0_260812.md',download_url:'dl://ex'},
  {name:'L2_응대KB_v2_19_260813.md',download_url:'dl://kb'}   // 프리픽스에 들어가면 안 됨
];
const BODY={'dl://l0_12':'헌법 구버전','dl://l0_13':'헌법 v1.3 본문',
            'dl://idx':'자산인덱스 본문','dl://ex':'응대예시 본문','dl://kb':'KB 본문'};

const sandbox={
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>propsStore[k]||null})},
  CacheService:{getScriptCache:()=>({
    get:k=>cacheStore[k]||null,
    put:(k,v,s)=>{if(String(v).length>100*1024) throw new Error('too big');cacheStore[k]=v;},
    remove:k=>{delete cacheStore[k];}
  })},
  UrlFetchApp:{
    fetch:(url,opt)=>{
      fetches.push(url);
      if(url.includes('api.anthropic.com')){
        lastPayload=JSON.parse(opt.payload);
        return {getResponseCode:()=>anthropicStatus,getContentText:()=>JSON.stringify(anthropicResponse)};
      }
      if(url.includes('api.github.com')) return {getResponseCode:()=>listStatus,
        getContentText:()=>JSON.stringify(FILES)};
      return {getResponseCode:()=>404,getContentText:()=>''};
    },
    fetchAll:reqs=>{
      fetchAllCalls.push(reqs.map(r=>r.url));
      return reqs.map(r=>({getResponseCode:()=>dlStatus,getContentText:()=>BODY[r.url]||''}));
    }
  },
  Logger:{log:m=>logs.push(String(m))},
  JSON,Object,String,Array,Math,Date,RegExp,Error,Number,console
};
vm.createContext(sandbox);
const bk=fs.readFileSync(G('build_kb.gs'),'utf8');
vm.runInContext(bk.match(/function acdParseVer_[\s\S]*?\n}/)[0],sandbox);
vm.runInContext(fs.readFileSync(G('claude_call.gs'),'utf8'),sandbox);

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};
const reset=()=>{fetches=[];fetchAllCalls=[];cacheStore={};lastPayload=null;
  anthropicStatus=200;listStatus=200;dlStatus=200;logs.length=0;
  propsStore={ANTHROPIC_API_KEY:'k',CANON_REPO:'x/acro_canon',GH_TOKEN:'t'};};

console.log('1) 프리픽스 로딩 — 최신본 선택·병렬 다운로드');
reset();
let p=sandbox.accLoadPrefix_();
ok('헌법 최신본(v1.3) 선택', p.includes('헌법 v1.3 본문') && !p.includes('헌법 구버전'));
ok('자산인덱스·응대예시 포함', p.includes('자산인덱스 본문') && p.includes('응대예시 본문'));
ok('KB는 프리픽스에 없음(질문마다 달라짐)', !p.includes('KB 본문'));
ok('목록 요청 1회뿐', fetches.filter(u=>u.includes('api.github.com')).length===1);
ok('본문은 fetchAll 1회 병렬 3건', fetchAllCalls.length===1 && fetchAllCalls[0].length===3);

console.log('2) CacheService — 두 번째 호출은 GitHub 왕복 0회');
fetches=[];fetchAllCalls=[];
let p2=sandbox.accLoadPrefix_();
ok('같은 내용 반환', p2===p);
ok('GitHub 호출 없음', fetches.length===0 && fetchAllCalls.length===0);
ok('flush 후에는 다시 받아온다', (sandbox.accFlushPrefix(), sandbox.accLoadPrefix_(), fetchAllCalls.length===1));

console.log('3) 로딩 실패 — 조립하지 않는다(반쪽 헌법 금지)');
reset(); propsStore={ANTHROPIC_API_KEY:'k'};   // 리포·토큰 없음
ok('속성 없으면 null', sandbox.accLoadPrefix_()===null);
reset(); listStatus=500;
ok('목록 실패면 null', sandbox.accLoadPrefix_()===null);
reset(); dlStatus=404;
ok('본문 하나라도 실패면 null', sandbox.accLoadPrefix_()===null);
reset(); sandbox.ACC_CFG.PREFIXES=['L0_헌법_v','L2_없는문서_v'];
ok('셋 중 하나 없으면 null', sandbox.accLoadPrefix_()===null);
sandbox.ACC_CFG.PREFIXES=['L0_헌법_v','L2_자산인덱스_v','L2_응대예시_v'];

console.log('4) 프롬프트 조립 — 캐시 경계가 정확한가');
reset();
anthropicResponse={stop_reason:'end_turn',content:[{type:'text',text:'  안녕하세요 😊  '}],
  usage:{cache_read_input_tokens:7000,cache_creation_input_tokens:0,input_tokens:120}};
let out=sandbox.accAsk_('작업지시 고정문','KB-0484 반과 설명','속이 쓰려요');
ok('응답 텍스트 trim', out==='안녕하세요 😊');
ok('system은 블록 2개', Array.isArray(lastPayload.system) && lastPayload.system.length===2);
ok('0번=정적 정본, 1번=작업지시', lastPayload.system[0].text.includes('헌법 v1.3 본문')
   && lastPayload.system[1].text==='작업지시 고정문');
ok('cache_control은 마지막 블록에만',
   !lastPayload.system[0].cache_control && lastPayload.system[1].cache_control.type==='ephemeral');
ok('KB 히트는 system이 아니라 사용자 메시지',
   !JSON.stringify(lastPayload.system).includes('KB-0484')
   && lastPayload.messages[0].content.includes('KB-0484'));
ok('환자 메시지가 KB 뒤(변동분은 뒤로)',
   lastPayload.messages[0].content.indexOf('KB-0484')<lastPayload.messages[0].content.indexOf('속이 쓰려요'));
ok('effort·max_tokens 지정', lastPayload.output_config.effort==='low' && lastPayload.max_tokens===1200);
ok('캐시 적중 로그 남김', logs.some(l=>l.includes('cache_read=7000')));

console.log('4b) 같은 접점 두 번째 호출 — 정적 구간이 바이트 동일');
let sys1=JSON.stringify(lastPayload.system);
sandbox.accAsk_('작업지시 고정문','다른 KB 히트','다른 질문');
ok('KB·질문이 바뀌어도 system 불변', JSON.stringify(lastPayload.system)===sys1);

console.log('5) 실패·거부 — 지어내지 않고 null');
reset();
anthropicResponse={stop_reason:'refusal',content:[]};
ok('refusal은 null', sandbox.accAsk_('t',null,'u')===null);
anthropicStatus=529; anthropicResponse={};
ok('HTTP 오류는 null', sandbox.accAsk_('t',null,'u')===null);
reset(); anthropicResponse={stop_reason:'end_turn',content:[]};
ok('빈 응답도 null', sandbox.accAsk_('t',null,'u')===null);
reset(); propsStore={CANON_REPO:'x/c',GH_TOKEN:'t'};   // API 키 없음
ok('키 없으면 호출조차 안 함', sandbox.accAsk_('t',null,'u')===null
   && !fetches.some(u=>u.includes('anthropic')));

console.log('6) KB 없이도 동작 (예약·인사 등)');
reset();
anthropicResponse={stop_reason:'end_turn',content:[{type:'text',text:'네, 도와드릴게요'}]};
out=sandbox.accAsk_('작업지시','','안녕하세요');
ok('KB 빈 값이면 히트 섹션 생략', out==='네, 도와드릴게요'
   && !lastPayload.messages[0].content.includes('정본 히트'));

console.log('7) 캐시 100KB 초과 — 캐시만 포기하고 응대는 계속');
reset();
BODY['dl://l0_13']='가'.repeat(200*1024);
p=sandbox.accLoadPrefix_();
ok('프리픽스는 정상 반환', !!p && p.length>100*1024);
fetches=[];fetchAllCalls=[];
sandbox.accLoadPrefix_();
ok('캐시 미저장 → 다음 호출은 다시 받음', fetchAllCalls.length===1);
BODY['dl://l0_13']='헌법 v1.3 본문';

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
