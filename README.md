# TV Futures Bridge v0.4 — Chrome Extension + Supertrend Visual Adapter

A browser-only experiment that reads a 19-cell visual signal from a TradingView Pine Script (no TradingView paid alerts) and sends market orders through the Binance USDT-M Futures API.

**Important:** The browser/TradingView chart must remain open and visible for automatic signal capture. This is an experimental prototype, not a reliable unattended trading engine. It **does not** place protective stop-loss or take-profit orders. High leverage carries rapid-liquidation risk. Do not treat syntactic/mock test success as proof of real exchange execution.

## Files
- `pine/supertrend_visual_bridge.pine`: Standard Supertrend with visual bridge v3 encoding (works with extension v0.4)
- `pine/bridge_adapter_snippet.pine`: Reusable visual adapter for another existing Pine indicator/strategy
- `pine/ema_visual_bridge_example.pine`: Example mapping to different signals
- `extension/`: Chrome Manifest V3 extension (load this directory unpacked)
- `tests/`: Node-based simulated API/decoder/lock regression tests

## Install
1. Remove/disable older *TV Futures Bridge* extension copies in `chrome://extensions` to prevent confusion or duplicate monitors.
2. Extract the ZIP, enable **Developer mode** in `chrome://extensions`, click **Load unpacked**, and choose the **extension** directory (not the parent directory or ZIP).
3. In TradingView, replace any old visual-bridge indicator with `pine/supertrend_visual_bridge.pine`. Use the Pine Editor to add it to your chart.
4. Keep the TradingView tab active with the color strip visible in the top-right. Use a BINANCE USDT-M perpetual contract chart (e.g. XRPUSDT). If chart symbol differs from the API symbol, edit the Pine **Bridge symbol override** input.
5. In the extension, choose a mode (Observe, Demo, Live), symbol (XRPUSDT), position size (start with 10 USDT notional if exchange rules allow), and leverage (start with 2x).
6. **Demo/Live:** paste the matching environment's API key and secret; click **Save credentials & test connection**. A signed Binance test-order call validates trading permission but **does not place any real order**.
7. Click **Start automatic trading**. The first decoded signal is treated as a baseline; only a subsequent, newly confirmed Supertrend reversal is eligible to trade.
8. For a chart-only test, use **VISUAL TEST** input in the Pine indicator (`TEST_LONG` / `TEST_SHORT`). These special visual signals can be detected but can **never** submit orders.

## Manual orders and recovery
- **Buy / Long**, **Sell / Short** and the **Close position** controls work without having a TradingView tab open. In Observe, they only log a signal. In Demo/Live, they send the indicated action to Binance.
- The extension supports Binance **One-way Mode**. In Hedge Mode it explains why it cannot trade; it does not alter account-wide position mode. It follows your current Isolated/Cross margin setting, rather than forcing it.
- If a position exists in the same direction, the extension does not add more size. If the position is opposite, the extension sends a reduce-only close, checks the position is flat, and then opens the new direction.
- When opening a new position it requests the configured symbol leverage via `POST /fapi/v1/leverage`. The input allows 1–100x, but Binance's symbol-specific leverage brackets determine what is actually allowed.
- As of Binance’s April 2026 change, **BTCUSDT requires at least 50 USDT notional**, while **XRPUSDT has a smaller reported minimum**. The default is XRPUSDT with 10 USDT notional to make a small test more practical. Binance exchangeInfo remains the final authority for live minimums.
- Size means **target total exposure/notional**, *not margin*. E.g. 10 USDT size at 5x targets a 10 USDT position (~2 USDT initial margin + fees). The requested size is rounded DOWN to Binance lot size steps. Orders below exchange minimum are rejected; the extension never silently increases size.
- **Fix for v0.3 “Trading locked” bug:** API validation errors do not create an order lock. A journal is recorded **only immediately before an order submission**. Explicit Binance order rejection clears the journal. Network uncertainty or partially filled orders pause automation.
- When you try again, the extension attempts to reconcile any ambiguous order by its `newClientOrderId` using `GET /fapi/v1/order`, then checks current position data. The manual recovery panel appears only when necessary. For old v0.3 locks with no client-order ID, check Binance Orders and Positions first before manually clearing.
- Stopping the extension never closes an existing Binance position. The extension does not reconcile protective conditional/algo orders. Review Binance positions and standing orders before using it against an existing trading account.

## Credentials and browser limitations
- API keys are stored in `chrome.storage.session` and survive closing the popup, but not a complete browser restart. They are never stored in the Pine Script, bundled extension code, or ordinary `chrome.storage.local` settings.
- Set Binance API permissions to Futures trading only; keep withdrawal access disabled. Consider a dedicated API key/account with limited funds. The extension can still access sensitive trading credentials when unlocked.
- Auto-monitor depends on screenshot decoding, Chrome's ability to capture the active tab, and TradingView's chart layout. It will miss signals if the chart is hidden, Chrome goes to sleep, or the color strip is obscured. It should not be relied upon for unattended real-money trading.
- The first chart signal after Start is intentionally skipped to avoid replaying a historical signal. Only confirmed candle events with recent timestamps are eligible.
- Any visual test-code signal (`TEST_LONG`, `TEST_SHORT`, etc.) is blocked from trade execution even in Live mode.

## Troubleshooting
- **Trade rejected for size:** Test connection displays the rounded quantity and current settings. Use a symbol/size that meets Binance minimums.
- **Invalid leverage:** 100x is a UI ceiling, not guaranteed for all contracts/accounts. Reduce the value until Binance accepts it.
- **“Trading locked”:** In **Previous order needs checking**, click **Check Binance**. If Binance cannot confirm execution, review order history and positions before clearing it manually. Do not blindly clear a lock after a network timeout.
- **No color strip:** Expand **Chart diagnostics & activity**, click **Scan chart now**. Keep the top-right visual table fully visible and make symbol/channel match.
- **Missing keys:** Set the correct Demo vs Live keys. Keys stored in one environment cannot be used for the other.
- **No manual trade in Observe:** Observe intentionally logs actions without calling Binance. Choose Demo first.
- **Preview says connected but real trading fails:** The `/order/test` API call does not prove the account has enough margin for the intended live trade, nor that the browser can detect TradingView visual signals.

## Local test commands
```sh
node tests/decoder.test.js
node tests/binance-futures.test.js
node tests/background.test.js
```
Tests use synthetic image buffers and mocked Binance endpoints. No real Binance credentials or orders are used. Pine is not compiled against TradingView's online editor by these tests.
