const el=id=>document.getElementById(id);
const configIds=['execution','symbol','size','leverage','channel'];
let refreshing=false;
function getForm(){return {execution:el('execution').value,symbol:el('symbol').value.trim().toUpperCase(),size:Number(el('size').value),leverage:Number(el('leverage').value),channel:Number(el('channel').value)};}
function setForm(s){if(!s)return;for(const k of configIds)if(s[k]!==undefined)el(k).value=String(s[k]);}
function updateUI(){
  const mode=el('execution').value;
  el('keysSection').hidden=mode==='observe';
  el('liveNote').hidden=mode!=='live';
  const size=Number(el('size').value),lev=Number(el('leverage').value);
  el('exposure').textContent=Number.isFinite(size)&&size>0&&lev>0?`${size} USDT position • approximately ${(size/lev).toFixed(2)} USDT initial margin at ${lev}x (excludes fees)`:'Enter a valid position size and leverage.';
}
async function send(message){const response=await chrome.runtime.sendMessage(message);if(response?.error)throw new Error(response.error);return response;}
function info(message){el('status').textContent=message;}
function fail(e){info('Error: '+e.message);}
async function state(){return send({type:'GET_STATE'});}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    const s=await state();const isRunning=!!s.monitor?.running;
    el('runningPill').textContent=isRunning?'Running':'Stopped';el('runningPill').classList.toggle('on',isRunning);
    el('statusDot').classList.toggle('on',isRunning);
    el('status').textContent=s.latestStatus||'Ready. Open a TradingView chart to begin.';
    const mode=el('execution').value;
    el('keyStatus').textContent=s.credentials?.[mode]?'Saved for this session':'Not connected';
    const lock=s.tradeLock&&['pending','submitting','needsReview'].includes(s.tradeLock.status)?s.tradeLock:null;
    el('lockPanel').hidden=!lock;
    if(lock)el('lockText').textContent=`${lock.environment||'?'} ${lock.symbol||'?'} ${lock.action||''}: ${lock.error||'Waiting for order confirmation.'}`;
    el('scanResult').textContent=s.lastDiagnostic?.message||'No chart scan yet.';
    const history=el('history');history.replaceChildren();
    for(const h of (s.history||[]).slice(0,7)){const li=document.createElement('li');li.textContent=`${new Date(h.at).toLocaleTimeString()} ${h.message}`;history.append(li);}
  } finally{refreshing=false;}
}
async function operate(action){
  const btn=el(action);if(btn)btn.disabled=true;
  try{await actionHandlers[action]();await refresh();}
  catch(e){fail(e);await refresh().catch(()=>{});info('Error: '+e.message);}
  finally{if(btn)btn.disabled=false;}
}
async function persist(){
  const form=getForm();
  const previous=(await state()).settings;
  const changed=!previous||configIds.some(k=>String(previous[k]??'')!==String(form[k]));
  if(changed)await send({type:'SAVE_SETTINGS',settings:form});
  if(form.execution!=='observe' && (el('apiKey').value||el('secret').value)){
    if(!el('apiKey').value||!el('secret').value)throw new Error('Enter both API key and secret to update credentials.');
    await send({type:'SAVE_KEYS',environment:form.execution,apiKey:el('apiKey').value,secret:el('secret').value});
    el('apiKey').value='';el('secret').value='';
  }
  return form;
}
function liveConfirm(s,verb){
  return s.execution!=='live'||confirm(`LIVE FUTURES: ${verb} may place REAL Binance market orders on ${s.symbol} using ${s.size} USDT notional at up to ${s.leverage}x. Continue?`);
}
const actionHandlers={
  connect:async()=>{
    const s=await persist();
    if(s.execution==='observe'){el('connectResult').textContent='Observe mode does not connect to Binance.';return;}
    const r=await send({type:'TEST_CONNECTION',settings:s});
    el('connectResult').textContent=`Connected to ${r.environment.toUpperCase()} • ${r.symbol} • Binance price ${r.price} • current ${r.currentLeverage}x (${r.marginType}) • order ~${r.estimatedNotional.toFixed(2)} USDT ${r.tradePermissionTested?'✓ test order accepted (no trade)':'— below exchange minimum'}`;
  },
  start:async()=>{
    const s=await persist();if(!liveConfirm(s,'Starting automation'))return;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab)throw new Error('Open the TradingView chart first.');
    await send({type:'START',tabId:tab.id});
  },
  stop:()=>send({type:'STOP'}),
  scan:async()=>{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab)throw new Error('No active TradingView tab.');
    const r=await send({type:'SCAN',tabId:tab.id,settings:getForm()});
    el('scanResult').textContent=r.message;
  },
  openLong:()=>manual(1),openShort:()=>manual(2),closeLong:()=>manual(3),closeShort:()=>manual(4),
  checkLock:async()=>{const r=await send({type:'RECONCILE'});info(r.message);},
  clearLock:async()=>{
    if(!confirm('Only clear this after checking the Binance order history and current position. An earlier order may have been submitted. Confirm you checked both.'))return;
    await send({type:'CLEAR_REVIEWED_LOCK',confirmed:true});
  }
};
async function manual(action){
  const s=await persist();
  if(!liveConfirm(s,'Manual trade'))return;
  const labels=['','BUY/LONG','SELL/SHORT','CLOSE LONG','CLOSE SHORT'];
  if(s.execution==='demo'&&!confirm(`Send ${labels[action]} order to Binance Futures DEMO?`))return;
  const result=await send({type:'MANUAL_SIGNAL',action});
  info(result.status);
}
async function init(){
  const s=await state();setForm(s.settings);updateUI();await refresh();
  for(const k of configIds)el(k).addEventListener('input',()=>{updateUI();if(k==='execution')refresh().catch(fail);});
  Object.keys(actionHandlers).forEach(k=>el(k).addEventListener('click',()=>operate(k)));
  chrome.storage.onChanged.addListener((c,area)=>{if(area==='local'&&['monitor','history','tradeLock','latestStatus','lastDiagnostic'].some(k=>k in c))refresh().catch(fail);});
}
init().catch(fail);
