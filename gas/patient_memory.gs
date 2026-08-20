/**
 * 환자 기억 — 지난 대화 검토 + 연속성 메모 (patient_memory.gs)
 *
 * 원장 지시 260820: "직원을 배우자. 직원도 환자 다 기억 못해. 지난 대화 이력을 검토하고,
 * 차트를 보고, 그러면서 응대하거든." — 기억은 암기가 아니라 **조회**다. 직원의 세 서랍:
 *   ① 지난 대화 훑기  → apmFormatHistory_ (화자 라벨 + 최근 N턴)
 *   ② 짧은 인수인계 메모 → apmLoadMemo_ / apmUpdateMemo_ (환자별 3줄 요약, 시트 저장)
 *   ③ 차트            → acqPatientContext_ (배선 2순위 — 별도 진행 중)
 *
 * 이 모듈은 260820 실측 사고 2건의 직접 처방이기도 하다 (원장 라인 테스트 J003):
 *   · AI가 자기가 한 말("4시 예약 도와드릴게요")을 환자가 한 말로 착각 → **화자 라벨** 강제
 *   · 옛 스레드의 온다 상담 맥락이 오늘 질문("내일 진료 시간?")을 덮음 → **최근 N턴 제한**
 *     + "답변은 마지막 환자 메시지에 먼저 한다" 계약을 맥락 블록에 동봉
 *
 * 저장: 스프레드시트 '환자메모' 탭 (ID는 속성 APM_SHEET_ID — public 리포에 환자 정보·
 *   시트 ID 절대 금지). 열: [key, 갱신일시, 메모]. key = 채널#환자ID (예: jp#J003).
 * 메모 갱신은 **발송 후**에 한다 — 환자 대기 시간에 얹지 않는다.
 *
 * 배선(허브/로컬): 응답 생성 전 ①②를 apmContextBlock_으로 묶어 사용자 메시지에서
 *   KB 히트·실측 맥락 **뒤**, 환자 메시지 **앞**에 끼운다(§2.2 캐시 순서 유지).
 *   발송 후 apmUpdateMemo_ → apmSaveMemo_.
 */

var APM_CFG = {
  MAX_TURNS: 10,           // 지난 대화는 최근 10턴만 — 옛 맥락이 오늘 질문을 덮지 않게
  MEMO_MAX_CHARS: 600,     // 메모는 짧아야 메모다
  MODEL: 'claude-opus-5',
  MAX_TOKENS: 300,
  SHEET_NAME: '환자메모'
};

/** 라벨 — 화자 구분이 이 모듈의 존재 이유다 */
var APM_WHO = { patient: '환자', ai: '아크로드(나)', staff: '직원' };

/**
 * ① 지난 대화 정리 (순수 함수).
 * turns: [{who:'patient'|'ai'|'staff', text:'...'}] 시간순.
 * 최근 MAX_TURNS만, 각 줄에 화자 라벨. 대화가 없으면 ''.
 */
function apmFormatHistory_(turns) {
  var t = (turns || []).slice(-APM_CFG.MAX_TURNS);
  if (!t.length) return '';
  var lines = [];
  for (var i = 0; i < t.length; i++) {
    var who = APM_WHO[t[i].who] || '기록';
    lines.push(who + ': ' + String(t[i].text || '').replace(/\n+/g, ' ').trim());
  }
  return lines.join('\n');
}

/**
 * ①+② → 프롬프트 블록 (순수 함수). 사용자 메시지에서 환자 메시지 바로 앞에 붙인다.
 * 셋 다 비면 '' — 빈 껍데기를 주입하지 않는다.
 */
function apmContextBlock_(memo, historyText) {
  if (!memo && !historyText) return '';
  var p = ['## 이 환자에 대한 기억 (내부 재료 — 원문을 환자에게 노출 금지)'];
  if (memo) p.push('[인수인계 메모]\n' + memo);
  if (historyText) {
    p.push('[지난 대화 · 최근 ' + APM_CFG.MAX_TURNS + '턴]\n' + historyText);
    p.push('⚠ "아크로드(나)" 줄은 **네가 한 말**이다. 환자가 한 말로 착각하지 마라 — ' +
      '환자가 말하지 않은 것을 "말씀하셨죠"라고 하면 안 된다.');
  }
  p.push('⚠ 답변은 **마지막 환자 메시지**에 먼저 한다. 지난 주제는 환자가 다시 꺼낼 때만 잇는다.');
  return p.join('\n\n');
}

/** ── ② 메모 저장소 (시트) ─────────────────────────────────────────────── */

function apmSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('APM_SHEET_ID');
  if (!id) return null;
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(APM_CFG.SHEET_NAME);
  return sh || ss.insertSheet(APM_CFG.SHEET_NAME);
}

/** 메모 읽기. 없거나 실패면 null — 기억이 없어도 응대는 돈다. */
function apmLoadMemo_(key) {
  try {
    var sh = apmSheet_();
    if (!sh || sh.getLastRow() < 1) return null;
    var vals = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
    for (var i = 0; i < vals.length; i++)
      if (String(vals[i][0]) === String(key)) return String(vals[i][2] || '') || null;
    return null;
  } catch (e) { return null; }
}

/** 메모 쓰기(있으면 갱신, 없으면 추가). 실패해도 조용히 — 응대를 막지 않는다. */
function apmSaveMemo_(key, memo, nowStr) {
  try {
    var sh = apmSheet_();
    if (!sh) return false;
    var m = String(memo || '').slice(0, APM_CFG.MEMO_MAX_CHARS);
    var n = sh.getLastRow();
    if (n >= 1) {
      var keys = sh.getRange(1, 1, n, 1).getValues();
      for (var i = 0; i < keys.length; i++)
        if (String(keys[i][0]) === String(key)) {
          sh.getRange(i + 1, 2, 1, 2).setValues([[nowStr || '', m]]);
          return true;
        }
    }
    sh.appendRow([String(key), nowStr || '', m]);
    return true;
  } catch (e) { return false; }
}

/**
 * ② 메모 갱신 — 이번 대화를 반영해 3줄 메모를 다시 쓴다. **발송 후 호출**(지연 무관).
 * 27KB 프리픽스를 쓰지 않는다 — 기록원 역할엔 작은 고정 지시 하나면 된다.
 * 실패·거부는 null — 호출부는 기존 메모를 유지하면 된다(잘못 쓸 바엔 안 쓴다).
 */
var APM_SCRIBE = '너는 한의원 응대 기록원이다. 기존 메모와 오늘 대화를 받아 다음 직원이 ' +
  '30초에 읽을 인수인계 메모로 갱신하라. 규칙: ① 3줄 이내, 600자 이내 ② 대화에 있는 사실만 — ' +
  '추측·진단 금지 ③ 남길 것: 환자가 밝힌 사실(이름·차트번호·상태), 진행 중인 일(예약 조율 등), ' +
  '다음에 할 일 ④ 끝난 일은 지운다 ⑤ 메모만 출력, 다른 말 금지.';

function apmUpdateMemo_(oldMemo, exchangeText) {
  try {
    var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!key) return null;
    var user = (oldMemo ? '[기존 메모]\n' + oldMemo + '\n\n' : '[기존 메모 없음]\n\n') +
      '[오늘 대화]\n' + String(exchangeText || '');
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: APM_CFG.MODEL, max_tokens: APM_CFG.MAX_TOKENS,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: APM_SCRIBE, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var j = JSON.parse(res.getContentText());
    if (j.stop_reason === 'refusal') return null;
    var out = '';
    for (var i = 0; i < (j.content || []).length; i++)
      if (j.content[i].type === 'text') out += j.content[i].text;
    out = out.trim();
    return out ? out.slice(0, APM_CFG.MEMO_MAX_CHARS) : null;
  } catch (e) { return null; }
}
