// 공개 대상 가림막 검증 — 시트에는 실제 값, qa374.json에는 가려진 값이 가야 한다
const fs=require('fs'), vm=require('vm');
const sb={PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},Logger:{log(){}},
 UrlFetchApp:{fetch:()=>({})},
 Utilities:{formatDate:()=>'x',base64Encode:()=>'x',newBlob:()=>({getBytes:()=>[]}),Charset:{UTF_8:1}},
 DriveApp:{},SpreadsheetApp:{},JSON,Object,String,Array,Math,Date,RegExp,Error,console,parseInt};
vm.createContext(sb); vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),sb);

const items=sb.acdParseCanon_(fs.readFileSync(process.argv[3],'utf8')).items
  .filter(i=>i['상태']==='확정');
let fail=0;
const ok=(c,l,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'   '+x:''));if(!c)fail++;};

const src=items.find(i=>i.KB==='KB-0302');
ok(!!src,'KB-0302 존재');
ok(/기업은행/.test(src['답변_KO']),'정본에는 은행명이 그대로 있다 (시트로 갈 값)');

const res=sb.acdWriteJson_(items,true);
console.log('  '+res.msg);
ok(/기업은행/.test(items.find(i=>i.KB==='KB-0302')['답변_KO']),
   '가림막이 원본 항목을 훼손하지 않았다 (시트 값 보존)');

// 가림막을 비우면 유출 검사가 잡아내야 한다
const saved=sb.ACD_CFG.PUBLIC_REDACT;
sb.ACD_CFG.PUBLIC_REDACT={};
let caught=null;
try{ sb.acdWriteJson_(items,true); }catch(e){ caught=e.message; }
ok(!!caught && /민감정보/.test(caught),'가림막 없으면 푸시를 중단한다');
if(caught) console.log('         → '+caught.split('\n').slice(0,2).join(' / ').slice(0,140));
sb.ACD_CFG.PUBLIC_REDACT=saved;

console.log('\n'+(fail?'실패 '+fail:'전부 통과'));
process.exit(fail?1:0);
