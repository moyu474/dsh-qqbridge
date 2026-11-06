import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolvePriceTable, priceUsage, normalizeUsage, beijingParts } from './model-prices.js';

export async function shrinkForTagging(buffer,mimeType) {
 const kind=['image/jpeg','image/png','image/gif','image/webp'].includes(mimeType)?mimeType:'image/jpeg';
 if(buffer.length<=900*1024 && kind!=='image/gif')return {buffer,mimeType:kind};
 const ext=({'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'})[kind];
 for(const [size,quality] of [['1568x1568>','92'],['1024x1024>','78']]) {
  try { const out=await new Promise((resolve,reject)=>{ const p=spawn('convert',[ext+':-'+(kind==='image/gif'?'[0]':''),'-resize',size,'-quality',quality,'jpg:-'],{stdio:['pipe','pipe','ignore']});let chunks=[],n=0,done=false;const timer=setTimeout(()=>{p.kill();finish(Error('压缩超时'))},20000);function finish(e,v){if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v)} p.on('error',e=>finish(e));p.stdout.on('data',c=>{n+=c.length;if(n>4*1024*1024){p.kill();finish(Error('压缩结果过大'))}else chunks.push(c)});p.on('close',c=>c===0?finish(null,Buffer.concat(chunks)):finish(Error('压缩失败')));p.stdin.on('error',()=>{});p.stdin.end(buffer); }); if(out.length>3&&out[0]===255&&out[1]===216&&out[2]===255)return {buffer:out,mimeType:'image/jpeg'}; } catch{}
 }
 throw Error('图片压缩失败');
}

// 2026-11-05：模型偶尔多给几个标签或给单字标签，原来卡 3~6 个会把标注判死。
// 放宽成「至少 1 个、最多 8 个，单个 1~8 字」，只清空白和控制字符。
export function parseImageTags(content) {
  const raw = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw Error('标签格式无效：没有 JSON');
  const x = JSON.parse(raw.slice(a, b + 1));
  const desc = Array.from(String(x.desc || '').replace(/\s+/g, ' ').trim()).slice(0, 40).join('');
  const src = Array.isArray(x.tags) ? x.tags : [];
  const tags = [];
  for (const v of src) {
    const t = Array.from(String(v || '').replace(/[\s\u0000-\u001f]+/g, '').trim()).slice(0, 8).join('');
    if (t && !tags.includes(t)) tags.push(t);
    if (tags.length >= 8) break;
  }
  if (!tags.length) throw Error('标签格式无效：tags 为空');
  return { desc, tags };
}

export function createImageTagger({library,stateDir,cfg={},fetchImage,log=()=>{},request=fetch,now=Date.now,shrink=shrinkForTagging}) {
 const c=cfg.socialV2?.lite||{}, model=String(c.model||'deepseek-chat'), base=String(c.baseUrl||process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com').replace(/\/+$/,''),key=String(c.apiKey||process.env.DEEPSEEK_API_KEY||''),file=path.join(stateDir,'image-tag-quota.json'),usage=path.join(stateDir,'image-usage.jsonl'),max=library.limits.maxPerDay;let quota={day:'',count:0},valid=true,running=false,timer=null,queue=[];
 try{quota=JSON.parse(fs.readFileSync(file,'utf8'));if(!quota||typeof quota.day!=='string'||!Number.isInteger(quota.count)||quota.count<0)throw Error('额度账结构无效')}catch(e){if(e.code!=='ENOENT'){valid=false;log('[pic] 额度账读取失败，停止标注: '+e.message)}}
 const day=()=>{const p=beijingParts(now());return `${p.year}-${p.month}-${p.day}`};
 function reserve(){if(!valid)return false;const d=day();if(quota.day!==d)quota={day:d,count:0};if(quota.count>=max)return false;const next={day:d,count:quota.count+1},tmp=file+'.'+process.pid+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';try{fs.mkdirSync(stateDir,{recursive:true});fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});fs.renameSync(tmp,file);quota=next;return true}catch(e){try{fs.unlinkSync(tmp)}catch{}valid=false;log('[pic] 额度账写入失败: '+e.message);return false}}
 function writeUsage(row){try{fs.mkdirSync(stateDir,{recursive:true});fs.appendFileSync(usage,JSON.stringify(row)+'\n',{mode:0o600})}catch(e){valid=false;log('[pic] 费用账写入失败，停止标注: '+e.message)}}
 async function attempt(job){const id=job.kind==='sticker'?job.id:job.sha256;let rawUsage=null,error='',ok=false,buckets=null,priced=null;try { const image=await fetchImage(job);if(!image?.buffer?.length)throw Error('图片下载失败');const shrunk=await shrink(image.buffer,image.mimeType);const response=await request(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model,max_tokens:200,messages:[{role:'user',content:[{type:'text',text:'看图，只输出 JSON：{"desc":"一句话描述（30字内）","tags":["标签"]}。标签3到6个，每个2到6字，口语化，适合群聊选择发图。'},{type:'image_url',image_url:{url:`data:${shrunk.mimeType};base64,${shrunk.buffer.toString('base64')}`}}]}]}),signal:AbortSignal.timeout(Math.min(120000,Math.max(5000,Number(c.timeoutMs)||30000)))});const body=await response.json();rawUsage=body.usage||null;if(!response.ok)throw Error('HTTP '+response.status+' '+String(body.error?.message||''));const tags=parseImageTags(body.choices?.[0]?.message?.content);library.patch(job.kind,id,{...tags,status:'done'});ok=true;log(`[pic] 标注完成 ${id}: ${tags.tags.join('、')}`);}catch(e){error=String(e?.message||e);const attempts=(Number(job.attempts)||0)+1;library.patch(job.kind,id,{attempts,status:attempts>=2?'failed':'pending',...(attempts>=2?{tags:[]}: {})});log(`[pic] 标注失败 ${id}: ${error}`);}finally{if(rawUsage){buckets=normalizeUsage(rawUsage);priced=priceUsage(buckets,{model,at:now(),table:resolvePriceTable(cfg.pricing)});}writeUsage({at:new Date(now()).toISOString(),model,kind:job.kind,id,success:ok,error,usage:rawUsage,buckets,cost:priced?.cost||null,rates:priced?.rates||null});} }
 async function drain(){if(running||!valid||!library.writable)return;running=true;try{while(queue.length){const job=queue[0];if(!reserve())break;queue.shift();await attempt(job);const fresh=library.view().find(e=>e.kind===job.kind&&(e.kind==='sticker'?e.id===job.id:e.sha256===job.sha256));if(fresh?.status==='pending' && Number(fresh.attempts)<2)queue.push(fresh);} }finally{running=false;if(queue.length&&valid&&max>0){timer=setTimeout(()=>{timer=null;drain().catch(e=>log('[pic] 队列失败: '+e.message))},60000);timer.unref?.();}}}
 function enqueue(job){if(!job||!valid||!library.writable||queue.some(e=>e.kind===job.kind&&(job.kind==='sticker'?e.id===job.id:e.sha256===job.sha256)))return;queue.push(job);setImmediate(()=>drain().catch(e=>log('[pic] 队列失败: '+e.message)));}
 return {enqueue,drain,enqueuePending(){for(const e of library.pending())enqueue({...e,kind:'image'})},get queued(){return queue.length},get running(){return running},close(){if(timer)clearTimeout(timer)}};
}
