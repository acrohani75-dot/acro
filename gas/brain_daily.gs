/**
 * 아크로드 뇌 1호 — 하루 마무리 (brain_daily.gs)
 *
 * 매일 22시(KST), 슬랙의 오늘 하루를 읽고 헌법(L0)의 렌즈로 정리해
 * #회의_프로그램에 "🌙 하루 마무리"를 게시한다. 조언은 실제로 보일 때만 0~2개.
 *
 * 구조 — L0 게이트웨이:
 *   헌법(acro_canon의 L0_헌법_v 최신본)이 시스템 프롬프트 최상단에 앉고,
 *   그 아래에 작업 지시, 그 아래에 오늘의 슬랙 다이제스트 + OK차트 실측(feed)이 온다.
 *   feed는 canon 리포 feed/okchart_daily.json — 워커 저녁 잡(okchart/daily_jobs.py)이 커밋.
 *   feed가 없거나 오늘 것이 아니면 조용히 생략(뇌는 실측 없이도 돈다).
 *   헌법 로딩 실패 시 마지막 캐시를 쓰고 슬랙에 경보한다(조용히 실패 금지).
 *
 * 전제: build_kb.gs · rainy_hook.gs 와 같은 Apps Script 프로젝트
 *       (SLACK_TOKEN · GH_TOKEN 속성, arnMask_ 재사용)
 * 속성: ANTHROPIC_API_KEY(필수) · BRAIN_POST_CHANNEL(#회의_프로그램 ID, 필수)
 *       BRAIN_READ_CHANNELS(읽을 채널 ID 쉼표구분, 필수) · CANON_REPO · GH_TOKEN
 *       상태 저장용: BRAIN_L0_CACHE · BRAIN_LAST_ERR
 * 설치: acbDailyInstall() 1회 → 매일 22시대 트리거
 * 수동 실행: acbDaily()
 *
 * 이 뇌는 읽고 · 생각하고 · #회의_프로그램에 게시만 한다.
 * 시트·정본·환자 채널에 쓰지 않는다. 환자 식별정보는 게시 전 마스킹된다.
 */

var ACB_CFG = {
  MODEL: 'claude-opus-5',
  MAX_TOKENS: 4000,
  PER_CHANNEL_CHARS: 6000,   // 채널당 다이제스트 상한 (최근 것 우선)
  TOTAL_CHARS: 40000,        // 전체 입력 상한
  MSG_LIMIT: 200,            // 채널당 최근 메시지 수
  L0_PREFIX: 'L0_헌법_v',
  KB_PREFIX: 'L2_응대KB_v'   // 정본 적체 감시용 (260813 — 8/6~8/13 17건 방치 사고)
};

/** 진입점 (트리거/수동) */
function acbDaily() {
  var props = PropertiesService.getScriptProperties();
  try {
    var l0 = acbLoadL0_();
    var digest = acbReadChannels_();
    var feed = acbLoadFeed_();
    var kb = acbLoadKbState_();
    var user = digest.text
      + (feed ? (digest.text ? '\n\n' : '') + '## OK차트 실측(전산)\n' + acbFeedText_(feed) : '')
      + (kb ? '\n\n## 정본 현황\n최신 응대KB: v' + kb.ver + ' (' + kb.ymd + ' 등재분까지)\n'
            + '이 날짜 이후 슬랙에 올라온 KB추가·KB수정·채굴 판정은 아직 정본에 없다.' : '');
    if (!user) { acbPost_('🌙 하루 마무리 — 오늘 읽을 수 있는 채널 메시지가 없습니다 (설정 확인: BRAIN_READ_CHANNELS).'); return; }
    var out = acbAsk_(l0.text + '\n\n---\n\n' + acbTaskPrompt_(), user);
    acbPost_(out + (l0.stale ? '\n_⚠ 헌법을 캐시본으로 사용함 (최신 로딩 실패)_' : ''));
    props.deleteProperty('BRAIN_LAST_ERR');
  } catch (e) {
    // 뇌가 죽으면 그 사실을 알린다. 단, 같은 오류로 매일 울리지는 않는다. (audit_kb 패턴)
    var msg = String(e && e.message || e);
    if (props.getProperty('BRAIN_LAST_ERR') !== msg) {
      acbPost_('🔺 하루 마무리 실패 — ' + msg.slice(0, 300) + '\n같은 오류가 반복되면 다시 알리지 않는다.');
      props.setProperty('BRAIN_LAST_ERR', msg);
    }
    throw e;
  }
}

/** 작업 지시 — 헌법 아래에 붙는다. 헌법과 충돌하면 헌법이 이긴다. */
function acbTaskPrompt_() {
  return [
    '너는 위 헌법을 따르는 아크로드다. 지금은 "하루 마무리" 시간이다.',
    '아래는 아크로한의원 슬랙의 오늘 메시지 다이제스트다(개인정보는 이미 마스킹됨).',
    '',
    '다음 형식으로 정리하라. 다섯 줄 안팎, 담백하게, 과장 없이:',
    '🌙 하루 마무리 — [오늘 날짜]',
    '· 문의 잔량: 미답·미확인으로 보이는 환자 문의 건수 (없으면 "없음")',
    '· 결산: 오늘 결산 제출 여부 (확인 안 되면 "확인 불가")',
    '· 판정 대기: 원장 판정을 기다리는 것 (채굴 다이제스트 등, 없으면 생략)',
    '· 정본 적체: "정본 현황" 블록이 있으면, 그 등재 날짜 **이후**에 슬랙에 올라온 KB추가·KB수정·채굴 판정이 다이제스트에 몇 건 보이는지 센다. 1건이라도 있으면 "미등재 N건 (가장 오래된 것 M/D)"으로 알린다. 0건이면 생략. 등재는 사람이 해야 하는 일이라, 조용히 쌓이면 그대로 잊힌다.',
    '· 내일: 준비사항 — 채널에서 실제로 보이는 것만 (없으면 생략)',
    '· 조언: 0~2개 — 정본과 어긋난 안내, 반복 수작업, 놓친 것이 실제로 보일 때만. 억지로 만들지 않는다. 없으면 "특이사항 없음"',
    '',
    '다이제스트에 "OK차트 실측(전산)" 블록이 있으면 결산·내일 항목은 그 숫자를 사실로 쓴다(전산 실측이 곧 확인이다).',
    '',
    '금지: 환자 이름·차트번호 언급(건수·이니셜만), 추측으로 채우기(확인 안 되면 "확인 불가"), 영업성 문구, 다이제스트에 없는 내용.'
  ].join('\n');
}

/** L0 헌법 로딩 — acro_canon 최신 L0_헌법_v 파일. 실패 시 캐시 + 경보 */
function acbLoadL0_() {
  var props = PropertiesService.getScriptProperties();
  var repo = props.getProperty('CANON_REPO'), token = props.getProperty('GH_TOKEN');
  try {
    if (!repo || !token) throw new Error('CANON_REPO/GH_TOKEN 미설정');
    var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/contents/', { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('리포 목록 HTTP ' + res.getResponseCode());
    var files = JSON.parse(res.getContentText());
    var best = null;
    for (var i = 0; i < files.length; i++) {
      var n = files[i].name || '';
      if (n.indexOf(ACB_CFG.L0_PREFIX) !== 0) continue;
      var v = acdParseVer_(n);   // canon_sync와 같은 버전 비교 (v1_10 > v1_7)
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) best = { f: files[i], v: v };
    }
    if (!best) throw new Error('L0_헌법_v 파일 없음');
    var raw = UrlFetchApp.fetch(best.f.download_url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (raw.getResponseCode() !== 200) throw new Error('헌법 다운로드 HTTP ' + raw.getResponseCode());
    var text = raw.getContentText('UTF-8');
    props.setProperty('BRAIN_L0_CACHE', text.slice(0, 40000));
    return { text: text, stale: false };
  } catch (e) {
    var cached = props.getProperty('BRAIN_L0_CACHE');
    if (cached) return { text: cached, stale: true };   // 캐시로 계속 — 게시물 말미에 표기됨
    throw new Error('헌법 로딩 실패(캐시도 없음): ' + String(e && e.message || e));
  }
}

/** 정본 현황 — 최신 L2_응대KB_v 파일명에서 버전·날짜를 읽는다.
 *  260813 사고: 원장이 슬랙에 직접 쓴 KB추가·KB수정 17건이 일주일간 정본에 안 들어갔다.
 *  채굴·판정은 돌았는데 등재만 끊긴 것을 아무도 못 봤다 — 그래서 뇌가 매일 본다.
 *  실패하면 null (조용한 생략 — 적체 감시 실패가 하루 마무리 전체를 죽이지 않는다). */
function acbLoadKbState_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var repo = props.getProperty('CANON_REPO'), token = props.getProperty('GH_TOKEN');
    if (!repo || !token) return null;
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/contents/',
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var files = JSON.parse(res.getContentText()), best = null;
    for (var i = 0; i < files.length; i++) {
      var n = files[i].name || '';
      if (n.indexOf(ACB_CFG.KB_PREFIX) !== 0) continue;
      var v = acdParseVer_(n);
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) best = { name: n, v: v };
    }
    if (!best) return null;
    var d = best.name.match(/_(\d{6})\.md$/);   // 파일명 말미 YYMMDD
    return { ver: best.v[0] + '.' + best.v[1], ymd: d ? d[1] : '', name: best.name };
  } catch (e) { return null; }
}

/** OK차트 실측 feed — canon 리포 feed/okchart_daily.json (워커 저녁 잡이 커밋).
 *  오늘 날짜가 아니거나 없으면 null — 뇌는 실측 없이도 돈다 (조용한 생략, 경보 아님) */
function acbLoadFeed_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var repo = props.getProperty('CANON_REPO'), token = props.getProperty('GH_TOKEN');
    if (!repo || !token) return null;
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/contents/feed/okchart_daily.json',
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var j = JSON.parse(res.getContentText());
    if (!j || !j.content) return null;
    var feed = JSON.parse(Utilities.newBlob(Utilities.base64Decode(String(j.content).replace(/\n/g, ''))).getDataAsString('UTF-8'));
    var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    return (feed && feed.date === today) ? feed : null;
  } catch (e) { return null; }
}

function acbFeedText_(f) {
  var won = function (n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; };
  var pays = (f.pay_by_method || []).map(function (p) { return p.method + ' ' + p.cnt + '건 ' + won(p.sum); }).join(' · ');
  return [
    '진료 환자 ' + (f.visits || 0) + '명',
    '결제: ' + (pays || '없음'),
    '오늘 발생 미수 합 ' + won(f.misu_today),
    '내일 예약 ' + (f.resv_tomorrow || 0) + '건' + (f.resv_tomorrow_first ? ' (첫 ' + f.resv_tomorrow_first + ')' : '')
  ].join('\n');
}

/** 오늘 00:00 KST 이후 슬랙 메시지 수집 → 마스킹 → 다이제스트 */
function acbReadChannels_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_TOKEN');
  var channels = String(props.getProperty('BRAIN_READ_CHANNELS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (!token || !channels.length) return { text: '' };
  var oldest = acbTodayStartTs_();
  var parts = [], total = 0;
  for (var c = 0; c < channels.length; c++) {
    var msgs = acbFetchHistory_(token, channels[c], oldest);
    if (!msgs.length) continue;
    var lines = [];
    for (var m = msgs.length - 1; m >= 0; m--) {   // 시간순으로 뒤집기
      var t = msgs[m];
      if (!t.text) continue;
      lines.push('[' + acbHm_(t.ts) + '] ' + arnMask_(String(t.text)).slice(0, 500));
    }
    var block = '## 채널 ' + channels[c] + ' (오늘 ' + lines.length + '건)\n' + lines.join('\n');
    if (block.length > ACB_CFG.PER_CHANNEL_CHARS) block = block.slice(-ACB_CFG.PER_CHANNEL_CHARS);   // 최근 것 우선
    if (total + block.length > ACB_CFG.TOTAL_CHARS) break;
    parts.push(block); total += block.length;
  }
  return { text: parts.join('\n\n') };
}

function acbFetchHistory_(token, channel, oldest) {
  var res = UrlFetchApp.fetch('https://slack.com/api/conversations.history?channel=' + encodeURIComponent(channel)
    + '&oldest=' + oldest + '&limit=' + ACB_CFG.MSG_LIMIT,
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText() || '{}');
  if (!j.ok) return [];   // 스코프 없음·미가입 채널은 건너뛴다 (전체 실패로 만들지 않는다)
  return j.messages || [];
}

/** Claude API 호출 — 헌법이 시스템 최상단. refusal은 정직하게 보고 */
function acbAsk_(system, user) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 미설정');
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: ACB_CFG.MODEL,
      max_tokens: ACB_CFG.MAX_TOKENS,
      system: system,
      messages: [{ role: 'user', content: user }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  if (j.stop_reason === 'refusal') throw new Error('모델이 응답을 거부함 (refusal)');
  var text = '';
  for (var i = 0; i < (j.content || []).length; i++) if (j.content[i].type === 'text') text += j.content[i].text;
  if (!text) throw new Error('빈 응답');
  return text.trim();
}

/** #회의_프로그램 게시 — 이 뇌의 유일한 출력 */
function acbPost_(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_TOKEN'), channel = props.getProperty('BRAIN_POST_CHANNEL');
  if (!token || !channel) throw new Error('SLACK_TOKEN/BRAIN_POST_CHANNEL 미설정');
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: channel, text: String(text).slice(0, 3000) }),
    muteHttpExceptions: true
  });
}

/** 오늘 00:00 KST의 유닉스 타임스탬프 (슬랙 oldest용) */
function acbTodayStartTs_() {
  var now = new Date();
  var kst = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(Math.floor(new Date(kst + 'T00:00:00+09:00').getTime() / 1000));
}

function acbHm_(ts) {
  return Utilities.formatDate(new Date(Number(ts) * 1000), 'Asia/Seoul', 'HH:mm');
}

/** 설치 — 매일 22시대 트리거 (기존 것 제거 후) */
function acbDailyInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'acbDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('acbDaily').timeBased().atHour(22).everyDays(1).create();
  acbPost_('🧠 아크로드 하루 마무리 설치 완료 — 매일 22시대에 오늘을 정리해 이 채널에 게시한다.');
}
