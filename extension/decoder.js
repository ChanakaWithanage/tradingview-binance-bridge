// Pure pixel decoder. No DOM inspection and no OCR.
// Must match the 19-cell Pine protocol v3 exactly.
(() => {
  const palette = [
    '#1A1A1A', '#E53935', '#43A047', '#1E88E5',
    '#FDD835', '#8E24AA', '#FB8C00', '#00ACC1',
    '#D81B60', '#7CB342', '#3949AB', '#6D4C41',
    '#90A4AE', '#C0CA33', '#5E35B1', '#F4511E'
  ].map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
  const START = [255, 0, 255];
  const NEXT = [0, 255, 255];
  const N = 19;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function symbolHash(symbol) {
    const text = String(symbol).toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(text)) throw new Error('Invalid Binance symbol.');
    let hash = 0;
    for (const ch of text) hash = (hash * 17 + ALPHABET.indexOf(ch) + 1) % 65536;
    return hash;
  }

  function rgb(image, x, y) {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    const idx = (y * image.width + x) * 4;
    return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
  }
  function matches(v, c, tolerance = 16) {
    return v && Math.abs(v[0] - c[0]) <= tolerance &&
      Math.abs(v[1] - c[1]) <= tolerance && Math.abs(v[2] - c[2]) <= tolerance;
  }
  function nibble(v) {
    if (!v) return -1;
    let best = Infinity;
    let at = -1;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const d = (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2 + (v[2] - c[2]) ** 2;
      if (d < best) { best = d; at = i; }
    }
    return best <= 32 ** 2 ? at : -1;
  }
  function parseCells(image, x, y, cellWidth) {
    if (x + N * cellWidth >= image.width + cellWidth) return null;
    if (!matches(rgb(image, Math.round(x + cellWidth * 0.5), y), START)) return null;
    if (!matches(rgb(image, Math.round(x + cellWidth * 1.5), y), NEXT)) return null;
    const values = [];
    for (let col = 2; col < N; col++) {
      const center = Math.round(x + cellWidth * (col + 0.5));
      const n = nibble(rgb(image, center, y));
      if (n < 0) return null;
      values.push(n);
    }
    const version = values[0], action = values[1];
    if (version !== 3 || action > 8) return null;
    let signalTimeSec = 0;
    for (let i = 2; i < 10; i++) signalTimeSec = signalTimeSec * 16 + values[i];
    const channel = values[10] * 16 + values[11];
    let symbolHashValue = 0;
    for (let i = 12; i < 16; i++) symbolHashValue = symbolHashValue * 16 + values[i];
    let checksum = 0;
    for (let i = 0; i < 16; i++) checksum = (checksum + values[i]) % 16;
    if (checksum !== values[16]) return null;
    // Guard against arbitrary patches of matching colors on a non-bridge chart.
    if ((action === 0 && signalTimeSec !== 0) || signalTimeSec > 0xffffffff) return null;
    return {
      version, action, actionName: ['NONE', 'OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'TEST_LONG', 'TEST_SHORT', 'TEST_CLOSE_LONG', 'TEST_CLOSE_SHORT'][action],
      signalTimeSec, channel, symbolHash: symbolHashValue,
      marker: `${channel}-${symbolHashValue}-${signalTimeSec}-${action}`,
      location: { x, y, cellWidth }
    };
  }

  // Find MAGENTA+Cyan adjacent solid-cell anchors, then sample 17 payload cells.
  // The strip must be fully visible, unobstructed, and reasonably wide.
  function detectStripe(image) {
    const maxY = Math.floor(image.height * 0.7);
    for (let y = 6; y < maxY; y += 3) {
      for (let x = 2; x < image.width - 100; x += 2) {
        if (!matches(rgb(image, x, y), START)) continue;
        let left = x, right = x;
        while (left > 0 && matches(rgb(image, left - 1, y), START)) left--;
        while (right + 1 < image.width && matches(rgb(image, right + 1, y), START)) right++;
        const width = right - left + 1;
        x = right;
        if (width < 9 || width > 140) continue;
        if (!matches(rgb(image, Math.round(left + width * 1.5), y), NEXT)) continue;
        // Two scan lines to avoid decoding arbitrary colored chart artifacts.
        const candidate = parseCells(image, left, y, width);
        if (!candidate) continue;
        const lowerY = Math.min(image.height - 1, y + 4);
        if (parseCells(image, left, lowerY, width)) return candidate;
      }
    }
    return null;
  }
  globalThis.VisualBridge = { detectStripe, parseCells, palette, rgb, symbolHash };
})();
