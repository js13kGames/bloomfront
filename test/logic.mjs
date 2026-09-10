// Headless checks for bloomfront.
//
//   node test/logic.mjs
//
// Reads index.html, pulls the real script out and runs it against stubbed browser
// objects. No game code is duplicated here, so these can't drift from the game.
//
// The useful bit is the requestAnimationFrame stub. It grabs the callback rather
// than scheduling it, so tests drive the real frame loop a tick at a time at
// whatever timestep they want. Economy, production, movement and combat all go
// through the same path the browser uses, and ninety seconds of game time takes
// milliseconds.
//
// Which exists because a background Chrome tab throttles animation frames to
// about one a second, and anything on a timer is then impossible to check by
// looking at it.

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const a = src.indexOf('<script type="module">');
const b = src.indexOf("</script>", a);
if (a < 0 || b < 0) throw new Error("could not find the script in index.html");
const code = src.slice(a + '<script type="module">'.length, b);

// --- stubs ---------------------------------------------------------------------

// Drawing calls all do nothing. Reading a property that was never written hands
// back a function, which covers the entire 2d context surface without listing it.
// Writes stick, so anything setting fillStyle and reading it back is fine.
const context2d = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});

// Enough of an element for the interface to build against. The game only writes
// to these, so none of it has to model the DOM, just absorb it.
const element = () => ({
  width: 0,
  height: 0,
  style: {},
  textContent: "",
  innerHTML: "",
  className: "",
  classList: { add() {}, remove() {}, contains: () => false },
  dataset: {},
  getContext: context2d,
  appendChild() {},
  addEventListener() {},
  querySelectorAll: () => [],
});

let rafCb = null;

const env = {
  document: {
    createElement: element,
    getElementById: element,
    head: { insertAdjacentHTML() {} },
    body: {},
  },
  addEventListener() {},
  requestAnimationFrame(cb) { rafCb = cb; return 1; },
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  performance: { now: () => 0 },
};
Object.assign(globalThis, env);

// Everything lives in module scope in the game, which is right for the artifact
// and useless here, so one line gets appended before evaluation. It only exists
// in this file; index.html never sees it.
const EXPOSE = `
;globalThis.__bloomfront = {
  MAP, at, inMap, vit, own, elev, kind, occupied, units, buildings, purse, territory,
  buildField, steppable, walkable, bloomAt, spawn, order, canPlace, place,
  GOAL, UNREACHED, FOAL, CHARGER, PRISM, GROVE, STABLE, SPIRE, WATER,
  DIRX, DIRY, UNITS, BUILD, LEVELS, COUNTER, DAMAGE, REACH, stepUnits, shots,
  think, brains, frontier, quarry,
  resume, begin, judge, showPause, showMenu, goalShare, play, HERDS,
  setWin: (d, c) => { winDominion = d; winConquest = c; },
  RIVALS, SPEEDS, POPS, maxPop, buildingAt, fightBuilding,
  setPop: (n) => { popIdx = n; },
  setDiff: (n) => { difficulty = n; },
  setSpeed: (n) => { speed = n; },
  applyBox, box, cam, toScreen,
  getWin: () => [winDominion, winConquest],
  worldX, worldY, spotX, spotY, pick, toWorld, cam, TW, TH, EH, pop, cap, INCOME, AURA,
  getState: () => state,
  getLand: () => landTiles,
  getHerds: () => herdCount,
  getHomes: () => homes,
  setHerds: (n) => { herdCount = n; },
  PLAY, PAUSED, ENDED, MENU,
};
`;

new Function(code + EXPOSE)();

const g = globalThis.__bloomfront;
if (!g) throw new Error("the game did not expose its internals");

// --- harness -------------------------------------------------------------------

let failures = 0;
let checks = 0;

function ok(label, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.log("FAIL  " + label + (detail === undefined ? "" : "   " + detail));
}

// Drive the real loop. The game takes its timestep from the argument, so seconds
// of game time cost microseconds of real time.
let clock = 0;
function advance(seconds, stepMs = 16) {
  const end = clock + seconds * 1000;
  while (clock < end) {
    clock += stepMs;
    if (!rafCb) throw new Error("the frame loop stopped scheduling");
    const cb = rafCb;
    rafCb = null;
    cb(clock);
  }
}

// --- the map -------------------------------------------------------------------

{
  const { MAP, elev, kind, LEVELS, WATER } = g;
  let water = 0, land = 0, highest = 0;
  const seen = new Set();
  for (let i = 0; i < MAP * MAP; i++) {
    if (kind[i] === WATER) water++; else land++;
    if (elev[i] > highest) highest = elev[i];
    seen.add(elev[i]);
    if (elev[i] >= LEVELS) { ok("elevation in range", false, "tile " + i + " is " + elev[i]); break; }
  }
  ok("elevation in range", true);
  ok("the map has both land and sea", water > 500 && land > 500, water + " water, " + land + " land");
  ok("the map uses most of its terraces", seen.size >= 4, "levels used: " + seen.size);

  // Edges should all be sea. Otherwise the continent runs off the map and the
  // ocean drawn past the border butts up against a cliff.
  let edgeLand = 0;
  for (let n = 0; n < MAP; n++) {
    for (const i of [n, (MAP - 1) * MAP + n, n * MAP, n * MAP + MAP - 1]) {
      if (kind[i] !== WATER) edgeLand++;
    }
  }
  ok("the continent does not touch the map edge", edgeLand === 0, edgeLand + " land tiles on the border");
}

// --- projection ----------------------------------------------------------------

// Anything standing on a tile has to draw inside that tile's diamond. Half a tile
// out is invisible in a screenshot and glaring in motion, where units walk through
// the terrace rather than over it.
{
  const { spotX, spotY, worldX, worldY, pick, TW, TH, elev, at, MAP } = g;

  // Centre of a tile's ground square lands on the centre of its diamond.
  let worst = 0;
  for (const [tx, ty] of [[0, 0], [5, 5], [12, 3], [40, 61], [MAP - 2, MAP - 2]]) {
    const dx = spotX(tx + 0.5, ty + 0.5) - worldX(tx, ty);
    const dy = spotY(tx + 0.5, ty + 0.5, 0) - worldY(tx, ty, 0);
    worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
  }
  ok("a tile centre projects onto its own diamond", worst < 1e-9, "off by " + worst);

  // Every corner of the square lands inside the diamond too. That's the property
  // stopping a unit from being painted over by the next tile.
  let outside = 0;
  for (let n = 0; n < 400; n++) {
    const tx = 20 + (n % 17), ty = 30 + ((n * 7) % 19);
    const px = tx + (n % 10) / 10, py = ty + ((n * 3) % 10) / 10;
    const dx = spotX(px, py) - worldX(tx, ty);
    const dy = spotY(px, py, 0) - worldY(tx, ty, 0);
    // Inside the diamond means |dx| / halfWidth + |dy| / halfHeight <= 1.
    if (Math.abs(dx) / (TW / 2) + Math.abs(dy) / (TH / 2) > 1.0001) outside++;
  }
  ok("every point of a tile projects inside that tile's diamond", outside === 0,
    outside + " of 400 outside");

  // Picking is the inverse. The tile under a point drawn for a tile is that tile.
  let wrong = 0, tried = 0;
  for (let ty = 30; ty < 45; ty++) {
    for (let tx = 30; tx < 45; tx++) {
      if (elev[at(tx, ty)] !== 0) continue;
      tried++;
      const hit = pick(worldX(tx, ty), worldY(tx, ty, 0));
      if (!hit || hit[0] !== tx || hit[1] !== ty) wrong++;
    }
  }
  ok("picking a tile centre returns that tile", tried > 0 && wrong === 0,
    wrong + " wrong of " + tried);
}

// --- the continent is one piece ------------------------------------------------

// All land has to be reachable from all other land or the map is unplayable.
// Herds can't meet and somebody ends up stranded with nowhere to go. Stricter
// than land and sea, since a plateau ringed by two-terrace drops is ground
// nothing can walk onto.
{
  const { MAP, at, kind, WATER, walkable, steppable, DIRX, DIRY, begin, occupied } = g;

  // The generator guarantees the terrain is one piece. Buildings land on it
  // afterwards and their footprints aren't walkable, so a grove can cut off a
  // tile or a pocket, which is a placement question and not a map one. Lift the
  // buildings for the duration, and measure with the game's own steppable rather
  // than a copy of it.
  const reachableAll = () => {
    const saved = occupied.slice();
    occupied.fill(0);
    try {
      return sweep();
    } finally {
      occupied.set(saved);
    }
  };

  const sweep = () => {
    let start = -1, land = 0;
    for (let i = 0; i < MAP * MAP; i++) {
      // Groves make their footprint unwalkable, so count tiles a unicorn could
      // stand on rather than tiles of land.
      if (walkable(i % MAP, (i / MAP) | 0)) { land++; if (start < 0) start = i; }
    }
    if (start < 0) return { land: 0, seen: 0 };

    const seen = new Uint8Array(MAP * MAP);
    const queue = new Int32Array(MAP * MAP);
    let head = 0, tail = 0, count = 0;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const ci = queue[head++];
      count++;
      const cx = ci % MAP, cy = (ci / MAP) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRX[d], ny = cy + DIRY[d];
        if (!g.inMap(nx, ny)) continue;
        const ni = at(nx, ny);
        if (seen[ni] || kind[ni] === WATER) continue;
        if (!steppable(cx, cy, nx, ny)) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
    return { land, seen: count };
  };

  const bad = [];
  let smallest = 1e9;
  for (let s = 1; s <= 40; s++) {
    begin(s * 15485863);
    const r = reachableAll();
    if (r.seen !== r.land) bad.push(s * 15485863 + " (" + r.seen + " of " + r.land + ")");
    smallest = Math.min(smallest, r.land);
  }
  ok("every seed generates one connected continent", bad.length === 0,
    bad.slice(0, 3).join("  "));
  ok("the continent is never whittled down to nothing", smallest > 1000,
    "smallest was " + smallest + " tiles");

  // Put the standard world back for whatever runs next.
  begin(1337);
}

// --- movement rules ------------------------------------------------------------

{
  const { MAP, at, elev, steppable, walkable, WATER, kind } = g;
  // More than one terrace is refused, both ways.
  let checked = 0, bad = 0;
  for (let y = 1; y < MAP - 1 && checked < 4000; y++) {
    for (let x = 1; x < MAP - 1 && checked < 4000; x++) {
      if (!walkable(x, y) || !walkable(x + 1, y)) continue;
      checked++;
      const drop = Math.abs(elev[at(x + 1, y)] - elev[at(x, y)]);
      if (drop > 1 && steppable(x, y, x + 1, y)) bad++;
    }
  }
  ok("a cliff of more than one terrace blocks movement", bad === 0, bad + " illegal steps of " + checked);
  ok("water is never walkable", (() => {
    for (let i = 0; i < MAP * MAP; i++) {
      if (kind[i] === WATER && walkable(i % MAP, (i / MAP) | 0)) return false;
    }
    return true;
  })());
}

// --- flow fields ---------------------------------------------------------------

{
  const { MAP, at, buildField, walkable, GOAL, UNREACHED, DIRX, DIRY, steppable } = g;
  const homes = g.getHomes();
  // The home tile holds the opening grove and isn't walkable, so test paths
  // against open ground next to it.
  let hx = homes[0][0], hy = homes[0][1];
  for (let r = 2; r < 12 && !walkable(hx, hy); r++) {
    hx = homes[0][0] + r;
    hy = homes[0][1];
  }
  ok("there is open ground beside home", walkable(hx, hy));
  const f = buildField(hx, hy);

  ok("the goal tile is marked as the goal", f[at(hx, hy)] === GOAL);

  // Every direction in the field is a legal step, and following it from anywhere
  // ends at the goal rather than looping.
  let illegal = 0, reached = 0, sampled = 0, stuck = 0;
  for (let i = 0; i < MAP * MAP && sampled < 600; i++) {
    if (f[i] === UNREACHED || f[i] === GOAL) continue;
    if (i % 7) continue;
    sampled++;
    let x = i % MAP, y = (i / MAP) | 0;
    for (let hops = 0; hops < MAP * 4; hops++) {
      const d = f[at(x, y)];
      if (d === GOAL) { reached++; break; }
      if (d === UNREACHED) { stuck++; break; }
      const nx = x + DIRX[d], ny = y + DIRY[d];
      if (!steppable(x, y, nx, ny)) { illegal++; break; }
      x = nx; y = ny;
      if (hops === MAP * 4 - 1) stuck++;
    }
  }
  ok("every field direction is a legal step", illegal === 0, illegal + " illegal of " + sampled);
  ok("following the field always arrives", reached === sampled,
    reached + " of " + sampled + " arrived, " + stuck + " stuck");

  // Ground the herd starts on has to be reachable from its own home, or there is
  // no opening move.
  let reachable = 0, near = 0;
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const x = hx + dx, y = hy + dy;
      if (!walkable(x, y)) continue;
      near++;
      if (f[at(x, y)] !== UNREACHED) reachable++;
    }
  }
  ok("home ground is reachable from home", reachable === near, reachable + " of " + near);
}

// --- the bloom field -----------------------------------------------------------

{
  const { at, vit, own, bloomAt, walkable, MAP } = g;
  // Quiet inland tile with nothing on it.
  let t = -1;
  for (let y = 4; y < MAP - 4 && t < 0; y++) {
    for (let x = 4; x < MAP - 4; x++) {
      if (walkable(x, y) && vit[at(x, y)] === 0) { t = at(x, y); var tx = x, ty = y; break; }
    }
  }
  ok("found a blighted tile to test on", t >= 0);

  bloomAt(tx, ty, 0, 0.5, 1.2);
  ok("walking on blight brings it back", vit[t] > 0, "vit " + vit[t].toFixed(3));
  ok("bloom claims the ground for the herd", own[t] === 0);

  // A rival can't just paint over it. Has to be bleached to nothing first.
  const before = vit[t];
  bloomAt(tx, ty, 1, 0.2, 1.2);
  ok("a rival bleaches rather than repaints", vit[t] < before && own[t] === 0,
    "vit " + vit[t].toFixed(3) + " own " + own[t]);
  // Enough force to kill it outright takes it in one go, and the surplus becomes
  // the new owner's bloom instead of being binned.
  bloomAt(tx, ty, 1, 5, 1.2);
  ok("ground changes hands once it is dead", own[t] === 1 && vit[t] > 0,
    "vit " + vit[t].toFixed(3) + " own " + own[t]);

  // A push too weak to kill it doesn't flip the owner.
  const t2 = at(tx + 1, ty);
  bloomAt(tx + 1, ty, 2, 0.9, 1.2);
  const held = own[t2];
  bloomAt(tx + 1, ty, 0, 0.05, 1.2);
  ok("a weak push does not take ground", own[t2] === held && vit[t2] > 0,
    "own " + own[t2] + " vit " + vit[t2].toFixed(3));
}

// --- the economy over time -----------------------------------------------------

{
  const { purse, territory, units, buildings } = g;

  ok("each herd starts with a grove", buildings.length === 3, buildings.length + " buildings");
  ok("each herd starts with a herd", units.length === 30, units.length + " units");

  // World gets built behind the menu and nothing runs until the game starts. Do
  // what Begin does.
  ok("the game waits on the menu", g.getState() === g.MENU);
  advance(1);
  ok("nothing moves while the menu is up", territory[0] === 0);
  g.resume();
  ok("starting the game leaves the menu", g.getState() === g.PLAY);

  const purseBefore = purse[0];
  advance(3);

  ok("the frame loop keeps running", rafCb !== null);
  ok("territory is counted once the economy ticks", territory[0] > 0,
    "territory " + territory[0].toFixed(1));
  ok("holding land earns bloom", purse[0] > purseBefore,
    purseBefore.toFixed(1) + " -> " + purse[0].toFixed(1));

  const unitsBefore = units.length;
  advance(30);
  ok("groves produce units", units.length > unitsBefore,
    unitsBefore + " -> " + units.length);
  ok("rivals also grow", territory[1] > 0 && territory[2] > 0,
    territory.map((n) => n.toFixed(1)).join(", "));

  // Bloom has to actually pile up. Production used to come out of the same purse
  // and ate the whole income, so nothing could ever be saved for.
  const bank = purse[0];
  advance(30);
  ok("bloom accumulates rather than being eaten by production", purse[0] > bank + 20,
    bank.toFixed(1) + " -> " + purse[0].toFixed(1) + " over 30s");

  // Herd size is bounded by the buildings, not by what's in the purse.
  const mine = units.filter((u) => u.herd === 0).length;
  ok("the herd is capped by buildings", mine <= g.cap[0] + 1,
    mine + " units against a cap of " + g.cap[0]);
}

// --- ground stays put ----------------------------------------------------------

{
  const { at, vit, walkable, MAP, units } = g;
  // Ground stays alive with nobody stood on it. Territory rotting on its own made
  // holding the map feel like bailing out a boat.
  let far = -1, fx = 0, fy = 0;
  outer:
  for (let y = 2; y < MAP - 2; y++) {
    for (let x = 2; x < MAP - 2; x++) {
      if (!walkable(x, y)) continue;
      let clear = true;
      for (const u of units) {
        if (Math.abs(u.x - x) < 16 && Math.abs(u.y - y) < 16) { clear = false; break; }
      }
      for (const b of g.buildings) {
        if (Math.abs(b.x - x) < 16 && Math.abs(b.y - y) < 16) { clear = false; break; }
      }
      if (clear) { far = at(x, y); fx = x; fy = y; break outer; }
    }
  }
  if (far >= 0) {
    g.bloomAt(fx, fy, 0, 1, 1.1);
    const before = vit[far];
    advance(20);
    ok("ground you have taken stays alive", vit[far] >= before - 1e-9,
      before.toFixed(3) + " -> " + vit[far].toFixed(3));
  } else {
    ok("found isolated ground to test with", false);
  }
}

// --- buildings bloom their surroundings ----------------------------------------

{
  const { buildings, vit, at, GROVE, SPIRE, territory } = g;
  const grove = buildings.find((b) => b.herd === 0 && b.type === GROVE);
  ok("the player has a grove to test with", !!grove);

  // Somewhere near the edge of the grove's reach that's still dead.
  let probe = -1;
  for (let r = 3; r <= 4 && probe < 0; r++) {
    for (let a = 0; a < 16; a++) {
      const x = Math.round(grove.x + Math.cos(a / 16 * 7) * r);
      const y = Math.round(grove.y + Math.sin(a / 16 * 7) * r);
      if (g.walkable(x, y) && vit[at(x, y)] < 0.5) { probe = at(x, y); break; }
    }
  }
  if (probe >= 0) {
    const before = vit[probe];
    advance(12);
    ok("a grove greens the land around it", vit[probe] > before,
      before.toFixed(3) + " -> " + vit[probe].toFixed(3));
  } else {
    ok("a grove greens the land around it", true, "already fully bloomed");
  }
}

// --- placement rules -----------------------------------------------------------

{
  const { canPlace, MAP, at, kind, elev, own, vit, WATER, inMap } = g;
  // Whatever canPlace accepts has to satisfy every rule it claims to check.
  let accepted = 0, wrong = 0;
  for (let y = 0; y < MAP - 1; y++) {
    for (let x = 0; x < MAP - 1; x++) {
      if (!canPlace(0, x, y)) continue;
      accepted++;
      const e = elev[at(x, y)];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = at(x + dx, y + dy);
          if (kind[i] === WATER || elev[i] !== e || own[i] !== 0 || vit[i] < 0.45) wrong++;
        }
      }
    }
  }
  ok("there is somewhere legal to build", accepted > 0, accepted + " footprints");
  ok("every accepted footprint obeys the rules", wrong === 0, wrong + " violations");

  ok("building off the edge of the map is refused",
    !canPlace(0, MAP - 1, MAP - 1) && !canPlace(0, -1, -1));
}

// --- attacking a settlement ----------------------------------------------------

// A footprint isn't walkable, which makes the obvious target of an attack the one
// tile you can't build a flow field for. Orders used to be dropped outright, so
// right clicking a settlement did nothing and every AI wave went nowhere.
{
  const { units, buildings, spawn, order, begin, canPlace, place, walkable,
          CHARGER, PRISM, GROVE, MAP, at } = g;

  begin(24601);
  g.resume();

  // A rival building, and a squad of ours parked away from it.
  const target = buildings.find((b) => b.herd === 1);
  ok("there is a rival building to attack", !!target);

  units.length = 0;
  const squad = [];
  let placed = 0;
  for (let r = 3; r < 14 && placed < 6; r++) {
    for (let a = 0; a < 16 && placed < 6; a++) {
      const t = a / 16 * Math.PI * 2;
      const x = Math.round(target.x + Math.cos(t) * r);
      const y = Math.round(target.y + Math.sin(t) * r);
      if (walkable(x, y)) { squad.push(spawn(0, CHARGER, x + 0.5, y + 0.5)); placed++; }
    }
  }
  ok("staged a squad near the rival building", squad.length === 6, squad.length + " staged");

  const startedAt = squad.map((u) => [u.x, u.y]);
  const hpBefore = target.hp;
  order(squad, target.x, target.y);
  ok("an order onto a building is accepted", squad.every((u) => u.field),
    squad.filter((u) => u.field).length + " of 6 given a path");

  advance(12);
  const moved = squad.filter((u, i) =>
    Math.hypot(u.x - startedAt[i][0], u.y - startedAt[i][1]) > 1).length;
  ok("units ordered onto a building actually move", moved > 0, moved + " of 6 moved");

  ok("a squad can damage a rival building", target.hp < hpBefore,
    hpBefore + " -> " + target.hp.toFixed(1));

  advance(90);
  ok("a squad can raze a rival building", !buildings.includes(target),
    "still standing at " + target.hp.toFixed(1) + " hp");
}

// --- returning fire ------------------------------------------------------------

{
  const { units, spawn, begin, walkable, MAP, at, elev, CHARGER, PRISM } = g;
  begin(24601);
  g.resume();

  // Flat ground with elbow room.
  let px = -1, py = -1;
  for (let y = 8; y < MAP - 8 && px < 0; y++) {
    for (let x = 8; x < MAP - 8; x++) {
      let flat = true;
      for (let dy = -4; dy <= 4 && flat; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          if (!walkable(x + dx, y + dy) || elev[at(x + dx, y + dy)] !== elev[at(x, y)]) {
            flat = false;
            break;
          }
        }
      }
      if (flat) { px = x; py = y; break; }
    }
  }
  ok("found flat ground to test return fire on", px >= 0);

  // A charger minding its own business and a prism shooting it from outside the
  // charger's reach. It has to notice.
  units.length = 0;
  const victim = spawn(0, CHARGER, px, py);
  const sniper = spawn(1, PRISM, px + 4.5, py);
  victim.foe = null;
  advance(4);
  ok("a unit under fire acquires whoever is shooting it", victim.foe === sniper,
    victim.foe ? "targeting something else" : "targeting nothing");
  ok("and it closes on them", Math.hypot(victim.x - sniper.x, victim.y - sniper.y) < 4.5,
    "gap " + Math.hypot(victim.x - sniper.x, victim.y - sniper.y).toFixed(2));

  units.length = 0;
  begin(1337);
}

// --- the opposing herds --------------------------------------------------------

// Before the combat checks, which clear the field to stage duels.
{
  const { buildings, units, territory, purse } = g;

  const before = territory.slice();
  advance(90);

  for (const h of [1, 2]) {
    const mine = buildings.filter((b) => b.herd === h);
    ok("herd " + h + " builds beyond its first grove", mine.length > 1,
      mine.length + " buildings");
    ok("herd " + h + " grows its territory", territory[h] > before[h],
      before[h].toFixed(1) + " -> " + territory[h].toFixed(1));
    ok("herd " + h + " spends what it earns", purse[h] < 4000, purse[h].toFixed(0) + " banked");
    const army = units.filter((u) => u.herd === h);
    ok("herd " + h + " has a herd", army.length > 0, army.length + " units");
    ok("herd " + h + " sends units out", army.some((u) => u.field || u.foe),
      army.filter((u) => u.field).length + " under orders");
  }

  // Herd zero has no brain, so it should still be sat on its opening army.
  ok("the player is not played for them",
    buildings.filter((b) => b.herd === 0).length === 1);
}

// --- combat --------------------------------------------------------------------

{
  const { COUNTER, FOAL, CHARGER, PRISM } = g;
  // The triangle has to close: each type beats exactly one and loses to exactly
  // one. Otherwise army composition isn't a decision.
  const beats = [];
  for (let a = 0; a < 3; a++) {
    let wins = 0, evens = 0;
    for (let d = 0; d < 3; d++) {
      if (COUNTER[a][d] > 1) { wins++; beats[a] = d; } else evens++;
    }
    ok("type " + a + " counters exactly one type", wins === 1, wins + " counters");
  }
  ok("the counter triangle is a cycle",
    beats[FOAL] === PRISM && beats[CHARGER] === FOAL && beats[PRISM] === CHARGER,
    JSON.stringify(beats));
  ok("nothing counters itself", COUNTER[0][0] === 1 && COUNTER[1][1] === 1 && COUNTER[2][2] === 1);
}

{
  const { units, spawn, walkable, MAP, at, elev, FOAL, CHARGER, PRISM, UNITS } = g;

  // Clear the field, or a duel gets decided by whoever wanders past.
  units.length = 0;

  // Flat ground, well away from anything.
  let px = -1, py = -1;
  for (let y = 6; y < MAP - 6 && px < 0; y++) {
    for (let x = 6; x < MAP - 6; x++) {
      let flat = true;
      for (let dy = -3; dy <= 3 && flat; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!walkable(x + dx, y + dy) || elev[at(x + dx, y + dy)] !== elev[at(x, y)]) { flat = false; break; }
        }
      }
      if (flat) { px = x; py = y; break; }
    }
  }
  ok("found a flat arena to fight on", px >= 0);

  // They start apart and close. Reach is half of what a counter means, and a
  // prism that begins in contact never gets to shoot, so starting them touching
  // would measure the wrong thing.
  const duel = (ta, tb) => {
    units.length = 0;
    const a = spawn(0, ta, px - 2.5, py);
    const b = spawn(1, tb, px + 2.5, py);
    for (let n = 0; n < 1800; n++) {
      g.stepUnits(1 / 60);
      if (a.hp <= 0 || b.hp <= 0 || units.length < 2) break;
    }
    return {
      a, b,
      aAlive: units.includes(a), bAlive: units.includes(b),
      why: "a hp " + a.hp.toFixed(1) + " at " + a.x.toFixed(2) + "," + a.y.toFixed(2) +
        " foe " + (a.foe ? "yes" : "no") +
        " | b hp " + b.hp.toFixed(1) + " at " + b.x.toFixed(2) + "," + b.y.toFixed(2) +
        " | gap " + Math.hypot(a.x - b.x, a.y - b.y).toFixed(2),
    };
  };

  let r = duel(CHARGER, FOAL);
  ok("a charger beats a foal", r.aAlive && !r.bAlive, r.why);
  r = duel(PRISM, CHARGER);
  ok("a prism beats a charger", r.aAlive && !r.bAlive, r.why);
  r = duel(FOAL, PRISM);
  ok("a foal beats a prism", r.aAlive && !r.bAlive, r.why);

  // Mirror one of them, so the result is the triangle rather than whichever unit
  // is simply better.
  r = duel(FOAL, CHARGER);
  ok("a foal loses to a charger", !r.aAlive && r.bAlive, r.why);

  units.length = 0;
}

{
  const { units, spawn, MAP, at, elev, walkable, CHARGER } = g;
  // Identical units, one a terrace up. High ground should take it.
  let lx = -1, ly = 0, hx = 0, hy = 0;
  outer2:
  for (let y = 2; y < MAP - 2; y++) {
    for (let x = 2; x < MAP - 2; x++) {
      if (!walkable(x, y) || !walkable(x + 1, y)) continue;
      if (elev[at(x + 1, y)] - elev[at(x, y)] === 1) {
        lx = x; ly = y; hx = x + 1; hy = y;
        break outer2;
      }
    }
  }
  if (lx < 0) {
    ok("found a terrace edge to fight across", false);
  } else {
    units.length = 0;
    const low = spawn(0, CHARGER, lx + 0.55, ly + 0.5);
    const high = spawn(1, CHARGER, hx + 0.15, hy + 0.5);
    for (let n = 0; n < 1200; n++) {
      g.stepUnits(1 / 60);
      if (low.hp <= 0 || high.hp <= 0) break;
    }
    ok("high ground wins an even fight", high.hp > 0 && low.hp <= 0,
      "low " + low.hp.toFixed(1) + " high " + high.hp.toFixed(1));
    units.length = 0;
  }
}

// --- winning and losing --------------------------------------------------------

{
  const { judge, buildings, territory, GROVE, getLand, goalShare, begin, units } = g;

  begin(4242);
  g.resume();
  ok("a fresh game is undecided", judge() === 0, "verdict " + judge());
  ok("a fresh game gives everyone a grove",
    buildings.filter((b) => b.type === GROVE).length === 3);

  // Lose every grove and it's over, whatever the map looks like.
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (buildings[i].herd === 0) buildings.splice(i, 1);
  }
  ok("losing every grove is defeat", judge() === -1, "verdict " + judge());

  // Razing both rivals wins.
  begin(4242);
  g.resume();
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (buildings[i].herd !== 0) buildings.splice(i, 1);
  }
  ok("razing every rival grove is victory", judge() === 1, "verdict " + judge());

  // So does holding the target share.
  begin(4242);
  g.resume();
  ok("holding the target share is victory", (() => {
    territory[0] = getLand() * goalShare() + 1;
    return judge() === 1;
  })(), "verdict " + judge());

  // A rival getting there first loses it.
  begin(4242);
  g.resume();
  territory[0] = 0;
  territory[2] = getLand() * goalShare() + 1;
  ok("a rival reaching the target first is defeat", judge() === -1, "verdict " + judge());

  ok("the target is a fraction of dry land, not of the whole map",
    getLand() > 0 && getLand() < g.MAP * g.MAP,
    getLand() + " of " + g.MAP * g.MAP);
}

{
  const { begin, units, buildings, territory, purse, vit, MAP } = g;

  // Restart has to leave nothing behind, or round two inherits round one's map
  // and armies.
  begin(777);
  g.resume();
  advance(20);
  const midUnits = units.length;
  ok("a game in progress has grown", midUnits > 30 || territory[0] > 0);

  begin(778);
  ok("restart clears the armies", units.length === 30, units.length + " units");
  ok("restart clears the buildings", buildings.length === 3, buildings.length + " buildings");
  ok("restart resets the purses",
    purse.slice(0, g.getHerds()).every((p) => p === 100), purse.join(", "));
  ok("restart resets the score", territory.every((t) => t === 0));
  ok("restart puts the player back in the game", g.getState() === g.PLAY);

  // No vitality carried over from the last continent.
  let bloomed = 0;
  for (let i = 0; i < MAP * MAP; i++) if (vit[i] > 0) bloomed++;
  ok("restart clears the old bloom", bloomed > 0 && bloomed < 1400,
    bloomed + " living tiles, which should be three home blobs only");
}

{
  // Every seed has to open playably. A herd with no grove has lost before anyone
  // touches anything, and the only way to know is to try a lot of continents.
  const { begin, buildings, units, GROVE } = g;
  let bad = [];
  for (let s = 1; s <= 60; s++) {
    begin(s * 7919);
    const groves = buildings.filter((b) => b.type === GROVE);
    if (groves.length !== 3 || units.length !== 30) {
      bad.push(s * 7919 + " (" + groves.length + " groves, " + units.length + " units)");
    }
  }
  ok("every seed opens with three groves and three herds", bad.length === 0,
    bad.slice(0, 4).join("  "));

  // Homes far enough apart to count as separate positions.
  bad = [];
  for (let s = 1; s <= 40; s++) {
    begin(s * 104729);
    const h = g.getHomes();
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const d = Math.hypot(h[i][0] - h[j][0], h[i][1] - h[j][1]);
        if (d < g.MAP * 0.095) bad.push(s * 104729 + " gap " + d.toFixed(1));
      }
    }
  }
  ok("herds never open on top of each other", bad.length === 0, bad.slice(0, 4).join("  "));
}

{
  // Pause stops the world.
  g.begin(31337);
  g.resume();
  advance(6);
  const t = g.territory[0];
  g.showPause();
  ok("pausing leaves the play state", g.getState() === g.PAUSED);
  advance(8);
  ok("nothing happens while paused", g.territory[0] === t,
    t.toFixed(2) + " -> " + g.territory[0].toFixed(2));
  g.resume();
  advance(4);
  ok("resuming starts it again", g.territory[0] !== t);
}

// --- victory routes ------------------------------------------------------------

// Either route can be switched off, and each has to change what ends the game
// rather than just the wording on the panel.
{
  const { begin, buildings, territory, getLand, goalShare, judge, setWin, GROVE } = g;
  const razeRivals = () => {
    for (let i = buildings.length - 1; i >= 0; i--) {
      if (buildings[i].herd !== 0) buildings.splice(i, 1);
    }
  };

  // Both on, either ends it.
  setWin(true, true);
  begin(5150);
  g.resume();
  ok("with both on, dominion wins", (() => {
    territory[0] = getLand() * goalShare() + 1;
    return judge() === 1;
  })());
  begin(5150);
  razeRivals();
  ok("with both on, conquest wins", judge() === 1);

  // Dominion only, so razing every grove no longer ends it. A herd without them
  // still trains from stables and spires.
  setWin(true, false);
  begin(5150);
  razeRivals();
  ok("with conquest off, razing every grove does not end it", judge() === 0,
    "verdict " + judge());
  territory[0] = getLand() * goalShare() + 1;
  ok("with conquest off, dominion still wins", judge() === 1);

  // Conquest only, so holding the continent pays but doesn't win.
  setWin(false, true);
  begin(5150);
  territory[0] = getLand() * 0.99;
  ok("with dominion off, holding the map does not win", judge() === 0,
    "verdict " + judge());
  razeRivals();
  ok("with dominion off, conquest still wins", judge() === 1);

  // Losing your own groves still loses it with conquest on.
  setWin(false, true);
  begin(5150);
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (buildings[i].herd === 0) buildings.splice(i, 1);
  }
  ok("with conquest on, losing your groves is defeat", judge() === -1);

  setWin(true, true);
  begin(1337);
}

// --- selection -----------------------------------------------------------------

// A unit's anchor is its hooves and the animal draws about thirty pixels above
// that. Hit testing the anchor alone means a box round what you can see selects
// nothing and a click on a body misses completely.
{
  const { units, spawn, begin, walkable, MAP, applyBox, box, toScreen, spotX, spotY,
          FOAL, CHARGER } = g;

  begin(1337);
  g.resume();
  units.length = 0;

  let sx = -1, sy = 0;
  for (let y = 10; y < MAP - 10 && sx < 0; y++) {
    for (let x = 10; x < MAP - 10; x++) if (walkable(x, y)) { sx = x; sy = y; break; }
  }
  const u = spawn(0, CHARGER, sx + 0.5, sy + 0.5);
  const [px, py] = toScreen(spotX(u.x, u.y), spotY(u.x, u.y, u.z));

  const drag = (x0, y0, x1, y1) => {
    box.x0 = x0; box.y0 = y0; box.x1 = x1; box.y1 = y1;
    return applyBox();
  };

  // Click on the body, well above the hooves.
  const bodyY = py - 20 * g.cam.z;
  drag(px, bodyY, px, bodyY);
  ok("clicking a unicorn's body selects it", u.sel, "body at " + bodyY.toFixed(0) +
    ", anchor at " + py.toFixed(0));

  // Box round the visible animal, with the anchor below the bottom edge.
  drag(px - 20, py - 40 * g.cam.z, px + 20, py - 8 * g.cam.z);
  ok("a box around the body selects it", u.sel);

  // Clicking the hooves still works.
  drag(px, py, px, py);
  ok("clicking the hooves selects it", u.sel);

  // A box nowhere near it doesn't.
  drag(px + 300, py + 300, px + 400, py + 400);
  ok("a box elsewhere deselects", !u.sel);

  // Rivals can't be selected at all.
  const rival = spawn(1, FOAL, sx + 1.5, sy + 0.5);
  const [rx, ry] = toScreen(spotX(rival.x, rival.y), spotY(rival.x, rival.y, rival.z));
  drag(rx - 40, ry - 60, rx + 40, ry + 20);
  ok("a rival cannot be selected", !rival.sel);

  units.length = 0;
  begin(1337);
}

// --- selected units have to obey ------------------------------------------------

// Not a selection failure. The ring lights up, the order is taken, and the unit
// stands there. Combat used to be resolved before movement and unconditionally,
// so anything in contact ignored where it was sent.
{
  const { units, spawn, begin, order, walkable, MAP, at, elev, CHARGER, FOAL,
          buildings, place, canPlace, GROVE } = g;

  begin(1337);
  g.resume();

  // Open ground with room. Level nearby so a building can go down, walkable
  // further out so there's somewhere to walk to. Asking for one flat slab
  // thirteen tiles across finds nothing on a jittered map.
  let px = -1, py = 0;
  for (let y = 12; y < MAP - 12 && px < 0; y++) {
    for (let x = 12; x < MAP - 12; x++) {
      let good = true;
      for (let dy = -8; dy <= 8 && good; dy++) {
        for (let dx = -8; dx <= 8; dx++) {
          if (!walkable(x + dx, y + dy)) { good = false; break; }
          if (Math.max(Math.abs(dx), Math.abs(dy)) <= 2 &&
            elev[at(x + dx, y + dy)] !== elev[at(x, y)]) { good = false; break; }
        }
      }
      if (good) { px = x; py = y; break; }
    }
  }
  ok("found ground to test orders on", px >= 0);

  // Locked in melee, then told to walk away.
  units.length = 0;
  const mine = spawn(0, CHARGER, px, py);
  spawn(1, CHARGER, px + 0.6, py);
  advance(2);
  ok("the unit is in a fight", mine.foe !== null);

  const from = [mine.x, mine.y];
  order([mine], px + 6, py + 4);
  ok("an order is accepted while fighting", !!mine.field);
  advance(6);
  ok("a selected unit in melee obeys a move order",
    Math.hypot(mine.x - from[0], mine.y - from[1]) > 2,
    "moved " + Math.hypot(mine.x - from[0], mine.y - from[1]).toFixed(2) + " tiles");

  // A unit with a building dropped on top of it still has to take orders.
  units.length = 0;
  const stuck = spawn(0, FOAL, px + 0.5, py + 0.5);
  g.bloomAt(px, py, 0, 1, 4);
  if (canPlace(0, px, py)) {
    place(0, GROVE, px, py);
    ok("a unit under a new building is pushed clear", walkable(stuck.x | 0, stuck.y | 0),
      "left at " + stuck.x.toFixed(1) + "," + stuck.y.toFixed(1));
    const was = [stuck.x, stuck.y];
    order([stuck], px + 7, py + 6);
    advance(8);
    ok("and it still answers orders afterwards",
      Math.hypot(stuck.x - was[0], stuck.y - was[1]) > 1.5,
      "moved " + Math.hypot(stuck.x - was[0], stuck.y - was[1]).toFixed(2) + " tiles");
  } else {
    ok("a unit under a new building is pushed clear", false, "could not place a building");
    ok("and it still answers orders afterwards", false);
  }

  units.length = 0;
  begin(1337);
}

// --- difficulty ----------------------------------------------------------------

// A rival is made easier by deciding less often, massing longer, banking more
// before it builds and sending less of its herd out. It is never made easier by
// taking away its income, because then it stops measuring the player's play.
{
  const { RIVALS, UNITS, BUILD } = g;
  ok("there are three settings", RIVALS.length === 3);

  let ordered = true;
  for (let i = 1; i < RIVALS.length; i++) {
    const easier = RIVALS[i - 1], harder = RIVALS[i];
    // cadence down, wave down, greed down, share of foals sent up
    if (!(easier[1] > harder[1] && easier[2] >= harder[2] &&
      easier[3] >= harder[3] && easier[4] <= harder[4])) ordered = false;
  }
  ok("each setting is strictly keener than the last", ordered,
    RIVALS.map((r) => r.join("/")).join("  "));

  ok("the hardest setting has no handicap at all",
    RIVALS[2][3] === 1 && RIVALS[2][4] === 1, RIVALS[2].join("/"));

  // Nothing in the difficulty table touches money or prices.
  const before = BUILD.map((b) => b.c).concat(UNITS.map((u) => u.c));
  g.setDiff(0);
  g.begin(9100);
  const after = BUILD.map((b) => b.c).concat(UNITS.map((u) => u.c));
  ok("difficulty does not change prices", before.every((v, i) => v === after[i]));
  ok("difficulty does not change starting purses",
    g.purse.slice(0, g.getHerds()).every((p) => p === 100), g.purse.join(", "));
  g.setDiff(1);
  g.begin(1337);
}

// --- attacking a building from any side -----------------------------------------

// Reach was measured from the centre of the footprint's top left tile, so a unit
// standing against the far side of a two by two was out of range of a building
// it was touching and refused to attack.
{
  const { units, spawn, begin, buildings, fightBuilding, walkable, CHARGER, REACH } = g;
  begin(1337);
  g.resume();

  const target = buildings.find((b) => b.herd === 1);
  ok("there is a rival building to stand beside", !!target);

  // One unit hard against each of the four sides of the footprint.
  const sides = [
    [target.x - 0.6, target.y + 1],
    [target.x + 2.6, target.y + 1],
    [target.x + 1, target.y - 0.6],
    [target.x + 1, target.y + 2.6],
  ];
  let engaged = 0;
  for (const [x, y] of sides) {
    units.length = 0;
    const u = spawn(0, CHARGER, x, y);
    u.foe = null;
    u.cool = 0;
    if (fightBuilding(u, 0.1)) engaged++;
  }
  ok("a unit engages a building from every side", engaged === 4,
    engaged + " of 4 sides in range");

  units.length = 0;
  begin(1337);
}

// --- targeting a building with the cursor ---------------------------------------

// A building is drawn a hundred pixels tall, so the tile under the cursor is
// ground far behind it. Right clicking a grove has to mean the grove.
{
  const { buildings, buildingAt, toScreen, worldX, worldY, elev, at, pick, toWorld,
          begin, cam } = g;
  begin(1337);
  g.resume();
  cam.z = 1;

  const b = buildings[0];
  const sx = toScreen(worldX(b.x + 0.5, b.y + 0.5), 0)[0];
  const sy = toScreen(0, worldY(b.x + 0.5, b.y + 0.5, elev[at(b.x, b.y)]))[1];

  ok("the base of a building is over that building", buildingAt(sx, sy - 4) === b);
  // Well up the sprite, where the tile underneath is something else entirely.
  ok("the top of a building is still that building", buildingAt(sx, sy - 90) === b);
  ok("empty sky is not a building", !buildingAt(sx, sy - 400));
  ok("ground away from it is not a building", !buildingAt(sx + 400, sy));
}

// --- herd size is the player's to set -------------------------------------------

{
  const { POPS, maxPop, setPop, begin, units, buildings, cap } = g;
  ok("there are several herd sizes", POPS.length >= 3);
  ok("they are ordered", POPS.every((n, i) => i === 0 || n > POPS[i - 1]), POPS.join(", "));

  for (let i = 0; i < POPS.length; i++) {
    setPop(i);
    ok("setting " + i + " gives a ceiling of " + POPS[i], maxPop() === POPS[i]);
  }

  // The ceiling actually binds: a herd never exceeds it however much it builds.
  setPop(0);
  begin(4242);
  g.resume();
  advance(150);
  let worst = 0;
  const count = [0, 0, 0, 0];
  for (const u of units) count[u.herd]++;
  for (let h = 0; h < g.getHerds(); h++) worst = Math.max(worst, count[h]);
  ok("no herd exceeds the chosen ceiling", worst <= POPS[0] + 2,
    "largest herd was " + worst + " against a ceiling of " + POPS[0]);

  setPop(1);
  begin(1337);
}

// --- game speed ----------------------------------------------------------------

// Speed scales the timestep the simulation is handed and nothing else, so the
// same game happens faster rather than a different one happening.
{
  const { SPEEDS, setSpeed, begin, territory } = g;
  ok("there are three speeds", SPEEDS.length === 3);
  ok("the middle speed is unscaled", SPEEDS[1][1] === 1, SPEEDS[1].join("/"));
  ok("they are ordered", SPEEDS[0][1] < SPEEDS[1][1] && SPEEDS[1][1] < SPEEDS[2][1]);

  const run = (n) => {
    setSpeed(n);
    begin(31337);
    g.resume();
    advance(20);
    return territory[0];
  };
  const slow = run(0), brisk = run(1), swift = run(2);
  ok("slower means less happens in the same wall time", slow < brisk,
    slow.toFixed(1) + " vs " + brisk.toFixed(1));
  ok("faster means more happens in the same wall time", swift > brisk,
    swift.toFixed(1) + " vs " + brisk.toFixed(1));

  setSpeed(1);
  begin(1337);
}

// --- the lobby -----------------------------------------------------------------

{
  const { begin, buildings, units, setHerds, getHerds, goalShare, territory, GROVE, showMenu } = g;

  for (const n of [2, 3, 4]) {
    setHerds(n);
    begin(9001);
    ok(n + " herds get " + n + " groves",
      buildings.filter((b) => b.type === GROVE).length === n,
      buildings.length + " buildings");
    ok(n + " herds get " + n * 10 + " unicorns", units.length === n * 10, units.length + " units");
    ok(n + " herds all sit on the map",
      new Set(g.getHomes().slice(0, n).map((h) => h.join(","))).size === n);
    // Nothing belonging to a herd that is not playing may exist.
    ok("no unit belongs to a herd that is not playing",
      units.every((u) => u.herd < n), "herd count " + n);
    ok("no building belongs to a herd that is not playing",
      buildings.every((b) => b.herd < n), "herd count " + n);
  }

  // The target scales: an even split plus a margin, so it is always reachable
  // and always demands being clearly ahead.
  setHerds(2);
  const two = goalShare();
  setHerds(4);
  const four = goalShare();
  ok("the target is an even share plus a margin",
    Math.abs(two - 0.54) < 1e-9 && Math.abs(four - 0.29) < 1e-9,
    "2 herds " + two.toFixed(3) + ", 4 herds " + four.toFixed(3));
  ok("more opponents means a lower bar each", four < two);

  // The lobby must not be running the game.
  setHerds(3);
  begin(9002);
  showMenu();
  ok("the lobby does not start the game", g.getState() === g.MENU);
  const before = territory.slice();
  advance(3);
  ok("nothing simulates in the lobby", territory.every((t, i) => t === before[i]));
  g.play();
  ok("Begin starts the game", g.getState() === g.PLAY);
  advance(3);
  ok("the game runs once begun", territory[0] > 0);
}

// --- result --------------------------------------------------------------------

console.log("");
console.log(failures ? failures + " of " + checks + " checks failed" : checks + " checks passed");
process.exit(failures ? 1 : 0);
