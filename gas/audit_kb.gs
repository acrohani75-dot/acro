/**
 * 아크로드 야간 드리프트 감사 (M3) — audit_kb.gs
 *
 * 매일 밤 정본(Drive md) ↔ 답변KB 시트 ↔ qa374.json(공개 리포)을 대조한다.
 * 어긋난 게 있을 때만 슬랙 한 줄. 깨끗하면 침묵하고, 주 1회만 생존 신호를 보낸다.
 *
 * 전제: build_kb.gs 와 **같은 Apps Script 프로젝트**에 있어야 한다.
 *       (acdParseCanon_ · acdSelfCheck_ · acdSlack_ · ACD_CFG 를 재사용한다)
 * 설치: 한 번만 acdAuditInstall() 실행 → 매일 03시대 트리거가 걸린다.
 * 수동 실행: acdAudit()
 *
 * 이 감사는 어디에도 **쓰지 않는다.** 읽고 비교하고 보고만 한다.
 * (스크립트 속성 AUD_* 2개만 상태 저장용으로 쓴다)
 */

var AUD_CFG = {
  HEARTBEAT_DAYS: 7,       // 이 일수마다 "전부 정상" 생존 신호 1줄
  MAX_LINES: 8,            // 슬랙 보고에 싣는 어긋남 최대 줄수 (나머지는 "외 N건")
  SNIP: 40                 // 값 비교 표시 길이
};

/** 수동/트리거 진입점 */
function acdAudit() {
  var props = PropertiesService.getScriptProperties();
  try {
    var report = acdAuditRun_();
    if (report.lines.length) {
      var head = report.leak ? '🚨 야간 감사 — **공개 리포에 민감정보**' :
                               '🌙 야간 드리프트 감사 — 어긋남 ' + report.total + '건';
      var body = report.lines.slice(0, AUD_CFG.MAX_LINES).join('\n');
      if (report.total > AUD_CFG.MAX_LINES) body += '\n… 외 ' + (report.total - AUD_CFG.MAX_LINES) + '건';
      acdSlack_(head + '\n' + body + '\n_정본 `' + report.canonName + '` · 확정 ' + report.confirmed + '건 기준_');
      props.setProperty('AUD_STREAK', '0');
    } else {
      // 침묵. 다만 연속 정상 횟수를 세고, 주 1회 생존 신호를 보낸다.
      // (센서가 죽어 조용한 것과 정상이라 조용한 것을 원장이 구분할 수 있어야 한다)
      var streak = Number(props.getProperty('AUD_STREAK') || 0) + 1;
      props.setProperty('AUD_STREAK', String(streak));
      var lastHb = Number(props.getProperty('AUD_LAST_HB') || 0);
      if (Date.now() - lastHb >= AUD_CFG.HEARTBEAT_DAYS * 864e5) {
        acdSlack_('💚 드리프트 감사 생존 신호 — 최근 ' + streak + '회 연속 전부 정상 (정본↔시트↔qa374)');
        props.setProperty('AUD_LAST_HB', String(Date.now()));
      }
    }
    return report;
  } catch (e) {
    // 감사 자체가 죽으면 그 사실을 알린다. 단, 같은 오류로 매일 울리지는 않는다.
    var msg = String(e && e.message || e);
    var last = props.getProperty('AUD_LAST_ERR') || '';
    if (last !== msg) {
      acdSlack_('🔺 드리프트 감사 실패 — ' + acdClip_(msg, 300) + '\n같은 오류가 반복되면 다시 알리지 않는다. 고쳐질 때까지 감사는 눈을 감고 있다.');
      props.setProperty('AUD_LAST_ERR', msg);
    }
    throw e;
  } finally {
    // 오류가 해소된 밤에는 다음 오류를 다시 알릴 수 있게 리셋
    if (props.getProperty('AUD_LAST_ERR') && !acdAuditLastFailed_) props.deleteProperty('AUD_LAST_ERR');
  }
}
var acdAuditLastFailed_ = false;

/** 본체 — 읽기 전용 */
function acdAuditRun_() {
  acdAuditLastFailed_ = true;
  var base = acdSelfCheck_(true);                          // quiet=true: 정본 후보 다수 경고는 빌드 때만
  var parsed = acdParseCanon_(base.text);
  var confirmed = [], held = {};
  parsed.items.forEach(function (it) {
    if ((it['상태'] || '') === ACD_CFG.PUBLISH_STATE) confirmed.push(it);
    else if (it['원본ID']) held[it['원본ID']] = true;
  });

  var lines = [];

  // ── ① 답변KB 시트 대조 ─────────────────────────────
  var sh = base.ss.getSheetByName(ACD_CFG.SHEET_TAB);
  var vals = sh.getDataRange().getValues();
  var header = vals.length ? vals[0] : [];
  var idCol = header.indexOf('id');
  if (idCol < 0) throw new Error('시트 헤더에 `id` 열이 없다.');
  var sheetMap = {};
  for (var r = 1; r < vals.length; r++) {
    var id = String(vals[r][idCol] || '').replace(/^\s+|\s+$/g, '');
    if (id) sheetMap[id] = vals[r];
  }

  confirmed.forEach(function (it) {
    var id = it['원본ID'];
    var row = sheetMap[id];
    if (!row) { lines.push('[시트] ' + id + ' — 정본 확정인데 시트에 없음'); return; }
    var exp = acdAuditRow_(it);
    for (var c = 0; c < ACD_CFG.SHEET_COLS.length; c++) {
      var a = acdTrimEnd_(String(row[c] == null ? '' : row[c]));
      var b = acdTrimEnd_(exp[c]);
      if (a !== b) {
        // 값이 여러 줄이면 보고가 흩어진다 — 한 줄로 눌러서 앞부분만 보여준다
        var flat = function (s) { return s.replace(/\s+/g, ' ').slice(0, AUD_CFG.SNIP); };
        lines.push('[시트] ' + id + ' ' + ACD_CFG.SHEET_COLS[c] + '열 — 「' +
          flat(a) + '…」 ≠ 정본 「' + flat(b) + '…」');
        break;                                             // 한 항목당 첫 어긋남만
      }
    }
  });

  // ── ② qa374.json (공개 리포) 대조 + 유출 검사 ────────
  var leak = false;
  var ghRepo = PropertiesService.getScriptProperties().getProperty('GH_REPO');
  if (!ghRepo) {
    lines.push('[qa374] GH_REPO 속성이 없어 공개 리포 대조를 건너뜀');
  } else {
    var url = 'https://raw.githubusercontent.com/' + ghRepo + '/main/' + ACD_CFG.GH_PATH;
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      lines.push('[qa374] 공개 리포에서 읽기 실패 HTTP ' + res.getResponseCode());
    } else {
      var body = res.getContentText();

      // 유출 검사 — 되돌릴 수 없는 사고라 최우선
      ACD_CFG.SENSITIVE.forEach(function (s) {
        var m = body.match(s.re);
        if (!m) return;
        if (s.minDigits && m[0].replace(/\D/g, '').length < s.minDigits) return;
        leak = true;
        lines.unshift('[유출] 공개 qa374.json에 ' + s.name + ' 패턴 (' + m[0].slice(0, 6) + '…) — 즉시 제거 필요');
      });

      var pub = JSON.parse(body);
      var pubMap = {};
      (pub.items || []).forEach(function (o) { if (o.id) pubMap[o.id] = o; });

      if ((pub.items || []).length !== confirmed.length) {
        lines.push('[qa374] 건수 ' + (pub.items || []).length + ' ≠ 정본 확정 ' + confirmed.length +
          ' — 빌드가 아직 안 돌았거나 손 수정이 끼었다');
      }
      confirmed.forEach(function (it) {
        var red = ACD_CFG.PUBLIC_REDACT[it['KB']];
        if (red) { it = acdShallowCopy_(it); for (var f in red) it[f] = red[f]; }
        var id = it['원본ID'];
        var o = pubMap[id];
        if (!o) { lines.push('[qa374] ' + id + ' 없음'); return; }
        if (acdTrimEnd_(String(o.a || '')) !== acdTrimEnd_(acdAuditEmoji_(it['답변_KO'] || ''))) {
          lines.push('[qa374] ' + id + ' 답변이 정본과 다름');
        }
      });
    }
  }

  acdAuditLastFailed_ = false;
  return {
    lines: lines.slice(0), total: lines.length, leak: leak,
    canonName: base.fileName, confirmed: confirmed.length
  };
}

/** 정본 항목 → 시트 기대 행 (빌드의 매핑·이모지 정규화와 동일, 슬랙 경고만 없음) */
function acdAuditRow_(it) {
  return ACD_CFG.SHEET_COLS.map(function (col) {
    for (var f in ACD_CFG.FIELD_MAP) {
      if (ACD_CFG.FIELD_MAP[f] === col) return acdAuditEmoji_(it[f] || '');
    }
    return '';
  });
}

function acdAuditEmoji_(v) {
  v = String(v);
  for (var code in ACD_CFG.EMOJI) {
    while (v.indexOf(code) >= 0) v = v.replace(code, ACD_CFG.EMOJI[code]);
  }
  return v;
}

/** 트리거 설치 — 한 번만 실행. 이미 있으면 지우고 다시 건다(중복 방지). */
function acdAuditInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'acdAudit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('acdAudit').timeBased().everyDays(1).atHour(3).create();
  acdSlack_('🌙 야간 드리프트 감사 설치 완료 — 매일 03시대에 정본↔시트↔qa374를 대조한다. 어긋날 때만 알린다.');
}
