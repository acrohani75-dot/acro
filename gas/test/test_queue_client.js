// okchart_queue_client.gs 순수 로직 검증 — GAS API 스텁
const fs=require('fs'), vm=require('vm'), path=require('path');
const G=f=>path.join(__dirname,'..',f);
let propsStore={}, script=[], calls=[], slept=0;
const sandbox={
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>propsStore[k]||null})},
  UrlFetchApp:{fetch:(url,opt)=>{calls.push({url,method:(opt&&opt.method)||'get'});
    const step=script.shift()||{code:404,body:'{}'};
    return {getResponseCode:()=>step.code,getContentText:()=>step.body};}},
  Utilities:{sleep:ms=>{slept+=ms;}},
  JSON,Object,String,Array,Math,Date,Error,Number,encodeURIComponent,console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(G('okchart_queue_client.gs'),'utf8'),sandbox);
sandbox.ACQ_CFG.POLL_MS=1000; sandbox.ACQ_CFG.MAX_WAIT_MS=3000; // 테스트용 축소

let pass=0,fail=0;
const ok=(l,c)=>{c?(pass++,console.log('  ✓ '+l)):(fail++,console.log('  ✗ '+l));};
const reset=(s)=>{script=s;calls=[];slept=0;};

console.log('1) 정상 왕복 — submit → processing → done');
propsStore={OKQ_URL:'https://q/exec',OKQ_TOKEN:'T'};
reset([{code:200,body:'{"id":"j1"}'},
       {code:200,body:'{"status":"processing"}'},
       {code:200,body:'{"status":"done","result":[{"sn":"000009"}]}'}]);
let r=sandbox.acqQuery_('patient_verify',{chart:'000009'});
ok('result 반환', Array.isArray(r)&&r[0].sn==='000009');
ok('submit은 POST·named_query', calls[0].method==='post');
ok('폴링 URL에 id·token', calls[1].url.includes('action=result')&&calls[1].url.includes('id=j1'));
ok('폴링 간격 준수(sleep 누적)', slept===2000);

console.log('2) 실패 경로 — 전부 null (조용한 생략)');
propsStore={};
ok('속성 미설정 → null', sandbox.acqQuery_('reservations',{})===null);
propsStore={OKQ_URL:'https://q/exec',OKQ_TOKEN:'T'};
reset([{code:500,body:''}]);
ok('submit HTTP 500 → null', sandbox.acqQuery_('reservations',{})===null);
reset([{code:200,body:'{"id":"j2"}'},{code:200,body:'{"status":"error","error":"bad"}'}]);
ok('워커 error → null(재시도 안 함)', sandbox.acqQuery_('reservations',{})===null);
reset([{code:200,body:'{"id":"j3"}'},{code:200,body:'{"status":"processing"}'},
       {code:200,body:'{"status":"processing"}'},{code:200,body:'{"status":"processing"}'}]);
ok('상한 초과(야간) → null', sandbox.acqQuery_('reservations',{})===null && slept===3000);
reset([{code:200,body:'{"id":"j4"}'},{code:503,body:''},
       {code:200,body:'{"status":"done","result":1}'}]);
ok('폴링 일시 오류는 건너뛰고 재시도', sandbox.acqQuery_('x',{})===1);

console.log('3) 환자 맥락 블록');
reset([{code:200,body:'{"id":"a"}'},{code:200,body:'{"status":"done","result":[]}'}]);
ok('본인 확인 실패(빈 결과) → 빈 문자열', sandbox.acqPatientContext_({chart:'1'})==='');
reset([{code:200,body:'{"id":"a"}'},{code:200,body:'{"status":"done","result":[{"sn":"1"}]}'},
       {code:200,body:'{"id":"b"}'},{code:200,body:'{"status":"done","result":[{"px":"다이어트재진"}]}'},
       {code:200,body:'{"id":"c"}'},{code:200,body:'{"status":"done","result":[]}'}]);
let ctx=sandbox.acqPatientContext_({chart:'1'});
ok('재진 확인+최근 진료 포함', ctx.includes('재진')&&ctx.includes('다이어트재진'));
ok('내부용 경고 문구 포함', ctx.includes('노출 금지'));

console.log('\n'+(fail?`❌ ${pass}/${pass+fail}`:`✅ 전부 통과 — ${pass}케이스`));
process.exit(fail?1:0);
