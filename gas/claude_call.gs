/**
 * 아크로드 공용 Claude 호출기 — 응대 지연 개선판 (claude_call.gs)
 *
 * 문제: 접점마다 매 메시지에 헌법(16KB)+자산인덱스(5KB)+응대예시(6KB) = 27KB를
 *       ① GitHub에서 새로 받고 ② 프롬프트로 새로 처리했다. 둘 다 매번 낭비다.
 *
 * 해법 3가지 (효과 순):
 *   1. 프롬프트 캐싱 — 27KB 정적 프리픽스에 cache_control. 캐시 읽기는 입력가의 약 0.1배,
 *      처리도 건너뛴다. 응답 시작(TTFT)이 가장 크게 줄어드는 지점.
 *   2. CacheService — 정본 3개를 6시간 캐시. GitHub 왕복 4회 → 0회(캐시 적중 시).
 *      미적중이어도 fetchAll로 병렬 처리해 4회 → 2회.
 *   3. effort/max_tokens — 환자 응대는 깊은 추론이 필요 없다. low + 짧은 출력.
 *
 * ⚠ 캐싱은 프리픽스 완전일치다. 정적인 것이 앞, 변하는 것이 뒤 — 순서가 곧 성능이다.
 *   그래서 KB 히트(질문마다 다름)는 system이 아니라 **사용자 메시지**에 넣는다.
 *   재설계 v1.2의 나열 순서(…KB히트 → 자산인덱스…)를 그대로 조립하면 캐시가 매번 깨진다.
 *
 * 속성: ANTHROPIC_API_KEY · CANON_REPO · GH_TOKEN
 */

var ACC_CFG = {
  MODEL: 'claude-opus-5',
  MAX_TOKENS: 1200,        // 환자 응대는 짧다. 넉넉하되 과하지 않게
  EFFORT: 'low',           // 응대는 깊은 추론이 아니라 정확한 인용 — 지연을 줄인다
  CACHE_SEC: 21600,        // CacheService 최대 6시간
  PREFIXES: ['L0_헌법_v', 'L2_자산인덱스_v', 'L2_응대예시_v']
};

/** 정적 프리픽스(헌법+자산인덱스+응대예시) 로딩.
 *  CacheService 적중 시 GitHub 왕복 0회. 미적중 시 목록 1회 + fetchAll 병렬 1회.
 *  실패해도 헌법만은 기존 경로로 확보한다 — 호출부가 null을 받으면 응대를 중단할 것. */
function accLoadPrefix_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('ACC_PREFIX');
  if (hit) return hit;

  var props = PropertiesService.getScriptProperties();
  var repo = props.getProperty('CANON_REPO'), token = props.getProperty('GH_TOKEN');
  if (!repo || !token) return null;
  var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/contents/',
    { headers: headers, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var files = JSON.parse(res.getContentText());

  // 접두어별 최신본 하나씩 고른다 (canon_sync와 동일한 버전 비교)
  var picks = [];
  for (var p = 0; p < ACC_CFG.PREFIXES.length; p++) {
    var best = null;
    for (var i = 0; i < files.length; i++) {
      var n = files[i].name || '';
      if (n.indexOf(ACC_CFG.PREFIXES[p]) !== 0) continue;
      var v = acdParseVer_(n);
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) best = { f: files[i], v: v };
    }
    if (!best) return null;   // 셋 중 하나라도 없으면 조립하지 않는다
    picks.push(best.f);
  }

  // 병렬 다운로드 — 순차 3회가 아니라 한 번에
  var reqs = picks.map(function (f) {
    return { url: f.download_url, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  });
  var rs = UrlFetchApp.fetchAll(reqs);
  var parts = [];
  for (var k = 0; k < rs.length; k++) {
    if (rs[k].getResponseCode() !== 200) return null;
    parts.push(rs[k].getContentText('UTF-8'));
  }
  var prefix = parts.join('\n\n---\n\n');
  try { cache.put('ACC_PREFIX', prefix, ACC_CFG.CACHE_SEC); } catch (e) {}   // 100KB 초과 시 캐시만 포기
  return prefix;
}

/** 정본 갱신 즉시 반영용 — 등재 후 한 번 호출하면 다음 요청부터 새 정본을 쓴다 */
function accFlushPrefix() {
  CacheService.getScriptCache().remove('ACC_PREFIX');
}

/**
 * 응대 1건 생성.
 *   staticTask : 접점별 작업 지시 + 출력 계약 (접점마다 고정 문자열이어야 캐시가 산다)
 *   kbText     : 이번 질문의 정본 히트 (질문마다 다름 → 캐시 뒤쪽)
 *   userText   : 환자 메시지
 * 반환: 응대 문자열. 실패·거부는 null (호출부가 사람 인계로 전환할 것)
 */
function accAsk_(staticTask, kbText, userText) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('ANTHROPIC_API_KEY');
  var prefix = accLoadPrefix_();
  if (!key || !prefix) return null;
  // fast mode 스위치 — 속성 ACC_FAST='1'이면 같은 오퍼스를 더 빠른 출력으로 뽑는다.
  // 단가가 2배라 기본은 꺼짐. 캐싱 적용 실측 후에도 느리면 원장 판단으로 켠다.
  var fast = props.getProperty('ACC_FAST') === '1';

  // 정적 블록만 system에. 마지막 블록에 cache_control — 여기까지가 캐시 구간이다.
  var system = [
    { type: 'text', text: prefix },
    { type: 'text', text: String(staticTask || ''), cache_control: { type: 'ephemeral' } }
  ];
  // 변하는 것은 전부 캐시 경계 뒤(사용자 메시지)로
  var user = (kbText ? '## 정본 히트\n' + kbText + '\n\n' : '') + '## 환자 메시지\n' + String(userText || '');

  var headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (fast) headers['anthropic-beta'] = 'fast-mode-2026-02-01';
  var body = {
    model: ACC_CFG.MODEL,
    max_tokens: ACC_CFG.MAX_TOKENS,
    output_config: { effort: ACC_CFG.EFFORT },
    system: system,
    messages: [{ role: 'user', content: user }]
  };
  if (fast) body.speed = 'fast';
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  var j = JSON.parse(res.getContentText());
  if (j.stop_reason === 'refusal') return null;   // 조용히 지어내지 않는다 — 사람에게 넘긴다

  // 캐시 적중 확인용 (0이 계속 나오면 프리픽스가 매번 바뀌고 있다는 뜻)
  try {
    var u = j.usage || {};
    Logger.log('cache_read=' + (u.cache_read_input_tokens || 0)
      + ' cache_write=' + (u.cache_creation_input_tokens || 0)
      + ' uncached=' + (u.input_tokens || 0));
  } catch (e) {}

  var text = '';
  for (var i = 0; i < (j.content || []).length; i++) if (j.content[i].type === 'text') text += j.content[i].text;
  return text ? text.trim() : null;
}
