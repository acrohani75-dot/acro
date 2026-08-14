// line_handoff.gs 검증 — 핵심은 "표시 없는 글은 아무 일도 안 일어난다"와 경합 방지
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

console.log('1) 명령 파서 — 발송 사고의 방어선');
let a=sandbox.alhParseCommand_('내일 전화드리기로 함. 김실장 확인');
ok('★표시 없는 글 = note(아무 일도 없음)', a.type==='note');
ok('발송 문구가 포함돼도 접두어가 아니면 note',
   sandbox.alhParseCommand_('이따 !발송 해야지').type==='note');
ok('!잠깐 = hold', sandbox.alhParseCommand_('!잠깐').type==='hold');
ok('!멈춤도 hold (동의어)', sandbox.alhParseCommand_('!멈춤').type==='hold');
ok('앞뒤 공백 허용', sandbox.alhParseCommand_('  !잠깐  ').type==='hold');
ok('!완료 = release', sandbox.alhParseCommand_('!완료').type==='release');
a=sandbox.alhParseCommand_('!발송 山田様、ご予約を承りました😊');
ok('!발송 + 텍스트 = send, 접두어 제거', a.type==='send' && a.text==='山田様、ご予約を承りました😊');
ok('!발송만 치면 note(빈 발송 방지)', sandbox.alhParseCommand_('!발송').type==='note');
ok('!잠깐 뒤에 말이 붙으면 note(오발동 방지)', sandbox.alhParseCommand_('!잠깐만요 다들').type==='note');

console.log('1b) !! 토글 — 온오프 버튼 (원장 확정 260814)');
ok('!! 단독 = toggle', sandbox.alhParseCommand_('!!').type==='toggle');
ok('공백 허용', sandbox.alhParseCommand_(' !! ').type==='toggle');
ok('!! 뒤에 말 붙으면 note(오발동 방지)', sandbox.alhParseCommand_('!! 잠깐만').type==='note');
ok('!!!는 note', sandbox.alhParseCommand_('!!!').type==='note');
propsStore={};
let tg=sandbox.alhHandleSlackCommand_('!!','U9','김실장',T0);
ok('첫 !! = 멈춤(hold로 해소)', tg.type==='hold' && tg.via==='toggle'
   && sandbox.alhIsHeld_('U9',T0+1)===true);
tg=sandbox.alhHandleSlackCommand_('!!','U9','김실장',T0+1000);
ok('두 번째 !! = 재개(release로 해소)', tg.type==='release'
   && sandbox.alhIsHeld_('U9',T0+2000)===false);
tg=sandbox.alhHandleSlackCommand_('!!','U9','김실장',T0+3000);
ok('세 번째 !! = 다시 멈춤', tg.type==='hold' && sandbox.alhIsHeld_('U9',T0+4000)===true);
tg=sandbox.alhHandleSlackCommand_('!!','U9','김실장',T0+3000+TTL+1);
ok('TTL로 이미 풀린 뒤 !! = 멈춤(재개 아님)', tg.type==='hold'
   && sandbox.alhIsHeld_('U9',T0+3000+TTL+2)===true);

console.log('2) 홀드 생명주기');
propsStore={};
ok('초기 상태 = 홀드 아님', sandbox.alhIsHeld_('U1',T0)===false);
sandbox.alhHold_('U1','김실장',T0);
ok('홀드 후 = 침묵', sandbox.alhIsHeld_('U1',T0+1000)===true);
ok('환자별 독립(다른 환자는 정상)', sandbox.alhIsHeld_('U2',T0+1000)===false);
ok('TTL 직전까지 유지', sandbox.alhIsHeld_('U1',T0+TTL-1)===true);
ok('TTL 지나면 자동 복귀', sandbox.alhIsHeld_('U1',T0+TTL+1)===false);
ok('만료 키는 정리됨', !propsStore['ALH_HOLD_U1']);
sandbox.alhHold_('U1','김실장',T0);
sandbox.alhRelease_('U1');
ok('!완료 즉시 복귀', sandbox.alhIsHeld_('U1',T0+1000)===false);

console.log('3) 진입점 — 판정과 상태가 같이 움직인다');
propsStore={};
let r=sandbox.alhHandleSlackCommand_('!잠깐','U1','김실장',T0);
ok('hold 반영', r.type==='hold' && sandbox.alhIsHeld_('U1',T0+1)===true);
r=sandbox.alhHandleSlackCommand_('메모: 환자가 배송지 변경 원함','U1','김실장',T0+1000);
ok('note는 홀드를 건드리지 않음', r.type==='note' && sandbox.alhIsHeld_('U1',T0+2000)===true);
r=sandbox.alhHandleSlackCommand_('!발송 こんにちは','U1','김실장',T0+TTL-1000);
ok('send는 홀드 갱신(직원 활동 = 연장)', r.type==='send'
   && sandbox.alhIsHeld_('U1',T0+TTL+1000)===true);
r=sandbox.alhHandleSlackCommand_('!완료','U1','김실장',T0+TTL+2000);
ok('release 반영', r.type==='release' && sandbox.alhIsHeld_('U1',T0+TTL+3000)===false);
r=sandbox.alhHandleSlackCommand_('!발송 안녕하세요','U3','박코디',T0);
ok('홀드 없던 환자도 send가 홀드를 건다', sandbox.alhIsHeld_('U3',T0+1)===true);

console.log('4) 경합 방지 — 발송 직전 최종 관문');
propsStore={};
ok('평시 발송 허용', sandbox.alhMaySend_('U1',T0)===true);
// AI가 응답 생성하는 사이 직원이 !잠깐 — 생성된 응답은 버려야 한다
sandbox.alhHandleSlackCommand_('!잠깐','U1','김실장',T0+3000);
ok('★생성 중 홀드 걸리면 발송 차단', sandbox.alhMaySend_('U1',T0+5000)===false);
ok('TTL 후 다시 허용', sandbox.alhMaySend_('U1',T0+3000+TTL+1)===true);

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
