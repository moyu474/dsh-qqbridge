import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecentCard, readRecentCard, refreshRecentCard, refreshTodaySupplement, getRecentContext } from './lite-recency.mjs';

test('archive to card, supplements, failure and empty archive', async t => {
  const workspace = path.dirname(fileURLToPath(import.meta.url));
  const root = fs.mkdtempSync(path.join(workspace, '.lite-recency-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(workspace + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'memory', 'g_1'); fs.mkdirSync(dir, { recursive: true });
  const dateOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const now = new Date(), date = dateOf(now), prev = new Date(now.getFullYear(), now.getMonth(), now.getDate()-3), earlier = dateOf(prev);
  const row = (date,hms,who,text) => JSON.stringify({date,hms,who,text});
  fs.writeFileSync(path.join(dir, `chat-${date}-a.jsonl`), row(date,'09:00:00','Alice','archived')+'\n'+row(date,'09:00:00','Bob','archived'));
  fs.writeFileSync(path.join(dir, `chat-${earlier}-a.jsonl`), row(earlier,'08:00:00','Carol','earlier'));
  let calls = 0;
  const api = async (url, req) => {
    calls++; const body = JSON.parse(req.body);
    assert.equal(body.model, 'deepseek-chat'); assert.equal(body.max_tokens, 520); assert.equal(body.temperature, 0.2); assert.equal(body.stream, false);
    assert.ok(Buffer.byteLength(body.messages[0].content + body.messages[1].content) <= 6500);
    assert.ok(body.messages[1].content.includes('Carol')); assert.ok(body.messages[1].content.includes('Bob')); assert.ok(req.signal);
    return {ok:true,json:async()=>({choices:[{message:{content:`${date.slice(5)} 09:00 Alice：archived`},finish_reason:'stop'}],usage:{completion_tokens:20}})};
  };
  const opts = {stateDir:root,key:'g:1',api,cfg:{apiKey:'test'}};
  const card = await buildRecentCard(opts); assert.equal(calls,1); assert.equal(card.sourceIds.length,1); assert.ok(!Number.isNaN(Date.parse(card.until))); assert.equal(readRecentCard(opts).content,card.content);
  fs.writeFileSync(path.join(dir,'today.jsonl'), [row(date,'09:00:00','Alice','archived'),row(date,'09:00:00','Bob','archived'),row(date,'10:00:00','Dan','supplement'),row(date,'11:00:00','Eve','current')].join('\n'));
  refreshTodaySupplement(opts); const ctx = getRecentContext({...opts,recent:[{text:'current'}]});
  assert.match(ctx,/近 7 天近况/); assert.match(ctx,/当天补充/); assert.match(ctx,/supplement/); assert.doesNotMatch(ctx,/current/);
  const old = await refreshRecentCard({...opts,api:async()=>{throw Error('network')}}); assert.equal(old.content,card.content);
  const bad = await refreshRecentCard({...opts,api:async()=>({ok:true,json:async()=>({choices:[{message:{content:`${date.slice(5)} 09:00 Unknown：bad`}}]})})}); assert.equal(bad.content,card.content);
  fs.mkdirSync(path.join(root,'memory','empty')); assert.equal((await buildRecentCard({...opts,key:'empty'})).content,''); assert.equal(getRecentContext({...opts,key:'missing'}),'');
  fs.renameSync(dir,dir+'-moved'); assert.equal(await refreshRecentCard(opts),null);
});
