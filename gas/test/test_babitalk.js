// babitalk_incall.gs 검증 — 실제 #cs_인콜 바비톡 카드 형태 그대로 (260829 실측 형식)
// ⚠ 공개 리포다. 이름·전화번호는 전부 가짜로 바꿔 넣는다(형식만 실측과 같다).
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
let cacheStore={};
const sandbox={
  CacheService:{getScriptCache:()=>({get:k=>cacheStore[k]||null,put:(k,v)=>{cacheStore[k]=v;}})},
  JSON,Object,String,Array,Math,Number,RegExp,Error,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(G('babitalk_incall.gs'),'utf8'),sandbox);

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};

const DB=`\n:blush: *바비톡* · 바비톡 파트너스\n[신규 DB 인입 알림:bell:]\n이벤트 상담 목적으로만 사용 가능한 정보입니다.\n\n이벤트명: ONDA 페이스 리프팅\n상담 요청 고객명: 홍길동\n고객 전화번호: 01000000001\n상담요청시간: 오후 상담\n\n감사합니다. `;
const KAKAO=`\n:blush: *바비톡* · 바비톡 파트너스\n[카톡상담 신규 DB 인입 알림:bell:]\n이벤트 상담 목적으로만 사용 가능한 정보입니다. 병원 공식 카카오톡 채널 1:1 채팅을 확인해주세요.\n\n이벤트명: 캡슐형태 맞춤 다이어트한약\n상담 요청 고객명: 김아무개\n고객 전화번호: 01000000002\n\n*전화/카카오톡 중복으로 연락하지 않도록 고객명을 확인해주세요.\n\n감사합니다. `;
const SALE=`\n:blush: *바비톡* · 바비톡 파트너스\n[이벤트결제 시술권 판매완료:bell:]\n시술권을 구입한 고객에게 내원예약을 위한 상담을 진행해주세요. 사용처리가 되지 않은 시술권은 유효기간 만료 시 자동환불됩니다.\n\n주문번호: E0000-0827-00000\n고객명: 이아무개\n고객 전화번호: 01000000003\n이벤트명: 바디 ONDA 리프팅\n구입옵션명: 바디온다 1만줄\n판매금액: 211000\n\n감사합니다. `;
const REFUND=`\n:blush: *바비톡* · 바비톡 파트너스\n[이벤트결제 환불 알림:bell:]\n고객님이 이벤트결제 시술권을 환불 요청했습니다.\n\n이벤트명: ONDA 페이스 리프팅\n환불옵션명: 온다 페이스 리프팅 1만줄\n주문번호: E0000-0824-00000\n환불 시술권 횟수: 2\n잔여 시술권 횟수: 0\n환불 신청 금액: 54000\n`;
const NOTICE=`\n:blush: *바비톡* · 바비톡 파트너스\n[푸시/팝업 정보 등록 마감 1일 전]\n구매하신 푸시/팝업 광고 정보가 아직 등록되지 않았습니다.\n\n- 병원명 : 아크로한의원\n- 구매 상품 : 쁘띠/피부\n\n감사합니다. `;
const LIVE=`\n:blush: *바비톡* · 바비톡 파트너스\n안녕하세요. 아크로한의원 담당자님.\n\n캡슐형태 맞춤 다이어트한약 이벤트가 라이브 되었습니다.\n\n감사합니다. `;
const NAVER=`\n:blush: *네이버 예약신청* · 아크로한의원, 예약신청\n조아무개님, ONDA 리프팅, 2026.09.04.(금) 오후 2:00, 새로운 예약이 접수되었습니다.`;

console.log('1) 파싱 — 카드 3종');
let d=sandbox.abtParse_(DB);
ok('신규 DB(전화) 인식', d.kind==='db');
ok('이름·전화·이벤트·희망시간', d.name==='홍길동' && d.phone==='010-0000-0001'
   && d.event==='ONDA 페이스 리프팅' && d.want==='오후 상담');
let k=sandbox.abtParse_(KAKAO);
ok('카톡상담이 신규DB(전화)로 오인되지 않는다(긴 머리글 우선)', k.kind==='db_kakao');
ok('카톡 카드는 상담요청시간 없음', k.want==='' && k.name==='김아무개');
let s=sandbox.abtParse_(SALE);
ok('시술권 판매완료 인식', s.kind==='sale');
ok('고객명/옵션/금액/주문번호', s.name==='이아무개' && s.option==='바디온다 1만줄'
   && s.amount==='211000' && s.orderNo==='E0000-0827-00000');
ok('"고객명"이 "상담 요청 고객명" 줄을 집지 않는다', sandbox.abtParse_(DB).name==='홍길동');

console.log('2) 기입하지 않는 것 — 조용히 물러난다');
ok('환불 알림은 refund(고객명 없음 → 행 못 만든다)', sandbox.abtParse_(REFUND).kind==='refund');
ok('광고 마감 공지는 notice', sandbox.abtParse_(NOTICE).kind==='notice');
ok('이벤트 라이브 안내는 notice', sandbox.abtParse_(LIVE).kind==='notice');
ok('네이버 카드는 other(바비톡 아님)', sandbox.abtParse_(NAVER).kind==='other');
ok('원장이 본문에 "바비톡"을 쓴 글은 other',
   sandbox.abtParse_('바비톡 광고비 정리해서 올려주세요').kind==='other');
ok('카드인데 이름 라벨이 사라지면 notice(형식 변경 → 지어내지 않는다)',
   sandbox.abtParse_(DB.replace('상담 요청 고객명','고객이름')).kind==='notice');
ok('전화번호가 없으면 notice', sandbox.abtParse_(DB.replace(/고객 전화번호.*\n/,'')).kind==='notice');

console.log('3) 기입안 필드 — 원장 확정 규칙');
let f=sandbox.abtCodi_(d);
ok('상담자는 아크로드', f.counselor==='아크로드');
ok('유입은 바비톡(추정 아님)', f.inflow==='바비톡');
ok('차트번호는 비운다 — 여기서 추측하지 않는다', f.chart==='');
ok('차트 빈 칸은 정상이라 표시한다(진료 전엔 번호가 없다 — 원장 판정 260829)',
   f.chartExpected===false && f.needs.indexOf('차트번호')<0);
ok('차트번호 꼬리표는 어느 카드에도 안 붙는다',
   [DB,KAKAO,SALE].every(x=>sandbox.abtCodi_(sandbox.abtParse_(x)).content.indexOf('차트')<0));
ok('내용에 종류·이벤트·희망시간', f.content.includes('바비톡 신규DB(전화)')
   && f.content.includes('ONDA 페이스 리프팅') && f.content.includes('상담요청 오후 상담'));
ok('아는 칸만 있으면 꼬리표 없음', f.needs.length===0 && f.content.indexOf('(코디 확인 필요)')<0);
let f2=sandbox.abtCodi_(sandbox.abtParse_(DB.replace(/상담요청시간.*\n/,'')));
ok('희망시간 없으면 (코디 확인 필요) 꼬리표',
   f2.needs.indexOf('상담 희망시간')>=0 && f2.content.includes('(코디 확인 필요): 상담 희망시간'));
let f3=sandbox.abtCodi_(k);
ok('카톡 건은 중복 연락 주의를 내용에 남긴다', f3.content.includes('전화·카톡 중복 연락 주의'));
let f4=sandbox.abtCodi_(s);
ok('판매 건은 금액 쉼표 + 내원예약 상담 필요',
   f4.content.includes('211,000원') && f4.content.includes('내원예약 상담 필요'));

console.log('4) 진입점 — 중복 방지');
cacheStore={};
let r=sandbox.abtHandle_(DB);
ok('카드 → 기입안 반환', r && r.fields.name==='홍길동' && r.kind==='db');
ok('명령 문자열은 원장이 치던 형식 그대로', r.command.indexOf('모든코디: 홍길동 / - / 바비톡 / ')===0);
ok('같은 카드 재수신은 null(두 번 기입 금지)', sandbox.abtHandle_(DB)===null);
ok('같은 고객의 다른 단계(판매완료)는 별건으로 통과', sandbox.abtHandle_(SALE)!==null);
ok('환불·공지·타 채널은 null', sandbox.abtHandle_(REFUND)===null
   && sandbox.abtHandle_(NOTICE)===null && sandbox.abtHandle_(NAVER)===null);
cacheStore={};
ok('캐시가 비면 다시 통과(캐시 만료 후 재기입은 허브 append 규칙이 받는다)',
   sandbox.abtHandle_(DB)!==null);

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
