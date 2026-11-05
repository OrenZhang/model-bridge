/** Real HTTP matrix. Only synthetic bridge_probe calls are executed in memory. */
import {randomBytes,createHash} from 'node:crypto';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {SSEDecoder} from '../dist/gateway/sse.js';
const base=(process.env.MODEL_BRIDGE_TEST_GATEWAY_URL??'').replace(/\/+$/,'').replace(/\/v1$/,'');
const key=process.env.MODEL_BRIDGE_TEST_GATEWAY_KEY;
if(!base||!key)throw new Error('Set MODEL_BRIDGE_TEST_GATEWAY_URL and MODEL_BRIDGE_TEST_GATEWAY_KEY.');
const endpoints={responses:'/v1/responses',chat:'/v1/chat/completions',messages:'/v1/messages'};
const selected=process.env.MODEL_BRIDGE_VALIDATION_MODELS?.split(',');
const headers={authorization:'Bearer '+key,'content-type':'application/json'};
const catalogResponse=await fetch(base+'/v1/models',{headers});if(!catalogResponse.ok)throw new Error('Catalog HTTP '+catalogResponse.status);
const catalog=await catalogResponse.json();
const models=catalog.data.filter(m=>selected?selected.includes(m.id):['kimi','minimax'].includes(m.owned_by)).map(m=>m.id);
if(!models.length||models.length>30)throw new Error('Choose between 1 and 30 models.');
const codex=await(await fetch(base+'/codex/models',{headers})).json();
const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
const tools={responses:[{type:'function',name:'bridge_probe',description:'Synthetic test: echoes the marker and returns a fresh receipt.',parameters:schema}],chat:[{type:'function',function:{name:'bridge_probe',description:'Synthetic marker echo and receipt.',parameters:schema}}],messages:[{name:'bridge_probe',description:'Synthetic marker echo and receipt.',input_schema:schema}]};
const cases=models.flatMap(model=>Object.keys(endpoints).flatMap(protocol=>[false,true].map(stream=>({model,protocol,stream}))));
const initialToolChoice=process.env.MODEL_BRIDGE_TEST_TOOL_CHOICE??'auto';
const results=[];const reportFile=process.env.MODEL_BRIDGE_VALIDATION_REPORT??'work/lan-model-matrix.json';
const nativePaths=process.env.MODEL_BRIDGE_NATIVE_FILES?.split(path.delimiter)??[];
async function nativeHashes(){return Promise.all(nativePaths.map(async file=>{try{return createHash('sha256').update(await readFile(file)).digest('hex')}catch(e){if(e.code==='ENOENT')return null;throw e}}));}const before=await nativeHashes();
const reasoningCount=(p,r)=>p==='responses'?(r.output??[]).filter(i=>i.type==='reasoning').length:p==='messages'?(r.content??[]).filter(i=>['thinking','redacted_thinking'].includes(i.type)).length:(r.choices?.[0]?.message?.reasoning_details?.length??(r.choices?.[0]?.message?.reasoning_content?1:0));
function streamed(protocol){
 let response,done=false;const blocks=[];const args=new Map();const calls=new Map();const message={role:'assistant',content:''};
 const parser=new SSEDecoder(({data})=>{
  if(data==='[DONE]'){done=true;return;}const e=JSON.parse(data);if(e.error||e.type==='error'||e.type==='response.failed')throw new Error('Stream provider error: '+(e.error?.code??e.error?.type??e.type));
  if(protocol==='responses'){if(e.type==='response.completed'){response=e.response;done=true;}}
  else if(protocol==='messages'){
   if(e.type==='message_start')response=e.message;
   if(e.type==='content_block_start'){blocks[e.index]=structuredClone(e.content_block);if(e.content_block.type==='tool_use')args.set(e.index,'');}
   if(e.type==='content_block_delta'){
    const block=blocks[e.index];const d=e.delta;
    if(d.type==='text_delta')block.text=(block.text??'')+d.text;
    if(d.type==='thinking_delta')block.thinking=(block.thinking??'')+d.thinking;
    if(d.type==='signature_delta')block.signature=(block.signature??'')+d.signature;
    if(d.type==='input_json_delta')args.set(e.index,(args.get(e.index)??'')+d.partial_json);
   }
   if(e.type==='content_block_stop'&&args.has(e.index))blocks[e.index].input=JSON.parse(args.get(e.index)||'{}');
   if(e.type==='message_delta'&&e.delta.stop_reason)response.stop_reason=e.delta.stop_reason;
   if(e.type==='message_stop'){response.content=blocks.filter(Boolean);done=true;}
  } else {
   const choice=e.choices?.[0];const d=choice?.delta??{};
   if(d.content)message.content+=d.content;if(d.reasoning_content)message.reasoning_content=(message.reasoning_content??'')+d.reasoning_content;
   if(d.reasoning_details){message.reasoning_details??=[];for(const detail of d.reasoning_details){const old=detail.index===undefined?undefined:message.reasoning_details.find(x=>x.index===detail.index);if(!old)message.reasoning_details.push(structuredClone(detail));else for(const [k,v]of Object.entries(detail))old[k]=['text','data','signature'].includes(k)&&typeof v==='string'?(old[k]??'')+v:v;}}
   for(const call of d.tool_calls??[]){let item=calls.get(call.index);if(!item){item={id:call.id,type:'function',function:{name:call.function?.name,arguments:''}};calls.set(call.index,item);}if(call.id)item.id=call.id;if(call.function?.name)item.function.name=call.function.name;if(call.function?.arguments)item.function.arguments+=call.function.arguments;}
   if(choice?.finish_reason)response={choices:[{message,finish_reason:choice.finish_reason}]};
  }
 });
 return {parser,finish(){parser.finish();if(protocol==='chat'&&calls.size)message.tool_calls=[...calls.values()];if(!done||!response)throw new Error('Incomplete stream');return response;}};
}
function text(protocol,response){return protocol==='responses'?(response.output??[]).flatMap(i=>i.content??[]).map(i=>i.text??'').join(''):protocol==='messages'?(response.content??[]).filter(i=>i.type==='text').map(i=>i.text).join(''):response.choices?.[0]?.message?.content??'';}
function calls(protocol,response){return protocol==='responses'?(response.output??[]).filter(i=>i.type==='function_call').map(i=>({id:i.call_id,name:i.name,args:JSON.parse(i.arguments)})):protocol==='messages'?(response.content??[]).filter(i=>i.type==='tool_use').map(i=>({id:i.id,name:i.name,args:i.input})):(response.choices?.[0]?.message?.tool_calls??[]).map(i=>({id:i.id,name:i.function.name,args:JSON.parse(i.function.arguments)}));}
async function scenario({model,protocol,stream}){
 const marker='marker_'+randomBytes(5).toString('hex'),receipt='receipt_'+randomBytes(6).toString('hex');const session='matrix_'+randomBytes(8).toString('hex');const history=[];
 const metric={model,protocol,stream,initialToolChoice,status:'failed',userTurns:0,toolCalls:0,requests:0,httpStatuses:[],reasoningReceived:0,reasoningReplayed:0,requestIds:[]};
 const levels=codex.models.find(m=>m.slug===model)?.supported_reasoning_levels?.map(e=>e.effort)??[];const effort=levels.includes('low')?'low':levels.includes('medium')?'medium':levels.find(e=>e!=='none');
 function user(content){history.push(protocol==='responses'?{role:'user',content:[{type:'input_text',text:content}]}:{role:'user',content});metric.userTurns++;}
 function assistant(r){if(protocol==='responses')history.push(...r.output);else if(protocol==='messages')history.push({role:'assistant',content:r.content});else history.push(r.choices[0].message);metric.reasoningReceived+=reasoningCount(protocol,r);}
 async function request(toolChoice){
  metric.reasoningReplayed+=history.reduce((n,m)=>n+reasoningCount(protocol,protocol==='responses'?{output:[m]}:protocol==='messages'?{content:m.role==='assistant'?m.content:[]}:{choices:[{message:m.role==='assistant'?m:{}}]}),0);
  const payload={model,stream,tools:tools[protocol],...(protocol==='responses'?{input:history,max_output_tokens:3000,...(effort?{reasoning:{effort}}:{})}:{messages:history,max_tokens:3000,...(effort?(protocol==='chat'?{reasoning_effort:effort}:{output_config:{effort}}):{})}),tool_choice:protocol==='messages'?{type:toolChoice==='required'?'any':toolChoice}:toolChoice};
  metric.requests++;const r=await fetch(base+endpoints[protocol],{method:'POST',headers:{...headers,'x-model-bridge-session':session},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});metric.httpStatuses.push(r.status);const id=r.headers.get('x-model-bridge-request-id');if(id)metric.requestIds.push(id);
  if(!r.ok){const error=await r.json().catch(()=>({}));throw new Error('HTTP '+r.status+' '+(error.error?.code??error.error?.type??''));}
  let out;if(stream){if(!r.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Missing SSE content-type');const collector=streamed(protocol);for await(const chunk of r.body)collector.parser.push(chunk);out=collector.finish();}else out=await r.json();
  if(out.error)throw new Error('JSON error response');return out;
 }
 try{
  user(`Remember marker ${marker}. Call bridge_probe exactly once with value equal to the marker. Wait for its receipt before answering.`);
  const first=await request(initialToolChoice);const toolCalls=calls(protocol,first);if(toolCalls.length!==1)throw new Error('Expected exactly one tool call');const call=toolCalls[0];if(call.name!=='bridge_probe'||call.args.value!==marker)throw new Error('Wrong synthetic tool arguments');assistant(first);metric.toolCalls++;
  const output=JSON.stringify({value:marker,receipt});
  if(protocol==='responses')history.push({type:'function_call_output',call_id:call.id,output});else if(protocol==='messages')history.push({role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:output}]});else history.push({role:'tool',tool_call_id:call.id,content:output});
  const second=await request('none');if(!text(protocol,second).includes(receipt))throw new Error('Tool receipt missing');assistant(second);
  user('Without tools, repeat the exact marker and receipt from the earlier tool result, and calculate 17 * 23.');const third=await request('none');const t=text(protocol,third);if(!t.includes(marker)||!t.includes(receipt)||!t.includes('391'))throw new Error('Second user turn lost history or calculation');assistant(third);
  user('Without tools, repeat the exact receipt from the earlier tool result and calculate 391 + 7.');const fourth=await request('none');if(!text(protocol,fourth).includes(receipt)||!text(protocol,fourth).includes('398'))throw new Error('Third user turn lost history or calculation');assistant(fourth);
  if(metric.reasoningReceived&&!metric.reasoningReplayed)throw new Error('Thinking was not replayed');metric.status='passed';
 }catch(e){metric.error=String(e.message).slice(0,200);}
 results.push(metric);console.log(JSON.stringify({...metric,requestIds:undefined}));
 await save();
}
let saving=Promise.resolve();
async function save(){const report={createdAt:new Date().toISOString(),realUpstream:true,transport:'LAN HTTP to the running gateway',models,scenarios:results,nativeClientFilesUnchanged:JSON.stringify(before)===JSON.stringify(await nativeHashes())};await mkdir(path.dirname(reportFile),{recursive:true});saving=saving.then(()=>writeFile(reportFile,JSON.stringify(report,null,2)+'\n'));await saving;}
let cursor=0;await Promise.all(Array.from({length:Math.min(Number(process.env.MODEL_BRIDGE_TEST_CONCURRENCY??3),cases.length)},async()=>{while(cursor<cases.length){const current=cases[cursor++];await scenario(current);}}));
await save();if(results.some(r=>r.status!=='passed'))process.exitCode=1;
