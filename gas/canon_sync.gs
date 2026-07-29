/**
 * 정본 자동 동기화 (M5) — canon_sync.gs
 *
 * private 리포(acro_canon)에 등재 세션이 정본을 푸시하면,
 * 이 함수가 매시간 확인해서 새 버전을 Drive `L2_확정지식` 폴더에 내려놓는다.
 * → "원장이 파일을 다운받아 Drive에 올리는" 마지막 수동 단계가 사라진다.
 *
 * 전제: build_kb.gs 와 같은 아크로드 프로젝트 (acdParseVer_·acdSlack_·ACD_CFG 재사용)
 * 속성: CANON_REPO = acrohani75-dot/acro_canon  ·  GH_TOKEN (private repo 읽기 가능해야 함)
 * 설치: acdCanonSyncInstall() 1회 → 매시간 트리거
 *
 * 원칙: Drive의 기존 파일은 절대 지우지 않는다(추가만). 정본 폴더의 버전 나열 관행 유지.
 *       빌드는 지금처럼 Drive에서 최신 버전을 집는다 — 빌드 코드는 변경 없음.
 */

function acdCanonSync() {
  var props = PropertiesService.getScriptProperties();
  var repo = props.getProperty('CANON_REPO');
  var token = props.getProperty('GH_TOKEN');
  if (!repo || !token) return;                                  // 미설정이면 조용히 무동작

  try {
    var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/contents/',
                                { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('리포 목록 HTTP ' + res.getResponseCode());
    var files = JSON.parse(res.getContentText());

    // 최신 버전 고르기 — 빌드와 같은 규칙 (숫자 비교, v1_10 > v1_7)
    var best = null;
    for (var i = 0; i < files.length; i++) {
      var n = files[i].name || '';
      if (n.indexOf(ACD_CFG.CANON_PREFIX) !== 0) continue;
      var v = acdParseVer_(n);
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) {
        best = { f: files[i], v: v };
      }
    }
    if (!best) return;

    // Drive에 같은 이름 파일이 이미 있으면 완료 상태 — 침묵
    var folder = DriveApp.getFoldersByName(ACD_CFG.CANON_FOLDER).next();
    if (folder.getFilesByName(best.f.name).hasNext()) return;

    // 본문 내려받기 (private raw)
    var raw = UrlFetchApp.fetch(best.f.download_url,
                                { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (raw.getResponseCode() !== 200) throw new Error('정본 다운로드 HTTP ' + raw.getResponseCode());
    var text = raw.getContentText('UTF-8');

    // 정본 맞는지 확인 — 깨진 파일을 Drive에 놓으면 빌드가 그걸 집는다
    var bytes = Utilities.newBlob(text, 'text/markdown').getBytes().length;
    if (text.indexOf('### [KB-') < 0 || bytes < 100000) {
      throw new Error('내용 검증 실패 — KB 블록 없음 또는 ' + bytes + '바이트(100KB 미만). Drive에 쓰지 않음.');
    }
    if (best.f.size && bytes !== best.f.size) {
      throw new Error('바이트 불일치 — 리포 ' + best.f.size + ' vs 수신 ' + bytes + '. 잘린 전송 의심, 쓰지 않음.');
    }

    folder.createFile(best.f.name, text, 'text/markdown');
    acdSlack_('📥 정본 동기화 — `' + best.f.name + '` (' + bytes + '바이트) Drive 반영. 다음 빌드가 이 버전을 집는다.');
  } catch (e) {
    // 같은 오류로 매시간 울리지 않기
    var msg = String(e && e.message || e);
    if (props.getProperty('CSYNC_LAST_ERR') !== msg) {
      acdSlack_('🔺 정본 동기화 실패 — ' + acdClip_(msg, 250));
      props.setProperty('CSYNC_LAST_ERR', msg);
    }
    return;
  }
  props.deleteProperty('CSYNC_LAST_ERR');
}

function acdCanonSyncInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'acdCanonSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('acdCanonSync').timeBased().everyHours(1).create();
  acdSlack_('📥 정본 자동 동기화 설치 완료 — 매시간 acro_canon 리포를 확인해 새 정본을 Drive에 내려놓는다.');
}
