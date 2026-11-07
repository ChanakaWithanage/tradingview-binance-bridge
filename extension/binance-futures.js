// Binance USD-M Futures API client. Browser only. No embedded API credentials.
// The notional amount is fixed independently of the leverage selection.
globalThis.BinanceFutures = (() => {
  const BASES = Object.freeze({ demo: 'https://demo-fapi.binance.com', live: 'https://fapi.binance.com' });
  const ACTIONS = ['NONE', 'OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT'];
  const encoder = new TextEncoder();

  class ApiError extends Error {
    constructor(message, { status = 0, code = null, network = false } = {}) {
      super(message); this.name = 'BinanceApiError'; this.status = status; this.code = code; this.network = network;
    }
  }
  async function request(environment, method, path, params = {}, credentials = null) {
    const base = BASES[environment];
    if (!base) throw new Error('Choose Demo or Live first.');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    const headers = {};
    if (credentials) {
      if (!credentials.apiKey || !credentials.secret) throw new Error('Missing Binance API credentials.');
      query.set('recvWindow', '5000');
      query.set('timestamp', String(Date.now()));
      const key = await crypto.subtle.importKey('raw', encoder.encode(credentials.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(query.toString()));
      query.set('signature', Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join(''));
      headers['X-MBX-APIKEY'] = credentials.apiKey;
    }
    const options = { method, headers, cache: 'no-store' };
    let url = base + path;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = query.toString();
    } else if (query.size) url += '?' + query.toString();
    let response;
    try { response = await fetch(url, options); }
    catch { throw new ApiError('Network request failed. Binance execution status may be unknown.', { network: true }); }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(`Unreadable Binance response (HTTP ${response.status}).`, { status: response.status }); }
    if (!response.ok) {
      const msg = String(data?.msg || 'Request rejected').slice(0, 250);
      throw new ApiError(`Binance ${data?.code ?? response.status}: ${msg}`, { status: response.status, code: Number(data?.code) || null });
    }
    return data;
  }
  function validateSettings(s) {
    if (!/^[A-Z0-9]{5,20}$/.test(s.symbol)) throw new Error('Enter a Binance USDT-M Futures symbol such as BTCUSDT.');
    if (!Number.isFinite(s.size) || s.size <= 0 || s.size > 1000000) throw new Error('Position size must be greater than 0 USDT.');
    if (!Number.isInteger(s.leverage) || s.leverage < 1 || s.leverage > 100) throw new Error('Leverage must be 1–100x.');
  }
  function precision(step) {
    const s = String(step);
    if (!s.includes('.')) return 0;
    return s.split('.')[1].replace(/0+$/, '').length;
  }
  function quantityDown(value, filter) {
    const step = Number(filter?.stepSize);
    if (!(step > 0) || !Number.isFinite(value) || value < 0) throw new Error('Invalid Binance quantity step.');
    return (Math.floor(value / step + 1e-9) * step).toFixed(precision(filter.stepSize));
  }
  function assertQuantity(value, filter) {
    const qty = Number(value);
    if (!(qty > 0) || qty + 1e-10 < Number(filter.minQty) || (Number(filter.maxQty) > 0 && qty > Number(filter.maxQty))) {
      throw new Error(`Trade size too small or large for this symbol (minimum quantity ${filter.minQty}). Try a different symbol or size.`);
    }
  }
  async function position(environment, symbol, credentials) {
    const rows = await request(environment, 'GET', '/fapi/v3/positionRisk', { symbol }, credentials);
    if (!Array.isArray(rows)) throw new Error('Unexpected Binance position response.');
    if (rows.some(p => p.symbol === symbol && p.positionSide !== 'BOTH')) throw new Error('Hedge Mode is not supported in this version; set Binance to One-way Mode.');
    const p = rows.find(p => p.symbol === symbol && p.positionSide === 'BOTH');
    const amount = p ? Number(p.positionAmt) : 0;
    if (!Number.isFinite(amount)) throw new Error('Invalid position quantity returned by Binance.');
    return amount;
  }
  async function context(settings, credentials, environment) {
    validateSettings(settings);
    const mode = await request(environment, 'GET', '/fapi/v1/positionSide/dual', {}, credentials);
    if (String(mode.dualSidePosition) !== 'false') throw new Error('Binance Hedge Mode is enabled. This extension currently supports One-way Mode only.');
    const cfgData = await request(environment, 'GET', '/fapi/v1/symbolConfig', { symbol: settings.symbol }, credentials);
    const cfg = (Array.isArray(cfgData) ? cfgData : [cfgData]).find(v => v?.symbol === settings.symbol);
    if (!cfg) throw new Error('Could not read Binance Futures symbol settings.');
    const exchange = await request(environment, 'GET', '/fapi/v1/exchangeInfo');
    const info = exchange.symbols?.find(s => s.symbol === settings.symbol);
    if (!info || info.status !== 'TRADING' || info.quoteAsset !== 'USDT') throw new Error('Symbol is not an active USDT-M Futures market.');
    const f = info.filters?.find(v => v.filterType === 'MARKET_LOT_SIZE' && Number(v.stepSize) > 0) || info.filters?.find(v => v.filterType === 'LOT_SIZE');
    if (!f || !(Number(f.stepSize) > 0)) throw new Error('Binance has not provided a usable order quantity step.');
    const ticker = await request(environment, 'GET', '/fapi/v1/ticker/price', { symbol: settings.symbol });
    const price = Number(ticker.price);
    if (!(price > 0)) throw new Error('Invalid market price.');
    const minRule = info.filters?.find(v => v.filterType === 'MIN_NOTIONAL');
    const minNotional = Number(minRule?.notional ?? minRule?.minNotional ?? 0);
    const qty = quantityDown(settings.size / price, f);
    const notional = Number(qty) * price;
    return { cfg, filter:f, qty, notional, price, minNotional, amount:await position(environment,settings.symbol,credentials) };
  }
  async function testConnection(settings, credentials, environment) {
    const ctx = await context(settings,credentials,environment);
    const sizeValid = Number(ctx.qty) >= Number(ctx.filter.minQty) && ctx.notional+1e-8 >= ctx.minNotional;
    // Binance test-order endpoint validates trade API authorization WITHOUT sending
    // a real order to the matching engine. Only try it with a valid market lot size.
    if (sizeValid) {
      await request(environment,'POST','/fapi/v1/order/test',{
        symbol:settings.symbol, side:'BUY',type:'MARKET',positionSide:'BOTH',quantity:ctx.qty
      }, credentials);
    }
    return { environment, symbol:settings.symbol, currentLeverage:Number(ctx.cfg.leverage), marginType:ctx.cfg.marginType,
      requestedLeverage:settings.leverage, price:ctx.price, quantity:ctx.qty, tradePermissionTested:sizeValid,
      estimatedNotional:ctx.notional, minNotional:ctx.minNotional, positionAmount:ctx.amount, sizeValid };
  }
  async function configureLeverage(settings,credentials,environment,cfg) {
    if (Number(cfg.leverage) === settings.leverage) return;
    const data = await request(environment,'POST','/fapi/v1/leverage',{symbol:settings.symbol,leverage:settings.leverage},credentials);
    if (Number(data.leverage) !== settings.leverage) throw new Error('Binance did not confirm requested leverage.');
  }
  function clientId(signal, leg) {
    const rand = String(signal.nonce || '').replace(/[^a-zA-Z0-9]/g,'').slice(0,8);
    return `TVB${signal.signalTimeSec}_${signal.channel}_${signal.action}_${rand}_${leg}`.slice(0,36);
  }
  async function getOrder(environment, credentials, symbol, id) {
    return request(environment,'GET','/fapi/v1/order',{symbol,origClientOrderId:id},credentials);
  }
  // The hook MUST persist a journal before any order request is sent.
  async function submit(environment, credentials, settings, signal, leg, side, quantity, reduceOnly, hooks) {
    const id = clientId(signal,leg);
    const record = { clientOrderId:id, environment, symbol:settings.symbol, action:signal.actionName,
      side, quantity:String(quantity), reduceOnly, phase:leg, at:Date.now(), status:'submitting' };
    await hooks.beforeOrder(record);
    let result;
    try {
      result = await request(environment,'POST','/fapi/v1/order',{
        symbol:settings.symbol, side, type:'MARKET', positionSide:'BOTH', quantity,
        ...(reduceOnly ? {reduceOnly:'true'} : {}), newOrderRespType:'RESULT',newClientOrderId:id
      },credentials);
    } catch (error) {
      // Explicit rejected request is different from a timeout/unknown execution.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![-1006,-1007].includes(error.code)) {
        await hooks.rejected(record,error);
      } else await hooks.uncertain(record,error);
      throw error;
    }
    if (result.status !== 'FILLED') {
      const error = new Error(`Order ${id} reported ${result.status || 'unknown'}; check Binance order status.`);
      await hooks.uncertain(record,error);
      throw error;
    }
    await hooks.resolved(record,result);
    return result;
  }
  async function trade(signal,settings,credentials,environment,hooks) {
    if (!hooks || ['beforeOrder','resolved','rejected','uncertain'].some(k => typeof hooks[k] !== 'function')) throw new Error('Order journal missing.');
    if (!([1,2,3,4].includes(signal.action)) || ACTIONS[signal.action] !== signal.actionName) throw new Error('Invalid trading signal.');
    const ctx = await context(settings,credentials,environment);
    const sign = signal.action === 1 ? 1 : signal.action === 2 ? -1 : 0;
    const closeSign = signal.action === 3 ? 1 : signal.action === 4 ? -1 : 0;
    const close = async (amount) => {
      const qty = quantityDown(Math.abs(amount),ctx.filter);
      if (Math.abs(Number(qty)-Math.abs(amount))>1e-8) throw new Error('Existing position quantity does not match market step.');
      assertQuantity(qty,ctx.filter);
      return submit(environment,credentials,settings,signal,'C',amount>0?'SELL':'BUY',qty,true,hooks);
    };
    if (closeSign) {
      if (ctx.amount * closeSign <= 0) return {status:`No matching ${signal.actionName} position to close.`};
      const order=await close(ctx.amount);
      return {status:`Closed position with Binance order ${order.orderId}.`};
    }
    if (ctx.amount * sign > 0) return {status:'Position already open in this direction; no extra order.'};
    assertQuantity(ctx.qty,ctx.filter);
    if (ctx.notional + 1e-8 < ctx.minNotional) throw new Error(`Position is ${ctx.notional.toFixed(2)} USDT; Binance minimum is ${ctx.minNotional} USDT. Increase size yourself if desired.`);
    // Verify Binance accepts the selected leverage BEFORE closing an opposite
    // position. The requested 100x may not be available for a given contract.
    await configureLeverage(settings,credentials,environment,ctx.cfg);
    if (ctx.amount !== 0) {
      await close(ctx.amount);
      if (Math.abs(await position(environment,settings.symbol,credentials))>1e-9) throw new Error('Opposite position not confirmed flat; no new entry.');
    }
    if (Math.abs(await position(environment,settings.symbol,credentials))>1e-9) throw new Error('Position changed before entry; no order placed.');
    const order=await submit(environment,credentials,settings,signal,'O',sign>0?'BUY':'SELL',ctx.qty,false,hooks);
    return {status:`${signal.actionName} filled. ${ctx.qty} ${settings.symbol}, approximately ${ctx.notional.toFixed(2)} USDT at ${settings.leverage}x (order ${order.orderId}).`};
  }
  return { request, trade, getOrder, testConnection, quantityDown, validateSettings, ApiError, BASES };
})();
