/**
 * 환자 기억 — 지난 대화 검토 + 연속성 메모 (patient_memory.gs)
 *
 * 원장 지시 260820: "직원을 배우자. 직원도 환자 다 기억 못해. 지난 대화 이력을 검토하고,
 * 차트를 보고, 그러면서 응대하거든." — 기억은 암기가 아니라 **조회**다. 직원의 세 서랍:
 *   ① 지난 대화 훑기  → apmFormatHistory_ (화자 라벨 + 최근 N턴)
 *   ② 짧은 인수인계 메모 → apmLoadMemo_ / apmUpdateMemo_ (환자별 3줄 요약, 시트 저장)
 *   ③ 차트            → acqPatientContext_ (배선 2순위 — 별도 진행 중)
 *
 * 260822 실측(원장 지시 "슬랙이나 인입원장 보면서 반영해봐"): **이력은 이미 다 있었다.**
 *   · 슬랙 채널의 환자 카드 스레드 = 그 환자와의 대화 전문(환자 발화·AI 응답·직원 메모)
 *   · 인입원장 `라인환자맵` 탭에 userId→채널·번호·**스레드ts** 가 이미 적히고 있다
 *   · 인입원장 `환자메모` 탭에는 이 모듈의 메모가 이미 쌓이는 중(jp#J153 …)
 *   그래서 ①에 빠져 있던 것은 "기억"이 아니라 **로더**였다. 아래 apmHistoryFor_가 그것이다.
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
  SHEET_NAME: '환자메모',
  MAP_SHEET_NAME: '라인환자맵',   // 같은 파일(인입원장)의 탭
  SLACK_LIMIT: 60                // 스레드에서 끌어올 최대 메시지(그중 최근 MAX_TURNS만 남는다)
};

/** 라인환자맵 열 위치(1-based). 실측 260822: userId·채널·번호·스레드ts·첫수신·최근수신… */
var APM_MAP_COL = { USER: 1, CH: 2, NO: 3, TS: 4 };

/** 채널 표기(환자맵 B열) → 슬랙 채널ID를 담은 속성 이름. ID는 코드에 적지 않는다. */
var APM_CH_PROP = { '일본': 'APM_SLACK_CH_JP', '대만': 'APM_SLACK_CH_TW' };

/** 라벨 — 화자 구분이 이 모듈의 존재 이유다 */
var APM_WHO = {
  patient: '환자',
  ai: '아크로드(나)',
  staff: '직원(환자에게 발송함)',
  note: '직원 메모(환자에게 안 나감)'   // 스레드 내부 메모 — 이걸 "말씀드렸듯이"로 쓰면 사고다
};

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
  '다음에 할 일 ④ 끝난 일은 지운다 ⑤ 메모만 출력, 다른 말 금지 ' +
  '⑥ **반드시 한국어로 쓴다.** 대화가 일본어·중국어여도 메모는 한국어다 — 이건 한국인 직원이 ' +
  '읽는 인수인계다(실측 260822: 일본어 대화의 메모가 일본어로 쌓여 있었다). ' +
  '환자 원문을 인용할 때만 원어를 따옴표로 남긴다.';

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


/** ── ① 지난 대화 로더 — 슬랙 스레드가 곧 대화 이력이다 ──────────────────
 *
 * 실측 260822, #cs_fn_일본_라인. 환자 1명 = 카드 1개 + 그 스레드가 대화 전문이다.
 * 스레드 안에서 화자를 가르는 표식(전부 실측):
 *
 *   환자   `*[J153]* [친구 추가]` · `*[#19756 백은영]* 여쭤보고 싶은게…`
 *          또는 원문 + 다음 줄 `(한국어) 번역`          ← 봇이 인바운드를 올린 형태
 *   AI     `:crescent_moon: 야간 대화응답 1/8 [Q001] → 일본 환자#J153`
 *          + `(한국어 대역) …`                          ← 아웃바운드는 "대역"이라 쓴다
 *   직원   사람 계정이 `!`/`!!`로 시작하는 글            ← 실제 발송
 *   메모   사람 계정의 그 밖의 글("차트 20193 GIMAMIYUKI", "예약표에 반영해뒀습니다")
 *
 * ⚠ 판정 규칙 하나만 지키면 260820 사고는 재발하지 않는다:
 *   **모르면 절대 '환자'로 찍지 않는다.** 기본값은 '기록'이다. AI가 한 말을 환자 말로
 *   착각하는 것이 이 모듈이 막으려는 바로 그 사고이기 때문이다.
 */
var APM_MARK = {
  PATIENT_TAG: /^\*\[([^\]]{1,40})\]\*\s*/,          // *[J153]* / *[#19756 백은영]*
  AI_HEAD: /(야간|주간)?\s*대화응답\s*\d+\/\d+/,      // :crescent_moon: 야간 대화응답 1/8 [Q001] →
  AI_GLOSS: /^\(한국어\s*대역\)\s*/,                  // 아웃바운드 번역 표시
  IN_GLOSS: /^\(한국어\)\s*/,                         // 인바운드 번역 표시
  CARD: /^:\w+:\s*\*라인\s*·/,                        // 카드 헤더(스레드 부모)
  CARD_GIST: /^요지:\s*(.+)$/m,
  ALERT: /^:rotating_light:\s*\*환자#\S+\s*([^*]+)\*\s*—\s*(.+)$/,
  SEND: /^(!!|!)\s*/,
  TOGGLE: /^\^$/
};

/** 슬랙 메시지 1건 → {who, text} 또는 null(버림). 순수 함수. */
function apmClassify_(msg) {
  var raw = String((msg && msg.text) || '').trim();
  if (!raw) return null;
  var isBot = !!(msg.bot_id || msg.subtype === 'bot_message');
  var lines = raw.split('\n');

  if (APM_MARK.TOGGLE.test(raw)) return null;            // 이어받기 명령 — 대화가 아니다

  if (APM_MARK.CARD.test(raw)) {                          // 카드: 요지 한 줄만 건진다
    var g = raw.match(APM_MARK.CARD_GIST);
    return g ? { who: 'note', text: '[접수 요지] ' + g[1].trim() } : null;
  }
  var al = raw.match(APM_MARK.ALERT);
  if (al) return { who: 'note', text: '[' + al[1].trim() + '] ' + al[2].trim() };

  var tag = raw.match(APM_MARK.PATIENT_TAG);
  if (tag) {
    var body = apmStripGloss_(raw.replace(APM_MARK.PATIENT_TAG, ''), APM_MARK.IN_GLOSS);
    return body ? { who: 'patient', text: body } : null;
  }

  if (APM_MARK.AI_HEAD.test(lines[0])) {                  // 아웃바운드
    var rest = lines.slice(1).join('\n').replace(APM_MARK.AI_GLOSS, '').trim();
    return rest ? { who: 'ai', text: rest } : null;
  }

  if (!isBot) {                                           // 사람이 쓴 글
    if (APM_MARK.SEND.test(raw))
      return { who: 'staff', text: raw.replace(APM_MARK.SEND, '').trim() };
    return { who: 'note', text: raw };
  }

  // 봇이 올린 글에 인바운드 번역 표시가 있으면 환자 발화다
  for (var i = 1; i < lines.length; i++)
    if (APM_MARK.IN_GLOSS.test(lines[i].trim()))
      return { who: 'patient', text: lines.slice(0, i).join('\n').trim() };

  return { who: 'kept', text: raw };                       // 모르면 '기록' — 환자로 찍지 않는다
}

/** 원문 + `(한국어) 번역` 이 붙어 있으면 원문만 남긴다(같은 말을 두 번 넣지 않는다). */
function apmStripGloss_(text, re) {
  var lines = String(text || '').split('\n');
  for (var i = 1; i < lines.length; i++)
    if (re.test(lines[i].trim())) return lines.slice(0, i).join('\n').trim();
  return String(text || '').trim();
}

/** 스레드 메시지 배열(시간순) → turns. */
function apmTurnsFromSlack_(messages) {
  var out = [];
  for (var i = 0; i < (messages || []).length; i++) {
    var t = apmClassify_(messages[i]);
    if (t) out.push(t);
  }
  return out;
}

/** ── 조회 배선 ────────────────────────────────────────────────────────── */

/** 인입원장 `라인환자맵`에서 userId → {ch, no, ts}. 없으면 null. */
function apmMapLookup_(userId) {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('APM_SHEET_ID');
    if (!id) return null;
    var sh = SpreadsheetApp.openById(id).getSheetByName(APM_CFG.MAP_SHEET_NAME);
    if (!sh || sh.getLastRow() < 1) return null;
    var vals = sh.getRange(1, 1, sh.getLastRow(), APM_MAP_COL.TS).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {          // 뒤에서부터 — 최신 행이 이긴다
      if (String(vals[i][APM_MAP_COL.USER - 1]) !== String(userId)) continue;
      var ts = String(vals[i][APM_MAP_COL.TS - 1] || '');
      if (!ts) return null;                                // 스레드ts 없으면 이력도 없다
      return {
        ch: String(vals[i][APM_MAP_COL.CH - 1] || ''),
        no: String(vals[i][APM_MAP_COL.NO - 1] || ''),
        ts: ts
      };
    }
    return null;
  } catch (e) { return null; }
}

/** 슬랙 스레드 읽기(읽기 전용). 실패는 null — 이력이 없어도 응대는 돈다. */
function apmSlackReplies_(channelId, threadTs) {
  try {
    var props = PropertiesService.getScriptProperties();
    var tok = props.getProperty('SLACK_BOT_TOKEN') || props.getProperty('SLACK_TOKEN');
    if (!tok || !channelId || !threadTs) return null;
    var url = 'https://slack.com/api/conversations.replies?channel=' + encodeURIComponent(channelId)
      + '&ts=' + encodeURIComponent(threadTs) + '&limit=' + APM_CFG.SLACK_LIMIT;
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var j = JSON.parse(res.getContentText());
    return j && j.ok && j.messages ? j.messages : null;
  } catch (e) { return null; }
}

/**
 * ① 완성형 — userId 하나로 지난 대화를 문자열까지. 실패·미등록은 '' (조용히).
 * 호출부: var hist = apmHistoryFor_(userId);
 *         var block = apmContextBlock_(apmLoadMemo_(key), hist);
 */
function apmHistoryFor_(userId) {
  var m = apmMapLookup_(userId);
  if (!m) return '';
  var propName = APM_CH_PROP[m.ch];
  if (!propName) return '';
  var chId = PropertiesService.getScriptProperties().getProperty(propName);
  if (!chId) return '';
  var msgs = apmSlackReplies_(chId, m.ts);
  if (!msgs) return '';
  return apmFormatHistory_(apmTurnsFromSlack_(msgs));
}

/** 환자맵 채널 표기 → 메모 key 접두어(jp#/tw#). 실측 260822 키 형식과 일치. */
function apmKeyFor_(userId) {
  var m = apmMapLookup_(userId);
  if (!m || !m.no) return null;
  var pre = m.ch === '일본' ? 'jp' : (m.ch === '대만' ? 'tw' : m.ch);
  return pre + '#' + m.no;
}
