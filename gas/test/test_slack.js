// acdSlackTarget_ 이 속성 조합을 올바르게 해석하는지
const fs=require('fs'), vm=require('vm');
function load(props){
  const sb={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},
   Logger:{log(){}},UrlFetchApp:{fetch:()=>({})},
   Utilities:{formatDate:()=>'x',base64Encode:()=>'x',newBlob:()=>({getBytes:()=>[]}),Charset:{UTF_8:1}},
   DriveApp:{},SpreadsheetApp:{},JSON,Object,String,Array,Math,Date,RegExp,Error,console,parseInt};
  vm.createContext(sb); vm.runInContext(fs.readFileSync('gas/build_kb.gs','utf8'),sb); return sb;
}
let fail=0;
const T=(label,props,expect)=>{
  let got;
  try{ const t=load(props).acdSlackTarget_(); got=t.mode+(t.channel?':'+t.channel:''); }
  catch(e){ got='ERR: '+e.message.split('\n')[0].slice(0,110); }
  const ok = expect instanceof RegExp ? expect.test(got) : got===expect;
  console.log((ok?'  PASS  ':'  FAIL  ')+label+'\n           → '+got);
  if(!ok) fail++;
};

T('원장님 현재 설정 (SLACK_TOKEN + SLACK_WEBHOOK_URL에 채널ID)',
  {SLACK_TOKEN:'xoxb-9178246661396-115532',SLACK_WEBHOOK_URL:'C0BDUTKLEGY'}, 'token:C0BDUTKLEGY');
T('명시적 채널 속성이 우선',
  {SLACK_TOKEN:'xoxb-abc',ACD_SLACK_CHANNEL:'C999',SLACK_WEBHOOK_URL:'C0BDUTKLEGY'}, 'token:C999');
T('진짜 웹훅만 있는 경우',
  {SLACK_WEBHOOK_URL:'https://hooks.slack.com/services/T/B/x'}, 'hook');
T('토큰만 있고 채널 모름 → 명확한 오류',
  {SLACK_TOKEN:'xoxb-abc'}, /^ERR:.*채널/);
T('채널ID를 웹훅 칸에 넣고 토큰 없음 → 원인 지목',
  {SLACK_WEBHOOK_URL:'C0BDUTKLEGY'}, /^ERR:.*웹훅 URL이 아니다/);
T('아무것도 없음', {}, /^ERR:.*슬랙 설정이 없다/);
console.log('\n'+(fail?'실패 '+fail:'전부 통과'));
process.exit(fail?1:0);
