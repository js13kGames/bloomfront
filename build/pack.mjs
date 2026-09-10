// Packs index.html into dist/bloomfront.zip, which is what gets submitted.
//
//   node build/pack.mjs [--tries=N] [--tiny[=name,name,...]]
//
// Nothing in build/ ships. This reads index.html, works on strings and writes to
// dist/, so the source is never touched and there's only one version of the game
// to look after.
//
// In order: wrap the script in an IIFE and minify it, minify the stylesheet,
// rebuild a bare HTML shell round the two, then run the script through Roadroller
// for a second candidate. Zip both, verify both, ship whichever is smaller.
//
// That last step can lose. Roadroller output is nearly incompressible, so if the
// script ever got small enough that plain DEFLATE won, packing would be making
// things worse. The build measures rather than assuming.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as esbuild from "esbuild";
import { Packer } from "roadroller";

// Zopfli emits a DEFLATE stream any unzip can read, taking far longer than zlib
// about it. Optional. Without it the build still works, just slightly fatter.
let zopfli = null;
try {
  zopfli = (await import("@gfx/zopfli")).default;
} catch (e) {
  console.log("zopfli not installed, falling back to zlib");
}

async function bestDeflate(data) {
  const plain = deflateRawSync(data, { level: 9 });
  if (!zopfli) return plain;
  const packed = await new Promise((resolve) => {
    zopfli.deflate(data, { numiterations: 200 }, (err, out) => resolve(err ? null : out));
  });
  return packed && packed.length < plain.length ? Buffer.from(packed) : plain;
}

const root = new URL("..", import.meta.url);
const src = readFileSync(new URL("index.html", root), "utf8");

// --- optional features ---------------------------------------------------------
//
// Regions of index.html can be fenced off, so features can be cut from the entry
// without forking the source into two copies that drift apart.
//
//   TINY-OFF <name>    opens a region the small build drops
//   TINY-END           closes it
//   TINY-ON <name>: c  a comment in the full build that becomes the code c in the
//                      small one, for stubbing whatever the region provided
//
// Marker lines never reach either artifact. Regions don't nest, and an unbalanced
// or unknown name stops the build instead of quietly shipping the wrong amount of
// game.

function fail(message) {
  console.error("pack: " + message);
  process.exit(1);
}

const OFF_RE = /TINY-OFF\s+([a-z0-9-]+)/;
const END_RE = /TINY-END/;
const ON_RE = /TINY-ON\s+([a-z0-9-]+)\s*:(.*)$/;

function applyFences(text, shouldCut) {
  const out = [];
  const names = new Set();
  let open = null;
  let line = 0;
  for (const text_line of text.split("\n")) {
    line++;
    const off = text_line.match(OFF_RE);
    if (off) {
      if (open) fail(`line ${line}: TINY-OFF ${off[1]} inside ${open}, regions do not nest`);
      open = off[1];
      names.add(open);
      continue;
    }
    if (END_RE.test(text_line)) {
      if (!open) fail(`line ${line}: TINY-END with no TINY-OFF open`);
      open = null;
      continue;
    }
    if (open) {
      if (!shouldCut(open)) out.push(text_line);
      continue;
    }
    const on = text_line.match(ON_RE);
    if (on) {
      names.add(on[1]);
      out.push(shouldCut(on[1]) ? on[2].replace(/\s*(\*\/|-->)\s*$/, "") : text_line);
      continue;
    }
    out.push(text_line);
  }
  if (open) fail(`unclosed TINY-OFF ${open}`);
  return { text: out.join("\n"), names };
}

const tinyArg = process.argv.find((a) => a === "--tiny" || a.startsWith("--tiny="));
const tiny = Boolean(tinyArg);
const only = tinyArg && tinyArg.includes("=")
  ? tinyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean)
  : null;

const fenced = applyFences(src, (name) => tiny && (!only || only.includes(name)));
const source = fenced.text;

for (const name of only || []) {
  if (!fenced.names.has(name)) {
    fail(`--tiny=${name}: no region is fenced under that name` +
      `\n  fenced regions: ${[...fenced.names].sort().join(", ") || "none"}`);
  }
}
const cutNames = [...fenced.names].filter((n) => tiny && (!only || only.includes(n))).sort();
if (tiny && !cutNames.length) console.log("--tiny: no fenced regions matched, this is the full game");

// --- pull the source apart ---------------------------------------------------

// Crude, and fine. The document is one file with a shape we control, so an HTML
// parser would be a dependency bought for nothing. The throw matters more than
// the parsing: reshape index.html and the build stops instead of packing an empty
// string.
function between(text, open, close) {
  const a = text.indexOf(open);
  const b = text.indexOf(close, a + open.length);
  if (a < 0 || b < 0) throw new Error("could not find " + open);
  return text.slice(a + open.length, b);
}

const css = between(source, "<style>", "</style>");
const js = between(source, '<script type="module">', "</script>");
const body = between(source, "<canvas", '<script type="module">');

// --- JavaScript --------------------------------------------------------------

// esbuild won't rename top-level bindings in transform mode, since in a module
// they might be exported and in a classic script something else on the page might
// read them. Wrapping the lot in an arrow function makes every binding local and
// esbuild will happily rename them all to one or two characters. Worth several
// kilobytes.
//
// Only safe because the script has no imports, no exports and no top-level await.
// It does have top-level side effects, which run the same inside the wrapper.
const wrapped = "(()=>{" + js + "})()";

// Property names the game owns and nothing else touches. esbuild renames these
// everywhere, which pays because the entity loops hit them on every object every
// frame.
//
// A list rather than a pattern, for one reason: a pattern that catches something
// the browser owns, .value or .width, gives you a game that's broken with no error
// anywhere. Whatever actually gets renamed lands in dist/mangle-cache.json so the
// list can be checked against reality.
const OWN_PROPS = [
  // Entities.
  "herd", "hp", "dir", "phase", "gx", "gy", "field", "sel", "foe", "cool",
  "hurt", "wave",
  // Sprite assembly.
  "depth", "col", "sa", "sb",
  // Palettes and tables.
  "coat", "leg", "muzzle", "mane", "horn", "barding", "hoof", "eye", "ink",
  "glow", "glowHot", "dead", "live", "tint", "rgb", "name", "cap",
  // Left out on purpose: type clashes with OscillatorNode and BiquadFilter, and
  // value, gain and frequency with AudioParam. x, y and z are already one
  // character, and Roadroller models the repetition better than renaming them
  // would.
];
const jsResult = await esbuild.transform(wrapped, {
  minify: true,
  target: "es2022",
  format: "iife",
  legalComments: "none",
  ...(OWN_PROPS.length
    ? { mangleProps: new RegExp("^(" + OWN_PROPS.join("|") + ")$"), mangleCache: {} }
    : {}),
});
const jsMin = jsResult.code.trim();
const mangleCache = jsResult.mangleCache || {};

for (const name of Object.keys(mangleCache)) {
  if (!OWN_PROPS.includes(name)) throw new Error("mangled an unlisted property: " + name);
}

const cssMin = (await esbuild.transform(css, { loader: "css", minify: true })).code.trim();

// --- HTML --------------------------------------------------------------------

// Rebuilt rather than minified. html, head and body are all optional in HTML5 and
// the browser infers them, so the shell is a doctype, a title, the stylesheet, the
// elements and the script.
function minifyBody(markup) {
  return ("<canvas" + markup)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*/g, "")
    .replace(/(\w+)="([\w-]+)"/g, "$1=$2")
    .trim();
}

const bodyMin = minifyBody(body);

// charset is only needed by the Roadroller build, whose output runs outside ASCII.
// With no declared encoding a browser can decode it differently from how it was
// written, which corrupts the packed string and leaves you with a decoder emitting
// nonsense. The plain build is all ASCII and survives whatever a browser guesses.
function shell(script, charset) {
  return "<!doctype html>" + (charset ? '<meta charset="utf-8">' : "") +
    "<title>bloomfront</title><style>" + cssMin + "</style>" + bodyMin +
    "<script>" + script + "</script>";
}

// The body tag is not optional here, whatever the spec says. Without it the script
// runs while document.body is still null, since the parser only creates one when
// it reaches content, and the game dies on the first getElementById. Six bytes for
// somewhere to put the markup.
function bareShell(script) {
  return "<!doctype html><meta charset=\"utf-8\"><title>bloomfront</title><body><script>" +
    script + "</script>";
}

const plain = shell(jsMin, false);

// The packed build moves the stylesheet and markup inside the script and injects
// them at startup. Roadroller only compresses what it's handed, and it's handed
// the script, so anything left in the document is bytes that only DEFLATE ever
// sees. DEFLATE is much worse at them than context mixing.
const injected = "document.head.insertAdjacentHTML('beforeend'," +
  JSON.stringify("<style>" + cssMin + "</style>") + ");" +
  "document.body.innerHTML=" + JSON.stringify(bodyMin) + ";" + jsMin;

// --- Roadroller ---------------------------------------------------------------

// Roadroller is a context mixing compressor for JavaScript. Several models each
// predict the next character from a different length of preceding context, a
// logistic mixer blends them with weights that adapt as it goes, and the result
// gets arithmetic coded. It beats DEFLATE on minified JS by a mile, because
// DEFLATE only matches repeated byte runs inside a 32 KB window and knows nothing
// about the structure of code.
//
// Its optimiser searches randomly and lands a few bytes apart run to run, so take
// the best of several. About ten seconds each, hence --tries for iterating.
const triesArg = process.argv.find((a) => a.startsWith("--tries="));
const tries = triesArg ? Math.max(1, parseInt(triesArg.slice(8), 10)) : 3;

let packed = null;
for (let i = 0; i < tries; i++) {
  try {
    const packer = new Packer([{ data: injected, type: "js", action: "eval" }], {});
    await packer.optimize(2);
    const { firstLine, secondLine } = packer.makeDecoder();
    const candidate = bareShell(firstLine + secondLine);
    if (!packed || candidate.length < packed.length) packed = candidate;
  } catch (e) {
    console.log("roadroller pass failed: " + e.message);
  }
}
if (!packed) console.log("roadroller unavailable, shipping plain minification");

// --- zip ----------------------------------------------------------------------

// CRC-32, reversed polynomial 0xEDB88320, as the zip format wants. Table built
// once at load.
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Written by hand instead of shelling out to zip, which adds extra fields,
// timestamps and platform metadata that this doesn't. Worth about nine bytes on
// identical compressed data. Small, but the project is scored in bytes and this is
// forty lines.
async function makeZip(name, contents) {
  const data = Buffer.from(contents, "utf8");
  const body = await bestDeflate(data);
  const nameBuf = Buffer.from(name, "ascii");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);    // signature "PK\3\4"
  local.writeUInt16LE(20, 4);            // version needed to extract, 2.0
  local.writeUInt16LE(0, 6);             // general purpose flags, none set
  local.writeUInt16LE(8, 8);             // compression method, 8 is deflate
  local.writeUInt32LE(0, 10);            // modification time and date, zeroed
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);  // compressed size
  local.writeUInt32LE(data.length, 22);  // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);  // signature "PK\1\2"
  central.writeUInt16LE(20, 4);          // version made by
  central.writeUInt16LE(20, 6);          // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);          // offset of the local header, first file

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // signature "PK\5\6"
  end.writeUInt16LE(1, 8);               // entries on this disk
  end.writeUInt16LE(1, 10);              // entries total
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(local.length + nameBuf.length + body.length, 16);

  return Buffer.concat([local, nameBuf, body, central, nameBuf, end]);
}

// The zip is the deliverable, and a malformed one is worse than a fat one because
// it breaks for whoever opens it rather than here. Read it back through its own
// headers, inflate, compare against what went in.
function verifyZip(zip, expected) {
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error("zip: bad local header");
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  const comp = zip.readUInt32LE(18);
  const start = 30 + nameLen + extraLen;
  const round = inflateRawSync(zip.subarray(start, start + comp)).toString("utf8");
  if (round !== expected) throw new Error("zip: contents do not round trip");
  if (zip.readUInt32LE(14) !== crc32(Buffer.from(expected, "utf8"))) {
    throw new Error("zip: crc mismatch");
  }
  if (zip.readUInt32LE(zip.length - 22) !== 0x06054b50) throw new Error("zip: bad end record");
}

// --- pick the winner and write it out ------------------------------------------

const candidates = [{ label: "minified", html: plain }];
if (packed) candidates.push({ label: "roadrolled", html: packed });
for (const c of candidates) {
  c.zip = await makeZip("index.html", c.html);
  verifyZip(c.zip, c.html);
}

const best = candidates.reduce((a, b) => (b.zip.length < a.zip.length ? b : a));

const tag = tiny ? "13" : "";

mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL(`dist/index${tag}.html`, root), best.html);
// Keep the unpacked build around. A Roadroller artifact is unreadable when
// something goes wrong in the browser; this one can at least be grepped.
writeFileSync(new URL(`dist/index${tag}.min.html`, root), plain);
writeFileSync(new URL(`dist/bloomfront${tag}.zip`, root), best.zip);
writeFileSync(new URL(`dist/mangle-cache${tag}.json`, root), JSON.stringify(mangleCache, null, 2));

const pad = (s, n) => String(s).padStart(n);
console.log("css      " + pad(css.length, 7) + " -> " + pad(cssMin.length, 7) + " B");
console.log("markup   " + pad(body.length, 7) + " -> " + pad(bodyMin.length, 7) + " B");
console.log("script   " + pad(js.length, 7) + " -> " + pad(jsMin.length, 7) + " B");
console.log("source   " + pad(src.length, 7) + " B" +
  (tiny && source.length !== src.length ? "  -> " + pad(source.length, 7) + " B fenced" : ""));
if (cutNames.length) console.log("dropped  " + cutNames.join(" "));
console.log("");
for (const c of candidates) {
  console.log(pad(c.label, 10) + "  html " + pad(c.html.length, 6) +
    " B   zip " + pad(c.zip.length, 6) + " B" + (c === best ? "   <- shipped" : ""));
}
const LIMIT = 13312;
console.log(`\ndist/bloomfront${tag}.zip  ` + best.zip.length + " B   " +
  (best.zip.length / LIMIT * 100).toFixed(1) + "% of the 13 KB limit   " +
  (LIMIT - best.zip.length) + " B of headroom");
