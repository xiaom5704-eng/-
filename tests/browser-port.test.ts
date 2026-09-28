import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserService} from '../server/browser-port';

test('Automatic ports close rejected services completely before starting the next listener',async () => {
  const events:string[]=[];const ports=[6667,10080,3100];
  const ready=await startBrowserService(0,async()=>{
    const port=ports.shift()!;events.push(`start:${port}`);
    return {port,close:async()=>{await new Promise(resolve=>setImmediate(resolve));events.push(`close:${port}`);}};
  });
  assert.equal(ready.port,3100);
  assert.deepEqual(events,['start:6667','close:6667','start:10080','close:10080','start:3100']);
});

test('Explicit forbidden ports fail before opening resources; ordinary startup failures are not retried',async () => {
  for(const port of [22,6000,6666,6697,10080]) {
    await assert.rejects(startBrowserService(port,async()=>assert.fail('must not open databases or listen')),/瀏覽器禁止/);
  }
  const collision=Object.assign(new Error('already in use'),{code:'EADDRINUSE'});let calls=0;
  await assert.rejects(startBrowserService(3000,async()=>{calls++;throw collision;}),error=>error===collision);
  assert.equal(calls,1);
});

test('An OS repeatedly assigning unusable ports stops with no leaked listener',async () => {
  let opened=0,closed=0;
  await assert.rejects(startBrowserService(0,async()=>{opened++;return {port:6666,close:async()=>{closed++;}};}),/指定 PORT=3000/);
  assert.equal(opened,8);assert.equal(closed,opened);
});
