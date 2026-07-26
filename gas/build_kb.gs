/**
 * 아크로드 빌드 — 정본(L2 응대KB) → 말단
 *
 *   정본:  Drive `L2_확정지식` 폴더의 `L2_응대KB_v*.md` 최신본  ← 여기만 손으로 고친다
 *   말단:  ① 답변KB 시트   ② qa374.json (GitHub)
 *
 * 방향은 한쪽뿐이다. 말단을 고쳐도 다음 빌드에서 정본 값으로 덮인다.
 *
 * ─── 이 파일은 public 리포에 있다 ───────────────────────────────
 * Drive 폴더 ID·스프레드시트 ID·토큰·웹훅 URL을 코드에 적지 않는다.
 * 전부 스크립트 속성(파일 > 프로젝트 속성 > 스크립트 속성)에서 읽는다.
 * 폴더·파일은 ID가 아니라 **이름으로 찾는다.**
 *
 * ─── 실행 순서 ────────────────────────────────────────────────
 *   1) kbBuildDryRun()   아무것도 쓰지 않는다. 리포트만 낸다. **먼저 이걸 통과시킨다.**
 *   2) kbBuildAll()      실제 반영.
 *
 * ─── 절대 규칙 ────────────────────────────────────────────────
 *   배포는 `clasp deploy -i <배포ID>`. `-i` 없이 deploy 하면 /exec URL이 새로 생겨
 *   라인 리치메뉴·QR·카톡 저장링크가 전부 끊긴다.
 */

var KB_CFG = {
  CANON_FOLDER: 'L2_확정지식',      // Drive 폴더 이름 (ID 아님)
  CANON_PREFIX: 'L2_응대KB_v',      // 이 접두어로 시작하는 파일 중 최신본
  SHEET_TAB: '답변KB',
  GH_PATH: 'qa374.json',

  // ─ 안전장치 ─ 정본이 잘려서 읽히면 시트를 비워버릴 수 있다. 그걸 막는다.
  MIN_ITEMS: 380,                   // 이보다 적게 파싱되면 중단
  MAX_SHRINK: 5,                    // 시트 기존 행보다 이 개수 이상 줄어들면 중단

  LANGS: ['KO', 'JA', 'ZH_CN', 'ZH_TW', 'TH', 'EN'],

  // 정본 필드 → 시트 열
  FIELD_MAP: {
    '원본ID': 'id',
    '원본코드': 'code',
    '태그': 'cat',
    '질문': 'q',
    '답변_KO': 'a',
    '난이도': 'diff'
  },
  SHEET_COLS: ['id', 'code', 'cat', 'q', 'a', 'diff'],

  // 슬랙 숏코드가 시트에 문자 그대로 굳는 사고가 있었다(260726, 13곳).
  // 클로드→슬랙 경로로 KB가 갱신될 때마다 재발하므로 빌드에서 매번 정규화한다.
  EMOJI: {
    ':blush:': '😊',
    ':arrow_forward:': '▶',
    ':heart:': '❤️',
    ':purple_heart:': '💜',
    ':heartpulse:': '💗',
    ':sparkles:': '✨',
    ':four_leaf_clover:': '🍀',
    ':pray:': '🙏',
    ':bow:': '🙇',
    ':cry:': '😢',
    ':disappointed_relieved:': '😥'
  }
};

// ══════════════════════════════════════════════════════════════
// 진입점
// ══════════════════════════════════════════════════════════════

function kbBuildDryRun() { return kbRun_(true); }
function kbBuildAll() { return kbRun_(false); }

function kbRun_(dry) {
  var log = [];
  var t0 = new Date().getTime();
  try {
    var chk = kbSelfCheck_();
    log.push('자가진단 통과 — 정본 `' + chk.fileName + '` (' + chk.bytes + ' bytes)');

    var parsed = kbParseCanon_(chk.text);
    log.push('파싱 ' + parsed.items.length + '건');
    if (parsed.warnings.length) {
      log.push('⚠ 파싱 경고 ' + parsed.warnings.length + '건: ' + parsed.warnings.slice(0, 5).join(' / '));
    }

    if (parsed.items.length < KB_CFG.MIN_ITEMS) {
      throw new Error('정본이 ' + parsed.items.length + '건뿐이다(최소 ' + KB_CFG.MIN_ITEMS +
        '). 정본이 잘려 읽혔을 수 있어 중단한다. 말단은 건드리지 않았다.');
    }

    // 원본ID는 시트의 키다. 비면 그 행은 시트에서 식별 불가가 되고,
    // 다음 빌드마다 "정본에 없는 행"으로 오인돼 중복이 쌓인다.
    // 빌드가 임의로 ID를 만들지 않는다 — 정본에서 사람이 부여해야 한다.
    var noId = parsed.items.filter(function (it) { return !it['원본ID']; })
      .map(function (it) { return it['KB']; });
    if (noId.length) {
      throw new Error('원본ID가 빈 항목 ' + noId.length + '건: ' + noId.join(', ') +
        '\n정본에서 ID를 부여한 뒤 다시 실행할 것. 빌드가 ID를 임의로 만들면 정본과 시트의 신원이 갈린다.');
    }

    var dupId = {}, dups = [];
    parsed.items.forEach(function (it) {
      var k = it['원본ID'];
      if (dupId[k]) dups.push(k); else dupId[k] = true;
    });
    if (dups.length) throw new Error('원본ID 중복 ' + dups.length + '건: ' + dups.join(', '));

    var norm = kbNormalizeAll_(parsed.items);
    if (norm.changed) log.push('이모지 숏코드 정규화 ' + norm.changed + '곳');

    var sheetRes = kbWriteSheet_(parsed.items, dry);
    log.push(sheetRes.msg);

    var jsonRes = kbWriteJson_(parsed.items, dry);
    log.push(jsonRes.msg);

    var head = (dry ? '🧪 빌드 리허설(쓰기 없음)' : '✅ 빌드 완료') +
      ' — 정본 ' + parsed.items.length + '건 · ' +
      Math.round((new Date().getTime() - t0) / 1000) + '초';

    var body = head + '\n' + log.map(function (l) { return '• ' + l; }).join('\n');
    if (sheetRes.sheetOnly && sheetRes.sheetOnly.length) {
      body += '\n\n🔸 *정본에 없는 시트 행 ' + sheetRes.sheetOnly.length + '건* — 지우지 않고 맨 아래 남겼다.\n' +
        '`' + sheetRes.sheetOnly.join('`, `') + '`\n' +
        '클로드→슬랙 경로로 시트에 직접 들어온 행이다. 정본에 올려야 다음 빌드에서 제자리를 잡는다.';
    }
    kbSlack_(body);
    return body;

  } catch (e) {
    var err = '🛑 빌드 중단 — ' + e.message + '\n' + log.map(function (l) { return '• ' + l; }).join('\n');
    kbSlack_(err);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// 0단계 · 자가진단
//   권한이 끊겨도 조용히 실패하지 않게 한다. 실패는 반드시 슬랙으로 나간다.
// ══════════════════════════════════════════════════════════════

function kbSelfCheck_() {
  var props = PropertiesService.getScriptProperties();
  ['KB_SPREADSHEET_ID', 'SLACK_WEBHOOK_URL'].forEach(function (k) {
    if (!props.getProperty(k)) throw new Error('스크립트 속성 `' + k + '`가 없다.');
  });

  var it = DriveApp.getFoldersByName(KB_CFG.CANON_FOLDER);
  if (!it.hasNext()) {
    throw new Error('Drive 폴더 `' + KB_CFG.CANON_FOLDER + '`를 읽을 수 없다. ' +
      '실행 계정에 정본 폴더 접근 권한이 있는지 확인할 것.');
  }
  var folder = it.next();
  if (it.hasNext()) throw new Error('`' + KB_CFG.CANON_FOLDER + '` 이름의 폴더가 둘 이상이다. 어느 것이 정본인지 알 수 없어 중단한다.');

  // 정본 후보를 모아 **버전을 숫자로** 비교한다.
  // 사전순으로 고르면 v1_10 < v1_7 이 되어 옛 파일을 정본으로 집는다.
  var cands = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (name.indexOf(KB_CFG.CANON_PREFIX) !== 0) continue;
    cands.push({ file: f, name: name, ver: kbParseVer_(name), mtime: f.getLastUpdated().getTime() });
  }
  if (!cands.length) throw new Error('`' + KB_CFG.CANON_FOLDER + '`에 `' + KB_CFG.CANON_PREFIX + '…` 파일이 없다.');

  cands.sort(function (a, b) {
    if (a.ver[0] !== b.ver[0]) return b.ver[0] - a.ver[0];
    if (a.ver[1] !== b.ver[1]) return b.ver[1] - a.ver[1];
    return b.mtime - a.mtime;                              // 버전 같으면 나중에 고친 것
  });
  var best = cands[0].file;

  // 정본 폴더에 정본이 여러 개 있으면 "정본은 하나"라는 전제가 깨진다.
  // 막지는 않되(옛 버전을 참고로 두는 경우가 있다) 반드시 알린다.
  if (cands.length > 1) {
    kbSlack_('⚠ 정본 폴더에 정본 후보가 ' + cands.length + '개 있다. 이번 빌드는 `' + cands[0].name + '`을 썼다.\n' +
      '나머지: `' + cands.slice(1).map(function (c) { return c.name; }).join('`, `') + '`\n' +
      '옛 버전은 `02_아카이브`로 옮기는 게 좋다. 정본 폴더에 둘 이상 있으면 어느 게 정본인지 사람이 헷갈린다.');
  }

  var text = best.getBlob().getDataAsString('UTF-8');
  if (text.indexOf('### [KB-') < 0) throw new Error('정본 파일에 KB 블록이 없다. 파일을 잘못 집었다.');

  var ss = SpreadsheetApp.openById(props.getProperty('KB_SPREADSHEET_ID'));
  if (!ss.getSheetByName(KB_CFG.SHEET_TAB)) throw new Error('시트 탭 `' + KB_CFG.SHEET_TAB + '`이 없다.');

  return { fileName: best.getName(), bytes: text.length, text: text, ss: ss };
}

// ══════════════════════════════════════════════════════════════
// 1단계 · 파싱
// ══════════════════════════════════════════════════════════════

function kbParseCanon_(text) {
  var blocks = text.split(/\r?\n(?=### \[KB-)/);
  var items = [];
  var warnings = [];
  var seen = {};

  for (var b = 0; b < blocks.length; b++) {
    var blk = blocks[b];
    if (blk.indexOf('### [KB-') !== 0) continue;      // 서두(제목·읽는 법)는 건너뛴다

    var idm = blk.match(/^### \[(KB-\d+)\]/);
    if (!idm) { warnings.push('KB-ID 없는 블록 #' + b); continue; }
    var kbId = idm[1];
    if (seen[kbId]) { warnings.push('KB-ID 중복 ' + kbId); }
    seen[kbId] = true;

    var lines = blk.split(/\r?\n/);
    var obj = { KB: kbId };
    var cur = null, buf = [];

    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      var m = line.match(/^- ([^:]+):[ \t]?([\s\S]*)$/);
      if (m) {
        if (cur !== null) { obj[cur] = kbTrimEnd_(buf.join('\n')); buf = []; cur = null; }
        var name = m[1].replace(/^\s+|\s+$/g, '');
        var val = m[2];
        if (val === '|') cur = name;                  // 여러 줄 값 시작
        else obj[name] = val;
      } else if (cur !== null) {
        buf.push(line.replace(/^ {4}/, ''));          // 4칸 들여쓰기 해제
      }
    }
    if (cur !== null) obj[cur] = kbTrimEnd_(buf.join('\n'));

    if (!obj['원본ID']) warnings.push(kbId + ' 원본ID 없음');
    if (!obj['질문']) warnings.push(kbId + ' 질문 없음');
    items.push(obj);
  }
  return { items: items, warnings: warnings };
}

function kbTrimEnd_(s) { return String(s).replace(/[\s﻿\xA0]+$/g, ''); }

/** `L2_응대KB_v1_7_260726.md` → [1, 7]. 버전을 못 읽으면 [-1,-1] (수정시각으로만 비교됨). */
function kbParseVer_(name) {
  var m = name.match(/_v(\d+)_(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [-1, -1];
}

// ══════════════════════════════════════════════════════════════
// 2단계 · 정규화 (슬랙 숏코드 → 실제 이모지)
// ══════════════════════════════════════════════════════════════

function kbNormalizeAll_(items) {
  var changed = 0, leftover = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    for (var k in it) {
      if (typeof it[k] !== 'string') continue;
      var v = it[k], before = v;
      for (var code in KB_CFG.EMOJI) {
        while (v.indexOf(code) >= 0) { v = v.replace(code, KB_CFG.EMOJI[code]); changed++; }
      }
      if (v !== before) it[k] = v;
      // 매핑에 없는 숏코드가 남았는지 본다 — 새 숏코드가 유입되면 알아야 한다
      var m = v.match(/:[a-z][a-z0-9_+\-]{1,29}:/g);
      if (m) for (var j = 0; j < m.length; j++) leftover[m[j]] = (leftover[m[j]] || 0) + 1;
    }
  }
  var keys = Object.keys(leftover);
  if (keys.length) {
    kbSlack_('⚠ 매핑에 없는 이모지 숏코드가 정본에 있다 — `' + keys.join('`, `') +
      '`\n`KB_CFG.EMOJI`에 추가하지 않으면 환자 화면에 그대로 찍힌다.');
  }
  return { changed: changed, leftover: keys };
}

// ══════════════════════════════════════════════════════════════
// 3단계 · 답변KB 시트
//   정본에 없는 시트 행은 **절대 지우지 않는다.** 맨 아래로 밀고 슬랙에 알린다.
//   (클로드→슬랙 경로가 시트에 직접 쓰기 때문에 이 행들이 생긴다)
// ══════════════════════════════════════════════════════════════

function kbWriteSheet_(items, dry) {
  var props = PropertiesService.getScriptProperties();
  var sh = SpreadsheetApp.openById(props.getProperty('KB_SPREADSHEET_ID')).getSheetByName(KB_CFG.SHEET_TAB);

  var old = sh.getDataRange().getValues();
  var oldHeader = old.length ? old[0] : [];
  var idCol = oldHeader.indexOf('id');
  if (idCol < 0) throw new Error('시트 헤더에 `id` 열이 없다.');

  var canonIds = {};
  var rows = items.map(function (it) {
    var id = it['원본ID'];
    canonIds[id] = true;
    return KB_CFG.SHEET_COLS.map(function (col) {
      for (var f in KB_CFG.FIELD_MAP) if (KB_CFG.FIELD_MAP[f] === col) return it[f] || '';
      return '';
    });
  });

  // 정본에 없는 기존 행 보존
  var sheetOnly = [], keep = [];
  for (var r = 1; r < old.length; r++) {
    var id = String(old[r][idCol] || '').replace(/^\s+|\s+$/g, '');
    if (!id) continue;
    if (!canonIds[id]) { sheetOnly.push(id); keep.push(old[r].slice(0, KB_CFG.SHEET_COLS.length)); }
  }

  var total = rows.length + keep.length;
  var oldCount = Math.max(0, old.length - 1);
  if (oldCount - total > KB_CFG.MAX_SHRINK) {
    throw new Error('시트 행이 ' + oldCount + ' → ' + total + '로 ' + (oldCount - total) +
      '건 줄어든다(허용 ' + KB_CFG.MAX_SHRINK + '). 정본 누락이 의심되어 중단한다.');
  }

  var msg = '시트 ' + oldCount + '행 → ' + total + '행' +
    (keep.length ? ' (정본 없는 행 ' + keep.length + '건 보존)' : '') +
    (dry ? ' [리허설 — 쓰지 않음]' : '');
  if (dry) return { msg: msg, sheetOnly: sheetOnly };

  var out = [KB_CFG.SHEET_COLS].concat(rows).concat(keep);
  sh.clearContents();
  sh.getRange(1, 1, out.length, KB_CFG.SHEET_COLS.length).setValues(out);
  return { msg: msg, sheetOnly: sheetOnly };
}

// ══════════════════════════════════════════════════════════════
// 4단계 · qa374.json (GitHub)
//   6개 언어를 함께 싣는다. 정본에는 번역이 있는데 말단에 없어서
//   외국인 응대에 못 쓰이던 문제(260726 확인)를 여기서 푼다.
// ══════════════════════════════════════════════════════════════

function kbWriteJson_(items, dry) {
  var payload = {
    version: 'build-' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmm'),
    updated: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd'),
    source: '정본 L2_응대KB (Drive ' + KB_CFG.CANON_FOLDER + ') 에서 자동 빌드. 이 파일을 직접 고치지 말 것 — 다음 빌드에서 덮인다.',
    count: items.length,
    items: items.map(function (it) {
      var o = {};
      KB_CFG.SHEET_COLS.forEach(function (col) {
        for (var f in KB_CFG.FIELD_MAP) if (KB_CFG.FIELD_MAP[f] === col) o[col] = it[f] || '';
      });
      KB_CFG.LANGS.forEach(function (lg) {
        if (lg === 'KO') return;                       // KO는 이미 a
        var v = it['답변_' + lg];
        if (v) o['a_' + lg] = v;                       // 번역 있는 것만 — 빈 필드로 파일 부풀리지 않는다
      });
      o.KB = it['KB'];                                 // 정본 추적용 불변 키
      return o;
    })
  };

  var body = JSON.stringify(payload, null, 2);
  var langCount = payload.items.filter(function (o) { return o.a_JA || o.a_EN; }).length;
  var msg = 'qa374.json ' + items.length + '건 · ' + Math.round(body.length / 1024) + 'KB' +
    ' (번역 있는 항목 ' + langCount + '건)' + (dry ? ' [리허설 — 쓰지 않음]' : '');
  if (dry) return { msg: msg };

  var commitMsg = '정본 빌드 — 응대KB ' + items.length + '건';

  // 기존 배포 GAS에 붙였으면 그쪽 함수를 재사용한다. 아니면 자체 푸시.
  // 자체 푸시가 되므로 **이 스크립트는 새 독립 프로젝트에 둘 수 있다.**
  // 기존 17개 프로젝트를 건드리지 않아도 되고, 웹앱 배포가 필요 없으니 /exec URL이 걸릴 일도 없다.
  if (typeof lwGitPutTo_ === 'function') {
    lwGitPutTo_(KB_CFG.GH_PATH, body, commitMsg);
  } else {
    kbGhPut_(KB_CFG.GH_PATH, body, commitMsg);
  }
  return { msg: msg };
}

/**
 * GitHub Contents API로 파일 하나를 덮어쓴다.
 * 스크립트 속성: GH_TOKEN (contents:write 권한) · GH_REPO (`owner/repo`) · GH_BRANCH (없으면 main)
 */
function kbGhPut_(path, content, message) {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('GH_TOKEN');
  var repo = p.getProperty('GH_REPO');
  var branch = p.getProperty('GH_BRANCH') || 'main';
  if (!token || !repo) {
    throw new Error('GitHub 푸시 설정이 없다. 스크립트 속성에 `GH_TOKEN`과 `GH_REPO`(owner/repo)를 넣을 것. ' +
      '또는 이 스크립트를 `lwGitPutTo_`가 있는 배포 GAS에 붙일 것.');
  }

  var base = 'https://api.github.com/repos/' + repo + '/contents/' + encodeURI(path);
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // 덮어쓰려면 현재 파일의 sha가 필요하다. 없으면(404) 신규 생성.
  var sha = null;
  var got = UrlFetchApp.fetch(base + '?ref=' + encodeURIComponent(branch),
    { method: 'get', headers: headers, muteHttpExceptions: true });
  if (got.getResponseCode() === 200) {
    sha = JSON.parse(got.getContentText()).sha;
  } else if (got.getResponseCode() !== 404) {
    throw new Error('GitHub 조회 실패 ' + got.getResponseCode() + ' — ' + got.getContentText().slice(0, 300));
  }

  var payload = {
    message: message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: branch
  };
  if (sha) payload.sha = sha;

  var put = UrlFetchApp.fetch(base, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = put.getResponseCode();
  if (code !== 200 && code !== 201) {
    // 409 = sha 충돌. 다른 경로가 같은 파일을 방금 밀었다는 뜻이다(§3 두 경로 충돌).
    throw new Error('GitHub 푸시 실패 ' + code +
      (code === 409 ? ' (sha 충돌 — 다른 경로가 같은 파일을 밀었다. 다시 실행할 것)' : '') +
      ' — ' + put.getContentText().slice(0, 300));
  }
}

// ══════════════════════════════════════════════════════════════
// 슬랙
// ══════════════════════════════════════════════════════════════

function kbSlack_(text) {
  var url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) { Logger.log(text); return; }
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('슬랙 발송 실패: ' + e.message + '\n' + text);
  }
}
