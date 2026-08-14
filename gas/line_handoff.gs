/**
 * 라인 주간 응대 이어받기 — 홀드 상태기계 + 슬랙 명령 파서 (line_handoff.gs)
 *
 * 대상: 일본·대만 LINE (원장 확정 260814 "라인은 일본, 대만만이야. 우선 그렇게 해보자").
 * 목적: 근무시간에도 AI가 바로바로 답하되, 직원이 언제든 이어받을 수 있게 한다.
 *
 * 원칙 (원장 지시 260814):
 *   1. 슬랙 스레드에 **아무 표시 없이 쓴 글은 아무 일도 일으키지 않는다** (내부 메모).
 *      발송용 답과 헷갈리는 사고를 구조로 막는다 — 환자에게 나가는 것은 !발송 뿐이다.
 *   2. "잠깐 멈춰" 신호는 가볍게: `!잠깐` 한 단어. AI만 침묵하고 나머지는 그대로 돈다.
 *      직원이 LINE 관리자 앱으로 직접 응대하러 갈 때도 이걸 먼저 친다 — 관리자 앱 발송은
 *      웹훅에 안 잡혀서 AI가 모르기 때문에, 멈춤 신호가 유일한 충돌 방지선이다.
 *   3. 자유도 높게: 명령 단어·홀드 시간은 전부 ALH_CFG에서 바꾼다. 해보면서 조정한다.
 *
 * 상태 저장: ScriptProperties (CacheService는 임의 축출 위험 — 홀드가 풀리면 AI가
 *   직원 응대 중에 끼어드는 사고라 결정적 저장을 쓴다). 만료는 읽을 때 정리.
 *
 * 배선(허브 몫): 슬랙 Events → doPost → alhHandleSlackCommand_() 판정 → LINE push /
 *   홀드 조작. 브릿지 수신 경로에서는 응답 생성 전에 alhIsHeld_(), 발송 직전에 한 번 더.
 */

var ALH_CFG = {
  TTL_MS: 2 * 60 * 60 * 1000,   // 직원 마지막 활동 후 2시간 지나면 AI 자동 복귀
  CMD_HOLD: ['!잠깐', '!멈춤'],   // AI 침묵 (직원 이어받기 / LINE 앱 응대 예고)
  CMD_RELEASE: ['!완료', '!재개'], // AI 복귀
  CMD_SEND: '!발송'               // 이 접두어 뒤 텍스트만 환자에게 나간다
};

/** 홀드 여부. 만료됐으면 정리하고 false — 판정과 청소를 한 곳에서. */
function alhIsHeld_(userId, nowMs) {
  var key = 'ALH_HOLD_' + String(userId);
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty(key);
  if (!v) return false;
  var until = Number(String(v).split('|')[0]);
  if (!(until > (nowMs || Date.now()))) { props.deleteProperty(key); return false; }
  return true;
}

/** 홀드 시작/갱신. byWho는 기록용(슬랙 표시 이름 등) */
function alhHold_(userId, byWho, nowMs) {
  var until = (nowMs || Date.now()) + ALH_CFG.TTL_MS;
  PropertiesService.getScriptProperties()
    .setProperty('ALH_HOLD_' + String(userId), until + '|' + String(byWho || ''));
}

function alhRelease_(userId) {
  PropertiesService.getScriptProperties().deleteProperty('ALH_HOLD_' + String(userId));
}

/**
 * 슬랙 스레드 답글 1건 판정 (순수 함수 — I/O 없음).
 * 반환: {type:'hold'|'release'|'send'|'note', text?}
 *   hold/release — 홀드 조작만. send — text를 환자 LINE으로 발송(+홀드 갱신).
 *   note — **기본값. 아무 일도 안 일어난다.** 내부 메모는 자유롭게 쓰라는 뜻이다.
 */
function alhParseCommand_(raw) {
  var t = String(raw || '').trim();
  var i;
  for (i = 0; i < ALH_CFG.CMD_HOLD.length; i++)
    if (t === ALH_CFG.CMD_HOLD[i]) return { type: 'hold' };
  for (i = 0; i < ALH_CFG.CMD_RELEASE.length; i++)
    if (t === ALH_CFG.CMD_RELEASE[i]) return { type: 'release' };
  if (t.indexOf(ALH_CFG.CMD_SEND) === 0) {
    var body = t.slice(ALH_CFG.CMD_SEND.length).replace(/^\s+/, '');
    // 빈 !발송은 발송하지 않는다 — 실수로 접두어만 친 경우
    return body ? { type: 'send', text: body } : { type: 'note' };
  }
  return { type: 'note' };
}

/**
 * 판정 + 상태 반영까지 한 번에 (허브 doPost가 부르는 진입점).
 * send도 홀드를 건다/갱신한다 — 직원이 직접 답하는 동안 AI가 끼어들지 않게.
 * 반환값의 type이 'send'면 호출부가 text를 LINE push로 보낸다.
 */
function alhHandleSlackCommand_(raw, userId, staffName, nowMs) {
  var a = alhParseCommand_(raw);
  if (a.type === 'hold' || a.type === 'send') alhHold_(userId, staffName, nowMs);
  if (a.type === 'release') alhRelease_(userId);
  return a;
}

/**
 * AI 발송 직전 최종 관문. 수신 시점 검사와 별도로 **발송 직전에 한 번 더** 부른다 —
 * 응답 생성 중에 직원이 !잠깐을 쳤으면 그 응답은 버려야 한다(경합 방지).
 */
function alhMaySend_(userId, nowMs) {
  return !alhIsHeld_(userId, nowMs);
}
