/**
 * 바비톡 인입 카드 → 모든코디 기입안 (babitalk_incall.gs)
 *
 * 목적(원장 확정 260829 「모든코디(콜 업무) 개편 안내」 ③):
 *   "슬랙에 인입 카드가 뜨는 건은 아크로드가 모든코디에 먼저 기입합니다."
 *   상담자 칸은 아크로드 · 불확실한 칸에는 (코디 확인 필요) 꼬리표 · 기존 이력은 append만.
 *
 * 흐름: 슬랙 Events(#cs_인콜 아크로인입봇 카드) → doPost → abtHandle_(text)
 *       → 기입 대상이면 {fields, command, dedupeKey} 반환 → 허브의 기존 `모든코디:` 처리기가 기입.
 *
 * ⚠ 이 파일은 **쓰지 않는다.** 카드 텍스트를 필드로 바꾸는 순수 함수만 있다.
 *   실제 OK차트 기입은 이미 검증된 허브 경로(집PC 세션 260829 dry-run 확인, 큐 2행)가 한다.
 *   DB는 SELECT 전용 원칙이 있고, 쓰기는 워커의 별도 경로다 — 여기서 새로 만들지 않는다.
 *
 * 판단 원칙:
 *   - 이름·전화가 둘 다 안 읽히면 기입안을 만들지 않는다(null). 지어낸 행은 지우기가 더 비싸다.
 *   - 차트번호는 여기서 추측하지 않는다. 전화·이름으로 명부 대조하는 건 허브 몫이고,
 *     이 파서는 UrlFetch를 한 번도 쓰지 않는다(차트 줍기 UrlFetch 폭증 이력 260828).
 *   - 유입은 '바비톡'으로 확정 — 카드 출처가 곧 유입경로라 추정이 아니다.
 *   - 환불·광고 공지 등 고객 인입이 아닌 카드는 조용히 물러난다.
 */

var ABT_CFG = {
  INFLOW: '바비톡',          // 모든코디 유입 칸
  COUNSELOR: '아크로드',      // 상담자 칸 — 코디가 본인 이름으로 바꾸면 그게 검수 완료
  NEED_TAG: '(코디 확인 필요)',
  DEDUPE_SEC: 21600          // 6시간. 슬랙 재전송·같은 카드 재게시로 두 번 기입되는 걸 막는다
};

/** 기입 대상 카드 3종. 검사 순서가 중요하다 —
 *  '카톡상담 신규 DB 인입 알림'은 '신규 DB 인입 알림'을 포함하므로 긴 것을 먼저 본다. */
var ABT_KINDS = [
  { kind: 'db_kakao', head: '카톡상담 신규 DB 인입 알림', label: '신규DB(카톡)' },
  { kind: 'db',       head: '신규 DB 인입 알림',          label: '신규DB(전화)' },
  { kind: 'sale',     head: '이벤트결제 시술권 판매완료',  label: '시술권 결제' }
];

/** 고객 인입이 아닌 카드 — 인식은 하되 기입하지 않는다(고객명이 아예 없다). */
var ABT_SKIP_HEADS = ['이벤트결제 환불 알림'];

/** 한 줄 라벨 값 읽기. 줄 시작에 붙은 라벨만 본다 —
 *  '고객명'으로 '상담 요청 고객명' 줄을 잘못 집는 걸 막는다. */
function abtField_(text, label) {
  var m = String(text || '').match(new RegExp('^[ \\t>]*' + label + '\\s*[:：]\\s*(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

/** 전화번호 정규화. 010 11자리만 하이픈을 넣고, 그 외는 원문 그대로 둔다(임의 가공 금지). */
function abtPhone_(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.slice(0, 3) === '010') return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (d.length === 10 && d.slice(0, 2) === '01') return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return String(raw || '').trim();
}

/** 사람 이름으로 볼 수 있는가. 숫자·기호만이면 거른다(라벨 오독 방어). */
function abtNameOk_(s) {
  var v = String(s || '').trim();
  if (!v || v.length > 20) return false;
  return /[가-힣A-Za-z぀-ヿ一-鿿]/.test(v);
}

/**
 * 카드 1건 파싱 (순수 함수).
 * 반환: {kind:'db'|'db_kakao'|'sale', label, name, phone, event, want, option, amount, orderNo}
 *     | {kind:'refund'|'notice'|'other'}
 */
function abtParse_(raw) {
  var t = String(raw || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // 바비톡 봇 카드인지부터. 원장·직원이 본문에 '바비톡'을 언급한 글까지 집으면 안 된다.
  if (!/\*바비톡\*/.test(t) && t.indexOf('바비톡 파트너스') < 0) return { kind: 'other' };

  for (var s = 0; s < ABT_SKIP_HEADS.length; s++) {
    if (t.indexOf(ABT_SKIP_HEADS[s]) >= 0) return { kind: 'refund' };
  }

  for (var i = 0; i < ABT_KINDS.length; i++) {
    var k = ABT_KINDS[i];
    if (t.indexOf(k.head) < 0) continue;
    var name = abtField_(t, '상담 요청 고객명') || abtField_(t, '고객명');
    var phone = abtField_(t, '고객 전화번호');
    if (!abtNameOk_(name) || !phone) return { kind: 'notice' };  // 라벨이 없으면 카드 형식이 바뀐 것
    return {
      kind: k.kind, label: k.label,
      name: name, phone: abtPhone_(phone),
      event: abtField_(t, '이벤트명'),
      want: abtField_(t, '상담요청시간'),
      option: abtField_(t, '구입옵션명'),
      amount: abtField_(t, '판매금액'),
      orderNo: abtField_(t, '주문번호')
    };
  }
  return { kind: 'notice' };   // 바비톡 카드이긴 하나 광고·정산 공지 — 기입 대상 아님
}

/** 금액 3자리 쉼표. 숫자가 아니면 원문 그대로. */
function abtWon_(v) {
  var d = String(v || '').replace(/[^0-9]/g, '');
  if (!d) return String(v || '').trim();
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

/**
 * 파싱 결과 → 모든코디 기입안 필드 (순수 함수).
 * 반환: {name, chart, chartExpected:false, phone, inflow, counselor, content, needs:[...]}
 *
 * chart는 항상 '' 이고 needs에도 넣지 않는다.
 * 원장 판정 260829: **차트번호는 진료를 해야 부여된다 — 인입 단계에 없는 게 정상이다.**
 * 그래서 차트 빈 칸에 (코디 확인 필요) 꼬리표를 붙이지 않는다. 매 건 달리면 그냥 소음이 되고,
 * 진짜 확인이 필요한 칸의 꼬리표까지 같이 무시당한다.
 * (재구매 환자라 명부에 있으면 허브가 대조해 채운다 — 못 찾아도 경고 없이 그냥 비운다.)
 */
function abtCodi_(p) {
  var needs = [];
  var bits = [ABT_CFG.INFLOW + ' ' + p.label];
  if (p.event) bits.push(p.event);

  if (p.kind === 'sale') {
    if (p.option) bits.push(p.option);
    if (p.amount) bits.push(abtWon_(p.amount));
    if (p.orderNo) bits.push('주문 ' + p.orderNo);
    bits.push('내원예약 상담 필요');
  } else if (p.kind === 'db_kakao') {
    bits.push('카카오톡 1:1 채팅 확인');
    bits.push('전화·카톡 중복 연락 주의');
  } else {
    if (p.want) bits.push('상담요청 ' + p.want);
    else needs.push('상담 희망시간');
  }
  if (!p.event) needs.push('이벤트명');

  var content = bits.join(' · ');
  if (needs.length) content += ' ' + ABT_CFG.NEED_TAG + ': ' + needs.join(' · ');

  return {
    name: p.name, chart: '', chartExpected: false, phone: p.phone,
    inflow: ABT_CFG.INFLOW, counselor: ABT_CFG.COUNSELOR,
    content: content, needs: needs
  };
}

/** 같은 카드가 두 번 와도 두 번 기입하지 않기 위한 키. 전화+종류+주문번호로 잡는다.
 *  신규DB→판매완료처럼 같은 고객의 다른 단계는 서로 다른 건이므로 종류를 키에 넣는다. */
function abtDedupeKey_(p) {
  return ['babitalk', p.kind, String(p.phone || '').replace(/[^0-9]/g, ''), p.orderNo || ''].join('|');
}

/** 이미 처리한 카드인가. 처음 보는 키면 표시하고 false. 캐시가 없으면 막지 않는다(false). */
function abtSeen_(key) {
  try {
    var c = CacheService.getScriptCache();
    if (!c) return false;
    if (c.get(key)) return true;
    c.put(key, '1', ABT_CFG.DEDUPE_SEC);
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 진입점 (허브 doPost가 #cs_인콜 봇 메시지마다 부른다).
 * 반환: null(무동작) | {fields, command, dedupeKey, kind}
 *
 * ⚠ 슬랙 `ㄱ` 승인 단계는 **없다**(원장 확정 260829). 인입 카드 건은 바로 기입하고,
 *   판정은 모든코디 화면에서 한다 — 코디가 상담자 칸을 본인 이름으로 바꾸는 게 검수 완료다.
 *   승인 대기 카드를 슬랙에 쌓는 건 같은 판정을 두 곳에서 두 번 하게 만드는 짓이다.
 *
 * 허브 결선 — 둘 중 하나만 고른다:
 *   (권장) fields를 기존 모든코디 기입 함수에 그대로 넘긴다. 문자열 왕복이 없어 오독이 없다.
 *   (대안) command 문자열을 기존 `모든코디:` 명령 처리기에 넣는다. 원장이 손으로 치던 그 형식이라
 *          경로가 이미 검증돼 있다. 다만 **차트 미상 자리를 `-`로 비우는 표기가 그 처리기에서
 *          통하는지 1건 확인하고 쓸 것** — 통하지 않으면 fields 경로를 쓴다.
 */
function abtHandle_(text) {
  var p = abtParse_(text);
  if (p.kind !== 'db' && p.kind !== 'db_kakao' && p.kind !== 'sale') return null;
  var key = abtDedupeKey_(p);
  if (abtSeen_(key)) return null;
  var f = abtCodi_(p);
  return {
    kind: p.kind,
    fields: f,
    dedupeKey: key,
    command: ['모든코디', ': ', f.name, ' / ', (f.chart || '-'), ' / ', f.inflow, ' / ', f.content].join('')
  };
}
