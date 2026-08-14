/**
 * CS_인콜 감시원 — 강남언니 예약 알림 파싱 + OK차트 대조 + 스레드 초안 (cs_incall.gs)
 *
 * 목적(원장 비전 260814): "슬랙 CS_인콜에 알림이 뜨면 OK차트 예약상황과 대조해가면서
 * 응대하는, 진짜 직원처럼." 그 1호 — 예약 알림은 이름·연락처·희망시간이 전부 텍스트라
 * 대조가 완전 자동이 된다.
 *
 * 흐름: 슬랙 Events(#cs_인콜 봇 메시지) → doPost → aciHandle_(text)
 *       → 예약 알림이면 희망 시각별 기존 예약을 큐로 조회 → 같은 스레드에 대조+초안 게시.
 *
 * 판단 원칙:
 *   - "가능/불가"를 단정하지 않는다. 베드·원장 수에 따라 같은 시각 중복 예약이 정상일 수
 *     있다 — 우리는 "그 시각 기존 예약 N건"이라는 사실만 붙이고 판단은 직원이 한다.
 *   - 조회 실패(null)는 "기존 예약 없음"이 아니라 "확인 불가"로 표기한다(모름 ≠ 없음).
 *   - 게시는 원내 채널(실명 허용). 환자 대면 발송은 하지 않는다 — 발송은 직원이
 *     강남언니 앱에서 한다(공개 API 없음). 초안은 복붙용이다.
 *   - 상담 알림(본문 없음)은 조용히 무시한다 — 본문 없는 초안은 지어내기가 된다.
 */

/**
 * 알림 1건 파싱 (순수 함수).
 * 반환: {kind:'resv', name, phone, slots:[{date:'YYYY-MM-DD', time:'HH:MM', raw}]}
 *     | {kind:'consult'} | {kind:'other'}
 */
function aciParse_(raw) {
  var t = String(raw || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  if (t.indexOf('강남언니 예약') >= 0) {
    // 형식: "이름 · 010-.... · (병원)" 줄 + "희망: 1. 2026. 8. 15 (토) 오후 1:00 | 2. ..."
    var name = '', phone = '';
    var line = t.match(/\n([^\n·]+)·([^·\n]+)·/);
    if (line) { name = line[1].trim(); phone = line[2].trim(); }
    var slots = [];
    var re = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})[^\d]*?(오전|오후)\s*(\d{1,2}):(\d{2})/g;
    var m;
    while ((m = re.exec(t))) {
      var h = Number(m[5]) % 12 + (m[4] === '오후' ? 12 : 0);
      slots.push({
        date: m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2),
        time: ('0' + h).slice(-2) + ':' + m[6],
        raw: m[2] + '/' + m[3] + ' ' + m[4] + ' ' + m[5] + ':' + m[6]
      });
    }
    if (slots.length) return { kind: 'resv', name: name, phone: phone, slots: slots };
    return { kind: 'other' };   // 예약인데 시각을 못 읽으면 조용히 물러난다 — 오독 초안 금지
  }
  if (t.indexOf('강남언니 상담') >= 0) return { kind: 'consult' };
  return { kind: 'other' };
}

/**
 * 대조 결과 → 스레드 게시문 (순수 함수).
 * bookedByDate: {'YYYY-MM-DD': ['HH:MM',...] | null}  — acqBookedTimes_ 결과. null = 확인 불가.
 */
function aciDraft_(p, bookedByDate) {
  var lines = ['🤖 예약 대조 (강남언니) — ' + (p.name || '이름미상') + ' ' + (p.phone || '')];
  var firstFree = null;
  for (var i = 0; i < p.slots.length; i++) {
    var s = p.slots[i];
    var booked = bookedByDate[s.date];
    var mark;
    if (booked === null || booked === undefined) mark = '확인 불가(큐 미응답)';
    else {
      var n = 0;
      for (var k = 0; k < booked.length; k++) if (booked[k] === s.time) n++;
      mark = n ? '기존 예약 ' + n + '건 있음' : '기존 예약 없음';
      if (!n && !firstFree) firstFree = s;
    }
    lines.push('· ' + s.raw + ' — ' + mark);
  }
  // 답장 문구는 만들지 않는다(원장 판정 260814 — 강남언니 예약은 채팅 답장이 아니라
  // 앱에서 확정 처리라 문구는 쓸 데가 없다). 필요한 건 판단 재료뿐이다.
  lines.push(firstFree
    ? '→ 제안: ' + firstFree.raw + ' (기존 예약 없음)'
    : '→ 희망 시각 전부 기존 예약 있음 또는 확인 불가 — 직원 판단 필요');
  lines.push('(참고용 — 베드·원장 배정에 따라 같은 시각도 가능할 수 있음. 확정 처리는 직원이.)');
  return lines.join('\n');
}

/**
 * 진입점 (허브 doPost가 부른다). 예약 알림이면 대조문 문자열 반환, 아니면 null(무동작).
 * 날짜별로 acqBookedTimes_ 재사용(내부적으로 named_query `resv_list`) — 시각 정규화와
 * null 규율(모름 ≠ 없음)을 그대로 물려받는다. 희망 3슬롯은 보통 같은 날이라 조회 1건이다.
 * ⚠ 선행조건: 워커에 `resv_list` 등록(정의: acro okchart/named_queries.md). 미등록이면
 *   전부 null → "확인 불가"로 게시된다(조용히 틀리지 않는다).
 */
function aciHandle_(text) {
  var p = aciParse_(text);
  if (p.kind !== 'resv') return null;
  var bookedByDate = {};
  for (var i = 0; i < p.slots.length; i++) {
    var d = p.slots[i].date;
    if (!(d in bookedByDate)) bookedByDate[d] = acqBookedTimes_(d);
  }
  return aciDraft_(p, bookedByDate);
}
