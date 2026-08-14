// line_handoff.gs 검증 — 핵심: 기존 발송 기호(!·!!)와 절대 안 섞이는 # 토글, 경합 방지
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
let propsStore={};
const sandbox={
  PropertiesService:{getScriptProperties:()=>({
    getProperty:k=>propsStore[k]||null,
    setProperty:(k,v)=>{propsStore[k]=String(v);},
    deleteProperty:k=>{delete propsStore[k];}
  })},
  Date, JSON,Object,String,Array,Math,Number,RegExp,Error,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(G('line_handoff.gs'),'utf8'),sandbox);

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};
const T0=1_000_000_000_000, TTL=sandbox.ALH_CFG.TTL_MS;
const P=t=>sandbox.alhParseCommand_(t).type;

console.log('1) 파서 — 기호 지형(발송 !·!! 은 기존 브릿지 소유, 토글은 #)');
ok('★표시 없는 글 = note(아무 일도 없음)', P('내일 전화드리기로 함. 김실장 확인')==='note');
ok('# 단독 = toggle', P('#')==='toggle');
ok('공백 허용', P(' # ')==='toggle');
ok('# 뒤에 말 붙으면 note(해시태그 메모 안전)', P('#메모 배송지변경')==='note');
ok('## 도 note', P('##')==='note');
ok('! + 본문 = staff_send(번역 발송 — 기존 경로)', P('!안녕하세요 예약 도와드릴게요')==='staff_send');
ok('!! + 본문 = staff_send(무번역 발송 — 기존 경로)', P('!!こんにちは')==='staff_send');
ok('! 단독은 note(빈 발송 아님)', P('!')==='note');
ok('!! 단독도 note', P('!!')==='note');
ok('문장 중간 기호는 무시', P('오늘 ! 표시 관련 회의')==='note');

console.log('2) # 토글 — 온오프 버튼');
propsStore={};
let r=sandbox.alhHandleSlackCommand_('#','U1','김실장',T0);
ok('첫 # = 멈춤(hold 해소)', r.type==='hold' && r.via==='toggle'
   && sandbox.alhIsHeld_('U1',T0+1)===true);
r=sandbox.alhHandleSlackCommand_('#','U1','김실장',T0+1000);
ok('두 번째 # = 재개(release 해소)', r.type==='release'
   && sandbox.alhIsHeld_('U1',T0+2000)===false);
r=sandbox.alhHandleSlackCommand_('#','U1','김실장',T0+3000);
ok('세 번째 # = 다시 멈춤', r.type==='hold' && sandbox.alhIsHeld_('U1',T0+4000)===true);
r=sandbox.alhHandleSlackCommand_('#','U1','김실장',T0+3000+TTL+1);
ok('TTL로 이미 풀린 뒤 # = 멈춤(재개 아님 — 실제 상태 기준)', r.type==='hold');

console.log('3) 직원 발송(!·!!) = 자동 홀드/연장');
propsStore={};
r=sandbox.alhHandleSlackCommand_('!산田様、確認いたします','U2','박코디',T0);
ok('발송하면 홀드 자동 시작', r.type==='staff_send' && sandbox.alhIsHeld_('U2',T0+1)===true);
sandbox.alhHandleSlackCommand_('!!追記です','U2','박코디',T0+TTL-1000);
ok('추가 발송이 홀드 연장', sandbox.alhIsHeld_('U2',T0+TTL+1000)===true);
r=sandbox.alhHandleSlackCommand_('메모: 내일 재확인','U2','박코디',T0+TTL+2000);
ok('note는 홀드를 건드리지 않음(연장 안 됨)', r.type==='note'
   && sandbox.alhIsHeld_('U2',(T0+TTL-1000)+TTL+1)===false);

console.log('4) 홀드 생명주기');
propsStore={};
ok('초기 상태 = 홀드 아님', sandbox.alhIsHeld_('U1',T0)===false);
sandbox.alhHold_('U1','김실장',T0);
ok('환자별 독립(다른 환자는 정상)', sandbox.alhIsHeld_('U2',T0+1000)===false);
ok('TTL 직전까지 유지', sandbox.alhIsHeld_('U1',T0+TTL-1)===true);
ok('TTL 지나면 자동 복귀', sandbox.alhIsHeld_('U1',T0+TTL+1)===false);
ok('만료 키는 정리됨', !propsStore['ALH_HOLD_U1']);
sandbox.alhHold_('U1','김실장',T0);
sandbox.alhRelease_('U1');
ok('release 즉시 복귀', sandbox.alhIsHeld_('U1',T0+1000)===false);

console.log('5) 경합 방지 — 발송 직전 최종 관문');
propsStore={};
ok('평시 발송 허용', sandbox.alhMaySend_('U1',T0)===true);
// AI가 응답 생성하는 사이 직원이 # — 생성된 응답은 버려야 한다
sandbox.alhHandleSlackCommand_('#','U1','김실장',T0+3000);
ok('★생성 중 홀드 걸리면 발송 차단', sandbox.alhMaySend_('U1',T0+5000)===false);
ok('TTL 후 다시 허용', sandbox.alhMaySend_('U1',T0+3000+TTL+1)===true);

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
