// 레이니 수신 소켓 검증 — 마스킹·중복·상한·테스트필터·불사(不死) 응답
const fs = require('fs'), vm = require('vm');
let rows = [['시각','최근시각','반복횟수','채널','언어','질문','응답여부','사용KB','상태','등재ID','비고']];
const sheet = {
  getLastRow: () => rows.length,
  appendRow: r => rows.push(r),
  getRange: (r, c, nr, nc) => ({
    getValues: () => rows.slice(r - 1, r - 1 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || 1))),
    setValue: v => { rows[r - 1][c - 1] = v; }
  })
};
let cacheStore = {};
const sb = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'x' }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
  CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
  ContentService: { createTextOutput: t => ({ text: t }) },
  Date, JSON, String, Number, Math, Object, Array, RegExp, console
};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), sb);

let fail = 0;
const ok = (c, l, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '   ' + x : '')); if (!c) fail++; };
const post = obj => sb.doPost({ postData: { contents: typeof obj === 'string' ? obj : JSON.stringify(obj) } });

post({ question: '온다 리프팅 가격이 얼마인가요?', lang: 'ko', answered: false });
ok(rows.length === 2 && rows[1][6] === '못답함' && rows[1][3] === 'rainy', '기본 수신 → 1행, 못답함');

post({ question: '제 번호는 010-1234-5678 입니다', lang: 'ko', answered: true, kb_id: 'Q011' });
ok(rows[2] && rows[2][5].includes('[전화]') && !rows[2][5].includes('1234'), '전화번호 마스킹', rows[2] ? rows[2][5] : '');
ok(rows[2] && rows[2][6] === '답함' && rows[2][7] === 'Q011', '답함 + 사용KB 기록');

post({ question: '온다, 리프팅 가격이 얼마인가요??', lang: 'ko' });
ok(rows.length === 3 && rows[1][2] === 2, '정규화 중복 → 행 수 그대로, 반복횟수 2', '행 ' + (rows.length - 1) + '개');

post({ question: 'E2E검증 테스트입니다' });
ok(rows.length === 3, '테스트 문구 → 무기록');

post('이건 JSON이 아님{{{');
ok(rows.length === 3, '깨진 JSON → 조용히 무시, 응답은 정상');
const resp = post({ question: '' });
ok(resp && resp.text === 'ok', '어떤 입력에도 200 ok');

const before = rows.length;
for (let i = 0; i < 40; i++) post({ question: '상한 검사용 질문 ' + i });
ok(rows.length - before <= 30, '분당 30건 상한', (rows.length - before) + '건만 수신');

console.log('\n' + (fail ? '실패 ' + fail : '전부 통과'));
process.exit(fail ? 1 : 0);
