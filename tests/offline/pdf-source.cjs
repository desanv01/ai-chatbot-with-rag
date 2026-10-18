const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const code=ts.transpileModule(fs.readFileSync(path.join(root,'lib/pdf-source.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(options={}){
 const exports={},requests=[],events=[];let timer;
 const chunks=options.chunks??[new TextEncoder().encode('%PDF-1.7\nfixture')];let index=0;
 const reader={async read(){if(options.hang)return new Promise((_,reject)=>requests[0].options.signal.addEventListener('abort',()=>reject(Error('private failure')),{once:true}));return index<chunks.length?{value:chunks[index++],done:false}:{done:true};},async cancel(){events.push('cancel');},releaseLock(){events.push('release');}};
 const response={ok:options.ok??true,headers:new Headers({'content-type':options.type??'application/pdf',...(options.length===undefined?{}:{'content-length':String(options.length)})}),body:options.noBody?null:{getReader:()=>reader}};
 vm.runInNewContext(code,{exports,URL,AbortController,Uint8Array,Error,Number,window:{location:{href:'https://app.test/chat',origin:'https://app.test'}},setTimeout(fn,ms){assert.equal(ms,30000);timer=fn;return 1;},clearTimeout(){events.push('clear');},fetch:async(url,opts)=>{requests.push({url,options:opts});return response;}});
 return {read:exports.readPdfBytes,requests,events,timeout:()=>timer(),response};
}
async function main(){
 let f=fixture();const own=new AbortController();let bytes=await f.read('/api/chat/attachment?reference=test',{signal:own.signal,maxBytes:1024});assert.equal(Buffer.from(bytes).toString(),'%PDF-1.7\nfixture');assert.equal(f.requests[0].options.credentials,'same-origin');assert.equal(f.requests[0].options.redirect,'error');assert.equal(f.requests[0].options.referrerPolicy,'no-referrer');assert.ok(f.events.includes('release'));assert.equal(f.events.includes('cancel'),false);
 f=fixture();await f.read('https://vmbigozqgvtyytziwtsb.supabase.co/storage/v1/object/sign/userfiles/owner/file.pdf?token=synthetic',{signal:new AbortController().signal});assert.equal(f.requests[0].options.credentials,'omit');
 f=fixture();await f.read('blob:https://app.test/fixture',{signal:new AbortController().signal});assert.equal(f.requests.length,1);
 for(const source of ['https://evil.test/file.pdf','https://app.test@evil.test/file.pdf','https://user:password@app.test/a.pdf','https://evil.supabase.co.evil.test/storage/v1/object/sign/a','javascript:alert(1)','data:application/pdf;base64,JVBERi0=','blob:https://other.test/fixture','https://vmbigozqgvtyytziwtsb.supabase.co/not-storage']){f=fixture();await assert.rejects(f.read(source,{signal:new AbortController().signal}));assert.equal(f.requests.length,0,source);}
 for(const maxBytes of [0,-1,1.5,NaN,Infinity,25*1024*1024+1]){f=fixture();await assert.rejects(f.read('/x',{signal:new AbortController().signal,maxBytes}));assert.equal(f.requests.length,0);}
 for(const opts of [{type:'text/html'},{ok:false},{noBody:true},{length:99999},{length:'not-a-number'},{length:0},{chunks:[new TextEncoder().encode('wrong')]},{chunks:[new Uint8Array([1,2])]}]){f=fixture(opts);await assert.rejects(f.read('/x',{signal:new AbortController().signal,maxBytes:1024}));assert.equal(f.requests[0].options.signal.aborted,true);assert.ok(f.events.includes('clear'));}
 f=fixture({chunks:[new TextEncoder().encode('%PDF-'),new Uint8Array(1024)]});await assert.rejects(f.read('/x',{signal:new AbortController().signal,maxBytes:1024}));assert.ok(f.events.includes('cancel'));assert.ok(f.events.includes('release'));assert.equal(f.requests[0].options.signal.aborted,true);
 f=fixture();const aborted=new AbortController();aborted.abort();await assert.rejects(f.read('/x',{signal:aborted.signal}));assert.equal(f.requests.length,0);
 f=fixture({hang:true});const timeoutRead=f.read('/x',{signal:new AbortController().signal});await new Promise(resolve=>setImmediate(resolve));f.timeout();await assert.rejects(timeoutRead);assert.ok(f.events.includes('cancel'));
 f=fixture({hang:true});const cancelled=new AbortController();const pending=f.read('/x',{signal:cancelled.signal});await new Promise(resolve=>setImmediate(resolve));cancelled.abort();await assert.rejects(pending);assert.ok(f.events.includes('cancel'));
 console.log('PASS actual bounded PDF source loader: trusted URLs, same-origin credentials, no cross-origin credentials, byte-stream and header bounds, magic, cancellation/deadline and cleanup; zero live requests');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
