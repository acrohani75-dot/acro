/**
 * OK차트 클라우드 큐 클라이언트 — 접점 GAS 공용 모듈 (게이트웨이 v2 §2.6)
 *
 * 경로: 접점 GAS → okchart-queue 웹앱 → [원장 PC 워커 v1.9.1] → SQL Server(읽기전용)
 * named_query만 허용(자유 SQL은 워커가 차단):
 *   patient_verify / reservations / package_status / recent_treatments / recent_rx
 *
 * 속성(Script Properties — 값은 코드·리포에 절대 넣지 않는다):
 *   OKQ_URL   큐 웹앱 /exec URL
 *   OKQ_TOKEN 큐 토큰
 *
 * 원칙: 실패·타임아웃·미설정은 전부 null — 응대는 실측 없이도 돈다(조용한 생략).
 *   환자에게 조회 지연·오류를 노출하지 않는다.
 * 야간 주의: 워커 폴링이 야간 300초라 대기 상한(180초) 안에 못 돌아올 수 있다 —
 *   야간 자동응대는 실측 조회 생략이 기본이다(설계 §2.6).
 *
 * 응답 계약 가정(큐 GAS v1.2 기준 — 필드명이 다르면 아래 done/error 판정부만 맞출 것):
 *   submit → {id: "..."} / result 폴링 → {status: "pending|processing|done|error", result: ...}
 */

var ACQ_CFG = {
  POLL_MS: 20000,      // 폴링 간격 20초 (허브 실측 권장)
  MAX_WAIT_MS: 180000  // 총 대기 상한 180초
};

/** named_query 실행. 성공 시 result, 그 외 전부 null */
function acqQuery_(name, params) {
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('OKQ_URL'), token = props.getProperty('OKQ_TOKEN');
    if (!url || !token) return null;
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ token: token, action: 'submit',
        job: { type: 'named_query', name: String(name), params: params || {} } }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var id = (JSON.parse(res.getContentText() || '{}') || {}).id;
    if (!id) return null;
    var waited = 0;
    while (waited < ACQ_CFG.MAX_WAIT_MS) {
      Utilities.sleep(ACQ_CFG.POLL_MS);
      waited += ACQ_CFG.POLL_MS;
      var r = UrlFetchApp.fetch(url + '?token=' + encodeURIComponent(token)
        + '&action=result&id=' + encodeURIComponent(id), { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) continue;   // 일시 오류는 다음 폴링에서 재시도
      var j = JSON.parse(r.getContentText() || '{}') || {};
      if (j.status === 'done') return (j.result === undefined) ? null : j.result;
      if (j.status === 'error') return null;       // 워커가 거부한 잡 — 재시도 무의미
    }
    return null;                                   // 상한 초과(야간 등) — 실측 없이 진행
  } catch (e) {
    return null;
  }
}

/** 예약된 시각 목록 (HH:MM). 조회 실패면 **null** — 빈 배열이 아니다.
 *  null과 []의 구별이 안전의 핵심이다: []는 "예약이 하나도 없다", null은 "모른다".
 *  모르는 상태에서 슬롯을 제시하면 중복 예약이 된다. */
function acqBookedTimes_(dateStr) {
  var rows = acqQuery_('resv_list', { d: String(dateStr) });
  if (!rows || !Array.isArray(rows)) return null;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var t = String((r && (r.Res_Time_0 !== undefined ? r.Res_Time_0 : r[0])) || '').trim();
    if (t) out.push(t.slice(0, 5));
  }
  return out;
}

/** 빈 슬롯 = 후보 슬롯 − 예약된 시각.
 *  candidates는 **브릿지의 기존 영업시간 모듈**이 만든다 — 여기서 영업시간을 새로 정의하지
 *  않는다(요일·공휴일 규칙이 갈라지면 260806 반일 오판 같은 사고가 반복된다).
 *  조회 실패(null)면 null을 그대로 돌려준다 — 호출부는 슬롯을 제시하지 말고
 *  "직원이 확인 후 안내드리겠습니다"로 넘겨야 한다. */
function acqFreeSlots_(dateStr, candidates) {
  var booked = acqBookedTimes_(dateStr);
  if (booked === null) return null;
  var taken = {};
  for (var i = 0; i < booked.length; i++) taken[booked[i]] = true;
  var free = [];
  for (var c = 0; c < (candidates || []).length; c++) {
    var s = String(candidates[c]).slice(0, 5);
    if (!taken[s]) free.push(s);
  }
  return free;
}

/** 예약 확정 게시 — 원내 채널에 1줄. **차트 쓰기는 하지 않는다**(INSERT 금지) —
 *  실제 예약 입력은 직원이 이 게시물을 보고 OK차트에 넣는다.
 *  채널 ID는 속성 OKQ_RESV_CHANNEL에서만 읽는다(리포에 값 금지). */
function acqPostReservation_(name, when, item) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_TOKEN'), ch = props.getProperty('OKQ_RESV_CHANNEL');
  if (!token || !ch) return false;
  var line = '[예약] ' + [name || '이름미상', when || '일시미상', item || '시술미상'].join(' / ');
  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: ch, text: line }),
    muteHttpExceptions: true
  });
  return res.getResponseCode() === 200;
}

/** 환자 실측 맥락 블록 — 프롬프트 [3.5]용. 본인 특정이 안 됐거나 조회 실패면 빈 문자열.
 *  주의(헌법 4): 결과는 내부 재료다 — 원문·타 환자 정보를 환자 메시지에 노출하지 않는다. */
function acqPatientContext_(params) {
  var v = acqQuery_('patient_verify', params);
  if (!v || (Array.isArray(v) && !v.length)) return '';
  var lines = ['## 환자 실측(전산 · 내부 재료 — 원문을 환자에게 노출 금지)',
               '환자 확인: 재진(전산 기록 있음)'];
  var tx = acqQuery_('recent_treatments', params);
  if (tx && tx.length) lines.push('최근 진료: ' + JSON.stringify(tx).slice(0, 800));
  var rs = acqQuery_('reservations', params);
  if (rs && rs.length) lines.push('예약: ' + JSON.stringify(rs).slice(0, 400));
  return lines.join('\n');
}
