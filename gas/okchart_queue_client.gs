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
  // 폴링 간격 — 평탄한 20초는 최대 20초를 그냥 버린다. 워커 주간 폴링이 15초라
  // 그 전에는 어차피 결과가 없고, 그 다음부터는 촘촘히 본다. 마지막 값을 상한까지 반복.
  POLL_STEPS_MS: [15000, 5000, 5000, 5000, 5000, 10000, 20000],
  MAX_WAIT_MS: 180000  // 총 대기 상한 180초
};

/** named_query 여러 건을 **한 번에** 제출하고 같이 기다린다.
 *  순차 호출(59초 × N)이 아니라 제출을 병렬화해 N건이 1건과 같은 시간에 끝난다.
 *  반환: jobs와 같은 길이의 배열. 각 원소는 result 또는 null(실패·타임아웃).
 *  jobs: [{name, params}, ...] */
function acqQueryMulti_(jobs) {
  var out = (jobs || []).map(function () { return null; });
  try {
    if (!out.length) return out;
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('OKQ_URL'), token = props.getProperty('OKQ_TOKEN');
    if (!url || !token) return out;

    // 1) 제출 — 전부 한 번에
    var subs = jobs.map(function (j) {
      return {
        url: url, method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ token: token, action: 'submit',
          job: { type: 'named_query', name: String(j.name), params: j.params || {} } }),
        muteHttpExceptions: true
      };
    });
    var srs = UrlFetchApp.fetchAll(subs);
    var pending = [];   // {i, id}
    for (var i = 0; i < srs.length; i++) {
      if (srs[i].getResponseCode() !== 200) continue;
      var id = (JSON.parse(srs[i].getContentText() || '{}') || {}).id;
      if (id) pending.push({ i: i, id: id });
    }
    if (!pending.length) return out;

    // 2) 폴링 — 남은 잡만 묶어서 한 번에
    var waited = 0, step = 0;
    while (pending.length && waited < ACQ_CFG.MAX_WAIT_MS) {
      var ms = ACQ_CFG.POLL_STEPS_MS[Math.min(step, ACQ_CFG.POLL_STEPS_MS.length - 1)];
      step++;
      Utilities.sleep(ms);
      waited += ms;
      var reqs = pending.map(function (p) {
        return { url: url + '?token=' + encodeURIComponent(token)
          + '&action=result&id=' + encodeURIComponent(p.id), muteHttpExceptions: true };
      });
      var rrs = UrlFetchApp.fetchAll(reqs);
      var still = [];
      for (var k = 0; k < pending.length; k++) {
        if (rrs[k].getResponseCode() !== 200) { still.push(pending[k]); continue; }  // 일시 오류는 재시도
        var j2 = JSON.parse(rrs[k].getContentText() || '{}') || {};
        if (j2.status === 'done') { out[pending[k].i] = (j2.result === undefined) ? null : j2.result; continue; }
        if (j2.status === 'error') continue;        // 워커가 거부한 잡 — 재시도 무의미
        still.push(pending[k]);
      }
      pending = still;
    }
    return out;                                     // 상한 초과분은 null — 실측 없이 진행
  } catch (e) {
    return out;
  }
}

/** named_query 1건. 성공 시 result, 그 외 전부 null */
function acqQuery_(name, params) {
  return acqQueryMulti_([{ name: name, params: params }])[0];
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
  // 3건을 한 번에 — 순차로 돌리면 대기가 3배가 된다(환자는 그 시간을 그대로 기다린다).
  // 본인 확인 전에 나머지도 같이 조회하지만, 확인 실패면 전부 버린다(아래 즉시 반환).
  var r = acqQueryMulti_([
    { name: 'patient_verify', params: params },
    { name: 'recent_treatments', params: params },
    { name: 'reservations', params: params }
  ]);
  var v = r[0];
  if (!v || (Array.isArray(v) && !v.length)) return '';
  var lines = ['## 환자 실측(전산 · 내부 재료 — 원문을 환자에게 노출 금지)',
               '환자 확인: 재진(전산 기록 있음)'];
  if (r[1] && r[1].length) lines.push('최근 진료: ' + JSON.stringify(r[1]).slice(0, 800));
  if (r[2] && r[2].length) lines.push('예약: ' + JSON.stringify(r[2]).slice(0, 400));
  return lines.join('\n');
}
