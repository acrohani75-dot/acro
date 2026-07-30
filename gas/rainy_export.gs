/**
 * 레이니 추출본 자동 생성 (M5-b) — rainy_export.gs
 *
 * 정본(Drive)에서 챗봇이 환자에게 직접 답해도 되는 항목만 걸러
 * `레이니_KB추출본_latest.md`를 만들어 CANON_REPO(private)에 푸시한다.
 * 260729 수동으로 만들던 추출본의 자동화 — 정본이 바뀌면 레이니 원천도 따라온다.
 *
 * 전제: build_kb.gs 와 같은 아크로드 프로젝트 (acdSelfCheck_·acdParseCanon_·acdSlack_ 재사용)
 * 속성: CANON_REPO · GH_TOKEN (canon_sync와 동일)
 * 설치: acdRainyExportInstall() 1회 → 매일 04시대 (야간 감사 다음 시간대)
 *
 * 추출 규칙 (260729 수동판과 동일):
 *   수록: 상태=확정 이면서 챗봇 직접응대 가능분
 *   제외: L계열(발송 스크립트) · R계열·[내부] 제목(내부규칙) · Q069(GLP-1 응대주의)
 *        · 난이도에 '의료진'/'연결' 포함 · Q302(계좌 상세) · 본문의 ※[내부] 메모 줄
 */

var ARX_CFG = {
  PATH: '레이니_KB추출본_latest.md',
  EXCLUDE_IDS: { 'Q302': 1, 'Q069': 1 },
  LANGS: ['JA', 'ZH_CN', 'ZH_TW', 'TH', 'EN']
};

function acdRainyExport() {
  var props = PropertiesService.getScriptProperties();
  var repo = props.getProperty('CANON_REPO');
  var token = props.getProperty('GH_TOKEN');
  if (!repo || !token) return;

  try {
    var base = acdSelfCheck_(true);
    var items = acdParseCanon_(base.text).items;
    var out = [], count = 0, cats = {};

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if ((it['상태'] || '') !== ACD_CFG.PUBLISH_STATE) continue;
      var oid = it['원본ID'] || '', title = it['제목'] || it['질문'] || '';
      var q = it['질문'] || '';
      if (/^L\d+$/.test(oid) || /^R\d+$/.test(oid)) continue;
      if (ARX_CFG.EXCLUDE_IDS[oid]) continue;
      if (q.indexOf('[내부') >= 0) continue;
      var diff = it['난이도'] || '';
      if (diff.indexOf('의료진') >= 0 || diff.indexOf('연결') >= 0) continue;
      if ((it['태그'] || '').indexOf('챗봇제외') >= 0) continue;         // 원장 검수: 챗봇 부적합 판정

      // 원장 검수로 챗봇용 변형문(답변_챗봇)이 있으면 그걸 쓴다. 없으면 답변_KO.
      var a = acdRainyStrip_(it['답변_챗봇'] || it['답변_KO'] || '');
      if (!a) continue;

      var cat = (it['태그'] || '기타').split(',')[0].replace(/^\s+|\s+$/g, '') || '기타';
      var langs = [];
      for (var l = 0; l < ARX_CFG.LANGS.length; l++) {
        if ((it['답변_' + ARX_CFG.LANGS[l]] || '').replace(/^\s+|\s+$/g, '')) langs.push(ARX_CFG.LANGS[l]);
      }
      if (!cats[cat]) { cats[cat] = []; }
      cats[cat].push('### [' + oid + '] ' + q + (langs.length ? ' 〔번역: ' + langs.join(',') + '〕' : '') + '\n' + a + '\n');
      count++;
    }

    var head = '# 레이니용 KB 추출본 — 정본 ' + base.fileName + ' 기반 자동 생성\n\n' +
      '> **빌드 산출물이다. 직접 고치지 말 것** — 고칠 것은 정본이고, 다음 추출 때 덮인다.\n' +
      '> 수록 ' + count + '건 · 제외: 발송 스크립트(L)·내부규칙(R/[내부])·의료진확인·계좌 상세·내부 메모.\n';
    var body = [head];
    for (var c in cats) {
      body.push('\n## ' + c + ' (' + cats[c].length + ')\n');
      body.push(cats[c].join('\n'));
    }
    var text = body.join('\n');

    // 유출 최종 검사 — 공개는 아니지만 챗봇 원천이므로 같은 기준
    for (var s = 0; s < ACD_CFG.SENSITIVE.length; s++) {
      var pat = ACD_CFG.SENSITIVE[s], m = text.match(pat.re);
      if (m && (!pat.minDigits || m[0].replace(/\D/g, '').length >= pat.minDigits)) {
        throw new Error('추출본에 ' + pat.name + ' 패턴 — 푸시 중단 (' + m[0].slice(0, 6) + '…)');
      }
    }
    if (count < 300) throw new Error('수록 ' + count + '건 — 300건 미만은 추출 오류 의심, 푸시 중단');

    var changed = acdRainyPut_(repo, token, ARX_CFG.PATH, text,
      '레이니 추출본 자동 갱신 — ' + base.fileName + ' 기반 ' + count + '건');
    if (changed) acdSlack_('🤖 레이니 추출본 갱신 — ' + count + '건 (' + base.fileName + ' 기반) → acro_canon');
  } catch (e) {
    var msg = String(e && e.message || e);
    var props2 = PropertiesService.getScriptProperties();
    if (props2.getProperty('ARX_LAST_ERR') !== msg) {
      acdSlack_('🔺 레이니 추출 실패 — ' + acdClip_(msg, 250));
      props2.setProperty('ARX_LAST_ERR', msg);
    }
    return;
  }
  PropertiesService.getScriptProperties().deleteProperty('ARX_LAST_ERR');
}

/** ※[내부] 메모 줄과 그 들여쓴 연속줄 제거 */
function acdRainyStrip_(a) {
  var lines = String(a).split('\n'), out = [], skip = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\s*※\s*\[내부\]/.test(l)) { skip = true; continue; }
    if (skip && /^\s{2,}\S/.test(l)) continue;
    skip = false; out.push(l);
  }
  return out.join('\n').replace(/^\s+|\s+$/g, '');
}

/** GitHub contents API PUT — 내용 같으면 안 쓰고 false 반환 */
function acdRainyPut_(repo, token, path, content, message) {
  var url = 'https://api.github.com/repos/' + repo + '/contents/' + encodeURIComponent(path);
  var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  var sha = null;
  var res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
  if (res.getResponseCode() === 200) {
    var cur = JSON.parse(res.getContentText());
    sha = cur.sha;
    var curBytes = Utilities.base64Decode(String(cur.content || '').replace(/\n/g, ''));
    if (Utilities.newBlob(curBytes).getDataAsString('UTF-8') === content) return false;   // 변화 없음 → 침묵
  }
  var payload = { message: message, content: Utilities.base64Encode(content, Utilities.Charset.UTF_8) };
  if (sha) payload.sha = sha;
  var put = UrlFetchApp.fetch(url, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = put.getResponseCode();
  if (code !== 200 && code !== 201) throw new Error('추출본 푸시 HTTP ' + code);
  return true;
}

function acdRainyExportInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'acdRainyExport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('acdRainyExport').timeBased().everyDays(1).atHour(4).create();
  acdSlack_('🤖 레이니 추출 자동화 설치 완료 — 매일 04시대, 정본 변경분만 acro_canon에 반영.');
}
