import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';

export const COOLDOWN_MS=15000;
const LEASE_MS=60000;
export const isTransit=l=>['BUS','SUBWAY','RAIL','TRAM','FERRY'].includes(l.mode);
const legsOf=s=>s.raw.best.legs.filter(l=>l.mode!=='WAIT');
const iso=n=>new Date(n).toISOString();
const fail=(code,message)=>Object.assign(Error(message),{code});
function authorize(s,token){
 if(!s||typeof token!=='string'||token.length!==s.resume_token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(s.resume_token)))throw fail('journey_not_found','저장된 여정을 확인하지 못했어요. 원래 안내 카드에서 다시 열어 주세요.');
}
function active(s){return legsOf(s).findIndex((l,i)=>i>=s.cursor&&isTransit(l));}
function event(s,id,kind,now,extra={}){return {event_id:id,journey_id:s.id,user_id:s.user_id,conversation_id:s.conversation_id,kind,received_at:iso(now),version:s.version,source:'mcp',test:s.test,app_version:s.app_version,...extra};}
function receipt(s,id,value){s.receipts[id]=value;const keys=Object.keys(s.receipts);for(const k of keys.slice(0,Math.max(0,keys.length-256)))delete s.receipts[k];}
function counts(){return {refresh_clicks:0,refresh_accepted:0,refresh_blocked:0,refresh_succeeded:0,refresh_failed:0,provider_calls:0,boarded:0,missed:0,alighted:0,arrived:0};}
export class JourneyService {
 constructor({store,view,refresh,replan,now=Date.now,appVersion='development',testMode=false}){Object.assign(this,{store,view,refresh,replan,now,appVersion,testMode});}
 async create({id,input,raw,meta={},test=this.testMode}){
  this.view(raw,input,id);
  raw={best:raw.best,query:raw.query,comparison:raw.comparison};
  const now=this.now(),hash=(kind,value)=>createHmac('sha256',this.store.identityKey).update(kind+':'+value).digest('hex').slice(0,32);
  const s=await this.store.mutate(id,existing=>{
   if(existing)return {value:existing};
   const state={schema:1,id,resume_token:randomBytes(32).toString('hex'),user_id:meta['openai/subject']?hash('subject',meta['openai/subject']):randomUUID(),conversation_id:meta['openai/session']?hash('session',meta['openai/session']):null,identity_source:meta['openai/subject']?'host_pseudonym':'journey_random',created_at:iso(now),updated_at:iso(now),version:1,app_version:this.appVersion,test,input,raw,cursor:0,onboard_leg_id:null,completed:[],history:[],arrivals:[],initial_target_at:input.target_arrival_at??null,initial_arrival_at:raw.best.arrival_at,initially_on_time:input.target_arrival_at?Date.parse(raw.best.arrival_at)<=Date.parse(input.target_arrival_at):null,arrival:null,last_refresh_at:null,operation:null,receipts:{},counts:counts()};
   return {state,value:state,events:[event(state,'created','journey_started',now)]};
  });return this.snapshot(s);
 }
 snapshot(s){
  const now=this.now(),index=active(s),leg=legsOf(s)[index],busy=!!s.operation&&s.operation.lease_until>now;
  const actions=s.arrival?[]:busy?[]:s.onboard_leg_id?['alighted']:index>=0?['boarded','missed']:['arrived'];
  const arrivals=legsOf(s).slice(s.cursor+(s.onboard_leg_id?1:0)).filter(isTransit).map(l=>({leg_id:l.leg_id,status:'not_refreshed',planned_departure_at:l.departure_at??l.start_at,...s.arrivals.find(a=>a.leg_id===l.leg_id)}));
  return {...this.view(s.raw,s.input,s.id),journey:{id:s.id,resume_token:s.resume_token,version:s.version,user_id:s.user_id,identity_source:s.identity_source,server_now:iso(now),cursor:s.cursor,onboard_leg_id:s.onboard_leg_id,active_leg_id:leg?.leg_id??null,completed:s.completed,history:s.history,actions,arrival:s.arrival,initial_target_at:s.initial_target_at,initial_arrival_at:s.initial_arrival_at,last_refresh_at:s.last_refresh_at,next_refresh_at:s.last_refresh_at?iso(Date.parse(s.last_refresh_at)+COOLDOWN_MS):null,operation:s.operation?{kind:s.operation.kind,id:s.operation.id,busy,pending:!!s.operation.pending,retry_after_ms:Math.max(0,s.operation.lease_until-now)}:null,arrivals,message:s.message??null}};
 }
 async restore({journey_id,resume_token}){const s=await this.store.load(journey_id);authorize(s,resume_token);return this.snapshot(s);}
 async act(args){
  const {journey_id,resume_token,event_id,action,version,leg_id,occurred_at}=args,now=this.now();
  if(!/^[\w-]{8,100}$/.test(event_id??''))throw fail('invalid_event','행동 식별자가 필요해요.');
  const result=await this.store.mutate(journey_id,(s,seen)=>{
   authorize(s,resume_token);
   if(seen||s.receipts[event_id])return {value:{state:s,duplicate:true}};
   const events=[],record=(kind,extra)=>events.push(event(s,event_id,kind,now,{action,occurred_at:occurred_at??null,...extra}));
   if(action==='refresh')s.counts.refresh_clicks++;
   const busy=s.operation&&s.operation.lease_until>now;
   const blocked=action==='refresh'&&(busy||s.arrival||s.last_refresh_at&&now-Date.parse(s.last_refresh_at)<COOLDOWN_MS);
   if(blocked){s.counts.refresh_blocked++;const outcome=s.arrival?'completed':busy?'in_flight':'cooldown';record('refresh_blocked',{outcome});receipt(s,event_id,outcome);return {state:s,events,value:{state:s}};}
   if(s.arrival)throw fail('completed','이미 도착을 기록한 여정이에요.');
   if(version!==s.version)throw fail('stale_state','진행 상태가 바뀌었어요. 최신 상태를 불러온 뒤 다시 눌러 주세요.');
   if(busy)throw fail('operation_pending','요청을 처리하고 있어요. 잠시 후 다시 눌러 주세요.');
   const legs=legsOf(s),index=active(s),target=legs[index];
   s.message=null;
   if(['boarded','missed','alighted'].includes(action)&&(!target||target.leg_id!==leg_id))throw fail('invalid_leg','현재 안내 중인 교통편인지 확인해 주세요.');
   if(action==='boarded'){
    if(s.onboard_leg_id)throw fail('already_onboard','이미 탑승 중이에요.');
    s.completed.push(...legs.slice(s.cursor,index).map(l=>l.leg_id));s.cursor=index;s.onboard_leg_id=leg_id;s.counts.boarded++;record('boarded',{leg_id});
   }else if(action==='alighted'){
    if(s.onboard_leg_id!==leg_id)throw fail('not_onboard','탑승 상태를 먼저 확인해 주세요.');
    s.completed.push(leg_id);s.cursor=index+1;s.onboard_leg_id=null;s.counts.alighted++;record('alighted',{leg_id});
   }else if(action==='arrived'){
    if(s.onboard_leg_id||index>=0)throw fail('unfinished_transit','승차와 하차를 먼저 확인해 주세요.');
    s.completed.push(...legs.slice(s.cursor).map(l=>l.leg_id));s.cursor=legs.length;s.counts.arrived++;
    s.arrival={confirmed_at:iso(now),client_reported_at:occurred_at??null,source:'user_button_server_received',on_time:s.initial_target_at?now<=Date.parse(s.initial_target_at):null,prediction_difference_s:Math.round((now-Date.parse(s.initial_arrival_at))/1000),target_difference_s:s.initial_target_at?Math.round((now-Date.parse(s.initial_target_at))/1000):null,initially_on_time:s.initially_on_time};record('arrived',s.arrival);
   }else if(action==='refresh'||action==='missed'){
    if(action==='missed'&&s.onboard_leg_id)throw fail('onboard','내렸어요를 누른 뒤 남은 길을 다시 찾아 주세요.');
    if(action==='missed'){
     const p=args.location;
     if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||Math.abs(p.lat)>90||Math.abs(p.lon)>180||!Number.isFinite(Date.parse(p.observed_at))||Math.abs(now-Date.parse(p.observed_at))>120000)throw fail('location_required','현재 위치를 확인한 뒤 다시 찾아 주세요.');
     s.counts.missed++;
    }else{s.last_refresh_at=iso(now);s.counts.refresh_accepted++;}
    s.operation={id:event_id,request_id:randomUUID(),kind:action,leg_id:leg_id??null,location:args.location??null,lease_until:now+LEASE_MS,started_at:iso(now)};
    record(action==='refresh'?'refresh_accepted':'missed',{leg_id:leg_id??null});
   }else throw fail('invalid_action','지원하지 않는 행동이에요.');
   s.updated_at=iso(now);s.version++;receipt(s,event_id,'accepted');return {state:s,events,value:{state:s,execute:action==='refresh'||action==='missed'}};
  },event_id);
  if(result.execute)return this.execute(result.state);
  return this.snapshot(result.state);
 }
 async execute(s){
  const op=s.operation,start=this.now();let response,error;
  try{response=op.kind==='refresh'?await this.refresh(s):await this.replan(s);if(op.kind==='missed'&&!response.pending)this.view(response.raw,s.input,s.id);}catch(e){error=e;}
  const updated=await this.store.mutate(s.id,current=>{
   if(current.operation?.id!==op.id)return {value:current};
   const now=this.now(),events=[];
   const log=(kind,details={})=>events.push(event(current,op.id+':'+kind,kind,now,{duration_ms:now-start,...details}));
   if(response?.pending){current.operation.lease_until=now+LEASE_MS;current.operation.pending=true;current.message='남은 길을 찾고 있어요.';return {state:current,value:current};}
   if(error){current.message=op.kind==='refresh'?'도착 정보를 갱신하지 못했어요. 마지막 확인 정보를 표시합니다.':'남은 길을 찾지 못했어요. 현재 안내를 유지합니다. 다시 시도해 주세요.';if(op.kind==='refresh')current.counts.refresh_failed++;log(op.kind+'_failed',{error_code:error.code??'upstream_failure'});}
   else if(op.kind==='refresh'){
    const failed=response.arrivals.filter(a=>a.status==='provider_error');
    current.arrivals=response.arrivals.map(a=>a.status==='provider_error'?{...a,last_known:current.arrivals.find(old=>old.leg_id===a.leg_id)?.last_known??current.arrivals.find(old=>old.leg_id===a.leg_id)}:a);
    if(failed.length&&failed.length===response.arrivals.length)current.counts.refresh_failed++;else current.counts.refresh_succeeded++;
    if(failed.length)current.message='일부 도착 정보를 갱신하지 못했어요. 다시 확인해 주세요.';
    current.counts.provider_calls+=response.provider_calls??0;log('refresh_completed',{provider_calls:response.provider_calls??null,results:response.arrivals,partial_failure:failed.length>0});
   }else{
    // A recovery replaces only the uncompleted suffix. Completed legs remain
    // available as history, never as boarding actions in the new route.
    current.history.push({replaced_at:iso(now),route_id:current.raw.best.route_id,completed_legs:legsOf(current).filter(l=>current.completed.includes(l.leg_id)),missed_leg_id:op.leg_id});
    current.raw={best:response.raw.best,query:response.raw.query,comparison:response.raw.comparison};current.input={...current.input,origin:{name:'현재 위치',lat:op.location.lat,lon:op.location.lon}};current.cursor=0;current.onboard_leg_id=null;current.arrivals=[];log('replan_completed',{route_id:response.raw.best.route_id});
   }
   current.operation=null;current.version++;current.updated_at=iso(now);return {state:current,events,value:current};
  });return this.snapshot(updated);
 }
 async continueOperation(args){
  const now=this.now();
  const claim=await this.store.mutate(args.journey_id,s=>{
   authorize(s,args.resume_token);if(!s.operation)return {value:{s,run:false}};
   if(s.operation.lease_until>now&&!s.operation.pending)return {value:{s,run:false}};
   if(s.operation.kind==='refresh'){
    // A lost refresh response must not trigger another provider call on restore.
    if(s.operation.lease_until<=now){const op=s.operation;s.operation=null;s.version++;s.message='새로고침 결과를 확인하지 못했어요. 다시 눌러 주세요.';s.counts.refresh_failed++;return {state:s,events:[event(s,op.id+':interrupted','refresh_interrupted',now)],value:{s,run:false}};}
    return {value:{s,run:false}};
   }
   s.operation.pending=false;s.operation.lease_until=now+LEASE_MS;return {state:s,value:{s,run:true}};
  });return claim.run?this.execute(claim.s):this.snapshot(claim.s);
 }
}
