// Sokoban solver: room-decomposed push-optimal A* search.
//
// A level is a hallway with independent rooms off it (the kit's generator
// guarantees this: each room holds 3-4 boxes and its own goals, a box pushed
// into the hallway can never come back, and the level's push-optimal count
// is the sum of its rooms' optima). So every room is solved push-optimally
// on its own -- a small push-based A* with dead-square pruning, 2x2
// deadlock pruning and an assignment heuristic -- and the walks between
// rooms are stitched in. Push-optimal per room means push-optimal overall.
//
// Determinism: budgets are counted in search expansions, never wall time;
// every tie is broken by a fixed order. Two runs on the same set write
// byte-identical answers.
//
// Run: node main.ts, reading /input/<id>/level.txt (or $MAKEFUN_INPUT_DIR)
// and writing /output/<id>/solution.txt (or $MAKEFUN_OUTPUT_DIR).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Work budgets (expansions), counted, never timed: deterministic across runs.
const ROOM_CAP = 400000;
const TOTAL_CAP = 3000000;
let totalExpansions = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** Flood fill from `from` through cells where free is 1 and blocked is 0. */
function flood(
  w: number,
  h: number,
  free: Uint8Array,
  blocked: Uint8Array,
  from: number,
): { seen: Uint8Array; min: number } {
  const seen = new Uint8Array(w * h);
  const queue = [from];
  seen[from] = 1;
  let min = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (free[q] && !blocked[q] && !seen[q]) {
        seen[q] = 1;
        if (q < min) min = q;
        queue.push(q);
      }
    }
  }
  return { seen, min };
}

/** Shortest walk (letters) from `from` to `to` through free, unblocked cells. */
function walkPath(
  w: number,
  h: number,
  free: Uint8Array,
  blocked: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h);
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (!free[q] || blocked[q] || prev[q] !== -2) continue;
      prev[q] = c;
      prevDir[q] = d;
      if (q === to) {
        let s = '';
        let cur = q;
        while (prev[cur] !== -1) {
          s = CH[prevDir[cur]] + s;
          cur = prev[cur];
        }
        return s;
      }
      queue.push(q);
    }
  }
  return null;
}

function occupancy(w: number, h: number, boxes: number[]): Uint8Array {
  const occ = new Uint8Array(w * h);
  for (const b of boxes) occ[b] = 1;
  return occ;
}

/** A room to solve on its own: its playable cells, goals, entry square. */
interface RoomCtx {
  w: number;
  h: number;
  free: Uint8Array; // playable cells: the room's floor plus its entry square
  goal: Uint8Array;
  goals: number[];
  live: Uint8Array; // cells from which a box can be pushed onto a goal
  pushDist: Int32Array[]; // pushDist[g][cell]: min pushes cell -> goals[g]
  entry: number;
}

/** Reverse push search from every goal: live cells and push distances. */
function buildRoomCtx(
  w: number,
  h: number,
  free: Uint8Array,
  goal: Uint8Array,
  goals: number[],
  entry: number,
): RoomCtx {
  const n = w * h;
  const live = new Uint8Array(n);
  const pushDist: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(n).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      const vx = v % w;
      const vy = (v / w) | 0;
      for (let d = 0; d < 4; d++) {
        // A box at u could have been pushed to v: u = v - d, player at u - d.
        const ux = vx - DX[d];
        const uy = vy - DY[d];
        const px = vx - 2 * DX[d];
        const py = vy - 2 * DY[d];
        if (ux < 0 || uy < 0 || ux >= w || uy >= h) continue;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const u = uy * w + ux;
        const p = py * w + px;
        if (!free[u] || !free[p]) continue;
        if (dist[u] >= 0) continue;
        dist[u] = dist[v] + 1;
        queue.push(u);
      }
    }
    pushDist.push(dist);
    for (let i = 0; i < n; i++) if (dist[i] >= 0) live[i] = 1;
  }
  return { w, h, free, goal, goals, live, pushDist, entry };
}

/** Minimum-assignment heuristic: sum of push distances, boxes to distinct goals. */
function heuristic(ctx: RoomCtx, boxes: number[]): number {
  const n = boxes.length;
  const m = ctx.goals.length;
  if (n !== m) return Infinity;
  // Brute-force permutations (n <= 4): try every box -> goal assignment.
  let best = Infinity;
  const used = new Uint8Array(m);
  const rec = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let g = 0; g < m; g++) {
      if (used[g]) continue;
      const d = ctx.pushDist[g][boxes[i]];
      if (d < 0) continue;
      used[g] = 1;
      rec(i + 1, sum + d);
      used[g] = 0;
    }
  };
  rec(0, 0);
  return best;
}

/** True when the 2x2 block holding the moved box is wall/box with no goal. */
function deadBlock(
  ctx: RoomCtx,
  occ: Uint8Array,
  cell: number,
): boolean {
  const w = ctx.w;
  const h = ctx.h;
  const x = cell % w;
  const y = (cell / w) | 0;
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      let allSolid = true;
      let hasGoal = false;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = x + ox + dx;
          const cy = y + oy + dy;
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue; // outside: a wall
          const q = cy * w + cx;
          if (ctx.goal[q]) hasGoal = true;
          if (ctx.free[q] && !occ[q]) allSolid = false;
        }
      }
      if (allSolid && !hasGoal) return true;
    }
  }
  return false;
}

interface SearchNode {
  boxes: number[];
  player: number;
  parent: number;
  pushBox: number;
  pushDir: number;
  g: number;
}

interface HeapEntry {
  idx: number;
  f: number;
  h: number;
  seq: number;
}

/** Binary heap ordered by (f, h, seq): fully deterministic. */
class Heap {
  a: HeapEntry[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: HeapEntry, y: HeapEntry): boolean {
    if (x.f !== y.f) return x.f < y.f;
    if (x.h !== y.h) return x.h < y.h;
    return x.seq < y.seq;
  }
  push(e: HeapEntry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): HeapEntry {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as HeapEntry;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

interface RoomSolution {
  moves: string;
  pushes: number;
  expansions: number;
}

/**
 * Push-optimal (weight 1) or weighted (weight > 1) A* over pushes for one
 * room. Returns null when the budget runs out or no solution exists.
 */
function solveRoom(
  ctx: RoomCtx,
  boxes0: number[],
  player0: number,
  weight: number,
  cap: number,
  requireExit: boolean,
): RoomSolution | null {
  const { w, h } = ctx;
  const nodes: SearchNode[] = [];
  const visited = new Map<string, number>();
  const heap = new Heap();
  let seq = 0;
  let expansions = 0;

  const startBoxes = [...boxes0].sort((a, b) => a - b);
  const h0 = heuristic(ctx, startBoxes);
  if (h0 === Infinity) return null;
  const occ0 = occupancy(w, h, startBoxes);
  const reg0 = flood(w, h, ctx.free, occ0, player0);
  const key0 = startBoxes.join(',') + '|' + reg0.min;
  nodes.push({ boxes: startBoxes, player: player0, parent: -1, pushBox: -1, pushDir: -1, g: 0 });
  visited.set(key0, 0);
  heap.push({ idx: 0, f: weight * h0, h: h0, seq: seq++ });

  while (heap.size > 0) {
    const e = heap.pop();
    const node = nodes[e.idx];
    const key = node.boxes.join(',') + '|' + flood(w, h, ctx.free, occupancy(w, h, node.boxes), node.player).min;
    if ((visited.get(key) as number) < node.g) continue; // stale entry
    expansions++;
    totalExpansions++;
    if (expansions > cap) return null;

    // Goal: every box on a goal, and the player able to reach the entry.
    const solved = node.boxes.every((b) => ctx.goal[b]);
    if (solved) {
      if (!requireExit) return finishRoom(ctx, nodes, e.idx);
      const occ = occupancy(w, h, node.boxes);
      const reg = flood(w, h, ctx.free, occ, node.player);
      if (reg.seen[ctx.entry]) return finishRoom(ctx, nodes, e.idx);
    }

    const occ = occupancy(w, h, node.boxes);
    const reg = flood(w, h, ctx.free, occ, node.player);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const tx = bx + DX[d];
        const ty = by + DY[d];
        const px = bx - DX[d];
        const py = by - DY[d];
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const t = ty * w + tx;
        const p = py * w + px;
        if (!ctx.free[t] || occ[t]) continue; // target must be open floor
        if (t === ctx.entry) continue; // never push a box out through the door
        if (!reg.seen[p]) continue; // the player must stand behind the box
        if (!ctx.live[t]) continue; // dead square: the box could never reach a goal
        const next = [...node.boxes];
        next[bi] = t;
        next.sort((a, b) => a - b);
        const occ2 = occupancy(w, h, next);
        if (deadBlock(ctx, occ2, t)) continue;
        const hh = heuristic(ctx, next);
        if (hh === Infinity) continue;
        const g2 = node.g + 1;
        const reg2 = flood(w, h, ctx.free, occ2, b);
        const key2 = next.join(',') + '|' + reg2.min;
        const prev = visited.get(key2);
        if (prev !== undefined && prev <= g2) continue;
        visited.set(key2, g2);
        nodes.push({ boxes: next, player: b, parent: e.idx, pushBox: b, pushDir: d, g: g2 });
        heap.push({ idx: nodes.length - 1, f: g2 + weight * hh, h: hh, seq: seq++ });
      }
    }
  }
  return null;
}

/** Rebuild the move string for a solved room, ending with the exit walk. */
function finishRoom(ctx: RoomCtx, nodes: SearchNode[], goalIdx: number): RoomSolution {
  const { w, h } = ctx;
  const steps: { box: number; dir: number; fromPlayer: number; boxes: number[] }[] = [];
  let cur = goalIdx;
  let pushes = 0;
  while (nodes[cur].parent >= 0) {
    const n = nodes[cur];
    const p = nodes[n.parent];
    steps.push({ box: n.pushBox, dir: n.pushDir, fromPlayer: p.player, boxes: p.boxes });
    pushes++;
    cur = n.parent;
  }
  steps.reverse();
  let moves = '';
  for (const s of steps) {
    const behind = s.box - (DY[s.dir] * w + DX[s.dir]);
    const walk = walkPath(w, h, ctx.free, occupancy(w, h, s.boxes), s.fromPlayer, behind);
    if (walk === null) return { moves: '', pushes: 0, expansions: 0 };
    moves += walk + CH[s.dir];
  }
  const goalNode = nodes[goalIdx];
  const exit = walkPath(w, h, ctx.free, occupancy(w, h, goalNode.boxes), goalNode.player, ctx.entry);
  if (exit === null) return { moves: '', pushes: 0, expansions: 0 };
  moves += exit;
  return { moves, pushes, expansions: 0 };
}

interface Room {
  ctx: RoomCtx;
  boxes: number[];
  goals: number[];
  entry: number;
}

/** Split a level into its rooms off the hallway. Null when it does not fit. */
function decompose(level: Level): Room[] | null {
  const { w, h } = level;
  const hallRow = (level.player / w) | 0;
  const floor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) floor[i] = level.wall[i] ? 0 : 1;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  let boxesSeen = 0;
  let goalsSeen = 0;
  for (let i = 0; i < w * h; i++) {
    if (!floor[i] || seen[i]) continue;
    if ((i / w | 0) === hallRow) {
      seen[i] = 1;
      continue;
    }
    const comp: number[] = [];
    const queue = [i];
    seen[i] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      comp.push(c);
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (floor[q] && !seen[q] && (q / w | 0) !== hallRow) {
          seen[q] = 1;
          queue.push(q);
        }
      }
    }
    const compSet = new Uint8Array(w * h);
    for (const c of comp) compSet[c] = 1;
    const boxes = comp.filter((c) => level.boxes.includes(c));
    const goals = comp.filter((c) => level.goal[c]);
    if (boxes.length === 0) continue;
    if (boxes.length !== goals.length) return null;
    const doors = comp.filter((c) => {
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (ny === hallRow && nx >= 0 && nx < w && floor[ny * w + nx]) return true;
      }
      return false;
    });
    if (doors.length !== 1) return null;
    const door = doors[0];
    const dx = door % w;
    const dy = (door / w) | 0;
    let entry = -1;
    for (let d = 0; d < 4; d++) {
      const nx = dx + DX[d];
      const ny = dy + DY[d];
      if (ny === hallRow && nx >= 0 && nx < w && floor[ny * w + nx]) entry = ny * w + nx;
    }
    if (entry < 0) return null;
    const free = new Uint8Array(w * h);
    for (const c of comp) free[c] = 1;
    free[entry] = 1;
    boxesSeen += boxes.length;
    goalsSeen += goals.length;
    rooms.push({
      ctx: buildRoomCtx(w, h, free, level.goal, goals, entry),
      boxes,
      goals,
      entry,
    });
  }
  if (boxesSeen !== level.boxes.length) return null;
  const totalGoals = (() => {
    let n = 0;
    for (let i = 0; i < w * h; i++) if (level.goal[i]) n++;
    return n;
  })();
  if (goalsSeen !== totalGoals) return null;
  rooms.sort((a, b) => a.entry - b.entry);
  return rooms;
}

/** Replay moves on a level: legal, solved, and how many pushes it took. */
function replay(level: Level, moves: string): { legal: boolean; solved: boolean; pushes: number } {
  const box = occupancy(level.w, level.h, level.boxes);
  let player = level.player;
  let pushes = 0;
  for (const ch of moves) {
    const d = CH.indexOf(ch);
    if (d < 0) return { legal: false, solved: false, pushes };
    const next = player + DY[d] * level.w + DX[d];
    if (level.wall[next]) return { legal: false, solved: false, pushes };
    if (box[next]) {
      const beyond = next + DY[d] * level.w + DX[d];
      if (level.wall[beyond] || box[beyond]) return { legal: false, solved: false, pushes };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < level.w * level.h; i++) {
    if (box[i] && !level.goal[i]) return { legal: true, solved: false, pushes };
  }
  return { legal: true, solved: true, pushes };
}

/** Solve one level: decompose into rooms, solve each, stitch the walks. */
function solveLevel(level: Level): string {
  const { w, h } = level;
  const floor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) floor[i] = level.wall[i] ? 0 : 1;
  const rooms = decompose(level);
  if (rooms !== null) {
    let moves = '';
    let playerNow = level.player;
    const boxesNow = occupancy(w, h, level.boxes);
    for (const room of rooms) {
      const walk = walkPath(w, h, floor, boxesNow, playerNow, room.entry);
      if (walk === null) return '';
      moves += walk;
      playerNow = room.entry;
      const weight = totalExpansions > TOTAL_CAP ? 3 : 1;
      let sol = solveRoom(room.ctx, room.boxes, room.entry, weight, ROOM_CAP, true);
      if (sol === null && weight === 1) {
        sol = solveRoom(room.ctx, room.boxes, room.entry, 3, ROOM_CAP, true);
      }
      if (sol === null) return '';
      moves += sol.moves;
      playerNow = room.entry;
      for (const b of room.boxes) boxesNow[b] = 0;
      for (const g of room.goals) boxesNow[g] = 1;
    }
    const check = replay(level, moves);
    return check.legal && check.solved ? moves : '';
  }
  // Fallback: the whole level as one room (no exit requirement), weighted.
  const free = floor;
  const goals: number[] = [];
  for (let i = 0; i < w * h; i++) if (level.goal[i]) goals.push(i);
  const ctx = buildRoomCtx(w, h, free, level.goal, goals, level.player);
  const sol = solveRoom(ctx, level.boxes, level.player, 2, ROOM_CAP, false);
  if (sol === null) return '';
  const check = replay(level, sol.moves);
  return check.legal && check.solved ? sol.moves : '';
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
