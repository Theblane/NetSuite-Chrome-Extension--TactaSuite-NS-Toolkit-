/**
 * TactaSuite NS Toolkit - Chrome Web Store package builder
 *
 * @author Blane Maher
 *
 * Builds tactasuite-ns-toolkit-<version>.zip at the repo root containing only
 * the runtime files (manifest at the zip root). No third-party zip tool is
 * needed: the archive is written by hand (deflate, forward-slash entries),
 * because Git Bash on Windows has no `zip` binary.
 *
 *   node scripts/build-zip.cjs            (or: npm run build:zip)
 *
 * Excluded on purpose: tests, docs, companion (distributed as a release
 * asset), node_modules, playwright output, store-assets, markdown files,
 * package*.json, this scripts folder, and any *.pem / *.zip.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OUT = path.join(ROOT, 'tactasuite-ns-toolkit-' + manifest.version + '.zip');

// Everything the extension needs at runtime. Keep in sync with manifest.json.
const INCLUDES = ['manifest.json', 'background', 'content', 'shared', 'popup', 'options', 'onboarding', 'icons'];
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIP_EXT = new Set(['.map', '.pem', '.zip', '.md', '.log', '.bak', '.tmp']);

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const files = [];
function walk(abs, rel) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs)) {
      if (SKIP_NAMES.has(e)) continue;
      walk(path.join(abs, e), rel ? rel + '/' + e : e);
    }
    return;
  }
  if (SKIP_NAMES.has(path.basename(abs)) || SKIP_EXT.has(path.extname(abs).toLowerCase())) return;
  files.push({ abs, name: rel.split(path.sep).join('/') });
}
for (const inc of INCLUDES) {
  const abs = path.join(ROOT, inc);
  if (!fs.existsSync(abs)) { console.error('missing include: ' + inc); process.exit(1); }
  walk(abs, inc);
}
files.sort((a, b) => (a.name < b.name ? -1 : 1));

// Fixed timestamp (2026-01-01 00:00) so rebuilding identical sources gives an identical zip.
const DOSDATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOSTIME = 0;
const locals = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const crc = crc32(data);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(f.name, 'utf8');

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOSTIME, 10); lh.writeUInt16LE(DOSDATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, nameBuf, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(DOSTIME, 12); ch.writeUInt16LE(DOSDATE, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + comp.length;
}
const cdStart = offset;
let cdSize = 0;
for (const b of central) cdSize += b.length;
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);

fs.writeFileSync(OUT, Buffer.concat([...locals, ...central, eocd]));
console.log(path.basename(OUT) + ': ' + files.length + ' files, ' + fs.statSync(OUT).size + ' bytes');
if (process.argv.includes('--list')) for (const f of files) console.log('  ' + f.name);
