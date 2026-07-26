// gas/build_kb.gs 의 파서를 실제 정본에 걸어 검증한다.
// GAS 전용 API는 스텁으로 막고, 순수 함수(parseCanon_ / normalizeAll_ / writeJson_)만 돌린다.
const fs = require('fs');
const vm = require('vm');

const GAS = process.argv[2];
const CANON = process.argv[3];

const logs = [];
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  Logger: { log: (s) => logs.push(s) },
  UrlFetchApp: { fetch: () => ({}) },
  Utilities: { formatDate: () => '260726-0000' },
  DriveApp: {}, SpreadsheetApp: {},
  JSON, Object, String, Array, Math, Date, RegExp, Error, console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(GAS, 'utf8'), sandbox);

const text = fs.readFileSync(CANON, 'utf8');
const parsed = sandbox.kbParseCanon_(text);

let fail = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
};

console.log('== 파싱 ==');
ok(parsed.items.length === 423, '블록 423건', '실제 ' + parsed.items.length);
ok(parsed.warnings.length === 0, '파싱 경고 0건', parsed.warnings.slice(0, 5).join(' / '));

const FIELDS = ['상태','갱신','원본ID','원본코드','태그','난이도','채널','질문',
                '답변_KO','답변_JA','답변_ZH_CN','답변_ZH_TW','답변_TH','답변_EN','근거'];
const missing = {};
parsed.items.forEach(it => FIELDS.forEach(f => {
  if (!(f in it)) missing[f] = (missing[f] || 0) + 1;
}));
ok(Object.keys(missing).length === 0, '15개 필드 전원 존재', JSON.stringify(missing));

const ids = parsed.items.map(i => i['원본ID']);
ok(new Set(ids).size === ids.length, '원본ID 중복 없음',
   '고유 ' + new Set(ids).size + '/' + ids.length);
ok(parsed.items.every(i => /^KB-\d{4}$/.test(i.KB)), 'KB-ID 형식');

console.log('\n== 여러 줄 값 (블록 스칼라) ==');
const multi = parsed.items.filter(i => i['질문'].indexOf('\n') >= 0);
ok(multi.length === 17, '여러 줄 질문 17건', '실제 ' + multi.length);
const q = parsed.items.find(i => i.KB === 'KB-0087');
if (q) { console.log('  예) KB-0087 질문 =', JSON.stringify(q['질문'])); }
const a92 = parsed.items.find(i => i.KB === 'KB-0092');
ok(a92 && a92['답변_KO'].indexOf('\n\n') >= 0, '여러 줄 답변의 빈 줄 보존');
ok(a92 && !/^\s/.test(a92['답변_KO']), '들여쓰기 4칸 해제됨');
ok(a92 && a92['답변_KO'].indexOf('발렛비 4,000원에 2시간 지원') >= 0, '주차 확정값 파싱');

console.log('\n== 이모지 정규화 ==');
const norm = sandbox.kbNormalizeAll_(parsed.items);
ok(norm.changed === 0, 'v1.6 정본에 남은 숏코드 0곳', '치환 ' + norm.changed);
ok(norm.leftover.length === 0, '매핑 밖 숏코드 0종', norm.leftover.join(','));

console.log('\n== json 산출물 ==');
const res = sandbox.kbWriteJson_(parsed.items, true);
console.log('  ' + res.msg);

console.log('\n== 시트 열 매핑 ==');
const first = parsed.items[0];
const row = sandbox.KB_CFG.SHEET_COLS.map(col => {
  for (const f in sandbox.KB_CFG.FIELD_MAP) if (sandbox.KB_CFG.FIELD_MAP[f] === col) return first[f] || '';
  return '';
});
console.log('  ' + JSON.stringify(row).slice(0, 200));
ok(row[0] === 'Q001' && row[2] === '응대 기본 원칙', '첫 행이 시트 원본과 일치');

console.log('\n' + (fail ? '실패 ' + fail + '건' : '전부 통과'));
process.exit(fail ? 1 : 0);
