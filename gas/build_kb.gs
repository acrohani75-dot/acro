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
 *   1) acdBuildDryRun()   아무것도 쓰지 않는다. 리포트만 낸다. **먼저 이걸 통과시킨다.**
 *   2) acdBuildAll()      실제 반영.
 *
 * ─── 절대 규칙 ────────────────────────────────────────────────
 *   배포는 `clasp deploy -i <배포ID>`. `-i` 없이 deploy 하면 /exec URL이 새로 생겨
 *   라인 리치메뉴·QR·카톡 저장링크가 전부 끊긴다.
 */

var ACD_CFG = {
  CANON_FOLDER: 'L2_확정지식',      // Drive 폴더 이름 (ID 아님)
  CANON_PREFIX: 'L2_응대KB_v',      // 이 접두어로 시작하는 파일 중 최신본
  SHEET_TAB: '답변KB',
  GH_PATH: 'qa374.json',

  // 정본은 초안도 담는다. 이 상태인 것만 말단으로 내린다.
  // 덕분에 원장 승인 전 문안을 정본에 올려둬도 환자에게 나가지 않는다.
  PUBLISH_STATE: '확정',
  SLACK_MAX: 3000,                  // 슬랙 한 메시지 최대 길이. 이 이상은 자른다

  // ─ 공개 대상 가림막 ─
  // 답변KB 시트는 비공개(소유자 전용)지만 qa374.json은 **public 리포**에 올라가
  // GitHub Pages로 전세계에 서빙된다. 정본에는 계좌번호처럼 내부에만 있어야 할 값이 있다.
  // 시트에는 실제 값을 그대로 쓰고, **공개 대상에만** 아래 문안으로 갈아끼운다.
  // (260727 발견: Q302 계좌번호·예금주·기업은행이 public 리포에 그대로 있었다)
  PUBLIC_REDACT: {
    'KB-0302': {
      '답변_KO':
        '계좌번호 안내드리겠습니다 ^^\n' +
        '▶아크로한의원 계좌번호◀\n\n' +
        '입금액 : 만원\n' +
        '※ 예금주·은행·계좌번호는 답변KB 시트(실시간 1차 소스)에서 확인해주세요.\n' +
        '   이 폴백 사본은 공개 저장소에 있어 계좌 정보를 담지 않습니다.\n\n' +
        '입금 후 연락 주시면 접수가 완료되며,\n' +
        '입금 확인이 되지 않을 경우 접수가 취소될 수 있습니다. 양해부탁드립니다.\n\n' +
        '📢 입금자명이 예약자명과 다를 경우 반드시 한의원으로 연락 부탁드립니다.'
    }
  },

  // 가림막을 거친 뒤에도 남아 있으면 **새로 유입된 민감정보**다. 막지 않고 알린다.
  // (막아버리면 어느 항목인지 모른 채 문안이 조용히 뭉개진다)
  SENSITIVE: [
    { name: '은행명', re: /(기업은행|국민은행|신한은행|우리은행|하나은행|농협|카카오뱅크|토스뱅크)/ },
    { name: '예금주 실명', re: /예금주\s*[:：]\s*[가-힣]{2,4}/ },
    // 날짜(2026-07-26)가 계좌번호로 오인된다. 숫자 총 10자리 이상만 계좌로 본다.
    // (실제 오탐 발생 260727 — 검사기를 안 만들었으면 이 규칙도 못 얻었다)
    { name: '계좌번호', re: /\b\d{2,4}-\d{2,6}-\d{2,6}(-\d{1,3})?\b/, minDigits: 10 },
    { name: '휴대폰번호', re: /01[016789]-?\d{3,4}-?\d{4}/ },
    { name: '주민등록번호', re: /\b\d{6}-[1-4]\d{6}\b/ }
  ],

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

function acdBuildDryRun() { return acdRun_(true); }
function acdBuildAll() { return acdRun_(false); }

/**
 * 자동 빌드 트리거 설치 — 한 번만 실행. 이미 있으면 지우고 다시 건다(중복 방지).
 *
 * ⚠ 왜 생겼나 (260824 실측): 이 파일에는 **트리거 설치 함수가 아예 없었다.**
 *   `acdBuildAll()`은 사람이 손으로 부르는 함수였고, 마지막 실행이 260805다.
 *   그 19일 동안 정본은 확정 475건 → 504건으로 갔는데 시트·qa374는 475건에 멈춰 있었다.
 *   감사(03시)는 매일 정확히 보고했으나 어긋남 목록에 묻혔다.
 *   원장 결재 260804 "자동빌드 허용"은 받았는데 **거는 사람이 없었다.**
 *
 * 감사보다 한 시간 앞선 02시에 건다 — 빌드가 먼저 맞춰놓고 감사가 확인하는 순서.
 */
function acdBuildInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'acdBuildAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('acdBuildAll').timeBased().everyDays(1).atHour(2).create();
}

/** 슬랙만 따로 시험한다. 빌드 전에 이걸 먼저 통과시키면 경보가 죽어 있는 상태를 피할 수 있다. */
function acdTestSlack() {
  acdCheckSlack_();
  var r = acdSlack_('✅ 아크로드 빌드 — 슬랙 연결 확인. 이 메시지가 보이면 경보가 살아 있다.');
  if (!r.ok) throw new Error('슬랙 발송 실패: ' + r.err);
  return '슬랙 정상';
}

/**
 * 슬랙 발송 방식을 정한다. 두 가지를 지원하고, **봇 토큰을 우선**한다.
 *
 *   ① 봇 토큰 (권장) — `SLACK_TOKEN`(xoxb-…) + 채널 ID.
 *      라인브릿지가 이미 쓰는 값이라 새로 만들 게 없다.
 *      채널 ID는 `ACD_SLACK_CHANNEL` → `SLACK_CHANNEL` → `SLACK_WEBHOOK_URL` 순으로 찾는다
 *      (마지막은 이름과 달리 채널 ID가 들어 있는 경우가 있어서다).
 *   ② 웹훅 — `SLACK_WEBHOOK_URL`이 `https://hooks.slack.com/…` 인 경우.
 *
 * 발송 시점이 아니라 **일 시작 전에** 검사한다. 나중에 터지면 실패 경보 자체가 못 나간다.
 */
function acdSlackTarget_() {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('SLACK_TOKEN');
  var hook = p.getProperty('SLACK_WEBHOOK_URL');

  if (token && token.indexOf('xox') === 0) {
    var ch = p.getProperty('ACD_SLACK_CHANNEL') || p.getProperty('SLACK_CHANNEL') || '';
    if (!ch && hook && /^[CGD][A-Z0-9]{6,}$/.test(hook)) ch = hook;   // 채널 ID가 여기 들어 있는 경우
    if (!ch) {
      throw new Error('`SLACK_TOKEN`은 있는데 보낼 채널을 모른다. 스크립트 속성에 ' +
        '`ACD_SLACK_CHANNEL` = 채널 ID(예: C로 시작하는 문자열)를 넣을 것.');
    }
    return { mode: 'token', token: token, channel: ch };
  }

  if (hook && hook.indexOf('https://hooks.slack.com/') === 0) return { mode: 'hook', url: hook };

  if (hook) {
    throw new Error('슬랙 설정이 잘못됐다. `SLACK_WEBHOOK_URL`에 `' + hook + '`가 들어 있는데 ' +
      '이건 웹훅 URL이 아니다(웹훅은 `https://hooks.slack.com/…`).\n' +
      '봇 토큰을 쓰려면 `SLACK_TOKEN`(xoxb-…)을, 웹훅을 쓰려면 웹훅 URL을 넣을 것.');
  }
  throw new Error('슬랙 설정이 없다. `SLACK_TOKEN`(+`ACD_SLACK_CHANNEL`) 또는 `SLACK_WEBHOOK_URL`을 넣을 것.');
}

function acdCheckSlack_() { acdSlackTarget_(); }

function acdRun_(dry) {
  var log = [];
  var t0 = new Date().getTime();
  try {
    acdCheckSlack_();          // 경보가 살아 있는지 **먼저** 본다. 죽어 있으면 실패도 알릴 수 없다.
    var chk = acdSelfCheck_();
    log.push('자가진단 통과 — 정본 `' + chk.fileName + '` (' + chk.bytes + '바이트 / ' +
      chk.chars + '자, Drive 파일 크기와 일치)');

    var parsed = acdParseCanon_(chk.text);
    log.push('파싱 ' + parsed.items.length + '건');
    if (parsed.warnings.length) {
      log.push('⚠ 파싱 경고 ' + parsed.warnings.length + '건: ' + parsed.warnings.slice(0, 5).join(' / '));
    }

    if (parsed.items.length < ACD_CFG.MIN_ITEMS) {
      throw new Error('정본이 ' + parsed.items.length + '건뿐이다(최소 ' + ACD_CFG.MIN_ITEMS +
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

    // 상태 필터 — 정본은 초안도 담는다. 그러나 **`확정`이 아닌 것은 말단으로 내리지 않는다.**
    // 이게 있어야 원장 승인 전 문안을 정본에 안전하게 올려둘 수 있다.
    var all = parsed.items;
    var held = all.filter(function (it) { return it['상태'] !== ACD_CFG.PUBLISH_STATE; });
    var items = all.filter(function (it) { return it['상태'] === ACD_CFG.PUBLISH_STATE; });

    // 답변이 한 언어도 없는 항목은 말단으로 내리지 않는다 (260828 실측 사고).
    //   정본에는 「**부작용 우려**」 같은 **구분행**이 섞여 있다. 질문 자리에 섹션 머리글이
    //   들어가고 답변은 비어 있다. 이런 것이 `상태: 확정`으로 바뀌면 답변 없는 항목이
    //   qa374·시트에 실려 AI가 빈 답을 후보로 본다.
    //   (260828 19:55 빌드에서 KB-0022·0025·0046·0056·0068 5건이 실제로 들어갔다.
    //    그전까지는 상태가 확정이 아니라 "말단 제외"로 걸러지고 있었다.)
    //   ⚠ 어느 한 언어라도 답변이 있으면 내린다 — 일본어만 있는 항목을 떨어뜨리지 않기 위해.
    var ansCols = ['답변_KO', '답변_JA', '답변_ZH_CN', '답변_ZH_TW', '답변_TH', '답변_EN'];
    var empty = items.filter(function (it) {
      for (var i = 0; i < ansCols.length; i++)
        if (acdTrimEnd_(String(it[ansCols[i]] || ''))) return false;
      return true;
    });
    if (empty.length) {
      items = items.filter(function (it) { return empty.indexOf(it) < 0; });
      log.push('답변 없는 확정 항목 ' + empty.length + '건 제외(구분행으로 보인다): ' +
        empty.map(function (it) { return it['KB']; }).join(', '));
    }
    if (held.length) {
      log.push('말단 제외 ' + held.length + '건 (상태≠' + ACD_CFG.PUBLISH_STATE + '): ' +
        held.map(function (it) { return it['KB'] + '(' + (it['상태'] || '상태없음') + ')'; }).join(', '));
    }
    if (items.length < ACD_CFG.MIN_ITEMS) {
      throw new Error('말단에 내릴 확정 항목이 ' + items.length + '건뿐이다(최소 ' + ACD_CFG.MIN_ITEMS + '). 중단한다.');
    }

    var norm = acdNormalizeAll_(items);
    if (norm.changed) log.push('이모지 숏코드 정규화 ' + norm.changed + '곳');

    var sheetRes = acdWriteSheet_(items, held, dry);
    log.push(sheetRes.msg);

    // 시트는 이미 썼다. 여기서 던지면 "시트는 반영됐는데 실패로 보이는" 상태가 된다.
    // 그래서 GitHub 실패는 잡아서 결과에 적는다. 무엇이 되고 무엇이 안 됐는지 분명해진다.
    var jsonRes;
    try { jsonRes = acdWriteJson_(items, dry); log.push(jsonRes.msg); }
    catch (je) { log.push('🔺 qa374.json 실패 — ' + acdClip_(je.message, 300) + ' (시트 반영은 위에 적힌 대로 끝났다)'); }

    var head = (dry ? '🧪 빌드 리허설(쓰기 없음)' : '✅ 빌드 완료') +
      ' — 정본 ' + all.length + '건 중 확정 ' + items.length + '건 · ' +
      Math.round((new Date().getTime() - t0) / 1000) + '초';

    var body = head + '\n' + log.map(function (l) { return '• ' + l; }).join('\n');
    if (sheetRes.heldKept && sheetRes.heldKept.length) {
      body += '\n\n⚠ *승인 전(상태≠확정) 항목이 시트에 들어 있다: `' + sheetRes.heldKept.join('`, `') + '`*\n' +
        '빌드가 넣은 게 아니라 이미 시트에 있던 것이고, 지우지 않고 값을 그대로 뒀다.\n' +
        '→ 내보내도 되는 내용이면 정본에서 `상태: 확정`으로 바꾸고, 아니면 시트에서 그 행을 지울 것.';
    }
    if (sheetRes.sheetOnly && sheetRes.sheetOnly.length) {
      body += '\n\n🔸 *정본에 없는 시트 행 ' + sheetRes.sheetOnly.length + '건* — 지우지 않고 맨 아래 남겼다.\n' +
        '`' + sheetRes.sheetOnly.join('`, `') + '`\n' +
        '클로드→슬랙 경로로 시트에 직접 들어온 행이다. 정본에 올려야 다음 빌드에서 제자리를 잡는다.';
    }
    acdSlack_(body);
    return body;

  } catch (e) {
    var err = '🛑 빌드 중단 — ' + acdClip_(e.message, 800) + '\n' + log.map(function (l) { return '• ' + l; }).join('\n');
    acdSlack_(err);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// 0단계 · 자가진단
//   권한이 끊겨도 조용히 실패하지 않게 한다. 실패는 반드시 슬랙으로 나간다.
// ══════════════════════════════════════════════════════════════

function acdSelfCheck_(quiet) {   // quiet=true(야간 감사): 읽기 검증만, 슬랙 경고 없음
  var props = PropertiesService.getScriptProperties();
  // 슬랙 설정은 acdCheckSlack_ 이 따로 본다(토큰 방식이면 SLACK_WEBHOOK_URL이 없어도 된다).
  if (!props.getProperty('KB_SPREADSHEET_ID')) throw new Error('스크립트 속성 `KB_SPREADSHEET_ID`가 없다.');

  var it = DriveApp.getFoldersByName(ACD_CFG.CANON_FOLDER);
  if (!it.hasNext()) {
    throw new Error('Drive 폴더 `' + ACD_CFG.CANON_FOLDER + '`를 읽을 수 없다. ' +
      '실행 계정에 정본 폴더 접근 권한이 있는지 확인할 것.');
  }
  var folder = it.next();
  if (it.hasNext()) throw new Error('`' + ACD_CFG.CANON_FOLDER + '` 이름의 폴더가 둘 이상이다. 어느 것이 정본인지 알 수 없어 중단한다.');

  // 정본 후보를 모아 **버전을 숫자로** 비교한다.
  // 사전순으로 고르면 v1_10 < v1_7 이 되어 옛 파일을 정본으로 집는다.
  var cands = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (name.indexOf(ACD_CFG.CANON_PREFIX) !== 0) continue;
    cands.push({ file: f, name: name, ver: acdParseVer_(name), mtime: f.getLastUpdated().getTime() });
  }
  if (!cands.length) throw new Error('`' + ACD_CFG.CANON_FOLDER + '`에 `' + ACD_CFG.CANON_PREFIX + '…` 파일이 없다.');

  cands.sort(function (a, b) {
    if (a.ver[0] !== b.ver[0]) return b.ver[0] - a.ver[0];
    if (a.ver[1] !== b.ver[1]) return b.ver[1] - a.ver[1];
    return b.mtime - a.mtime;                              // 버전 같으면 나중에 고친 것
  });
  var best = cands[0].file;

  // 정본 폴더에 정본이 여러 개 있으면 "정본은 하나"라는 전제가 깨진다.
  // 막지는 않되(옛 버전을 참고로 두는 경우가 있다) 반드시 알린다.
  if (cands.length > 1 && !quiet) {
    acdSlack_('⚠ 정본 폴더에 정본 후보가 ' + cands.length + '개 있다. 이번 빌드는 `' + cands[0].name + '`을 썼다.\n' +
      '나머지: `' + cands.slice(1).map(function (c) { return c.name; }).join('`, `') + '`\n' +
      '옛 버전은 `02_아카이브`로 옮기는 게 좋다. 정본 폴더에 둘 이상 있으면 어느 게 정본인지 사람이 헷갈린다.');
  }

  var text = best.getBlob().getDataAsString('UTF-8');
  if (text.indexOf('### [KB-') < 0) throw new Error('정본 파일에 KB 블록이 없다. 파일을 잘못 집었다.');

  // 정본을 **끝까지** 읽었는지 확인한다.
  // 주의: `text.length`는 바이트가 아니라 UTF-16 코드 유닛 수다. 한글은 1유닛·3바이트라
  // 둘이 2배 가까이 벌어진다(260726: 185,362유닛 = 354,296바이트). 바이트끼리 비교해야 한다.
  var readBytes = Utilities.newBlob(text).getBytes().length;
  var driveBytes = best.getSize();
  if (driveBytes && readBytes !== driveBytes) {
    throw new Error('정본을 끝까지 읽지 못했다. Drive 파일 ' + driveBytes +
      ' 바이트인데 읽은 것은 ' + readBytes + ' 바이트다. 잘린 정본으로 빌드하면 지식이 사라진다.');
  }

  var ss = SpreadsheetApp.openById(props.getProperty('KB_SPREADSHEET_ID'));
  if (!ss.getSheetByName(ACD_CFG.SHEET_TAB)) throw new Error('시트 탭 `' + ACD_CFG.SHEET_TAB + '`이 없다.');

  return { fileName: best.getName(), bytes: readBytes, chars: text.length, text: text, ss: ss };
}

// ══════════════════════════════════════════════════════════════
// 1단계 · 파싱
// ══════════════════════════════════════════════════════════════

function acdParseCanon_(text) {
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
        if (cur !== null) { obj[cur] = acdTrimEnd_(buf.join('\n')); buf = []; cur = null; }
        var name = m[1].replace(/^\s+|\s+$/g, '');
        var val = m[2];
        if (val === '|') cur = name;                  // 여러 줄 값 시작
        else obj[name] = val;
      } else if (cur !== null) {
        buf.push(line.replace(/^ {4}/, ''));          // 4칸 들여쓰기 해제
      }
    }
    if (cur !== null) obj[cur] = acdTrimEnd_(buf.join('\n'));

    if (!obj['원본ID']) warnings.push(kbId + ' 원본ID 없음');
    if (!obj['질문']) warnings.push(kbId + ' 질문 없음');
    items.push(obj);
  }
  return { items: items, warnings: warnings };
}

function acdTrimEnd_(s) { return String(s).replace(/[\s﻿\xA0]+$/g, ''); }

/** 가림막을 적용할 때 원본 항목(시트로 갈 값)을 건드리지 않기 위한 얕은 복사. */
function acdShallowCopy_(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }

/** `L2_응대KB_v1_7_260726.md` → [1, 7]. 버전을 못 읽으면 [-1,-1] (수정시각으로만 비교됨). */
function acdParseVer_(name) {
  var m = name.match(/_v(\d+)_(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [-1, -1];
}

// ══════════════════════════════════════════════════════════════
// 2단계 · 정규화 (슬랙 숏코드 → 실제 이모지)
// ══════════════════════════════════════════════════════════════

function acdNormalizeAll_(items) {
  var changed = 0, leftover = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    for (var k in it) {
      if (typeof it[k] !== 'string') continue;
      var v = it[k], before = v;
      for (var code in ACD_CFG.EMOJI) {
        while (v.indexOf(code) >= 0) { v = v.replace(code, ACD_CFG.EMOJI[code]); changed++; }
      }
      if (v !== before) it[k] = v;
      // 매핑에 없는 숏코드가 남았는지 본다 — 새 숏코드가 유입되면 알아야 한다
      var m = v.match(/:[a-z][a-z0-9_+\-]{1,29}:/g);
      if (m) for (var j = 0; j < m.length; j++) leftover[m[j]] = (leftover[m[j]] || 0) + 1;
    }
  }
  var keys = Object.keys(leftover);
  if (keys.length) {
    acdSlack_('⚠ 매핑에 없는 이모지 숏코드가 정본에 있다 — `' + keys.join('`, `') +
      '`\n`ACD_CFG.EMOJI`에 추가하지 않으면 환자 화면에 그대로 찍힌다.');
  }
  return { changed: changed, leftover: keys };
}

// ══════════════════════════════════════════════════════════════
// 3단계 · 답변KB 시트
//   정본에 없는 시트 행은 **절대 지우지 않는다.** 맨 아래로 밀고 슬랙에 알린다.
//   (클로드→슬랙 경로가 시트에 직접 쓰기 때문에 이 행들이 생긴다)
// ══════════════════════════════════════════════════════════════

function acdWriteSheet_(items, held, dry) {
  var props = PropertiesService.getScriptProperties();
  var sh = SpreadsheetApp.openById(props.getProperty('KB_SPREADSHEET_ID')).getSheetByName(ACD_CFG.SHEET_TAB);

  var old = sh.getDataRange().getValues();
  var oldHeader = old.length ? old[0] : [];
  var idCol = oldHeader.indexOf('id');
  if (idCol < 0) throw new Error('시트 헤더에 `id` 열이 없다.');

  var canonIds = {};
  var rows = items.map(function (it) {
    var id = it['원본ID'];
    canonIds[id] = true;
    return ACD_CFG.SHEET_COLS.map(function (col) {
      for (var f in ACD_CFG.FIELD_MAP) if (ACD_CFG.FIELD_MAP[f] === col) return it[f] || '';
      return '';
    });
  });

  // 보류 항목(상태≠확정)의 원본ID
  var heldIds = {};
  (held || []).forEach(function (it) { if (it['원본ID']) heldIds[it['원본ID']] = true; });

  // 기존 시트 행을 세 갈래로 나눈다. **어느 쪽도 지우지 않는다.**
  //   ① 확정 → 정본 값으로 다시 쓴다
  //   ② 보류(검토중·검수대기) → 시트에 있던 값을 그대로 둔다. 승인 안 된 문안을 정본에서 밀어넣지 않는다
  //   ③ 정본에 아예 없음 → 그대로 두고 슬랙에 보고 (클로드→슬랙 경로가 직접 쓴 행)
  var sheetOnly = [], keep = [], heldRows = [], heldKept = [];
  for (var r = 1; r < old.length; r++) {
    var id = String(old[r][idCol] || '').replace(/^\s+|\s+$/g, '');
    if (!id) continue;
    var row = old[r].slice(0, ACD_CFG.SHEET_COLS.length);
    if (canonIds[id]) continue;                                  // ①
    if (heldIds[id]) { heldRows.push(row); heldKept.push(id); }   // ②
    else { sheetOnly.push(id); keep.push(row); }                  // ③
  }

  var total = rows.length + heldRows.length + keep.length;
  var oldCount = Math.max(0, old.length - 1);
  if (oldCount - total > ACD_CFG.MAX_SHRINK) {
    throw new Error('시트 행이 ' + oldCount + ' → ' + total + '로 ' + (oldCount - total) +
      '건 줄어든다(허용 ' + ACD_CFG.MAX_SHRINK + '). 정본 누락이 의심되어 중단한다.');
  }

  var msg = '시트 ' + oldCount + '행 → ' + total + '행' +
    (heldRows.length ? ' (⚠ 승인 전 항목 ' + heldRows.length + '건이 시트에 노출 중, 값은 유지: ' + heldKept.join(',') + ')' : '') +
    (keep.length ? ' (정본 없는 행 ' + keep.length + '건 보존)' : '') +
    (dry ? ' [리허설 — 쓰지 않음]' : '');
  if (dry) return { msg: msg, sheetOnly: sheetOnly, heldKept: heldKept };

  var out = [ACD_CFG.SHEET_COLS].concat(rows).concat(heldRows).concat(keep);
  sh.clearContents();
  sh.getRange(1, 1, out.length, ACD_CFG.SHEET_COLS.length).setValues(out);
  return { msg: msg, sheetOnly: sheetOnly, heldKept: heldKept };
}

// ══════════════════════════════════════════════════════════════
// 4단계 · qa374.json (GitHub)
//   6개 언어를 함께 싣는다. 정본에는 번역이 있는데 말단에 없어서
//   외국인 응대에 못 쓰이던 문제(260726 확인)를 여기서 푼다.
// ══════════════════════════════════════════════════════════════

function acdWriteJson_(items, dry) {
  var payload = {
    version: 'build-' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmm'),
    updated: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd'),
    source: '정본 L2_응대KB (Drive ' + ACD_CFG.CANON_FOLDER + ') 에서 자동 빌드. 이 파일을 직접 고치지 말 것 — 다음 빌드에서 덮인다.',
    count: items.length,
    items: items.map(function (it) {
      var red = ACD_CFG.PUBLIC_REDACT[it['KB']];
      if (red) { it = acdShallowCopy_(it); for (var f in red) it[f] = red[f]; }
      var o = {};
      ACD_CFG.SHEET_COLS.forEach(function (col) {
        for (var f in ACD_CFG.FIELD_MAP) if (ACD_CFG.FIELD_MAP[f] === col) o[col] = it[f] || '';
      });
      ACD_CFG.LANGS.forEach(function (lg) {
        if (lg === 'KO') return;                       // KO는 이미 a
        var v = it['답변_' + lg];
        if (v) o['a_' + lg] = v;                       // 번역 있는 것만 — 빈 필드로 파일 부풀리지 않는다
      });
      o.KB = it['KB'];                                 // 정본 추적용 불변 키
      return o;
    })
  };

  var body = JSON.stringify(payload, null, 2);

  // 공개 대상에 민감정보가 남았는지 본다. 있으면 **푸시하지 않고 중단**한다.
  // 한 번 public 리포에 올라가면 커밋 이력에 영원히 남는다. 되돌려도 남는다.
  var leaks = [];
  payload.items.forEach(function (o) {
    var text = JSON.stringify(o);
    ACD_CFG.SENSITIVE.forEach(function (s) {
      var m = text.match(s.re);
      if (!m) return;
      if (s.minDigits && m[0].replace(/\D/g, '').length < s.minDigits) return;   // 날짜 등 오탐 제외
      leaks.push(o.KB + '/' + o.id + ' — ' + s.name + ' (' + m[0].slice(0, 6) + '…)');
    });
  });
  if (leaks.length) {
    throw new Error('공개 대상(qa374.json)에 민감정보가 있어 푸시를 중단한다:\n' + leaks.slice(0, 10).join('\n') +
      '\n→ `ACD_CFG.PUBLIC_REDACT`에 해당 KB-ID의 대체 문안을 넣을 것. ' +
      'public 리포에 한 번 올라가면 커밋 이력에 영원히 남는다.');
  }
  var langCount = payload.items.filter(function (o) { return o.a_JA || o.a_EN; }).length;
  var msg = 'qa374.json ' + items.length + '건 · ' + Math.round(body.length / 1024) + 'KB' +
    ' (번역 있는 항목 ' + langCount + '건)' + (dry ? ' [리허설 — 쓰지 않음]' : '');
  if (dry) return { msg: msg };

  var commitMsg = '정본 빌드 — 응대KB ' + items.length + '건';

  // ⚠ 다른 파일의 `lwGitPutTo_`를 부르지 않는다.
  //   260727 사고: 인자 순서를 확인하지 않고 `lwGitPutTo_(경로, 본문, 메시지)`로 불렀는데
  //   실제 순서가 달라 155KB 본문이 URL 자리로 들어갔다. encodeURI가 그걸 %20 범벅으로 만들고,
  //   오류 메시지에 본문이 통째로 실려 슬랙이 폭주했다.
  //   남의 함수 시그니처에 의존하지 않고 항상 자체 푸시를 쓴다.
  acdGhPut_(ACD_CFG.GH_PATH, body, commitMsg);
  return { msg: msg };
}

/**
 * GitHub Contents API로 파일 하나를 덮어쓴다.
 * 스크립트 속성: GH_TOKEN (contents:write 권한) · GH_REPO (`owner/repo`) · GH_BRANCH (없으면 main)
 */
function acdGhPut_(path, content, message) {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('GH_TOKEN');
  var repo = p.getProperty('GH_REPO');
  var branch = p.getProperty('GH_BRANCH') || 'main';
  if (!token || !repo) {
    throw new Error('GitHub 푸시 설정이 없다. 스크립트 속성에 `GH_REPO`(owner/repo 형식)를 넣을 것. ' +
      '`GH_TOKEN`은 라인브릿지 프로젝트에 이미 있다.');
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
    throw new Error('GitHub 조회 실패 ' + got.getResponseCode() + ' — ' + acdClip_(got.getContentText(), 200));
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
      ' — ' + acdClip_(put.getContentText(), 200));
  }
}

// ══════════════════════════════════════════════════════════════
// 슬랙
// ══════════════════════════════════════════════════════════════

/** 슬랙·오류 문자열을 자른다. 260727에 155KB 본문이 오류 메시지에 실려 나갔다. */
function acdClip_(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + '\n…(' + (s.length - n) + '자 생략)';
}

function acdSlack_(text) {
  Logger.log(text);                       // 슬랙이 죽어도 실행 로그에는 남는다 (여기는 자르지 않는다)
  text = acdClip_(text, ACD_CFG.SLACK_MAX);
  var t;
  try { t = acdSlackTarget_(); }
  catch (e) { Logger.log('슬랙 설정 문제: ' + e.message); return { ok: false, err: e.message }; }

  // 채널 분리 (260730): 기계 독백은 로그 채널(ACD_SLACK_CHANNEL), 사람이 봐야 하는
  // 긴급(🚨·🔺)만 경보 채널(ACD_ALERT_CHANNEL, 보통 #회의_프로그램)로.
  // 경보 채널 속성이 없으면 전부 기본 채널 — 기존 동작과 동일(하위호환).
  if (t.mode === 'token' && (text.indexOf('🚨') === 0 || text.indexOf('🔺') === 0)) {
    var alertCh = PropertiesService.getScriptProperties().getProperty('ACD_ALERT_CHANNEL');
    if (alertCh) t = { mode: 'token', token: t.token, channel: alertCh };
  }

  try {
    var res;
    if (t.mode === 'token') {
      res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { Authorization: 'Bearer ' + t.token },
        payload: JSON.stringify({ channel: t.channel, text: text }),
        muteHttpExceptions: true
      });
      var j = JSON.parse(res.getContentText());
      if (!j.ok) {
        // not_in_channel = 봇을 채널에 초대해야 한다 (`/invite @봇이름`)
        var hint = j.error === 'not_in_channel' ? ' — 채널에서 `/invite` 로 봇을 초대할 것'
          : j.error === 'channel_not_found' ? ' — 채널 ID가 틀렸다'
            : j.error === 'invalid_auth' ? ' — SLACK_TOKEN이 만료·오타'
              : '';
        Logger.log('슬랙 거절: ' + j.error + hint);
        return { ok: false, err: j.error + hint };
      }
      return { ok: true };
    }

    res = UrlFetchApp.fetch(t.url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ text: text }), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { ok: false, err: 'HTTP ' + res.getResponseCode() };
    return { ok: true };

  } catch (e) {
    Logger.log('슬랙 발송 실패: ' + e.message);
    return { ok: false, err: e.message };
  }
}
