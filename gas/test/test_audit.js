// 야간 감사 검증 — 실데이터로 "어긋남을 잡는가"와 "깨끗하면 침묵하는가"를 본다
// 사용: node test_audit.js <build_kb.gs> <audit_kb.gs> <정본.md> <시트스냅샷.json> <qa374.json>
const fs = require('fs'), vm = require('vm');
const [, , BUILD, AUDIT, CANON, SHEET, QA] = process.argv;
const canonText = fs.readFileSync(CANON, 'utf8');
const sheetVals = JSON.parse(fs.readFileSync(SHEET, 'utf8'));
const qaBody = fs.readFileSync(QA, 'utf8');

let slackMsgs = [];
const propsStore = { KB_SPREADSHEET_ID: 'x', GH_REPO: 'acrohani75-dot/acro', SLACK_TOKEN: 'x', ACD_SLACK_CHANNEL: 'x' };
const sheetObj = { getDataRange: () => ({ getValues: () => sheetVals }) };
const sb = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => propsStore[k] || null,
    setProperty: (k, v) => { propsStore[k] = v; },
    deleteProperty: k => { delete propsStore[k]; }
  }) },
  DriveApp: { getFoldersByName: () => {
    let n = 0;
    return { hasNext: () => n < 1, next: () => { n++; return { getFiles: () => {
      let m = 0;
      return { hasNext: () => m < 1, next: () => { m++; return {
        getName: () => CANON.split('/').pop(),
        getBlob: () => ({ getDataAsString: () => canonText }),
        getSize: () => Buffer.byteLength(canonText, 'utf8'),
        getLastUpdated: () => new Date(0)
      }; } };
    } }; } };
  } },
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheetObj }) },
  UrlFetchApp: { fetch: url => String(url).includes('raw.githubusercontent')
    ? { getResponseCode: () => 200, getContentText: () => qaBody }
    : { getResponseCode: () => 200, getContentText: () => '{"ok":true}' } },
  Utilities: { formatDate: () => 'x', base64Encode: () => 'x',
    newBlob: t => ({ getBytes: () => Buffer.from(t, 'utf8') }), Charset: { UTF_8: 1 } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }) },
  Logger: { log() {} }, Date, JSON, Object, String, Array, Math, RegExp, Error, Number, console, Buffer
};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(BUILD, 'utf8'), sb);
vm.runInContext(fs.readFileSync(AUDIT, 'utf8'), sb);
sb.acdSlack_ = m => slackMsgs.push(m);   // 슬랙 발송 가로채기

let fail = 0;
const ok = (c, l, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '   ' + x : '')); if (!c) fail++; };

// ── 시나리오 1: 실데이터 (시트=v1.8빌드 결과, qa374=손수정 v2.2, 정본=v2.1) → 어긋남을 잡아야 한다
const rep = sb.acdAudit();
ok(rep.total > 0, '어긋남 감지됨', rep.total + '건');
const all = rep.lines.join('\n');
ok(/\[시트\] Q117/.test(all), '재탕전 판정(KB-0117) 드리프트를 잡음');
ok(/\[시트\] Q126|\[시트\] Q146|\[시트\] Q147|\[시트\] Q148/.test(all), '보관 판정(v2.0 수정 4곳) 드리프트를 잡음');
ok(/\[qa374\] 건수/.test(all), 'qa374 건수 불일치(빌드 미실행)를 잡음');
ok(!/\[유출\]/.test(all), '유출 오탐 없음 (계좌는 이미 가려짐)');
ok(slackMsgs.length === 1, '슬랙 보고 정확히 1건', slackMsgs.length + '건');
ok(slackMsgs[0] && slackMsgs[0].length <= 3200, '보고가 요약됨 (폭주 방지)');
console.log('\n  --- 보고 예시(앞 6줄)');
(slackMsgs[0] || '').split('\n').slice(0, 6).forEach(l => console.log('  | ' + l));

// ── 시나리오 2: 시트·qa374를 정본에서 유도 → 침묵해야 한다
slackMsgs = [];
const parsed = sb.acdParseCanon_(canonText);
const confirmed = parsed.items.filter(i => (i['상태'] || '') === sb.ACD_CFG.PUBLISH_STATE);
sheetVals.length = 0;
sheetVals.push(sb.ACD_CFG.SHEET_COLS.slice());
confirmed.forEach(it => sheetVals.push(sb.acdAuditRow_(it)));
const pubItems = confirmed.map(it => {
  const red = sb.ACD_CFG.PUBLIC_REDACT[it['KB']];
  if (red) { it = sb.acdShallowCopy_(it); for (const f in red) it[f] = red[f]; }
  return { id: it['원본ID'], q: it['질문'] || '', a: sb.acdAuditEmoji_(it['답변_KO'] || '') };
});
const cleanQa = JSON.stringify({ items: pubItems });
sb.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => cleanQa });
delete propsStore.AUD_LAST_HB;                        // 생존 신호 조건 성립시키기
const rep2 = sb.acdAudit();
ok(rep2.total === 0, '깨끗하면 어긋남 0');
ok(slackMsgs.length === 1 && /생존 신호/.test(slackMsgs[0]), '침묵 + 주1회 생존 신호만');
propsStore.AUD_LAST_HB = String(Date.now());
slackMsgs = [];
sb.acdAudit();
ok(slackMsgs.length === 0, '생존 신호 이후에는 완전 침묵');

// ── 시나리오 3: 공개 리포에 계좌가 다시 들어오면 → 유출 경보
slackMsgs = [];
const leakQa = cleanQa.replace('"items"', '"x":"기업은행 089-084316-01-012","items"');
sb.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => leakQa });
const rep3 = sb.acdAudit();
ok(rep3.leak === true, '유출 감지');
ok(/공개 리포에 민감정보/.test(slackMsgs[0] || ''), '유출은 🚨 최우선 경보');

console.log('\n' + (fail ? '실패 ' + fail + '건' : '전부 통과'));
process.exit(fail ? 1 : 0);
