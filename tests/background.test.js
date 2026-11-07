const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const local={},session={},submitted=[];
const store=o=>({async get(keys){const names=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||{});return Object.fromEntries(names.filter(k=>k in o).map(k=>[k,o[k]]));},async set(v){Object.assign(o,v);},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete o[k];}});
let failure='preflight';
const ctx={crypto:webcrypto,URL,fetch,TextEncoder,importScripts(){},VisualBridge:{detectStripe:()=>null,symbolHash:()=>333},
 BinanceFutures:{validateSettings:s=>{if(s.leverage>100)throw new Error('cap exceeded');},
 testConnection:async()=>({ok:true}),request:async()=>[],getOrder:async()=>({status:'FILLED'}),
 trade:async(signal,settings,credentials,env,hooks)=>{
  if(failure==='preflight')throw new Error('Too small for Binance minimum order size.');
  const info={status:'submitting',clientOrderId:'abc0123',environment:env,symbol:settings.symbol,action:signal.actionName,at:Date.now()};
  await hooks.beforeOrder(info);submitted.push(info);
  if(failure==='uncertain'){await hooks.uncertain(info,new Error('network dropped'));throw new Error('network dropped');}
  await hooks.resolved(info,{status:'FILLED'});return {status:'FILLED'};
 }},chrome:{tabs:{get:async id=>({id,active:true,windowId:1,url:'https://www.tradingview.com/chart/'})},storage:{local:store(local),session:store(session)},runtime:{onMessage:{addListener(){}},onInstalled:{addListener(){}},onStartup:{addListener(){}}}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),ctx);
(async()=>{
 const s={symbol:'BTCUSDT',channel:7,size:10,leverage:2,execution:'demo'};
 local.settings=s;session.demoCredentials={apiKey:'demo-key',secret:'test'};
 await assert.rejects(ctx.manualSignal(1),/Too small/);
 assert.equal(local.tradeLock,undefined,'preflight failure must NOT lock future trading');
 local.tradeLock={status:'needsReview',environment:'demo',symbol:'BTCUSDT',error:'Calculated 1.00 USDT below Binance minimum 5.00 USDT.'};
 let result=await ctx.pendingLock();assert.equal(result,null,'legacy preflight lock automatically cleared');
 failure='ok';await ctx.manualSignal(1);assert.equal(local.tradeLock,undefined,'confirmed order clears journal');
 failure='uncertain';await assert.rejects(ctx.manualSignal(2),/network dropped/);
 assert.equal(local.tradeLock.status,'needsReview','unknown execution remains held');
 result=await ctx.reconcile();assert.equal(result.clear,true,'terminal Binance order with confirmed position clears lock');
 assert.equal(local.tradeLock,undefined);
 local.tradeLock={status:'needsReview',environment:'demo',symbol:'BTCUSDT',error:'old unknown error'};
 result=await ctx.reconcile();assert.equal(result.legacy,true,'legacy unknown lock must not be automatically forgotten');
 console.log('PASS: manual preflight no lock, v0.3 preflight recovery, order journal, uncertain order auto-reconciliation, legacy unknown preserved.');
})().catch(e=>{console.error(e);process.exitCode=1;});
