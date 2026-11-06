const {app,session}=require('electron');
const {createServer}=require('node:http');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const deadline=setTimeout(()=>{console.error('Update transport validation timed out');app.exit(1)},20000);
 const {UpdateTransport}=await import(pathToFileURL(path.resolve('dist/desktop/update-transport.js')).href);
 let authenticated=0;
 const expected='Basic '+Buffer.from('mb:fixture-secret').toString('base64');
 const proxy=createServer((q,r)=>{
  if(q.headers['proxy-authorization']!==expected){r.writeHead(407,{'proxy-authenticate':'Basic realm="fixture"'});r.end();return;}
  authenticated++;r.end('via-authenticated-proxy');
 });
 const origin=createServer((q,r)=>{
  if(q.url==='/broken'){r.writeHead(200,{'content-length':'100'});r.write('partial');setImmediate(()=>r.socket?.destroy());return;}
  if(q.url==='/slow'){r.setHeader('content-type','application/octet-stream');r.write(Buffer.alloc(16384));return;}
  r.end('direct');
 });
 const isolated=session.fromPartition('model-bridge-update-test-'+Date.now(),{cache:false});
 const transport=new UpdateTransport(isolated);
 try{
  for(const s of[proxy,origin])await new Promise(r=>s.listen(0,'127.0.0.1',r));
  await transport.apply({url:'http://mb:fixture-secret@127.0.0.1:'+proxy.address().port,label:'订阅测试'});
  assert.equal(await(await transport.fetch('http://updates.model-bridge.invalid/package')).text(),'via-authenticated-proxy');
  assert.equal(authenticated,1);
  let rejected;transport.login({isProxy:false,host:'127.0.0.1',port:proxy.address().port},(...values)=>{rejected=values});assert.deepEqual(rejected,['','']);
  transport.login({isProxy:true,host:'unrelated.invalid',port:proxy.address().port},(...values)=>{rejected=values});assert.deepEqual(rejected,['','']);
  await transport.apply();
  assert.equal(await(await transport.fetch('http://127.0.0.1:'+origin.address().port)).text(),'direct');
  console.log('PASS: authenticated proxy and direct fetches completed');
  await assert.rejects(async()=>await(await transport.fetch('http://127.0.0.1:'+origin.address().port+'/broken')).text());
  const cancellation=new AbortController();
  const stream=await transport.fetch('http://127.0.0.1:'+origin.address().port+'/slow',{signal:cancellation.signal});
  const reader=stream.body.getReader();await reader.read();cancellation.abort();await assert.rejects(reader.read());
  console.log('PASS: isolated updater supports authenticated subscription proxies, never sends proxy credentials to origin auth, and switches to direct');
  console.log('PASS: incomplete downloads and cancellation reject the stream instead of producing an installable file');
 }finally{
  clearTimeout(deadline);
  await isolated.closeAllConnections();
  for(const s of[proxy,origin]){s.closeAllConnections();await new Promise(r=>s.close(r));}
  app.quit();
 }
}).catch(e=>{console.error(e);app.exit(1)});
