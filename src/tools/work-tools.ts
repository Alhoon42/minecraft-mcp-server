import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFighting, cancelFight } from './defense-tools.js';
import { stopFollowing } from './extra-tools.js';

/*
 * Long-running "jobs" (dig-area, mine-ore) run in the background so the bot keeps
 * working between messages. Use work-status to check progress and stop-work to halt.
 */

type JobState = {
  name: string;
  running: boolean;
  stopRequested: boolean;
  dug: number;
  skipped: number;
  message: string;
  startedAt: number;
};

let currentJob: JobState | null = null;

// Where the bot goes when its bag is full (set with set-home).
let home: Vec3 | null = new Vec3(-386, 54, 71);

// Y limits: never dig above maxDigY or below minDigY (null = no limit)
let maxDigY: number | null = null;
let minDigY: number | null = null;
// Single protected levels, e.g. a floor at Y 25 (never dug). Saved so they survive restarts.
const keepLevels = new Set<number>();
const limitsFile = path.join(os.homedir(), '.claudebot', 'limits.json');
function saveLimits(): void {
  try {
    fs.mkdirSync(path.dirname(limitsFile), { recursive: true });
    fs.writeFileSync(limitsFile, JSON.stringify({ maxDigY, minDigY, keepLevels: [...keepLevels] }, null, 2));
  } catch (e) { log('warn', `could not save limits: ${e}`); }
}
try {
  const saved = JSON.parse(fs.readFileSync(limitsFile, 'utf8')) as { maxDigY?: number | null; minDigY?: number | null; keepLevels?: number[] };
  maxDigY = saved.maxDigY ?? null;
  minDigY = saved.minDigY ?? null;
  for (const y of saved.keepLevels ?? []) keepLevels.add(y);
} catch { /* nothing saved yet */ }
function outsideLimits(y: number): boolean {
  return keepLevels.has(y) || (maxDigY !== null && y > maxDigY) || (minDigY !== null && y < minDigY);
}

async function goHome(bot: mineflayer.Bot): Promise<void> {
  if (!home) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const movements: any = (bot.pathfinder as any).movements;
  try {
    // Walk back the natural way first (no digging)
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(home.x, home.y, home.z, 2)), 120000, bot);
    bot.chat('Back at base with a full bag!');
  } catch {
    // Only during a dig job: allow digging a way back if there's no open path
    if (movements) movements.canDig = true;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(home.x, home.y, home.z, 2)), 120000, bot);
      bot.chat('Back at base with a full bag!');
    } catch {
      bot.chat("My bag's full but I couldn't find my way back to base.");
    } finally {
      if (movements) movements.canDig = false;
    }
  }
}

// Blocks the bot must never break (while digging jobs or while path-finding).
const DEFAULT_PROTECTED = ['stone_bricks', 'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'ladder', 'torch', 'wall_torch', 'glass', 'glass_pane', 'hopper', 'oak_door', 'spruce_door', 'birch_door'];
const protectedNames: Set<string> = new Set(DEFAULT_PROTECTED);

function isProtected(name: string): boolean {
  return protectedNames.has(name) || name.endsWith('_bed') || name.endsWith('_door');
}

export function applyProtection(bot: mineflayer.Bot): void {
  try {
    const mcData = minecraftData(bot.version);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const movements: any = (bot.pathfinder as any).movements;
    if (!movements) return;
    if (!(movements.blocksCantBreak instanceof Set)) movements.blocksCantBreak = new Set();
    for (const [name, block] of Object.entries(mcData.blocksByName)) {
      if (isProtected(name)) movements.blocksCantBreak.add((block as { id: number }).id);
    }
    // Rule: only dig when asked. Walking around (come here, go to bed, chests...) finds a
    // natural path. Dig jobs (dig-area, mine-ore, dig-stairs) switch digging on themselves.
    movements.canDig = false;

    // Rule: never dig straight down. Going down through solid ground is only allowed
    // diagonally (forward + down), which makes stairs. Dropping into an open hole is still fine.
    if (!movements.__noDigDown && typeof movements.getMoveDown === 'function') {
      const orig = movements.getMoveDown.bind(movements);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      movements.getMoveDown = (node: any, neighbors: any[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tmp: any[] = [];
        orig(node, tmp);
        for (const m of tmp) if (!m.toBreak || m.toBreak.length === 0) neighbors.push(m);
      };
      movements.__noDigDown = true;
    }
  } catch (e) {
    log('warn', `applyProtection failed: ${e}`);
  }
}

const TOOL_SUFFIXES = ['_pickaxe', '_shovel', '_axe', '_hoe', 'shears'];
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'command_block']);
const DANGER = new Set(['lava', 'water']);
const DEFAULT_KEEP = ['_pickaxe', '_shovel', '_axe', '_sword', '_hoe', 'shears', 'torch', 'bread', 'cooked_', 'apple'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTool(item: any): boolean {
  return TOOL_SUFFIXES.some(s => item.name.endsWith(s));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function equipBestTool(bot: mineflayer.Bot, block: any): Promise<void> {
  const tools = bot.inventory.items().filter(isTool);
  if (tools.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let best: any = null;
  let bestTime = Infinity;
  for (const tool of tools) {
    let t = Infinity;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t = (block as any).digTime(tool.type, false, false, false, [], []);
    } catch {
      t = Infinity;
    }
    // Only count tools that can actually harvest the block (so ore drops)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const harvest = (block as any).harvestTools;
    if (harvest && !harvest[tool.type]) {
      t = t * 10;
    }
    if (t < bestTime) {
      bestTime = t;
      best = tool;
    }
  }
  if (best && (!bot.heldItem || bot.heldItem.type !== best.type)) {
    await bot.equip(best, 'hand');
  }
}

function inventoryFull(bot: mineflayer.Bot): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv: any = bot.inventory;
  const empty = typeof inv.emptySlotCount === 'function' ? inv.emptySlotCount() : 1;
  return empty === 0;
}

function shouldKeep(name: string, keep: string[]): boolean {
  return keep.some(k => name.includes(k));
}

async function tossJunk(bot: mineflayer.Bot, keep: string[]): Promise<number> {
  let tossed = 0;
  for (const item of bot.inventory.items()) {
    if (shouldKeep(item.name, keep)) continue;
    if (['cobblestone', 'cobbled_deepslate', 'dirt', 'gravel', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite'].includes(item.name)) {
      await bot.tossStack(item);
      tossed += item.count;
    }
  }
  return tossed;
}

async function collectNearbyDrops(bot: mineflayer.Bot, radius: number): Promise<void> {
  const drops = Object.values(bot.entities).filter(e =>
    e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= radius
  );
  for (const drop of drops.slice(0, 8)) {
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0)), 6000, bot);
    } catch {
      // ignore unreachable drops
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, bot: mineflayer.Bot): Promise<T> {
  let id: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => {
      bot.pathfinder.stop();
      reject(new Error('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (id) clearTimeout(id);
    p.catch(() => {});
  }
}

function touchesDanger(bot: mineflayer.Bot, pos: Vec3): boolean {
  // Water: only if it would flow in (next to or above the block)
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const [dx, dy, dz] of offsets) {
    const b = bot.blockAt(pos.offset(dx, dy, dz));
    if (b && DANGER.has(b.name)) return true;
  }
  // Lava: look 2 blocks around, including below, before opening anything up
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b && b.name === 'lava') return true;
      }
    }
  }
  return false;
}

// Air gap under a block deeper than this means a cave: digging it would drop the bot.
function dropBelow(bot: mineflayer.Bot, pos: Vec3): number {
  let depth = 0;
  for (let i = 1; i <= 6; i++) {
    const b = bot.blockAt(pos.offset(0, -i, 0));
    if (b && b.name !== 'air' && b.name !== 'cave_air') break;
    depth++;
  }
  return depth;
}

async function digOne(bot: mineflayer.Bot, pos: Vec3, job: JobState, allowDigPath: boolean): Promise<void> {
  if (outsideLimits(pos.y)) { job.skipped++; return; }
  // Wait while fighting off a mob
  while (isFighting() && !job.stopRequested) await sleep(300);
  const block = bot.blockAt(pos);
  if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return;
  if (UNBREAKABLE.has(block.name) || DANGER.has(block.name) || isProtected(block.name)) {
    job.skipped++;
    return;
  }
  if (touchesDanger(bot, pos)) {
    job.skipped++;
    return;
  }

  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const movements: any = (bot.pathfinder as any).movements;
    const prevCanDig = movements ? movements.canDig : undefined;
    if (movements && !allowDigPath) movements.canDig = false;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), 15000, bot);
    } catch {
      // try again letting the pathfinder dig its own way
      if (movements) movements.canDig = true;
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), 15000, bot);
      } catch {
        job.skipped++;
        if (movements) movements.canDig = prevCanDig;
        return;
      }
    }
    if (movements) movements.canDig = prevCanDig;
  }

  const fresh = bot.blockAt(pos);
  if (!fresh || fresh.name === 'air') return;
  await equipBestTool(bot, fresh);
  try {
    await bot.dig(fresh, true);
    job.dug++;
  } catch (e) {
    log('warn', `dig failed at ${pos}: ${e}`);
    job.skipped++;
  }
}

// Walk backwards for a moment so the bot doesn't pick its own drops back up
async function stepBack(bot: mineflayer.Bot): Promise<void> {
  try {
    bot.setControlState('back', true);
    await sleep(900);
  } finally {
    bot.setControlState('back', false);
  }
}


/**
 * Turn loose names into real block ids: "diamonds" -> diamond_ore + deepslate_diamond_ore,
 * "iron ore" -> iron_ore + deepslate_iron_ore, "logs" -> oak_log etc.
 */
export function resolveBlockNames(version: string, raw: string): string[] {
  const mcData = minecraftData(version);
  const has = (n: string) => mcData.blocksByName[n] !== undefined;
  let n = raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  // Trees / wood / logs -> every kind of log (oak, birch, spruce...)
  if (['tree', 'trees', 'wood', 'woods', 'log', 'logs', 'timber'].includes(n)) {
    return Object.keys(mcData.blocksByName).filter(b => b.endsWith('_log') && !b.startsWith('stripped_'));
  }
  // "birch tree", "oak wood" -> birch_log, oak_log
  const treeKind = n.match(/^([a-z_]+?)_(tree|trees|wood|logs?)$/);
  if (treeKind && has(`${treeKind[1]}_log`)) return [`${treeKind[1]}_log`];
  const ORES = ['diamond', 'iron', 'coal', 'gold', 'redstone', 'lapis', 'emerald', 'copper'];
  const base = n.replace(/s$/, '');
  if (ORES.includes(n) || ORES.includes(base)) n = `${ORES.includes(n) ? n : base}_ore`;
  if (n === 'lapis_lazuli_ore') n = 'lapis_ore';
  if (!has(n) && has(base)) n = base;
  const out = new Set<string>();
  if (has(n)) out.add(n);
  if (n.endsWith('_ore')) {
    const plain = n.replace(/^deepslate_/, '');
    if (has(plain)) out.add(plain);
    if (has(`deepslate_${plain}`)) out.add(`deepslate_${plain}`);
  }
  if (out.size === 0 && has(`${n}_ore`)) { out.add(`${n}_ore`); if (has(`deepslate_${n}_ore`)) out.add(`deepslate_${n}_ore`); }
  return [...out];
}

/** One-line summary of the current job, for the Qwen brain. */
export function jobSummary(): string {
  if (!currentJob) return 'No job.';
  return `${currentJob.running ? 'Running' : 'Last'} job: ${currentJob.name} — ${currentJob.message} (dug ${currentJob.dug})`;
}

/** Emergency stop: cancel the job, walking, digging, following and fighting straight away. */
export function stopEverything(bot: mineflayer.Bot): void {
  if (currentJob?.running) currentJob.stopRequested = true;
  stopFollowing();
  cancelFight();
  try { bot.pathfinder.stop(); } catch { /* ignore */ }
  try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
  try { bot.stopDigging(); } catch { /* ignore */ }
  try { bot.clearControlStates(); } catch { /* ignore */ }
}

function startJob(name: string): JobState {
  currentJob = {
    name,
    running: true,
    stopRequested: false,
    dug: 0,
    skipped: 0,
    message: 'starting',
    startedAt: Date.now()
  };
  return currentJob;
}

export function registerWorkTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "toss-item",
    "Drop items from the bot's inventory on the ground in front of it (e.g. to hand them to a player). Use itemName 'all' to drop everything except tools and food.",
    {
      itemName: z.string().describe("Item name (e.g. 'coal', 'raw_iron') or 'all'"),
      count: z.coerce.number().int().positive().optional().describe("How many to drop (default: all of that item)"),
      lookAtX: z.coerce.number().optional().describe("Optional X to face before dropping (e.g. a player's position)"),
      lookAtY: z.coerce.number().optional(),
      lookAtZ: z.coerce.number().optional(),
    },
    async ({ itemName, count, lookAtX, lookAtY, lookAtZ }: { itemName: string; count?: number; lookAtX?: number; lookAtY?: number; lookAtZ?: number }) => {
      const bot = getBot();
      if (lookAtX !== undefined && lookAtY !== undefined && lookAtZ !== undefined) {
        await bot.lookAt(new Vec3(lookAtX, lookAtY + 1, lookAtZ), true);
      }
      if (itemName === 'all') {
        let total = 0;
        for (const item of bot.inventory.items()) {
          if (shouldKeep(item.name, DEFAULT_KEEP)) continue;
          await bot.tossStack(item);
          total += item.count;
          await sleep(100);
        }
        await stepBack(bot);
        return factory.createResponse(`Dropped ${total} items (kept tools and food)`);
      }
      const matching = bot.inventory.items().filter(i => i.name === itemName);
      if (matching.length === 0) {
        return factory.createResponse(`No ${itemName} in inventory`);
      }
      const have = matching.reduce((s, i) => s + i.count, 0);
      const amount = Math.min(count ?? have, have);
      await bot.toss(matching[0].type, null, amount);
      await stepBack(bot);
      return factory.createResponse(`Dropped ${amount} ${itemName}`);
    }
  );

  factory.registerTool(
    "dig-stairs",
    "Dig a staircase down (or up) to a target Y level, one step at a time, in a compass direction. Never digs straight down. Stops at lava, water or big drops. Places cobblestone over small gaps in the floor.",
    {
      targetY: z.coerce.number().int().describe("Y level to reach, e.g. -58 for diamonds"),
      direction: z.enum(['north', 'south', 'east', 'west']).optional().describe("Which way the stairs go (default: the way the bot is facing)"),
    },
    async ({ targetY, direction }: { targetY: number; direction?: 'north' | 'south' | 'east' | 'west' }) => {
      const bot = getBot();
      if (currentJob?.running) {
        return factory.createResponse(`Already running job '${currentJob.name}'. Call stop-work first.`);
      }
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
      let dir = direction;
      if (!dir) {
        const yaw = bot.entity.yaw; // 0 = north (−z) in mineflayer
        const a = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        dir = a < Math.PI / 4 || a >= 7 * Math.PI / 4 ? 'north' : a < 3 * Math.PI / 4 ? 'west' : a < 5 * Math.PI / 4 ? 'south' : 'east';
      }
      const [dx, dz] = dirs[dir];
      const up = targetY > Math.floor(bot.entity.position.y);
      applyProtection(bot);
      const job = startJob(`dig-stairs ${up ? 'up' : 'down'} ${dir} to Y${targetY}`);

      (async () => {
        try {
          let steps = 0;
          while (!job.stopRequested) {
            while (isFighting() && !job.stopRequested) await sleep(300);
            const cur = bot.entity.position.floored();
            if (cur.y === targetY) break;
            const next = cur.offset(dx, up ? 1 : -1, dz);
            // Clear feet, head and headroom of the next step (and the block above us when going up)
            const toClear = up
              ? [cur.offset(0, 2, 0), next, next.offset(0, 1, 0)]
              : [next, next.offset(0, 1, 0), next.offset(0, 2, 0)];
            let blocked = false;
            for (const p of toClear) {
              const b = bot.blockAt(p);
              if (!b) { blocked = true; break; }
              if (DANGER.has(b.name) || touchesDanger(bot, p)) {
                job.message = `Stopped: lava or water near (${p.x}, ${p.y}, ${p.z})`;
                bot.chat('Stopped digging stairs: lava or water ahead!');
                blocked = true; break;
              }
              if (outsideLimits(p.y) && b.name !== 'air' && b.name !== 'cave_air') {
                job.message = `Stopped: Y${p.y} is outside the digging limits`;
                blocked = true; break;
              }
              if (UNBREAKABLE.has(b.name) || isProtected(b.name)) {
                job.message = `Stopped: can't break ${b.name}`;
                blocked = true; break;
              }
              if (b.name !== 'air' && b.name !== 'cave_air') {
                await equipBestTool(bot, b);
                await bot.dig(b, true);
                job.dug++;
              }
            }
            if (blocked) break;
            // Floor under the next step
            const floorPos = next.offset(0, -1, 0);
            const floor = bot.blockAt(floorPos);
            if (floor && (floor.name === 'air' || floor.name === 'cave_air')) {
              if (dropBelow(bot, floorPos) > 3) {
                job.message = `Stopped: big drop at (${floorPos.x}, ${floorPos.y}, ${floorPos.z})`;
                bot.chat('Stopped digging stairs: there is a cave below.');
                break;
              }
              const filler = bot.inventory.items().find(i => ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'].includes(i.name));
              const support = bot.blockAt(floorPos.offset(0, -1, 0));
              if (filler && support && support.name !== 'air') {
                try {
                  await bot.equip(filler, 'hand');
                  await bot.placeBlock(support, new Vec3(0, 1, 0));
                } catch { /* walk on anyway */ }
              }
            }
            const movements: any = (bot.pathfinder as any).movements;
            const prev = movements?.canDig;
            if (movements) movements.canDig = false;
            try {
              await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z)), 10000, bot);
            } finally {
              if (movements) movements.canDig = prev;
            }
            steps++;
            job.message = `Step ${steps}, now at Y${next.y}`;
            if (steps % 50 === 0) await collectNearbyDrops(bot, 4);
          }
          job.message = job.stopRequested ? 'Stopped' : (job.message.startsWith('Stopped') ? job.message : `Reached Y${bot.entity.position.floored().y}`);
          bot.chat(`Stairs done: ${job.message}`);
        } catch (e) {
          job.message = `Error: ${e}`;
          log('warn', `dig-stairs error: ${e}`);
        } finally {
          job.running = false;
        }
      })();
      return factory.createResponse(`Started digging stairs ${up ? 'up' : 'down'} towards the ${dir} to Y${targetY}. Check with work-status.`);
    }
  );

  factory.registerTool(
    "dig-limits",
    "Set Y levels the bot must never dig outside of, anywhere. E.g. maxY 53 = leave everything above Y 53 alone. Use clear: true to remove the limits.",
    {
      maxY: z.coerce.number().int().optional().describe("Highest Y he may dig (blocks above are left alone)"),
      minY: z.coerce.number().int().optional().describe("Lowest Y he may dig"),
      clear: z.boolean().optional().describe("Remove all limits"),
    },
    async ({ maxY, minY, clear }: { maxY?: number; minY?: number; clear?: boolean }) => {
      if (clear) { maxDigY = null; minDigY = null; keepLevels.clear(); saveLimits(); return factory.createResponse('Digging limits and protected levels removed.'); }
      if (maxY !== undefined) maxDigY = maxY;
      if (minY !== undefined) minDigY = minY;
      saveLimits();
      return factory.createResponse(`Digging limits: ${maxDigY !== null ? `nothing above Y${maxDigY}` : 'no top limit'}, ${minDigY !== null ? `nothing below Y${minDigY}` : 'no bottom limit'}.`);
    }
  );

  factory.registerTool(
    "protect-level",
    "Never dig at one Y level (e.g. a floor the player built). With no y, uses the level of the floor the nearest player is standing on. remove: true un-protects it.",
    {
      y: z.coerce.number().int().optional().describe("Y level to leave alone (default: the floor under the player)"),
      remove: z.boolean().optional(),
    },
    async ({ y, remove }: { y?: number; remove?: boolean }) => {
      const bot = getBot();
      let level = y;
      if (level === undefined) {
        const player = Object.values(bot.players).find(p => p.entity && p.username !== bot.username);
        if (!player?.entity) return factory.createResponse("I can't see you. Tell me the Y level instead.");
        level = Math.floor(player.entity.position.y) - 1;
      }
      if (remove) keepLevels.delete(level); else keepLevels.add(level);
      saveLimits();
      const list = [...keepLevels].sort((a, b) => b - a).map(v => `Y${v}`).join(', ') || 'none';
      return factory.createResponse(`${remove ? 'No longer protecting' : 'Leaving alone'} Y${level}. Protected levels: ${list}`);
    }
  );

  factory.registerTool(
    "dig-inside-markers",
    "Dig a hole whose corners are marked with marker blocks (default amethyst_block, 'crystal blocks'). Finds the 4 corner markers nearby, then digs everything inside them from the markers' level down to bottomY, layer by layer. Marker blocks and their edge rows are left alone unless includeEdge is true.",
    {
      bottomY: z.coerce.number().int().describe("Lowest layer to dig"),
      topY: z.coerce.number().int().optional().describe("Highest layer to dig (default: the markers' level)"),
      marker: z.string().optional().describe("Marker block (default amethyst_block)"),
      includeEdge: z.boolean().optional().describe("Also dig the rows the markers sit on (default false = only inside)"),
      tossJunk: z.boolean().optional(),
    },
    async ({ bottomY, topY, marker = 'amethyst_block', includeEdge = false, tossJunk }: { bottomY: number; topY?: number; marker?: string; includeEdge?: boolean; tossJunk?: boolean }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const id = mcData.blocksByName[marker]?.id;
      if (id === undefined) return factory.createResponse(`Unknown marker block: ${marker}`);
      const found = bot.findBlocks({ matching: id, maxDistance: 64, count: 256 });
      // Find the biggest rectangle whose 4 corners are all markers on the same level
      const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
      const set = new Set(found.map(p => key(p.x, p.y, p.z)));
      let best: { minX: number; maxX: number; minZ: number; maxZ: number; y: number; area: number } | null = null;
      for (const a of found) {
        for (const b of found) {
          if (b.y !== a.y || b.x <= a.x || b.z <= a.z) continue;
          if (!set.has(key(a.x, a.y, b.z)) || !set.has(key(b.x, a.y, a.z))) continue;
          const area = (b.x - a.x) * (b.z - a.z);
          if (area >= 4 && (!best || area > best.area)) best = { minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z, y: a.y, area };
        }
      }
      if (!best) return factory.createResponse(`I can't find 4 ${marker} corners on the same level within 64 blocks.`);
      const e = includeEdge ? 0 : 1;
      const box = { x1: best.minX + e, x2: best.maxX - e, z1: best.minZ + e, z2: best.maxZ - e };
      const dig = factory.registry.get('dig-area');
      if (!dig) return factory.createResponse('dig-area is missing');
      const r = await dig.run({ ...box, topY: topY ?? best.y, bottomY, tossJunk,
        skip: includeEdge ? [{ x: best.minX, z: best.minZ }, { x: best.minX, z: best.maxZ }, { x: best.maxX, z: best.minZ }, { x: best.maxX, z: best.maxZ }] : [] });
      const text = r.content.map(c => c.text).join(' ');
      return factory.createResponse(`Markers found at corners (${best.minX},${best.minZ}) to (${best.maxX},${best.maxZ}), Y${best.y}. Digging X ${box.x1}..${box.x2}, Z ${box.z1}..${box.z2}. ${text}`);
    }
  );

  factory.registerTool(
    "dig-area",
    "Start a background job that clears a box of blocks layer by layer from the top down, row by row (snake pattern). Returns straight away; the bot keeps working until done or stop-work is called. Skips blocks next to lava/water and blocks over deep caves. Check progress with work-status.",
    {
      x1: z.coerce.number().describe("Corner 1 X"),
      z1: z.coerce.number().describe("Corner 1 Z"),
      x2: z.coerce.number().describe("Corner 2 X"),
      z2: z.coerce.number().describe("Corner 2 Z"),
      topY: z.coerce.number().describe("Highest layer to dig (Y)"),
      bottomY: z.coerce.number().describe("Lowest layer to dig (Y)"),
      skip: z.array(z.object({ x: z.coerce.number(), y: z.coerce.number().optional(), z: z.coerce.number() })).optional()
        .describe("Columns (x,z) or blocks (x,y,z) to leave alone, e.g. a ladder shaft"),
      tossJunk: z.boolean().optional().describe("When inventory is full, drop stone/dirt/gravel instead of stopping (default: false)"),
    },
    async (args: { x1: number; z1: number; x2: number; z2: number; topY: number; bottomY: number; skip?: { x: number; y?: number; z: number }[]; tossJunk?: boolean }) => {
      const bot = getBot();
      if (currentJob?.running) {
        return factory.createResponse(`Already running job '${currentJob.name}'. Call stop-work first.`);
      }
      const minX = Math.min(args.x1, args.x2), maxX = Math.max(args.x1, args.x2);
      const minZ = Math.min(args.z1, args.z2), maxZ = Math.max(args.z1, args.z2);
      const top = Math.max(args.topY, args.bottomY), bottom = Math.min(args.topY, args.bottomY);
      const skip = args.skip ?? [];
      const isSkipped = (x: number, y: number, zz: number) =>
        skip.some(s => s.x === x && s.z === zz && (s.y === undefined || s.y === y));

      applyProtection(bot);
      const job = startJob(`dig-area (${minX},${minZ})-(${maxX},${maxZ}) Y${top}..${bottom}`);

      (async () => {
        try {
          for (let y = top; y >= bottom && !job.stopRequested; y--) {
            let forward = true;
            for (let zz = maxZ; zz >= minZ && !job.stopRequested; zz--) {
              const xs: number[] = [];
              for (let x = minX; x <= maxX; x++) xs.push(x);
              if (!forward) xs.reverse();
              forward = !forward;
              for (const x of xs) {
                if (job.stopRequested) break;
                if (isSkipped(x, y, zz)) continue;
                const pos = new Vec3(x, y, zz);
                const b = bot.blockAt(pos);
                if (!b || b.name === 'air' || b.name === 'cave_air') continue;
                if (dropBelow(bot, pos) > 3) {
                  job.skipped++;
                  continue;
                }
                if (inventoryFull(bot)) {
                  if (args.tossJunk) {
                    await tossJunk(bot, DEFAULT_KEEP);
                  }
                  if (inventoryFull(bot)) {
                    job.message = `Paused: inventory full at Y${y} row Z${zz} – went back to base`;
                    bot.chat('My inventory is full! Heading back to base.');
                    job.stopRequested = true;
                    await goHome(bot);
                    break;
                  }
                }
                job.message = `Digging Y${y}, row Z${zz}`;
                await digOne(bot, pos, job, false);
              }
              await collectNearbyDrops(bot, 6);
            }
          }
          if (!job.stopRequested) {
            job.message = `Finished: dug ${job.dug} blocks, skipped ${job.skipped}`;
            bot.chat(`Big hole done! Dug ${job.dug} blocks.`);
          } else if (!job.message.startsWith('Paused')) {
            job.message = `Stopped: dug ${job.dug}, skipped ${job.skipped}`;
          }
        } catch (e) {
          job.message = `Error: ${e}`;
          log('error', `dig-area failed: ${e}`);
        } finally {
          job.running = false;
        }
      })();

      return factory.createResponse(`Started ${job.name}. It runs in the background; use work-status to check and stop-work to stop.`);
    }
  );

  factory.registerTool(
    "mine-ore",
    "Start a background job that finds and mines a block type nearby (e.g. coal_ore, iron_ore, deepslate_diamond_ore) until it has mined the target number or runs out. Picks up drops and always uses the best tool.",
    {
      blockType: z.string().describe("Block to mine, e.g. 'diamond_ore' or just 'diamonds' (deepslate versions are included automatically)"),
      alsoMine: z.array(z.string()).optional().describe("Other block types to count too, e.g. ['deepslate_coal_ore']"),
      target: z.coerce.number().int().positive().describe("How many blocks to mine"),
      maxDistance: z.coerce.number().optional().describe("Search radius (default 64)"),
    },
    async ({ blockType, alsoMine, target, maxDistance = 64 }: { blockType: string; alsoMine?: string[]; target: number; maxDistance?: number }) => {
      const bot = getBot();
      if (currentJob?.running) {
        return factory.createResponse(`Already running job '${currentJob.name}'. Call stop-work first.`);
      }
      const mcData = minecraftData(bot.version);
      // Forgiving names: "diamonds" -> diamond_ore + deepslate_diamond_ore
      const names = [...new Set([blockType, ...(alsoMine ?? [])].flatMap(n => {
        const r = resolveBlockNames(bot.version, n);
        return r.length ? r : [n];
      }))];
      const ids = names.map(n => mcData.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
      if (ids.length === 0) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }
      applyProtection(bot);
      const job = startJob(`mine-ore ${names.join('/')} x${target}`);

      (async () => {
        try {
          let misses = 0;
          while (job.dug < target && !job.stopRequested && misses < 3) {
            const found = bot.findBlocks({ point: bot.entity.position, matching: ids, maxDistance, count: 64 });
            if (found.length === 0) {
              misses++;
              job.message = 'No more found nearby';
              break;
            }
            // nearest first
            found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
            const pos = found[0];
            if (inventoryFull(bot)) {
              await tossJunk(bot, DEFAULT_KEEP);
              if (inventoryFull(bot)) {
                job.message = 'Paused: inventory full – went back to base';
                bot.chat('My inventory is full! Heading back to base.');
                await goHome(bot);
                break;
              }
            }
            job.message = `Mining ${bot.blockAt(pos)?.name} at (${pos.x}, ${pos.y}, ${pos.z})`;
            const before = job.dug;
            await digOne(bot, pos, job, true);
            if (job.dug === before) misses++;
            else misses = 0;
            await collectNearbyDrops(bot, 5);
          }
          if (job.dug >= target) {
            job.message = `Finished: mined ${job.dug}`;
            bot.chat(`Done! Mined ${job.dug} ${blockType}.`);
          } else if (!job.message.startsWith('Paused')) {
            job.message = `Stopped after mining ${job.dug} (${job.message})`;
          }
        } catch (e) {
          job.message = `Error: ${e}`;
          log('error', `mine-ore failed: ${e}`);
        } finally {
          job.running = false;
        }
      })();

      return factory.createResponse(`Started ${job.name}. It runs in the background; use work-status to check and stop-work to stop.`);
    }
  );

  factory.registerTool(
    "protect-blocks",
    "Set which block types the bot must never break (when digging or finding its way). Stone bricks, chests, furnaces, crafting tables, ladders, torches, glass, doors and beds are protected by default.",
    {
      add: z.array(z.string()).optional().describe("Block names to protect, e.g. ['oak_planks', 'polished_andesite']"),
      remove: z.array(z.string()).optional().describe("Block names to stop protecting"),
    },
    async ({ add, remove }: { add?: string[]; remove?: string[] }) => {
      const bot = getBot();
      for (const n of add ?? []) protectedNames.add(n);
      for (const n of remove ?? []) protectedNames.delete(n);
      // rebuild pathfinder set from scratch so removals take effect
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const movements: any = (bot.pathfinder as any).movements;
      if (movements) movements.blocksCantBreak = new Set();
      applyProtection(bot);
      return factory.createResponse(`Protected blocks: ${[...protectedNames].sort().join(', ')} (plus all beds and doors)`);
    }
  );

  factory.registerTool(
    "set-home",
    "Set the base the bot returns to when its bag is full (default -386, 54, 71). With no coordinates, uses the bot's current position.",
    {
      x: z.coerce.number().optional(), y: z.coerce.number().optional(), z: z.coerce.number().optional(),
    },
    async ({ x, y, z: zz }: { x?: number; y?: number; z?: number }) => {
      const bot = getBot();
      home = (x !== undefined && y !== undefined && zz !== undefined)
        ? new Vec3(x, y, zz)
        : bot.entity.position.floored();
      return factory.createResponse(`Home set to (${home.x}, ${home.y}, ${home.z})`);
    }
  );

  factory.registerTool(
    "work-status",
    "Check the progress of the current or last background job (dig-area / mine-ore)",
    {},
    async () => {
      if (!currentJob) return factory.createResponse('No job has been started.');
      const mins = Math.round((Date.now() - currentJob.startedAt) / 60000);
      return factory.createResponse(
        `${currentJob.running ? 'RUNNING' : 'NOT RUNNING'}: ${currentJob.name}\n` +
        `Dug: ${currentJob.dug}, skipped: ${currentJob.skipped}, minutes: ${mins}\n` +
        `Status: ${currentJob.message}`
      );
    }
  );

  factory.registerTool(
    "stop-work",
    "Stop everything straight away: the background job, walking, digging, following and fighting.",
    {},
    async () => {
      const bot = getBot();
      const had = currentJob?.running ? `${currentJob.name} (dug ${currentJob.dug} so far)` : null;
      stopEverything(bot);
      return factory.createResponse(had ? `Stopped ${had} and everything else` : 'Stopped everything');
    }
  );
}
