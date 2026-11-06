import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createImageHistory, validateImageReplies } from './lite-vision.mjs';
import { createLitePrompt } from './lite-prompt.js';

test('图片历史会话隔离、有界及过期', () => {
  let now = 0; const h = createImageHistory({ttl: 100, limit: 2, now: () => now});
  h.put('group:1','abc','认得'); assert.equal(h.get('group:1','abc'),'认得');
  assert.equal(h.get('group:2','abc'),''); assert.equal(h.get('group:1','xyz'),'');
  now = 101; assert.equal(h.get('group:1','abc'),'');
});
test('多图校验未知、冲突、缺失和单图兼容', () => {
 const selected = [{source:{_replyRef:'m5144'}},{source:{_replyRef:'m5145'}}];
 assert.deepEqual(validateImageReplies([{text:'这图好看',imageRef:'img1',replyTo:'m5144'}],selected),[]);
 assert.ok(validateImageReplies([{text:'x',imageRef:'img3'}],selected).length);
 assert.ok(validateImageReplies([{text:'x',imageRef:'img1',replyTo:'m5145'}],selected).length);
 assert.ok(validateImageReplies([{text:'x',imageRef:['img1','img2']}],selected).length);
 assert.deepEqual(validateImageReplies(['这视频好看'],selected),[]);
 assert.deepEqual(validateImageReplies(['里面是假娃娃'],selected,'m5145'),[]);
 assert.deepEqual(validateImageReplies(['这图好看'],selected.slice(0,1)),[]);
 assert.deepEqual(validateImageReplies(['早上好'],selected),[]);
});
test('拍一拍同时有新内容，不误称没有内容', () => {
 const st = { recentMessages:[], wakeActorId:'1' };
 const p=createLitePrompt({cfg:{socialV2:{lite:{}}},STATE_DIR:'.',log(){},getSocialV2State:()=>st,getStickerEntries:()=>[],detectThread:()=>({active:false}),recallColdStorage:()=>({block:''}),triggerWantsRecall:()=>false,describeLiking:()=>'',nicknameOf:()=> '甲',likingData:()=>({}),getRecentContext:()=>''});
 const poke={kind:'poke',text:'[拍一拍]甲拍了你'};
 for(const m of [{text:'龙娘'}, {hasMedia:true}, {text:'我提到拍一拍'}]) {
  const out=p.buildLiteUserMessage('group:1','poke',{messages:[poke,m]});
  assert.match(out,/同时有新消息，先看消息再回应/); assert.doesNotMatch(out,/只吐槽被拍/); assert.doesNotMatch(out,/没有附任何文字|没有内容。/);
 }
 assert.match(p.buildLiteUserMessage('group:1','poke',{messages:[poke]}),/没有附任何文字/);
 st.wakeActorId=null;
 assert.match(p.buildLiteUserMessage('group:1','poke',{messages:[poke,{text:'龙娘'}]}),/同时有新消息/);
});
test('发送链逐条引用路由与 legacy 首条兼容', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const a=src.indexOf('  function sendMessagesV2('), b=src.indexOf('\n  // 审计范围',a);
 let sendChain=Promise.resolve(); const sent=[];
 const sandbox={captureSendGuard:()=>()=>{},onebotSend:async (...args)=>sent.push(args),sleep:async()=>{},log(){},computeGapsV2:()=>[],cfg:{},get sendChain(){return sendChain},set sendChain(v){sendChain=v}};
 const send=vm.runInNewContext('('+src.slice(a,b).trim()+')',sandbox);
 await send('group:1',['一','二'],[],null,null,[{replyTo:'5144',at:null},{replyTo:'5145',at:null}]);
 assert.equal(sent[0][3],'5144'); assert.equal(sent[1][3],'5145');
 sent.length=0; await send('group:1',['一','二'],[],'100','200');
 assert.equal(sent[0][3],'100'); assert.equal(sent[0][4],'200'); assert.equal(sent[1][3],null);
 sent.length=0; await send('group:1',['一\n二','三'],[],null,null,[{replyTo:'5144',at:null},{replyTo:'5145',at:null}]);
 assert.deepEqual(sent.map(x=>x[3]),['5144','5144','5145']);
 sent.length=0; await send('group:1',['甲\n乙',''],[],null,null,[{replyTo:'5144',at:null},{replyTo:'5145',at:null}]);
 assert.deepEqual(sent.map(x=>x[2]),['甲','乙']); assert.deepEqual(sent.map(x=>x[3]),['5144','5144']);
});
test('真实 API 组包按最终图片顺序邻接标签并保留无来源视频', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const a=src.indexOf('  async function callLiteApi('), b=src.lastIndexOf('  /**',src.indexOf('  async function applyLiteActionsV2(',a));
 let body;
 const ctx={cleanForJson:x=>x,log(){},AbortSignal,fetch:async (_url,opt)=>{body=JSON.parse(opt.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{}'}}]})}}};
 const call=vm.runInNewContext('('+src.slice(a,b).trim()+')',ctx);
 const selected=[{source:{_from:'视频抽帧拼图'},vision:{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}},{source:{_from:'甲',_replyRef:'m5144'},vision:{type:'image_url',image_url:{url:'data:image/png;base64,Yg=='}}}];
 await call({apiKey:'x',baseUrl:'http://localhost',model:'test',maxTokens:20,timeoutMs:1000},'system','user',{selected,hadImages:true});
 const content=body.messages[1].content;
 assert.equal(content.length,5); assert.match(content[1].text,/img1.*视频抽帧拼图.*无可引用来源/);
 assert.equal(content[2].image_url.url,selected[0].vision.image_url.url);
 assert.match(content[3].text,/img2.*甲.*m5144/); assert.equal(content[4].image_url.url,selected[1].vision.image_url.url);
 assert.match(content[0].text,/img1 = [^\n]*\nimg2 = /);
});
test('动作执行过滤拆行保持引用，部分发送失败不写历史', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const a=src.indexOf('  async function applyLiteActionsV2('), b=src.indexOf('\n  // ── 每日人民币额度',a);
 const puts=[], sent=[]; let fail=false;
 const context={cfg:{socialV2:{send:{}}},litePrompt:{cleanLiteReplyText:x=>String(x).trim()},SENSITIVE_RE:/秘密/,log(){},computeGapsV2:()=>[],resolveReplyInfo:async()=>true,
  liteImageHistory:{put:(...v)=>puts.push(v)},recordSentMessagesV2(){},markPresenceV2(){},applySendFinishV2:async()=>null,saveSocialV2State(){},fs:{appendFileSync(){}},TOOL_LOG_FILE:'unused',
  sendMessagesV2:async (_key, messages, _delays, _reply, _at, routes)=>{if(fail){const e=Error('fail');e.sent=[messages[0]];throw e} sent.push({messages,routes}); return messages;}};
 const apply=vm.runInNewContext('('+src.slice(a,b).trim()+')',context);
 const state={recentMessages:[]}, targets=new Map([['m5144',{messageId:'5144'}],['m5145',{messageId:'5145'}]]), images=[{hash:'a'},{hash:'b'}];
 const actions={reply:[{text:'秘密',replyTo:'m5144',imageRef:'img1'},{text:'甲\n乙',replyTo:'m5145',imageRef:'img2'}]};
 const out=await apply('group:1',state,actions,targets,images);
 assert.equal(out.sent,2); assert.deepEqual(Array.from(sent[0].messages),['甲','乙']);
 assert.deepEqual(Array.from(sent[0].routes,x=>x.replyTo),['5145','5145']);
 assert.deepEqual(puts.map(x=>x.slice(1)),[['b','甲\n乙']]);
 puts.length=0; sent.length=0; await apply('group:1',state,{replyTo:'m5144',reply:[{text:'甲',imageRef:'img1'}]},targets,images); assert.equal(sent[0].routes[0].replyTo,'5144');
 puts.length=0; sent.length=0; state.recentMessages=[{sender:'乙',userId:'222'}]; await apply('group:1',state,{replyTo:'m5144',reply:[{text:'秘密',imageRef:'img1'},{text:'你好',at:'乙'}]},targets,images); assert.equal(sent[0].routes[0].replyTo,null); assert.equal(sent[0].routes[0].at,'222');
 puts.length=0; sent.length=0; await apply('group:1',state,{replyTo:'m5144',reply:[{text:'秘密'},{text:'你好'}]},targets,images); assert.equal(sent[0].routes[0].replyTo,null);
 puts.length=0; sent.length=0; await apply('group:1',state,{replyTo:'m5144',reply:[{text:'你好'}]},targets,images); assert.equal(sent[0].routes[0].replyTo,'5144');
 puts.length=0; fail=true; await apply('group:1',state,actions,targets,images); assert.equal(puts.length,0);
});
test('真实补图分支只对唯一近期图片补充这是谁', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const anchor=src.indexOf('  async function deliverLiteV2('), a=src.indexOf('    if (!Array.isArray(media) || media.length === 0)',anchor), b=src.indexOf('    // 主动开口前的拦截',a);
 const f=vm.runInNewContext('(function(st, media){'+src.slice(a,b)+';return media;})',{log(){},Date,key:'group:1',reason:'nameMention'});
 const image=(seq)=>({hasMedia:true,media:[{kind:'image'}],time:Date.now(),seq,sender:'甲'});
 let st={recentMessages:[image(1),{text:'这是谁'}]}; assert.equal(f(st,[]).length,1);
 st={recentMessages:[{...image(1),media:[{kind:'image',_quoted:true,_sourceName:'原作者',_sourceUserId:'123'}],sender:'引用者'}, {text:'这是谁'}]}; const quoted=f(st,[])[0]; assert.equal(quoted._fromName,'原作者'); assert.equal(quoted._fromUid,'123');
 st={recentMessages:[image(1),image(2),{text:'这是谁'}]}; assert.equal(f(st,[]).length,0);
 st={recentMessages:[image(1),{text:'今天天气不错'}]}; assert.equal(f(st,[]).length,0);
 st={recentMessages:[{...image(1),time:Date.now()-360000},{text:'这是谁'}]}; assert.equal(f(st,[]).length,0);
});
test('真实图片筛选按原字节哈希并遵循最终顺序和预算', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const a=src.indexOf('  function prepareLiteImages('), b=src.indexOf('  async function callLiteApi(',a);
 const crypto=await import('node:crypto');
 const fn=vm.runInNewContext('('+src.slice(a,b).trim()+')',{crypto,Buffer,log(){},mediaPartToBuffer:p=>({buffer:Buffer.from(p.data,'base64'),mimeType:p.mediaType}),shrinkImageForVision:(buffer,mimeType)=>({buffer,mimeType})});
 const part=(s,from)=>({type:'image',data:Buffer.from(s).toString('base64'),mediaType:'image/png',_from:from});
 const input=[part('same','甲'),{type:'text',text:'x'},part('same','乙'),part('other','丙')];
 const out=fn(input).selected;
 assert.equal(out.length,3); assert.equal(out[0].hash,out[1].hash); assert.notEqual(out[1].hash,out[2].hash);
 assert.equal(out[1].source._from,'乙');
 const large={type:'image',data:Buffer.alloc(5*1024*1024).toString('base64'),mediaType:'image/png'};
 assert.equal(fn([large,part('small','丙')]).selected.length,1);
});
test('真实 deliver 图片校验重试、计费和安全收尾', async () => {
 const src=fs.readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
 const a=src.indexOf('  async function deliverLiteV2('), b=src.indexOf('  function findMessageMedia(',a);
 for(const outcome of ['bad','valid','throw']) {
  const st={recentMessages:[]}; let calls=0,bills=0,applied;
  const selected=[{source:{_seq:1},hash:'a',bytes:1,mime:'image/png'},{source:{_seq:2},hash:'b',bytes:1,mime:'image/png'}];
  const bad={reply:[{text:'这图',imageRef:'img9'}],wake:{mode:'diving'}};
  const valid={reply:[{text:'这图',imageRef:'img1',replyTo:'m1'},{text:'那图',imageRef:'img2',replyTo:'m2'}],wake:{mode:'diving'}};
  const ctx={litePrompt:{liteConfig:()=>({enabled:true}),buildLiteSystemPrompt:()=>'',buildLiteUserMessage:(_k,_r,_s,_re,_sw,_seq,_f,map)=>{map.set('m1',{messageId:'1'});map.set('m2',{messageId:'2'});return '问题'},parseLiteActions:JSON.parse},getSocialV2State:()=>st,buildWakeSnapshotV2:()=>({messages:[],readThroughSeq:1}),resolveMediaList:async()=>[],videoMod:{findVideoSourceV2:()=>null},prepareLiteImages:()=>({selected}),liteImageHistory:{get:()=>''},validateImageReplies,log(){},recordLiteUsage:()=>bills++,noteModelMessagesV2:()=>1,dumpLiteTurn(){},usageTotal:()=>0,
   callLiteApi:async()=>{calls++;if(calls===2&&outcome==='throw') throw Error('timeout');return {text:JSON.stringify(calls===1||outcome==='bad'?bad:valid),usage:{},model:'x'}},
   applyLiteActionsV2:async(_k,_s,actions)=>{applied=actions;return {sent:actions.reply.length,finish:{ok:true},errors:[]}}};
  const deliver=vm.runInNewContext('('+src.slice(a,b).trim()+')',ctx);
  const report=await deliver('group:1','question',[{_seq:1},{_seq:2}]);
  assert.equal(report.sent,outcome==='valid'?2:1); assert.equal(bills,outcome==='throw'?1:2); assert.equal(calls,2);
  assert.deepEqual(JSON.parse(JSON.stringify(applied.wake)),{mode:'diving'}); assert.equal(report.finish.ok,true); assert.equal(st.__liteReadThrough,undefined);
 }
});
