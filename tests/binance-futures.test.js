const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
let env='demo',position=0,leverage=2,marginType='CROSSED',maxLeverage=100,minNotional=5;
let orderError=null;
const orders=[],testOrders=[],journal=[];
const creds=e=>({apiKey:e+'-key',secret:'non-secret-for-mock'});
function res(body,status=200){return{ok:status===200,status,async json(){return body;}};}
async function mockFetch(url,opts={}){
 const u=new URL(url),method=opts.method||'GET';
 assert.equal(u.origin,env==='demo'?'https://demo-fapi.binance.com':'https://fapi.binance.com');
 const p=method==='POST'?new URLSearchParams(opts.body):u.searchParams;
 if (['/fapi/v1/positionSide/dual','/fapi/v1/symbolConfig','/fapi/v3/positionRisk','/fapi/v1/leverage','/fapi/v1/order/test','/fapi/v1/order'].includes(u.pathname)) {
  assert.equal(opts.headers['X-MBX-APIKEY'],env+'-key');
  assert.ok(p.get('signature')); // signed Binance requests
 }
 if(u.pathname==='/fapi/v1/positionSide/dual')return res({dualSidePosition:false});
 if(u.pathname==='/fapi/v1/symbolConfig')return res([{symbol:'BTCUSDT',marginType,leverage}]);
 if(u.pathname==='/fapi/v1/exchangeInfo')return res({symbols:[{symbol:'BTCUSDT',status:'TRADING',quoteAsset:'USDT',filters:[{filterType:'MARKET_LOT_SIZE',minQty:'0.001',maxQty:'999',stepSize:'0.001'},{filterType:'MIN_NOTIONAL',notional:String(minNotional)}]}]});
 if(u.pathname==='/fapi/v1/ticker/price')return res({price:'1000'});
 if(u.pathname==='/fapi/v3/positionRisk')return res(position?[{symbol:'BTCUSDT',positionAmt:String(position),positionSide:'BOTH'}]:[]);
 if(u.pathname==='/fapi/v1/leverage'&&method==='POST'){
  if(Number(p.get('leverage'))>maxLeverage)return res({code:-4028,msg:'Invalid leverage'},400);
  leverage=Number(p.get('leverage'));return res({leverage});
 }
 if(u.pathname==='/fapi/v1/order/test'){
  assert.equal(method,'POST');assert.equal(p.get('type'),'MARKET');
  testOrders.push(Object.fromEntries(p));return res({});
 }
 if(u.pathname==='/fapi/v1/order'&&method==='POST'){
  if(orderError==='rejected')return res({code:-2019,msg:'Margin is insufficient'},400);
  if(orderError==='network')throw new Error('Simulated network loss');
  const row=Object.fromEntries(p.entries());orders.push(row);
  const delta=(row.side==='BUY'?1:-1)*Number(row.quantity);
  if(row.reduceOnly==='true')assert.ok(Math.abs(position+delta)<Math.abs(position));
  position+=delta;
  return res({orderId:orders.length,status:'FILLED'});
 }
 if(u.pathname==='/fapi/v1/order'&&method==='GET') {
  const found=orders.find(o=>o.newClientOrderId===p.get('origClientOrderId'));
  return found?res({clientOrderId:found.newClientOrderId,status:'FILLED'}):res({code:-2013,msg:'Order does not exist'},400);
 }
 throw new Error(`Unexpected mock ${method} ${u.pathname}`);
}
const context={fetch:mockFetch,crypto:webcrypto,TextEncoder,URL,URLSearchParams};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/binance-futures.js'),'utf8'),context);
const api=context.BinanceFutures;
const s={symbol:'BTCUSDT',size:10,leverage:2};
const signal=(action,t=1794048000)=>({action,actionName:['NONE','OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT'][action],signalTimeSec:t,channel:7,nonce:'1234abCD'});
function hooks(){return{
 beforeOrder:async r=>{journal.push('pending');},
 resolved:async()=>{journal.push('resolved');},
 rejected:async()=>{journal.push('rejected');},
 uncertain:async()=>{journal.push('uncertain');}
};}
(async()=>{
 assert.equal(api.quantityDown(0.01987,{stepSize:'0.0010000'}),'0.019');
 let p=await api.testConnection(s,creds('demo'),'demo');assert.equal(p.sizeValid,true);assert.equal(p.tradePermissionTested,true);assert.equal(testOrders.length,1);
 assert.equal(orders.length,0,'a connection test must never trade');
 await api.trade(signal(1),s,creds('demo'),'demo',hooks());
 assert.equal(position,.01);assert.equal(orders.length,1);assert.equal(journal.join(','),'pending,resolved');
 await api.trade(signal(1,1794048060),s,creds('demo'),'demo',hooks());assert.equal(orders.length,1,'no stacking');
 await api.trade(signal(2,1794048120),s,creds('demo'),'demo',hooks());assert.equal(position,-.01);assert.equal(orders.length,3,'reverse: reduce-only close and new short');assert.equal(orders[1].reduceOnly,'true');
 await api.trade(signal(4,1794048180),s,creds('demo'),'demo',hooks());assert.equal(position,0);assert.equal(orders[3].reduceOnly,'true');
 const count=journal.length;
 await assert.rejects(api.trade(signal(1),{...s,size:1},creds('demo'),'demo',hooks()),/minimum/);
 assert.equal(journal.length,count,'preflight errors must never create a persistent order lock');
 marginType='ISOLATED';maxLeverage=20;
 await assert.rejects(api.trade(signal(1),{...s,leverage:100},creds('demo'),'demo',hooks()),/Invalid leverage/);
 assert.equal(journal.length,count,'leverage errors must never create a persistent order lock');
 maxLeverage=100;
 await api.trade(signal(1),{...s,leverage:100},creds('demo'),'demo',hooks());assert.equal(leverage,100);assert.equal(position,.01);
 await api.trade(signal(3),{...s,leverage:100},creds('demo'),'demo',hooks());assert.equal(position,0);
 orderError='rejected';
 await assert.rejects(api.trade(signal(1),{...s,leverage:100},creds('demo'),'demo',hooks()),/insufficient/);
 assert.equal(journal.at(-1),'rejected','known Binance rejection clears in-flight order lock');
 orderError='network';
 await assert.rejects(api.trade(signal(1),{...s,leverage:100},creds('demo'),'demo',hooks()),/network/i);
 assert.equal(journal.at(-1),'uncertain','network failure must retain lock');
 orderError=null;
 env='live';leverage=2;
 await api.trade(signal(2),s,creds('live'),'live',hooks());
 assert.equal(orders.at(-1).side,'SELL');assert.equal(position,-.01);
 console.log('PASS: Binance test connection (non-trading order), small notional, 100x configuration, reverse, close reduce-only, known rejection, ambiguous network failure, Live/Demo separation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
