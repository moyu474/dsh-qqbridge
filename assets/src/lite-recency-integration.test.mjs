import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createLitePrompt } from './lite-prompt.js';
import { buildRecentCard, readRecentCard, refreshRecentCard, getRecentContext, refreshTodaySupplement } from './lite-recency.mjs';

const workspace = path.dirname(fileURLToPath(import.meta.url));
const localDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(workspace, '.recency-integration-'));
  const dir = path.join(stateDir, 'memory', 'group_1');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    assert.ok(path.resolve(stateDir).startsWith(workspace + path.sep));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return { stateDir, key: 'group:1', dir };
}
function prompt(st, getContext) {
  return createLitePrompt({
    cfg: { socialV2: { lite: { recentLimit: 2 } } }, STATE_DIR: workspace,
    log() {}, getSocialV2State: () => st, getStickerEntries: () => [],
    detectThread: () => ({ active: true, count: 3, rows: [{type:'msg', m:{sender:'早先', text:'话头锚点'}}] }),
    recallColdStorage: () => ({block:''}), triggerWantsRecall: () => false,
    describeLiking: () => '', nicknameOf: () => '', likingData: () => ({}),
    getRecentContext: getContext,
  });
}

test('user 最前端注入，传入 recent/thread/额外 unread 去重，缺依赖和失败零副作用', () => {
  const st = { recentMessages: [{seq:2,sender:'甲',text:'当前甲'},{seq:3,sender:'乙',text:'当前乙'}] };
  const snapshot = {messages:[{seq:1,sender:'丙',text:'窗口外未读'}]};
  const prefix = '【近 7 天近况｜截至 2026-11-03 03:59】\n11-02 12:00 甲：说要考试';
  let seen;
  const p = prompt(st, args => { seen = args; return prefix; });
  const first = p.buildLiteUserMessage('group:1','atMention',snapshot);
  assert.ok(first.startsWith(prefix + '\n\n'));
  assert.ok(first.indexOf(prefix) < first.indexOf('话头锚点'));
  assert.deepEqual(seen.recent.map(r=>r.text),['话头锚点','窗口外未读','当前甲','当前乙']);
  st.recentMessages.push({seq:4,sender:'丁',text:'新消息'});
  assert.ok(p.buildLiteUserMessage('group:1','poke',snapshot).startsWith(prefix + '\n\n'));
  assert.equal(prompt(st,undefined).buildLiteUserMessage('group:1','poke',snapshot),
    prompt(st,()=>{throw Error('bad card')}).buildLiteUserMessage('group:1','poke',snapshot));
});

test('缓存 mtime 检查、API/归档失败保留原件、并发单调用、当天补充出错仍有日卡', async t => {
  const opts = fixture(t), date = localDay(new Date());
  const archive = path.join(opts.dir, `chat-${date}-copy.jsonl`);
  const row = {date,hms:'01:00:00',who:'甲',text:'说要考试'};
  fs.writeFileSync(archive, JSON.stringify(row));
  let calls=0;
  const api = async () => {
    calls++;
    await new Promise(r => setTimeout(r,10));
    return {ok:true,json:async()=>({choices:[{message:{content:`${date.slice(5)} 01:00 甲：说要考试`},finish_reason:'stop'}],usage:{completion_tokens:25}})};
  };
  await Promise.all([refreshRecentCard({...opts,api,cfg:{apiKey:'offline'}}),refreshRecentCard({...opts,api,cfg:{apiKey:'offline'}})]);
  assert.equal(calls,1);
  const file = path.join(opts.dir,'recent-card.json'), before = fs.readFileSync(file,'utf8');
  await refreshRecentCard({...opts,api:async()=>({ok:false,status:503}),cfg:{apiKey:'offline'}});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  fs.writeFileSync(archive,'{broken jsonl');
  await refreshRecentCard({...opts,api,cfg:{apiKey:'offline'}});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  fs.renameSync(archive,archive+'.saved'); fs.mkdirSync(archive);
  await refreshRecentCard({...opts,api,cfg:{apiKey:'offline'}});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.match(getRecentContext(opts),/说要考试/);
  const changed = {...JSON.parse(before),content:`${date.slice(5)} 01:00 甲：原件修改可见`};
  fs.writeFileSync(file,JSON.stringify(changed));
  const stamp = new Date(Date.now()+3000); fs.utimesSync(file,stamp,stamp);
  assert.equal(readRecentCard(opts).content,changed.content);
});

test('7 天选样、300 条/80 字/输入字节预算和输出长度截断', async t => {
  const opts = fixture(t);
  const dates=[];
  for(let i=0;i<8;i++) {
    const d = new Date(); d.setDate(d.getDate()-i); const date=localDay(d); dates.push(date);
    fs.writeFileSync(path.join(opts.dir,`chat-${date}-copy.jsonl`),Array.from({length:100},(_,n)=>JSON.stringify({date,hms:`01:${String(n%60).padStart(2,'0')}:00`,who:`甲${n}`,text:'这是一条需要截断的归档材料'.repeat(20)})).join('\n'));
  }
  const api = async (_, req) => {
    const body=JSON.parse(req.body), material=body.messages[1].content, rows=material.split('\n');
    assert.ok(rows.length<=300); assert.ok(rows.every(r=>[...r].length<=80));
    assert.ok(Buffer.byteLength(body.messages.map(m=>m.content).join(''))<=6500);
    for(const date of dates.slice(0,7)) assert.ok(material.includes(date.slice(5)));
    assert.ok(!material.includes(dates[7].slice(5)));
    return {ok:true,json:async()=>({choices:[{message:{content:rows[0]+'\n不完整的尾行'},finish_reason:'length'}],usage:{completion_tokens:520}})};
  };
  const card=await buildRecentCard({...opts,api,cfg:{apiKey:'offline'}});
  assert.ok(!card.content.includes('不完整'));
  const ctx=getRecentContext(opts);
  assert.ok(ctx.startsWith('【近 7 天近况｜截至 '));
  // 输出 token<=520，标题和分隔符的逐字节上界仍使日卡<=600。
  const header=ctx.split('\n')[0]; assert.ok(520+Buffer.byteLength(header+'\n')+16<=600);
});

test('本轮相同摘录省略，未进日卡的当天材料可补充，补充整块<=100字节', async t => {
  const opts=fixture(t),date=localDay(new Date());
  const row=(hms,text)=>({date,hms,who:'甲',text});
  fs.writeFileSync(path.join(opts.dir,`chat-${date}-copy.jsonl`),JSON.stringify(row('01:00:00','说要考试')));
  await buildRecentCard({...opts,cfg:{apiKey:'offline'},api:async()=>({ok:true,json:async()=>({choices:[{message:{content:`${date.slice(5)} 01:00 甲：说要考试`}}],usage:{completion_tokens:25}})})});
  fs.writeFileSync(path.join(opts.dir,'today.jsonl'),[row('01:00:00','说要考试'),row('02:00:00','这条新材料特别长但只摘录原话'.repeat(10))].map(JSON.stringify).join('\n'));
  refreshTodaySupplement(opts);
  const ctx=getRecentContext(opts),extra=ctx.split('【当天补充】')[1];
  assert.ok(extra); assert.ok(Buffer.byteLength('【当天补充】'+extra)<=100);
  assert.equal(ctx.match(/说要考试/g).length,1);
  assert.ok(!getRecentContext({...opts,recent:[{text:'这条新材料特别长但只摘录原话'.repeat(10)}]}).includes('【当天补充】'));
});

function schedulerHarness(at, card) {
  const source=fs.readFileSync(path.join(workspace,'bridge.js'),'utf8');
  const start=source.indexOf('  function startLiteRecencyMaintenance() {');
  const end=source.indexOf('\n  function isSocialEnabled()',start);
  assert.ok(start>0&&end>start);
  let now=new Date(at).getTime();
  const RealDate=Date;
  class Clock extends RealDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
  const timers=[],intervals=[],refreshes=[],extras=[];
  const context={Date:Clock,STATE_DIR:workspace,cfg:{},log(){},path,fs:{readdirSync:()=>[]},
    socialV2:{conversations:new Map([['group:1',{}]])},canonicalV2Key:k=>k,
    litePrompt:{liteConfig:()=>({enabled:true})},readRecentCard:()=>card,
    refreshRecentCard:async a=>{refreshes.push(a.key);card={generatedAt:new Clock().toISOString()};},
    refreshTodaySupplement:a=>extras.push(a.key),
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return{unref(){}};},
    setInterval:(fn,ms)=>{intervals.push({fn,ms});return{unref(){}};}};
  vm.runInNewContext(source.slice(start,end)+'\nstartLiteRecencyMaintenance();',context);
  return {timers,intervals,refreshes,extras,setNow:t=>{now=new RealDate(t).getTime();}};
}

test('启动缺卡/>26h 补建、归档窗口等待、04:10 日调度和每小时本地刷新', async () => {
  const h=schedulerHarness('2026-11-03T04:05:00',null);
  assert.equal(h.refreshes.length,0); assert.equal(h.timers[0].ms,5*60000);
  h.setNow('2026-11-03T04:10:00');h.timers[0].fn();await new Promise(r=>setImmediate(r));
  assert.deepEqual(h.refreshes,['group:1']); assert.equal(h.timers[1].ms,24*3600000);
  h.intervals[0].fn(); assert.equal(h.intervals[0].ms,3600000); assert.ok(h.extras.length>=2);
  const fresh=schedulerHarness('2026-11-03T10:00:00',{generatedAt:'2026-11-03T04:11:00'});
  assert.equal(fresh.refreshes.length,0);
  const stale=schedulerHarness('2026-11-03T10:00:00',{generatedAt:'2026-11-02T07:59:00'});
  assert.equal(stale.refreshes.length,1);
  const missing=schedulerHarness('2026-11-03T10:00:00',null);
  assert.equal(missing.refreshes.length,1);
  const missed=schedulerHarness('2026-11-03T04:15:00',{generatedAt:'2026-11-02T04:16:00'});
  assert.equal(missed.refreshes.length,1); // 未满26h，但今天04:10停机错过了。
  const beforeArchive=schedulerHarness('2026-11-03T02:00:00',{generatedAt:'2026-11-02T04:11:00'});
  assert.equal(beforeArchive.refreshes.length,0); // 不在凌晨重复昨天已完成的卡。
});

test('脱敏真实导出样例逐条可回溯原话，样例前缀不因 recent 改动', () => {
  const base=path.join(workspace,'recency-example');
  const stateDir=path.join(base,'state'),key='group:1';
  const archive=fs.readFileSync(path.join(stateDir,'memory','group_1','chat-2026-10-21-copy.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const card=readRecentCard({stateDir,key});
  assert.equal(card.content.split('\n').length,7);
  for(const line of card.content.split('\n')) {
    const match=line.match(/^(\d{2}-\d{2}) (\d{2}:\d{2}) (.+?)：原话“(.+)”$/);
    assert.ok(match);
    assert.ok(archive.some(r=>r.date.slice(5)===match[1]&&r.hms.slice(0,5)===match[2]&&r.who===match[3]&&r.text===match[4]));
  }
  const context=getRecentContext({stateDir,key,recent:[]});
  assert.equal(context,getRecentContext({stateDir,key,recent:[{text:'本轮变化'}]}));
  assert.equal(context+'\n',fs.readFileSync(path.join(base,'card.txt'),'utf8'));
  assert.ok(!/@\d{5,}/.test(JSON.stringify(archive)));
});
