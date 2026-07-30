/**
 * 레이니 수신 소켓 (SPEC M2 부록 B) — rainy_hook.gs
 *
 * 레이니(홈페이지 챗봇)가 대화 1건이 끝날 때마다 JSON을 POST하면
 * `아크로_인입원장`의 `레이니로그` 탭에 1행을 쌓는다. 슬랙 발송 없음(조용한 감각).
 *
 * 넣는 곳: 아크로드 독립 프로젝트 (build_kb.gs · audit_kb.gs 와 같은 곳)
 * 배포: 새 웹앱 배포 허용 — 이 프로젝트는 신규라 /exec에 환자 대면 의존이 없다.
 *       배포 → 웹앱 → 나(소유자) 권한 실행 · 익명 포함 모든 사용자 액세스.
 *       발급된 /exec URL을 레이니 측에 전달한다.
 *       ⚠ 라인브릿지 프로젝트에 넣지 말 것 (그쪽 doPost와 충돌).
 *
 * 레이니가 보낼 JSON:
 *   { "ts": "...", "lang": "ko", "question": "...", "answered": true|false, "kb_id": "..." }
 *   answered=false 또는 누락 = 못답함 (수요 신호)
 *
 * 응답은 무조건 200 "ok" — 오류를 돌려주면 레이니 쪽 재시도가 폭주한다.
 */

var ARN_CFG = {
  TAB: '레이니로그',
  HEADER: ['시각', '최근시각', '반복횟수', '채널', '언어', '질문', '응답여부', '사용KB', '상태', '등재ID', '비고'],
  MAX_ROWS: 5000,          // 폭주 안전판 — 넘으면 조용히 버림
  RATE_PER_MIN: 30,        // 분당 수신 상한
  DEDUP_WINDOW_MS: 7 * 864e5,
  DEDUP_SCAN: 200,         // 중복 비교는 최근 N행만
  Q_MAX: 500,
  TEST_PATTERNS: ['시스템테스트', 'TEST-USER', 'E2E', '검증', '테스트입니다']   // 부록 A-1과 동일
};

function doPost(e) {
  try { arnIngest_(e); } catch (err) { /* 감각이 죽어도 조용히 — 원칙 §6-1 */ }
  return ContentService.createTextOutput('ok');   // 항상 200
}

function arnIngest_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body || body.length > 20000) return;
  var d;
  try { d = JSON.parse(body); } catch (x) { return; }

  var q = String(d.question || '').trim();
  if (!q) return;
  for (var i = 0; i < ARN_CFG.TEST_PATTERNS.length; i++) {
    if (q.indexOf(ARN_CFG.TEST_PATTERNS[i]) >= 0) return;      // 테스트 오염 차단
  }

  // 분당 상한 — CacheService 카운터
  var cache = CacheService.getScriptCache();
  var key = 'arn_' + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  if (n > ARN_CFG.RATE_PER_MIN) return;

  var masked = arnMask_(q).slice(0, ARN_CFG.Q_MAX);
  var lang = String(d.lang || '기타').slice(0, 8);
  var answered = (d.answered === true) ? '답함' : (d.answered === 'handoff' ? '이관' : '못답함');
  var kbId = String(d.kb_id || '').slice(0, 20);

  var sh = arnSheet_();
  var last = sh.getLastRow();
  if (last >= ARN_CFG.MAX_ROWS) return;                        // 안전판

  // 7일 내 동일 질문(정규화) → 새 행 대신 반복횟수 +1
  var norm = arnNorm_(masked);
  var from = Math.max(2, last - ARN_CFG.DEDUP_SCAN + 1);
  if (last >= 2) {
    var rows = sh.getRange(from, 1, last - from + 1, 6).getValues();
    for (var r = rows.length - 1; r >= 0; r--) {
      if (arnNorm_(String(rows[r][5])) !== norm) continue;
      var t = new Date(rows[r][1]).getTime();
      if (Date.now() - t > ARN_CFG.DEDUP_WINDOW_MS) break;
      var rowIdx = from + r;
      sh.getRange(rowIdx, 2).setValue(new Date());             // 최근시각
      sh.getRange(rowIdx, 3).setValue(Number(rows[r][2] || 1) + 1);   // 반복횟수
      return;
    }
  }

  sh.appendRow([new Date(), new Date(), 1, 'rainy', lang, masked, answered, kbId, '신규', '', '']);
}

/** 개인정보 마스킹 — SPEC §4와 동일 규칙 */
function arnMask_(s) {
  return String(s)
    .replace(/\+?\d{1,3}[- ]?\d{1,4}[- ]?\d{3,4}[- ]?\d{4}/g, function (m) {
      return m.replace(/\D/g, '').length >= 9 ? '[전화]' : m;   // 총 9자리 이상만 전화로 본다
    })
    .replace(/\b\d{2,6}([-. ]\d{2,6}){2,}\b/g, function (m) {
      return m.replace(/\D/g, '').length >= 10 ? '[번호]' : m;  // 날짜 오탐 방지(숫자 10자리 이상)
    })
    .replace(/[\w.\-]+@[\w.\-]+\.\w{2,}/g, '[메일]');
}

function arnNorm_(s) {
  return String(s).toLowerCase().replace(/[\s\.,!?~^:;'"()\[\]{}·…-]/g, '');
}

function arnSheet_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('KB_SPREADSHEET_ID'));
  var sh = ss.getSheetByName(ARN_CFG.TAB);
  if (!sh) {
    sh = ss.insertSheet(ARN_CFG.TAB);
    sh.appendRow(ARN_CFG.HEADER);
  }
  return sh;
}
