/**
 * 라인 주간 응대 이어받기 — 홀드 상태기계 + 슬랙 명령 파서 (line_handoff.gs)
 *
 * 대상: 일본·대만 LINE (원장 확정 260814 "라인은 일본, 대만만이야. 우선 그렇게 해보자").
 * 목적: 근무시간에도 AI가 바로바로 답하되, 직원이 언제든 이어받을 수 있게 한다.
 *
 * ⚠ 기호 지형 (원장 확인 260814): 발송은 기존 브릿지 관례가 이미 소유한다 —
 *   `!<텍스트>` = 번역해서 발송, `!!<텍스트>` = 번역 없이 발송. **이 모듈은 발송을
 *   구현하지 않는다**(기존 발송 로직 불변·최소침습). 그래서 AI 토글은 `!` 계열을 피해
 *   `^`다(원장 확정 260822) — !·!!·!!!처럼 개수로 갈리면 세는 실수가 곧 오발송이 된다.
 *   ($는 한국어 모바일 키보드에서 ₩로 표시되는 경우가 있어 배제. #은 해시태그 메모와
 *   겹쳐 배제 — `^`는 슬랙에서 아무 서식도 만들지 않아 오작동 여지가 없다.)
 *
 * 원칙 (원장 지시 260814):
 *   1. 슬랙 스레드에 **아무 표시 없이 쓴 글은 아무 일도 일으키지 않는다** (내부 메모).
 *      환자에게 나가는 것은 기존 발송 접두어(!·!!)뿐이다.
 *   2. `^` = AI 온오프 버튼. 직원이 LINE 관리자 앱으로 직접 응대하러 갈 때도 이걸 먼저
 *      친다 — 관리자 앱 발송은 웹훅에 안 잡혀서 AI가 모르기 때문에, 이게 유일한 충돌 방지선이다.
 *   3. 직원이 !·!!로 발송하면 홀드가 자동으로 걸린다/연장된다 — 직원이 답하는 중에
 *      AI가 끼어들지 않게. 발송 자체는 기존 경로가 한다(이 모듈은 홀드만 조작).
 *   4. 자유도 높게: 기호·홀드 시간은 전부 ALH_CFG에서 바꾼다. 해보면서 조정한다.
 *
 * 상태 저장: ScriptProperties (CacheService는 임의 축출 위험 — 홀드가 풀리면 AI가
 *   직원 응대 중에 끼어드는 사고라 결정적 저장을 쓴다). 만료는 읽을 때 정리.
 *
 * 배선(허브 몫): 슬랙 Events → doPost → alhHandleSlackCommand_() 판정 → LINE push /
 *   홀드 조작. 브릿지 수신 경로에서는 응답 생성 전에 alhIsHeld_(), 발송 직전에 한 번 더.
 */

var ALH_CFG = {
  TTL_MS: 2 * 60 * 60 * 1000,     // 직원 마지막 활동 후 2시간 지나면 AI 자동 복귀
  CMD_TOGGLE: '^',                 // AI 온오프 버튼 — 정확히 이 한 글자일 때만
  SEND_PREFIXES: ['!!', '!']       // 기존 브릿지 발송 관례(번역없이/번역). 긴 것 먼저 검사.
                                   // 발송 로직은 기존 브릿지 소유 — 여기서는 홀드 연장용 감지만.
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
 * 반환: {type:'toggle'|'staff_send'|'note'}
 *   toggle — ^ 한 글자. staff_send — 기존 발송 접두어(!·!!)로 시작하는 글(홀드 연장 신호).
 *   note — **기본값. 아무 일도 일어나지 않는다.** 내부 메모는 자유롭게 쓰라는 뜻이다.
 */
function alhParseCommand_(raw) {
  var t = String(raw || '').trim();
  if (t === ALH_CFG.CMD_TOGGLE) return { type: 'toggle' };   // 정확히 ^ 한 글자 — 뒤에 말 붙으면 메모
  // 일치하는 가장 긴 접두어 하나로만 판정 — '!!' 단독이 '!'+본문으로 오판되지 않게
  var best = '';
  for (var i = 0; i < ALH_CFG.SEND_PREFIXES.length; i++) {
    var p = ALH_CFG.SEND_PREFIXES[i];
    if (t.indexOf(p) === 0 && p.length > best.length) best = p;
  }
  if (best && t.length > best.length)
    return { type: 'staff_send' };     // 발송은 기존 브릿지가 한다 — 여기서는 홀드 신호로만 쓴다
  return { type: 'note' };             // 접두어만 있고 본문 없는 !·!!는 메모(빈 발송 아님)
}

/**
 * 판정 + 상태 반영까지 한 번에 (허브 doPost가 부르는 진입점).
 * toggle(^)은 현재 상태를 보고 hold/release로 **해소해서** 반환한다 — 호출부는
 * hold/release/staff_send/note 4종만 처리하면 된다.
 * staff_send(!·!! 발송)는 홀드를 걸고/연장하고 기존 발송 경로에 그대로 넘긴다 —
 * 직원이 직접 답하는 동안 AI가 끼어들지 않게. 발송 자체는 이 모듈 밖(기존 브릿지).
 * ⚠ 토글은 지금 상태가 안 보이면 헷갈린다 — 호출부(허브)는 반환 type이 hold면
 *   "⏸ AI 멈춤", release면 "▶ AI 재개"를 스레드에 1줄 답글로 남길 것(필수).
 */
function alhHandleSlackCommand_(raw, userId, staffName, nowMs) {
  var a = alhParseCommand_(raw);
  if (a.type === 'toggle')
    a = { type: alhIsHeld_(userId, nowMs) ? 'release' : 'hold', via: 'toggle' };
  if (a.type === 'hold' || a.type === 'staff_send') alhHold_(userId, staffName, nowMs);
  if (a.type === 'release') alhRelease_(userId);
  return a;
}

/**
 * AI 발송 직전 최종 관문. 수신 시점 검사와 별도로 **발송 직전에 한 번 더** 부른다 —
 * 응답 생성 중에 직원이 ^을 쳤으면 그 응답은 버려야 한다(경합 방지).
 */
function alhMaySend_(userId, nowMs) {
  return !alhIsHeld_(userId, nowMs);
}
