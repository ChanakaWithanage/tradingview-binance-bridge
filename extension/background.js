importScripts('decoder.js','binance-futures.js');
const DEFAULT_SETTINGS = Object.freeze({symbol:'XRPUSDT',channel:7,size:10,leverage:2,execution:'observe'});
const ACTIONS = ['NONE','OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT','TEST_LONG','TEST_SHORT','TEST_CLOSE_LONG','TEST_CLOSE_SHORT'];
let pollBusy=false, tradeBusy=false;

function normalize(src={}) {
  const s = {
    symbol:String(src.symbol ?? DEFAULT_SETTINGS.symbol).trim().toUpperCase(),
    channel:Number(src.channel ?? 7), size:Number(src.size ?? 10),
    leverage:Number(src.leverage ?? src.maxLeverage ?? 2),
    execution:String(src.execution ?? 'observe')
  };
  if (!Number.isInteger(s.channel) || s.channel < 0 || s.channel > 255) throw new Error('Visual channel must be 0–255.');
  if (!['observe','demo','live'].includes(s.execution)) throw new Error('Unknown trading environment.');
  BinanceFutures.validateSettings(s);
  return s;
}
async function record(message,kind='info') {
  const {history=[]}=await chrome.storage.local.get('history');
  history.unshift({at:Date.now(),message,kind});
  await chrome.storage.local.set({history:history.slice(0,35),latestStatus:message});
}
function tradingViewTab(tab) {
  return !!tab?.active && /^https:\/\/([a-z0-9-]+\.)?tradingview\.com\//i.test(tab.url || '');
}
async function screenshotPixels(windowId) {
  const dataUrl=await chrome.tabs.captureVisibleTab(windowId,{format:'png'});
  const blob=await (await fetch(dataUrl)).blob();
  const bitmap=await createImageBitmap(blob);
  try {
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0);
    return ctx.getImageData(0,0,bitmap.width,bitmap.height);
  } finally {bitmap.close();}
}
async function scanTab(tabId,raw) {
  const s=normalize(raw || (await chrome.storage.local.get('settings')).settings || DEFAULT_SETTINGS);
  const tab=await chrome.tabs.get(tabId);
  if(!tradingViewTab(tab)) throw new Error('Open a TradingView chart in the active tab, then scan again.');
  const image=await screenshotPixels(tab.windowId);
  const signal=VisualBridge.detectStripe(image);
  if (!signal) {
    const message=`No visual signal strip found in ${image.width}×${image.height}. Keep the chart and top-right color strip visible.`;
    await chrome.storage.local.set({lastDiagnostic:{found:false,message,at:Date.now()}});
    return {found:false,message};
  }
  const channelMatches=signal.channel===s.channel;
  const symbolMatches=signal.symbolHash===VisualBridge.symbolHash(s.symbol);
  const message=`Signal strip found: ${signal.actionName}; channel ${signal.channel}${channelMatches?' ✓':' (expected '+s.channel+')'}, symbol ${symbolMatches?'✓':'mismatch'}. No order placed.`;
  await chrome.storage.local.set({latestSignal:signal,lastDiagnostic:{found:true,message,at:Date.now()}});
  await record('SCAN: '+message, channelMatches && symbolMatches ? 'signal' : 'warning');
  return {found:true,validSettings:channelMatches && symbolMatches,message,decoded:signal};
}
async function getCredentials(execution) {
  if(execution==='observe') return null;
  const key=execution+'Credentials';
  const result=await chrome.storage.session.get(key);
  const creds=result[key];
  if(!creds?.apiKey || !creds?.secret) throw new Error(`Enter and save ${execution.toUpperCase()} API key and secret first.`);
  return creds;
}
async function stop() {
  await chrome.storage.local.set({monitor:{running:false},latestStatus:'Automatic trading stopped. Existing Binance positions are unchanged.'});
  return {ok:true};
}
async function saveSettings(raw) {
  const settings=normalize(raw);
  await stop();
  await chrome.storage.local.set({settings});
  await record('Settings saved. Automatic trading stopped until Start is clicked.');
  return {ok:true,settings};
}
async function saveKeys(environment,apiKey,secret) {
  if(!['demo','live'].includes(environment)) throw new Error('Select Demo or Live to save credentials.');
  if(!String(apiKey||'').trim() || !String(secret||'').trim()) throw new Error('Enter both API key and secret.');
  await chrome.storage.session.set({[environment+'Credentials']:{apiKey:String(apiKey).trim(),secret:String(secret).trim()}});
  await stop();
  await record(`${environment.toUpperCase()} API credentials saved for this browser session.`);
  return {ok:true};
}
// An earlier v0.3 build locked even when preflight checks failed, before submitting an order.
// Those specific, recognizable preflight errors are safe to discard on upgrade.
function v03Preflight(lock) {
  return !lock.clientOrderId && /^needsReview$/.test(lock.status || '') &&
    /Set Isolated margin|exceeds configured cap|below Binance minimum|Hedge mode unsupported|existing Futures orders|conditional\/TP\/SL orders|No usable Binance|symbol configuration missing|market lot size|reversal is OFF|Missing .*API key|leverage .*cap/i.test(lock.error || '');
}
async function pendingLock() {
  const {tradeLock}=await chrome.storage.local.get('tradeLock');
  if(!tradeLock || !['submitting','needsReview','pending'].includes(tradeLock.status)) return null;
  if(v03Preflight(tradeLock)) {
    await chrome.storage.local.remove('tradeLock');
    await record('Recovered an old v0.3 preflight-only lock; no order had been submitted.');
    return null;
  }
  return tradeLock;
}
async function reconcile() {
  const lock=await pendingLock();
  if(!lock) return {clear:true,message:'No unresolved Binance order.'};
  if(!lock.clientOrderId) return {clear:false,legacy:true,message:'Old v0.3 lock has no Binance order ID. Review Binance order history and positions, then use the manual clear button.'};
  const creds=await getCredentials(lock.environment);
  let order;
  try {order=await BinanceFutures.getOrder(lock.environment,creds,lock.symbol,lock.clientOrderId);}
  catch(e) {
    return {clear:false,message:`Could not confirm order ${lock.clientOrderId}: ${e.message}. Check Binance before clearing.`};
  }
  const status=String(order.status || 'UNKNOWN');
  if(!['FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH'].includes(status)) {
    return {clear:false,order,message:`Order ${lock.clientOrderId} is ${status}; automatic trading stays paused.`};
  }
  // Verify API access to the current position too before lifting an uncertain lock.
  try { await BinanceFutures.request(lock.environment,'GET','/fapi/v3/positionRisk',{symbol:lock.symbol},creds); }
  catch(e) {return {clear:false,message:`Order ${status}, but position confirmation failed: ${e.message}`};}
  await chrome.storage.local.remove('tradeLock');
  await record(`Reconciled Binance order ${lock.clientOrderId}: ${status}. Ready.`, 'signal');
  return {clear:true,order,message:`Previous order ${status}. Trading unlocked.`};
}
async function requireNoPendingOrder() {
  if(!(await pendingLock())) return;
  const result=await reconcile();
  if(!result.clear) throw new Error(`Earlier Binance order not resolved. ${result.message}`);
}
function journalHooks() {
  return {
    beforeOrder: async info => { await chrome.storage.local.set({tradeLock:info}); },
    resolved: async () => { await chrome.storage.local.remove('tradeLock'); },
    rejected: async (info,error) => { await chrome.storage.local.remove('tradeLock'); await record(`Binance rejected ${info.phase} order: ${error.message}`,'warning'); },
    uncertain: async (info,error) => { await chrome.storage.local.set({tradeLock:{...info,status:'needsReview',error:error.message}}); }
  };
}
async function execute(signal,s,source) {
  if(![1,2,3,4].includes(signal.action) || ACTIONS[signal.action]!==signal.actionName) throw new Error('Invalid signal.');
  if(s.execution==='observe') {
    await record(`${source}: ${signal.actionName} ${s.symbol} — observed, no order.`, 'signal');
    return {status:'Observed — no order placed.'};
  }
  if(tradeBusy) throw new Error('Another order request is still processing.');
  tradeBusy=true;
  try {
    await requireNoPendingOrder();
    const creds=await getCredentials(s.execution);
    const result=await BinanceFutures.trade(signal,s,creds,s.execution,journalHooks());
    await record(`${source}: ${result.status}`,'signal');
    return result;
  } catch(e) {
    const lock=await pendingLock();
    if(lock) {
      await stop();
      await record(`Order status uncertain — automation paused. ${e.message}`,'error');
    } else await record(`Trade not placed: ${e.message}`,'warning');
    throw e;
  } finally {tradeBusy=false;}
}
async function manualSignal(action) {
  const s=normalize((await chrome.storage.local.get('settings')).settings || DEFAULT_SETTINGS);
  const a=Number(action);
  if(![1,2,3,4].includes(a)) throw new Error('Invalid manual action.');
  return execute({action:a,actionName:ACTIONS[a],channel:s.channel,signalTimeSec:Math.floor(Date.now()/1000),nonce:crypto.randomUUID().replaceAll('-','').slice(0,8)},s,'MANUAL');
}
async function start(tabId) {
  const s=normalize((await chrome.storage.local.get('settings')).settings || DEFAULT_SETTINGS);
  const tab=await chrome.tabs.get(tabId);
  if(!tradingViewTab(tab)) throw new Error('Open TradingView in the active tab first.');
  if(s.execution!=='observe') {
    await getCredentials(s.execution);
    await requireNoPendingOrder();
  }
  const runId=crypto.randomUUID();
  await chrome.storage.local.set({monitor:{running:true,tabId,windowId:tab.windowId,runId,baselineSet:false,lastMarker:null}});
  await record(`Monitoring started: ${s.execution.toUpperCase()}, ${s.symbol}. Existing chart signal is ignored; waiting for a NEW signal.`);
  return {ok:true};
}
async function poll(tabId) {
  const {monitor,settings:rawSettings}=await chrome.storage.local.get(['monitor','settings']);
  if(!monitor?.running || monitor.tabId!==tabId || pollBusy || tradeBusy) return {skipped:'inactive'};
  pollBusy=true;
  const s=normalize(rawSettings || DEFAULT_SETTINGS);
  try {
    const tab=await chrome.tabs.get(tabId);
    if(!tradingViewTab(tab) || monitor.windowId!==tab.windowId) return {skipped:'tab-inactive'};
    const signal=VisualBridge.detectStripe(await screenshotPixels(tab.windowId));
    const {monitor:current}=await chrome.storage.local.get('monitor');
    if(!current?.running || current.runId!==monitor.runId) return {skipped:'stopped'};
    if(!signal) return {skipped:'no-color-strip'};
    await chrome.storage.local.set({latestSignal:signal});
    if(signal.channel!==s.channel || signal.symbolHash!==VisualBridge.symbolHash(s.symbol)) return {skipped:'symbol-or-channel-mismatch'};
    if(!current.baselineSet) {
      await chrome.storage.local.set({monitor:{...current,baselineSet:true,lastMarker:signal.marker}});
      await record(`Chart connected (${signal.actionName}). Waiting for a new confirmed signal.`,'signal');
      return {skipped:'baseline'};
    }
    if(signal.marker===current.lastMarker) return {skipped:'duplicate'};
    if(current.candidate!==signal.marker) {
      await chrome.storage.local.set({monitor:{...current,candidate:signal.marker}});
      return {skipped:'confirming'};
    }
    await chrome.storage.local.set({monitor:{...current,lastMarker:signal.marker,candidate:null}});
    const age=Date.now()-signal.signalTimeSec*1000;
    if(signal.action===0 || age>90000 || age< -10000) return {skipped:'none-or-stale'};
    if(signal.action>=5) {
      await record(`Visual test ${signal.actionName} detected. No Binance order.`, 'signal');
      return {test:true};
    }
    const result=await execute(signal,s,'CHART');
    return result;
  } catch(e) {
    await record(`Monitoring error: ${e.message}`,'error');
    if(s.execution==='live') await stop();
    return {error:e.message};
  } finally {pollBusy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply) => {
  (async()=>{
    switch(message.type) {
      case 'SAVE_SETTINGS': return saveSettings(message.settings);
      case 'SAVE_KEYS': return saveKeys(message.environment,message.apiKey,message.secret);
      case 'CLEAR_KEYS': await chrome.storage.session.remove(message.environment+'Credentials');await stop();return {ok:true};
      case 'TEST_CONNECTION': {
        const s=normalize(message.settings);
        if(s.execution==='observe') throw new Error('Choose Demo or Live to test Binance connection.');
        return BinanceFutures.testConnection(s,await getCredentials(s.execution),s.execution);
      }
      case 'SCAN': return scanTab(message.tabId,message.settings);
      case 'START': return start(message.tabId);
      case 'STOP': return stop();
      case 'POLL': return sender.tab?.id ? poll(sender.tab.id) : {skipped:'not-chart'};
      case 'MANUAL_SIGNAL': return manualSignal(message.action);
      case 'RECONCILE': return reconcile();
      case 'CLEAR_REVIEWED_LOCK': {
        if(message.confirmed!==true) throw new Error('Confirm Binance order history and positions were reviewed first.');
        const lock=await pendingLock();
        if(!lock) return {ok:true};
        await chrome.storage.local.remove('tradeLock');
        await record(`Previous ${lock.environment}/${lock.symbol} lock manually cleared after Binance review.`, 'warning');
        return {ok:true};
      }
      case 'GET_STATE': {
        const state=await chrome.storage.local.get(['settings','monitor','history','latestStatus','latestSignal','tradeLock','lastDiagnostic']);
        const session=await chrome.storage.session.get(['demoCredentials','liveCredentials']);
        return {...state,credentials:{demo:!!session.demoCredentials,live:!!session.liveCredentials}};
      }
      default:throw new Error('Unknown extension action.');
    }
  })().then(reply).catch(e => reply({error:e.message}));
  return true;
});
chrome.runtime.onInstalled.addListener(async()=>{
  await stop();await record('Extension updated. Configure settings, test connection and start monitoring.');
});
chrome.runtime.onStartup.addListener(async()=>{
  await stop();await record('Browser restarted. Click Start to resume monitoring.');
});
