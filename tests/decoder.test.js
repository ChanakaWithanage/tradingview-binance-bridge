const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '../extension/decoder.js'), 'utf8');
const scope = {};
vm.runInNewContext(src, scope);
const bridge = scope.VisualBridge;
const colors = bridge.palette;
function build(action = 1, timestamp = 1794048000, channel = 7, tamper = false, x = 650, y = 24, cell = 22) {
  const width = 1400, height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 17; data[i + 1] = 25; data[i + 2] = 34; data[i + 3] = 255;
  }
  const ts = [];
  for (let i = 7; i >= 0; i--) ts.push(Math.floor(timestamp / (16 ** i)) % 16);
  const h = bridge.symbolHash('BTCUSDT');
  const hs = [3,2,1,0].map(i=>Math.floor(h/(16**i))%16);
  const payload = [3, action, ...ts, Math.floor(channel / 16), channel % 16, ...hs];
  let crc = payload.reduce((a, b) => a + b, 0) % 16;
  if (tamper) crc = (crc + 1) % 16;
  const cols = [[255, 0, 255], [0, 255, 255], ...payload.map(n => colors[n]), colors[crc]];
  for (let c = 0; c < cols.length; c++) {
    for (let yy = y; yy < y + 22; yy++) for (let xx = x + c * cell; xx < x + (c + 1) * cell; xx++) {
      const at = (yy * width + xx) * 4;
      data[at] = cols[c][0]; data[at + 1] = cols[c][1]; data[at + 2] = cols[c][2];
    }
  }
  return { width, height, data };
}
const good = bridge.detectStripe(build());
assert.ok(good, 'should decode an image with a valid bridge');
assert.equal(good.actionName, 'OPEN_LONG');
assert.equal(good.channel, 7);
assert.equal(good.symbolHash, bridge.symbolHash('BTCUSDT'));
assert.notEqual(good.symbolHash, bridge.symbolHash('ETHUSDT'));
assert.equal(good.signalTimeSec, 1794048000);
const short = bridge.detectStripe(build(2, 1794048060, 212));
assert.equal(short.actionName, 'OPEN_SHORT');
assert.equal(short.channel, 212);
assert.equal(bridge.detectStripe(build(3, 1794048120, 7)).actionName,'CLOSE_LONG');
assert.equal(bridge.detectStripe(build(4, 1794048180, 7)).actionName,'CLOSE_SHORT');
assert.equal(bridge.detectStripe(build(5, 1794048300, 7)).actionName,'TEST_LONG');
assert.equal(bridge.detectStripe(build(6, 1794048360, 7)).actionName,'TEST_SHORT');
assert.equal(bridge.detectStripe(build(7, 1794048420, 7)).actionName,'TEST_CLOSE_LONG');
assert.equal(bridge.detectStripe(build(8, 1794048480, 7)).actionName,'TEST_CLOSE_SHORT');
assert.equal(bridge.detectStripe(build(1, 1794048000, 7, true)), null, 'checksum corruption should reject');
console.log('Decoder v3 tests passed: OPEN/CLOSE, safe TEST actions, channel 212, corrupted checksum.');
