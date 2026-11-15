import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {SqliteJourneyStore} from './journey-store.mjs';
import {JourneyService} from './journey-service.mjs';

// Public review harness. Transport and UI are synthetic; the service/store are
// unchanged copies of the original implementation. No network calls are made.
const base=resolve(dirname(fileURLToPath(import.meta.url)),'.review-state');
mkdirSync(base,{recursive:true});
const folder=mkdtempSync(join(base,'run-')),db=join(folder,'journeys.sqlite');
let store=new SqliteJourneyStore(db),now=Date.parse('2026-10-28T03:00:00Z');
let refreshCalls=0,replanCalls=0;
const passed=[];
const raw={best:{route_id:'synthetic-review-route',arrival_at:new Date(now+1800000).toISOString(),legs:[
  {leg_id:'walk-1',mode:'RUN'}, {leg_id:'bus-1',mode:'BUS'}, {leg_id:'walk-2',mode:'RUN'}
]}};
const input={origin:{name:'합성 출발지',lat:37.5,lon:127},destination:{name:'합성 목적지',lat:37.51,lon:127.01},run_speed_kmh:10,target_arrival_at:new Date(now+1900000).toISOString()};
const view=raw=>{assert.ok(Array.isArray(raw?.best?.legs),'valid synthetic route required');return {route_id:raw.best.route_id};};
const service=()=>new JourneyService({store,now:()=>now,view,testMode:true,appVersion:'portfolio-review',
  refresh:async()=>{refreshCalls++;return {arrivals:[],provider_calls:1};},
  replan:async()=>{replanCalls++;return {raw:structuredClone(raw)};}});
let svc=service();
try {
  let p=await svc.create({id:randomUUID(),input,raw,meta:{'openai/subject':'synthetic-review-user'}});
  const original=p.journey,auth={journey_id:p.journey.id,resume_token:p.journey.resume_token};
  const act=async(action,extra={})=>{p=await svc.act({...auth,action,event_id:randomUUID(),version:p.journey.version,leg_id:p.journey.active_leg_id,...extra});return p;};
  await assert.rejects(svc.restore({...auth,resume_token:'x'.repeat(64)}),/확인하지/);
  await assert.rejects(act('arrived'),/승차와 하차/);
  await assert.rejects(act('boarded',{version:0}),/진행 상태/);
  passed.push('01 invalid token, stale version and premature arrival rejected');

  const eventId=randomUUID();await act('refresh',{event_id:eventId});await act('refresh',{event_id:eventId});
  assert.equal(refreshCalls,1);now+=14999;await act('refresh');assert.equal(refreshCalls,1);
  store.close();store=new SqliteJourneyStore(db);svc=service();p=await svc.restore(auth);
  assert.equal(p.journey.user_id,original.user_id);assert.equal(p.journey.initial_arrival_at,original.initial_arrival_at);
  now++;await act('refresh');assert.equal(refreshCalls,2);
  passed.push('02 duplicate refresh blocked; 14999/15000ms boundary survives DB reopen');

  await act('boarded');assert.deepEqual(p.journey.actions,['alighted']);
  await assert.rejects(act('missed'),/내렸어요/);
  store.close();store=new SqliteJourneyStore(db);svc=service();p=await svc.restore(auth);
  assert.deepEqual(p.journey.actions,['alighted']);await act('alighted');
  now=Date.parse(raw.best.arrival_at)+300000;
  const arrivalId=randomUUID();await act('arrived',{event_id:arrivalId});await act('arrived',{event_id:arrivalId});
  assert.equal(p.journey.arrival.on_time,false);assert.equal(p.journey.arrival.prediction_difference_s,300);
  assert.equal(store.events(auth.journey_id).filter(e=>e.kind==='arrived').length,1);
  assert.deepEqual(p.journey.actions,[]);
  passed.push('03 boarded/alighted/arrived persist; duplicate arrival produces one event');

  let release;
  const concurrent=new JourneyService({store,now:()=>now,view,refresh:()=>new Promise(r=>release=r)});
  const c=await concurrent.create({id:randomUUID(),input,raw,test:true});
  const ca={journey_id:c.journey.id,resume_token:c.journey.resume_token,version:1,action:'refresh'};
  const inflight=concurrent.act({...ca,event_id:randomUUID()});await new Promise(r=>setImmediate(r));
  const blocked=await concurrent.act({...ca,event_id:randomUUID()});assert.equal(blocked.journey.operation.busy,true);
  release({arrivals:[],provider_calls:0});await inflight;
  assert.equal((await store.load(ca.journey_id)).counts.refresh_accepted,1);
  passed.push('04 concurrent refresh accepts one external operation');

  const badSvc=new JourneyService({store,now:()=>now,view,replan:async()=>({raw:{best:{}}})});
  const bad=await badSvc.create({id:randomUUID(),input,raw,test:true});
  const failed=await badSvc.act({journey_id:bad.journey.id,resume_token:bad.journey.resume_token,version:1,action:'missed',leg_id:'bus-1',event_id:randomUUID(),location:{lat:37.5,lon:127,observed_at:new Date(now).toISOString()}});
  assert.equal(failed.journey.operation,null);assert.equal(failed.journey.history.length,0);assert.equal(failed.route_id,raw.best.route_id);
  assert.match(failed.journey.message,/찾지 못했어요/);
  passed.push('05 failed recovery releases operation and preserves previous route');

  const lost=await svc.create({id:randomUUID(),input,raw,test:true});
  await store.mutate(lost.journey.id,s=>{s.operation={kind:'refresh',id:randomUUID(),lease_until:now-1};return {state:s};});
  const callsBefore=refreshCalls;
  const restored=await svc.continueOperation({journey_id:lost.journey.id,resume_token:lost.journey.resume_token});
  assert.equal(restored.journey.operation,null);assert.equal(refreshCalls,callsBefore);
  passed.push('06 interrupted refresh recovery makes no extra provider call');

  const r=await svc.create({id:randomUUID(),input,raw,test:true});
  const ra={journey_id:r.journey.id,resume_token:r.journey.resume_token,version:1,action:'missed',leg_id:'bus-1'};
  await assert.rejects(svc.act({...ra,event_id:randomUUID()}),/현재 위치/);
  const recovered=await svc.act({...ra,event_id:randomUUID(),location:{lat:37.5,lon:127,observed_at:new Date(now).toISOString()}});
  assert.equal(replanCalls,1);assert.equal(recovered.journey.initial_arrival_at,raw.best.arrival_at);
  assert.equal(recovered.journey.initial_target_at,input.target_arrival_at);assert.equal(recovered.journey.history.length,1);
  passed.push('07 missed recovery requires location and preserves original target/prediction');

  const walk=structuredClone(raw);walk.best.legs=walk.best.legs.filter(l=>l.mode==='RUN');
  const n=await svc.create({id:randomUUID(),input:{...input,target_arrival_at:undefined},raw:walk,test:true});
  const done=await svc.act({journey_id:n.journey.id,resume_token:n.journey.resume_token,version:1,action:'arrived',event_id:randomUUID()});
  assert.equal(done.journey.arrival.on_time,null);
  passed.push('08 no target yields null target-arrival assessment');
  console.log(JSON.stringify({result:'PASS',checks:passed.length,node:process.version,executed_at:new Date().toISOString(),network_calls:0,scope:'original journey service/store with synthetic transport and view adapters',passed},null,2));
} finally {
  store.close();
  const target=resolve(folder);
  if(!target.startsWith(base+sep))throw Error('Refusing cleanup outside review-state');
  rmSync(target,{recursive:true,force:true});
}
