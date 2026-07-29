// 정본 동기화 검증 — 새 버전 반영·기존 침묵·깨진 파일 거부·오류 1회 알림
const fs=require('fs'), vm=require('vm');
const canon=fs.readFileSync(process.argv[3],'utf8');
let driveFiles=['L2_응대KB_v2_4_260729.md'], created=[], slack=[], props={CANON_REPO:'o/r',GH_TOKEN:'t'};
let repoList=[{name:'L2_응대KB_v2_4_260729.md',size:1,download_url:'u4'},
              {name:'L2_응대KB_v2_5_260729.md',size:Buffer.byteLength(canon),download_url:'u5'}];
let rawBody=canon;
const sb={
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>{props[k]=v},deleteProperty:k=>{delete props[k]}})},
 UrlFetchApp:{fetch:u=>String(u).includes('/contents/')
   ?{getResponseCode:()=>200,getContentText:()=>JSON.stringify(repoList)}
   :{getResponseCode:()=>200,getContentText:()=>rawBody}},
 DriveApp:{getFoldersByName:()=>({next:()=>({
   getFilesByName:n=>({hasNext:()=>driveFiles.includes(n)}),
   createFile:(n,t)=>{created.push(n);driveFiles.push(n)}})})},
 Utilities:{newBlob:t=>({getBytes:()=>Buffer.from(t,'utf8')})},
 ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyHours:()=>({create:()=>{}})})})},
 Logger:{log(){}},Date,JSON,String,Number,Math,Object,Array,RegExp,Error,console,Buffer};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),sb);           // build_kb (acdParseVer_ 등)
vm.runInContext(fs.readFileSync(process.argv[4],'utf8'),sb);           // canon_sync
sb.acdSlack_=m=>slack.push(m);

let fail=0; const ok=(c,l,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(x?'   '+x:''));if(!c)fail++;};

sb.acdCanonSync();
ok(created.includes('L2_응대KB_v2_5_260729.md'),'새 버전 → Drive 생성');
ok(slack.length===1 && /정본 동기화/.test(slack[0]),'반영 알림 1건');

slack=[];created=[];
sb.acdCanonSync();
ok(created.length===0 && slack.length===0,'이미 반영됨 → 완전 침묵');

driveFiles=driveFiles.filter(n=>!n.includes('v2_6'));
repoList.push({name:'L2_응대KB_v2_6_260730.md',size:50,download_url:'u6'});
rawBody='깨진 파일';
slack=[];created=[];
sb.acdCanonSync();
ok(created.length===0,'깨진 파일 → Drive에 쓰지 않음');
ok(slack.length===1 && /동기화 실패/.test(slack[0]),'실패 알림 1건');
slack=[];
sb.acdCanonSync();
ok(slack.length===0,'같은 오류 반복 → 침묵');

console.log('\n'+(fail?'실패 '+fail:'전부 통과'));
process.exit(fail?1:0);
