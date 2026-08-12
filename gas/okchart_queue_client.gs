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
