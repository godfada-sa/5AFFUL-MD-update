const fs = require('fs');
const src = fs.readFileSync('lib/smd.js', 'utf8');
const start = src.indexOf('const _0x51f62d=[');
const end = src.indexOf('];', start);
const arr = eval('[' + src.slice(start + 'const _0x51f62d=['.length, end) + ']');
const dec = (h) => arr[parseInt(h) - 0x112];

(function (_0xc219dc, _0x27fde2) {
  const _0x136a13 = dec, _0x18a03c = _0xc219dc();
  while (true) {
    try {
      const _0x3d1f30 = -parseInt(_0x136a13(0x283)) / 0x1 + parseInt(_0x136a13(0x1ca)) / 0x2 +
        parseInt(_0x136a13(0x217)) / 0x3 * (parseInt(_0x136a13(0x24f)) / 0x4) +
        -parseInt(_0x136a13(0x296)) / 0x5 + -parseInt(_0x136a13(0x159)) / 0x6 *
        (parseInt(_0x136a13(0x1c5)) / 0x7) + parseInt(_0x136a13(0x226)) / 0x8 +
        -parseInt(_0x136a13(0x243)) / 0x9;
      if (_0x3d1f30 === _0x27fde2) break;
      else _0x18a03c.push(_0x18a03c.shift());
    } catch (_0x5da36a) {
      _0x18a03c.push(_0x18a03c.shift());
    }
  }
})(() => arr, 0xee349);

// Dump every decoded string with its hex index
for (let i = 0x112; i < 0x112 + arr.length; i++) {
  const v = dec(i);
  if (typeof v === 'string' && /listen|localhost|server|port|http/i.test(v)) {
    console.log(i.toString(16), JSON.stringify(v));
  }
}
