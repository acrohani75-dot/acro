const fs=require('fs'), vm=require('vm');
const sb={PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},Logger:{log(){}},
 UrlFetchApp:{fetch:()=>({})},Utilities:{formatDate:()=>'x',base64Encode:()=>'x',Charset:{UTF_8:1}},
 DriveApp:{},SpreadsheetApp:{},JSON,Object,String,Array,Math,Date,RegExp,Error,console,parseInt};
vm.createContext(sb); vm.runInContext(fs.readFileSync('gas/build_kb.gs','utf8'),sb);

const names=['L2_응대KB_v1_6_260726.md','L2_응대KB_v1_7_260726.md','L2_응대KB_v1_10_260801.md',
             'L2_응대KB_v2_0_260810.md','L2_응대KB_v10_2_261101.md','L2_응대KB_구본.md'];
const c=names.map((n,i)=>({name:n,ver:sb.parseVer_(n),mtime:i}));
c.sort((a,b)=>a.ver[0]!==b.ver[0]?b.ver[0]-a.ver[0]:a.ver[1]!==b.ver[1]?b.ver[1]-a.ver[1]:b.mtime-a.mtime);
console.log('버전 파싱:'); names.forEach(n=>console.log('  ',n,'→',JSON.stringify(sb.parseVer_(n))));
console.log('\n정렬 결과 (맨 위가 정본으로 선택됨):');
c.forEach((x,i)=>console.log(`  ${i===0?'★':' '} ${x.name}`));
console.log('\n사전순으로 골랐다면:', names.filter(n=>n.startsWith('L2_응대KB_v')).sort().pop());
