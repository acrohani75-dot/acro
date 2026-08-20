
const fs=require('fs'),vm=require('vm'),path=require('path');
let cache={};
const sandbox={
  CacheService:{getScriptCache:()=>({get:k=>cache[k]||null,put:(k,v,s)=>{cache[k]=v;}})},
  JSON,Object,String,Array,Math,Number,RegExp,Error,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','reply_guard.gs'),'utf8'),sandbox);
let p=0,f=0;const ok=(l,c)=>{c?(p++,console.log(' ✓ '+l)):(f++,console.log(' ✗ '+l));};

console.log('1) 중복 발송 차단');
cache={};
ok('처음 온 메시지는 통과', sandbox.argDupe_('m1')===false);
ok('★같은 메시지 재도착은 중복 판정', sandbox.argDupe_('m1')===true);
ok('다른 메시지는 통과', sandbox.argDupe_('m2')===false);
ok('id 없으면 막지 않음(오차단 방지)', sandbox.argDupe_('')===false && sandbox.argDupe_(null)===false);

console.log('2) 언어 게이트 — 일본 채널');
const KR='안녕하세요 후기는 여기서 보실 수 있습니다 https://www.gangnamunni.com/hospitals/2067 감사합니다';
let r=sandbox.argLang_(KR,'jp');
ok('★강남언니 한국판 적발', r.ok===false && r.hits.length===1);
ok('일본판으로 자동 교체', r.fixed && r.fixed.includes('gangnamunni.com/jp/hospitals/2067')
   && !r.fixed.includes('.com/hospitals/2067'));
r=sandbox.argLang_(KR,'tw');
ok('대만 채널은 대만판으로', r.fixed.includes('/tw/hospitals/2067'));
ok('한국 채널은 통과(게이트 미적용)', sandbox.argLang_(KR,'ko').ok===true);
ok('이미 일본판이면 통과', sandbox.argLang_('こちら https://www.gangnamunni.com/jp/hospitals/2067','jp').ok===true);

console.log('3) 대체 없는 한국어 전용 자산 → 사람 인계');
r=sandbox.argLang_('참고하세요 https://blog.naver.com/acrohani01/222917737480','jp');
ok('★네이버 블로그 적발', r.ok===false && r.hits.length===1);
ok('대체 없으면 fixed=null(기계적 삭제 안 함)', r.fixed===null);
ok('카카오톡 채널도 차단', sandbox.argLang_('http://pf.kakao.com/_VcUxmC','jp').ok===false);
ok('유튜브(한국어 내레이션)도 차단', sandbox.argLang_('https://youtube.com/shorts/RY3tl6UANSk','tw').ok===false);
ok('한국어 가이드도 차단',
   sandbox.argLang_('https://acrohani75-dot.github.io/acro/acro_diet_guide.html','jp').ok===false);
ok('링크 없는 순수 답변은 통과', sandbox.argLang_('こんにちは、承知いたしました。','jp').ok===true);
ok('외국인 설문(script.google.com)은 통과',
   sandbox.argLang_('https://script.google.com/macros/s/AKfycbzQ7IB/exec','jp').ok===true);

console.log('4) 통합 관문');
cache={};
let c=sandbox.argCheck_('네 확인했습니다','jp','x1');
ok('정상 발송', c.send===true && c.text==='네 확인했습니다');
ok('★같은 id 재호출은 발송 차단', sandbox.argCheck_('네 확인했습니다','jp','x1').send===false);
c=sandbox.argCheck_(KR,'jp','x2');
ok('교체 가능하면 교체 후 발송', c.send===true && c.text.includes('/jp/') && c.swapped.length===1);
c=sandbox.argCheck_('https://blog.naver.com/acrohani01','jp','x3');
ok('교체 불가면 발송 안 함 + 사유', c.send===false && /한국어 전용/.test(c.reason));
ok('한국 채널은 그대로 발송', sandbox.argCheck_(KR,'ko','x4').send===true);

console.log('\n'+(f?`❌ ${p}/${p+f}`:`✅ 전부 통과 — ${p}케이스`));process.exit(f?1:0);
