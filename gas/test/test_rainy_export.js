// 레이니 추출 자동화 검증 — 필터·내부제거·무변화 침묵·유출 중단
const fs=require('fs'), vm=require('vm');
const canon=fs.readFileSync(process.argv[3],'utf8');
let slack=[], puts=[], remote={};   // path→content
const sb={
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>({CANON_REPO:'o/r',GH_TOKEN:'t',KB_SPREADSHEET_ID:'x'}[k]||null),
   setProperty(){},deleteProperty(){}})},
 DriveApp:{getFoldersByName:()=>{let n=0;return{hasNext:()=>n<1,next:()=>{n++;return{getFiles:()=>{let m=0;
   return{hasNext:()=>m<1,next:()=>{m++;return{getName:()=>'L2_응대KB_v2_6_260729.md',
   getBlob:()=>({getDataAsString:()=>canon}),getSize:()=>Buffer.byteLength(canon),getLastUpdated:()=>new Date(0)};}};}};}};}},
 SpreadsheetApp:{openById:()=>({getSheetByName:()=>({})})},
 UrlFetchApp:{fetch:(u,o)=>{
   const path=decodeURIComponent(String(u).split('/contents/')[1]||'');
   if(!o||!o.method){ // GET
     if(remote[path]) return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({sha:'s',content:Buffer.from(remote[path],'utf8').toString('base64')})};
     return{getResponseCode:()=>404,getContentText:()=>'{}'};
   }
   const body=JSON.parse(o.payload); remote[path]=Buffer.from(body.content,'base64').toString('utf8');
   puts.push(path); return{getResponseCode:()=>201,getContentText:()=>'{}'};
 }},
 Utilities:{newBlob:(t)=>({getBytes:()=>Buffer.from(t,'utf8'),getDataAsString:()=>Buffer.isBuffer(t)?t.toString('utf8'):String(t)}),
   base64Encode:(t)=>Buffer.from(t,'utf8').toString('base64'),
   base64Decode:(t)=>Buffer.from(t,'base64'),
   formatDate:()=>'x',Charset:{UTF_8:1}},
 ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyDays:()=>({atHour:()=>({create(){}})})})})},
 Logger:{log(){}},Date,JSON,String,Number,Math,Object,Array,RegExp,Error,console,Buffer};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),sb);   // build_kb
vm.runInContext(fs.readFileSync(process.argv[4],'utf8'),sb);   // rainy_export
sb.acdSlack_=m=>slack.push(m);

let fail=0; const ok=(c,l,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'   '+x:''));if(!c)fail++;};

sb.acdRainyExport();
ok(puts.length===1,'첫 실행 → 푸시 1회');
const txt=remote['레이니_KB추출본_latest.md']||'';
const n=(txt.match(/^### \[/gm)||[]).length;
ok(n>=350 && n<=370,'수록 건수 정상 범위',n+'건');
ok(!/\[L\d+\]|\[R\d+\]/.test(txt),'L·R 계열 제외');
ok(!txt.includes('Q302')&&!txt.includes('089-084316'),'계좌 항목·패턴 없음');
ok(!/※\s*\[내부\]/.test(txt),'내부 메모 없음');
ok(txt.includes('[M001]'),'채굴 수확(M001) 포함');
ok(txt.includes('온다(ONDA) 가격'),'v2.6 제목 개정 반영');
ok(slack.length===1&&/레이니 추출본 갱신/.test(slack[0]),'갱신 알림 1건');

slack=[];puts=[];
sb.acdRainyExport();
ok(puts.length===0&&slack.length===0,'변화 없음 → 완전 침묵');

console.log('\n'+(fail?'실패 '+fail:'전부 통과'));
process.exit(fail?1:0);
