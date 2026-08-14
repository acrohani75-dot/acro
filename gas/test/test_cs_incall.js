// cs_incall.gs 검증 — 실제 #cs_인콜 알림 원문 형태 그대로 넣는다 (260814 실측)
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
let bookedScript={};   // {date: [...]|null}
const sandbox={
  acqBookedTimes_:d=>(d in bookedScript?bookedScript[d]:null),
  JSON,Object,String,Array,Math,Number,RegExp,Error,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(G('cs_incall.gs'),'utf8'),sandbox);

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};

// 실측 원문 (슬랙 검색 260814 — HTML 엔티티 포함)
const RESV=`\n:blush: *강남언니 예약*\n문채원 · 010-2610-0825 · (병원)\n희망: 1. 2026. 8. 15 (토) 오후 1:00\n | 2. 2026. 8. 15 (토) 오후 1:30\n | 3. 2026. 8. 15 (토) 오후 2:00\n`;
const CONSULT=`\n:blush: *강남언니 상담* :jp:\n&lt;제목: @gangnamsister&gt; \n[Web발신]\n채팅상담이 접수되었습니다.\n\n상담경로: Acro ダイエット カプセル 韓方\n상담유형: イベント\n상담번호: 9440856\n`;

console.log('1) 파싱 — 실측 원문');
let p=sandbox.aciParse_(RESV);
ok('예약 알림 인식', p.kind==='resv');
ok('이름·전화 추출', p.name==='문채원' && p.phone==='010-2610-0825');
ok('슬롯 3개', p.slots.length===3);
ok('오후 1:00 → 13:00 / 날짜 ISO', p.slots[0].date==='2026-08-15' && p.slots[0].time==='13:00');
ok('오후 2:00 → 14:00', p.slots[2].time==='14:00');
ok('상담 알림은 consult(본문 없음 — 초안 금지)', sandbox.aciParse_(CONSULT).kind==='consult');
ok('무관한 메시지는 other', sandbox.aciParse_('오늘 결산 제출했습니다').kind==='other');
ok('오전 11:00 → 11:00', sandbox.aciParse_('강남언니 예약\n김a · 010-1 · (병원)\n희망: 1. 2026. 9. 1 (화) 오전 11:00')
   .slots[0].time==='11:00');
ok('오후 12:00 → 12:00 (정오)', sandbox.aciParse_('강남언니 예약\n김a · 010-1 · (병원)\n희망: 1. 2026. 9. 1 (화) 오후 12:00')
   .slots[0].time==='12:00');
ok('예약인데 시각 못 읽으면 other(오독 초안 금지)',
   sandbox.aciParse_('강남언니 예약\n누군가 · 010-2 · (병원)\n희망: 미정').kind==='other');

console.log('2) 대조문 — 사실만 붙이고 단정하지 않는다');
let d=sandbox.aciDraft_(p,{'2026-08-15':['13:30','10:00','13:30']});
ok('빈 시각은 "기존 예약 없음"', d.includes('8/15 오후 1:00 — 기존 예약 없음'));
ok('겹친 시각은 건수로(2건)', d.includes('8/15 오후 1:30 — 기존 예약 2건 있음'));
ok('가능/불가 단정 없음 + 직원 확정 문구', !d.includes('불가') && d.includes('확정은 직원이'));
ok('첫 빈 시각으로 답장 초안', d.includes('답장 초안') && d.includes('8/15 오후 1:00 시간으로'));
d=sandbox.aciDraft_(p,{'2026-08-15':null});
ok('조회 실패는 "확인 불가"(없음이 아님)', d.includes('확인 불가') && !d.includes('기존 예약 없음'));
ok('전부 확인 불가면 초안 대신 직원 판단 요청', d.includes('직원 판단'));
d=sandbox.aciDraft_(p,{'2026-08-15':['13:00','13:30','14:00']});
ok('전부 차 있으면 초안 없이 직원 판단', d.includes('직원 판단') && !d.includes('답장 초안'));

console.log('3) 진입점 — 큐 결합');
bookedScript={'2026-08-15':['13:30']};
let out=sandbox.aciHandle_(RESV);
ok('예약 알림 → 대조문 반환', out && out.includes('기존 예약 없음') && out.includes('문채원'));
ok('상담 알림 → null(무동작)', sandbox.aciHandle_(CONSULT)===null);
ok('일반 메시지 → null', sandbox.aciHandle_('메모')===null);
bookedScript={'2026-08-15':null};
ok('큐 미응답 → 확인 불가로 게시(침묵 아님)', sandbox.aciHandle_(RESV).includes('확인 불가'));

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
