import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { applyProtection } from './work-tools.js';

/*
 * Named places (e.g. "chest 1", "furnaces") and a memory of what is in each chest.
 * Saved to ~/.claudebot/memory.json on the player's PC so it survives restarts.
 */

interface Place { x: number; y: number; z: number; }
interface ChestRecord { items: Record<string, number>; checkedAt: string; }
interface Memory {
  places: Record<string, Place>;
  chests: Record<string, ChestRecord>; // key "x,y,z"
}

const memDir = path.join(os.homedir(), '.claudebot');
const memFile = path.join(memDir, 'memory.json');
let mem: Memory | null = null;

function load(): Memory {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(memFile, 'utf8')) as Memory;
    mem.places ??= {};
    mem.chests ??= {};
  } catch {
    mem = { places: {}, chests: {} };
  }
  return mem;
}

function save(): void {
  try {
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(memFile, JSON.stringify(load(), null, 2));
  } catch (e) {
    log('warn', `could not save memory: ${e}`);
  }
}

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', first: '1', second: '2', third: '3', fourth: '4' };
/** "The Chest Three!" -> "chest 3", "chest3" -> "chest 3", "chest number 2" -> "chest 2" */
const norm = (name: string) => name.toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(the|number|no)\b/g, ' ')
  .replace(/\b([a-z]+)\b/g, w => NUMBER_WORDS[w] ?? w)
  .replace(/([a-z])(\d)/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim();
const key = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;


/**
 * Which chest a sign labels: a wall sign stuck on the front of a chest (sorting walls),
 * else the chest directly below the sign, else the closest chest within 2 blocks.
 */
function chestForSign(bot: mineflayer.Bot, sp: Vec3) {
  const ids = containerIds(bot);
  const sign = bot.blockAt(sp);
  if (sign && sign.name.includes('wall')) {
    const facing = String((sign.getProperties() as Record<string, unknown>).facing ?? '');
    const back: Record<string, [number, number]> = { north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0] };
    const d = back[facing];
    if (d) {
      const behind = bot.blockAt(sp.offset(d[0], 0, d[1]));
      if (behind && ids.includes(behind.type)) return behind;
    }
  }
  const below = bot.blockAt(sp.offset(0, -1, 0));
  if (below && ids.includes(below.type)) return below;
  return bot.findBlock({ matching: ids, maxDistance: 2, point: sp });
}

export function resolvePlace(name: string, bot?: mineflayer.Bot): Vec3 | null {
  const m = load();
  const want = norm(name);
  for (const [n, p] of Object.entries(m.places)) {
    if (norm(n) === want) return new Vec3(p.x, p.y, p.z);
  }
  // Not saved yet: look for a sign with that text on or next to a chest, and remember it
  if (bot) {
    const signs = bot.findBlocks({ matching: signIds(bot), maxDistance: 48, count: 100 });
    for (const sp of signs) {
      if (norm(signText(bot.blockAt(sp)).replace(/ \/ /g, ' ')) !== want) continue;
      const chest = chestForSign(bot, sp);
      if (!chest) continue;
      const c = chest.position;
      m.places[want] = { x: c.x, y: c.y, z: c.z };
      save();
      return c.clone();
    }
  }
  return null;
}

/** The chest nearest to the nearest player (for "I'm standing on/next to the chest"). */
export function chestNearPlayer(bot: mineflayer.Bot): Vec3 | null {
  const player = nearestPlayer(bot);
  if (!player?.entity) return null;
  const c = bot.findBlock({ matching: containerIds(bot), maxDistance: 4, point: player.entity.position });
  return c ? c.position.clone() : null;
}

function placeNameFor(pos: Vec3): string | null {
  const m = load();
  for (const [n, p] of Object.entries(m.places)) {
    if (p.x === pos.x && p.y === pos.y && p.z === pos.z) return n;
  }
  return null;
}

function label(pos: Vec3): string {
  const n = placeNameFor(pos);
  return n ? `"${n}" (${pos.x}, ${pos.y}, ${pos.z})` : `(${pos.x}, ${pos.y}, ${pos.z})`;
}

/** Remember the full contents of an open chest. Call after any deposit/withdraw. */
export function recordChest(pos: Vec3, items: { name: string; count: number }[]): void {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  load().chests[key(pos)] = { items: counts, checkedAt: new Date().toISOString() };
  save();
}

function describe(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'empty';
  return entries.map(([n, c]) => `${n} x${c}`).join(', ');
}

async function gotoNear(bot: mineflayer.Bot, pos: Vec3, range: number, ms = 60000): Promise<void> {
  applyProtection(bot);
  let id: ReturnType<typeof setTimeout> | null = null;
  const p = bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
  const t = new Promise<never>((_, reject) => {
    id = setTimeout(() => { bot.pathfinder.stop(); reject(new Error('Could not get there in time')); }, ms);
  });
  try { await Promise.race([p, t]); } finally { if (id) clearTimeout(id); p.catch(() => {}); }
}

function containerIds(bot: mineflayer.Bot): number[] {
  const mcData = minecraftData(bot.version);
  return ['chest', 'trapped_chest', 'barrel']
    .map(n => mcData.blocksByName[n]?.id)
    .filter((id): id is number => id !== undefined);
}

function nearestPlayer(bot: mineflayer.Bot) {
  let best: mineflayer.Player | null = null;
  let bestD = Infinity;
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue;
    const d = p.entity.position.distanceTo(bot.entity.position);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

async function openAndRecord(bot: mineflayer.Bot, pos: Vec3): Promise<Record<string, number>> {
  const block = bot.blockAt(pos);
  if (!block) throw new Error('Chest not loaded');
  await gotoNear(bot, pos, 2);
  const c = await bot.openContainer(block);
  try {
    recordChest(pos, c.containerItems());
  } finally {
    c.close();
  }
  return load().chests[key(pos)].items;
}

function signIds(bot: mineflayer.Bot): number[] {
  const mcData = minecraftData(bot.version);
  return Object.values(mcData.blocksByName).filter(b => b.name.endsWith('_sign')).map(b => b.id);
}

function signText(block: any): string {
  try {
    const t = block.getSignText?.();
    const parts: string[] = Array.isArray(t) ? t : [String(t ?? '')];
    return parts.map(s => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  } catch {
    return '';
  }
}

export function registerPlacesTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "sort-into-chests",
    "Put items into the chests whose signs name them (e.g. a 'Dirt' sign = dirt chest, 'Cobblestone' or 'Cobble' = cobblestone, 'Iron' = raw_iron and iron_ingot). Keeps tools, torches and food. Anything without a matching chest stays in the bag.",
    {},
    async () => {
      const bot = getBot();
      const signs = bot.findBlocks({ matching: signIds(bot), maxDistance: 32, count: 100 });
      const targets: { words: string[]; label: string; chest: Vec3 }[] = [];
      for (const sp of signs) {
        const text = signText(bot.blockAt(sp)).replace(/ \/ /g, ' ');
        const chest = text ? chestForSign(bot, sp) : null;
        if (!chest) continue;
        const words = norm(text).split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w) && w !== 'chest')
          .map(w => w.replace(/s$/, '').replace(/^cobble$/, 'cobblestone'));
        if (words.length) targets.push({ words, label: text, chest: chest.position.clone() });
      }
      if (targets.length === 0) return factory.createResponse('No signs on chests that name items.');
      const keep = ['_pickaxe', '_shovel', '_axe', '_sword', '_hoe', 'shears', 'torch', 'bread', 'cooked_', 'apple'];
      // group the bag by target chest
      const plan = new Map<string, { chest: Vec3; label: string; items: string[] }>();
      for (const it of bot.inventory.items()) {
        if (keep.some(k => it.name.includes(k))) continue;
        const parts = it.name.split('_');
        const t = targets.find(tg => tg.words.every(w => parts.some(p => p.replace(/s$/, '') === w) || it.name === w));
        if (!t) continue;
        const k = `${t.chest.x},${t.chest.y},${t.chest.z}`;
        if (!plan.has(k)) plan.set(k, { chest: t.chest, label: t.label, items: [] });
        if (!plan.get(k)!.items.includes(it.name)) plan.get(k)!.items.push(it.name);
      }
      if (plan.size === 0) return factory.createResponse("Nothing in my bag matches any chest's sign.");
      const lines: string[] = [];
      for (const { chest, label, items } of plan.values()) {
        try {
          await gotoNear(bot, chest, 2);
          const c = await bot.openContainer(bot.blockAt(chest)!);
          let n = 0;
          try {
            for (const name of items) {
              for (const it of bot.inventory.items().filter(i => i.name === name)) {
                try { await c.deposit(it.type, null, it.count); n += it.count; } catch { break; }
              }
            }
            recordChest(chest, c.containerItems());
          } finally { c.close(); }
          lines.push(`${label}: ${n} (${items.join(', ')})`);
        } catch (e) {
          lines.push(`${label}: couldn't use it (${String(e).slice(0, 60)})`);
        }
      }
      return factory.createResponse(`Sorted:\n${lines.join('\n')}`);
    }
  );

  factory.registerTool(
    "read-signs",
    "Read the text on all signs within range (default 16 blocks).",
    { maxDistance: z.coerce.number().optional() },
    async ({ maxDistance = 16 }: { maxDistance?: number }) => {
      const bot = getBot();
      const found = bot.findBlocks({ matching: signIds(bot), maxDistance, count: 100 });
      if (found.length === 0) return factory.createResponse('No signs nearby.');
      const lines = found.map(pos => {
        const text = signText(bot.blockAt(pos));
        return `- (${pos.x}, ${pos.y}, ${pos.z}): ${text || '(blank)'}`;
      });
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "name-chests-from-signs",
    "For every sign within 16 blocks that is on or next to a chest (within 2 blocks), save that chest as a named place using the sign's text. Then 'put coal in <sign text>' works.",
    {},
    async () => {
      const bot = getBot();
      const signs = bot.findBlocks({ matching: signIds(bot), maxDistance: 16, count: 100 });
      const lines: string[] = [];
      for (const sp of signs) {
        const text = signText(bot.blockAt(sp)).replace(/ \/ /g, ' ');
        if (!text) continue;
        const chest = chestForSign(bot, sp);
        if (!chest) continue;
        const p = chest.position;
        load().places[norm(text)] = { x: p.x, y: p.y, z: p.z };
        lines.push(`- "${norm(text)}" = chest at (${p.x}, ${p.y}, ${p.z})`);
      }
      save();
      return factory.createResponse(lines.length ? `Named ${lines.length} chest(s):\n${lines.join('\n')}` : 'No signs next to chests found.');
    }
  );

  factory.registerTool(
    "save-place",
    "Give a name to a spot so it can be used later (e.g. 'chest 1', 'furnaces', 'diamond chest'). With no coordinates it uses the chest nearest to the player (within 4 blocks), or else where the player is standing.",
    {
      name: z.string().describe("Name for the place, e.g. 'chest 1'"),
      x: z.coerce.number().optional(), y: z.coerce.number().optional(), z: z.coerce.number().optional(),
    },
    async ({ name, x, y, z: zz }: { name: string; x?: number; y?: number; z?: number }) => {
      const bot = getBot();
      let pos: Vec3 | null = null;
      if (x !== undefined && y !== undefined && zz !== undefined) {
        pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(zz));
      } else {
        const player = nearestPlayer(bot);
        if (!player?.entity) return factory.createResponse("I can't see a player near me. Give me coordinates instead.");
        const chest = bot.findBlock({ matching: containerIds(bot), maxDistance: 4, point: player.entity.position });
        pos = chest ? chest.position.clone() : player.entity.position.floored();
      }
      load().places[norm(name)] = { x: pos.x, y: pos.y, z: pos.z };
      save();
      const what = bot.blockAt(pos)?.name ?? 'spot';
      return factory.createResponse(`Saved "${norm(name)}" = ${what} at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "list-places",
    "List all named places, and what is remembered in each chest.",
    {},
    async () => {
      const m = load();
      const lines = Object.entries(m.places).map(([n, p]) => {
        const rec = m.chests[key(p)];
        return `- ${n}: (${p.x}, ${p.y}, ${p.z})${rec ? ` — ${describe(rec.items)}` : ''}`;
      });
      return factory.createResponse(lines.length ? lines.join('\n') : 'No places saved yet.');
    }
  );

  factory.registerTool(
    "forget-place",
    "Remove a named place.",
    { name: z.string() },
    async ({ name }: { name: string }) => {
      const m = load();
      if (!m.places[norm(name)]) return factory.createResponse(`No place called "${name}".`);
      delete m.places[norm(name)];
      save();
      return factory.createResponse(`Forgot "${norm(name)}".`);
    }
  );

  factory.registerTool(
    "go-to-place",
    "Walk to a named place.",
    { name: z.string() },
    async ({ name }: { name: string }) => {
      const bot = getBot();
      const pos = resolvePlace(name, bot);
      if (!pos) return factory.createResponse(`No place called "${name}". Use list-places.`);
      await gotoNear(bot, pos, 2, 120000);
      return factory.createResponse(`At "${norm(name)}"`);
    }
  );

  factory.registerTool(
    "check-chests",
    "Open chests and remember what's in them. Give a place name to check one chest, or leave empty to check every chest within 16 blocks.",
    { name: z.string().optional().describe("Named place to check (default: all nearby chests)") },
    async ({ name }: { name?: string }) => {
      const bot = getBot();
      let targets: Vec3[];
      if (name) {
        const pos = resolvePlace(name, bot);
        if (!pos) return factory.createResponse(`No place called "${name}".`);
        targets = [pos];
      } else {
        targets = bot.findBlocks({ matching: containerIds(bot), maxDistance: 16, count: 50 });
      }
      if (targets.length === 0) return factory.createResponse('No chests nearby.');
      const lines: string[] = [];
      for (const pos of targets) {
        try {
          const items = await openAndRecord(bot, pos);
          lines.push(`- ${label(pos)}: ${describe(items)}`);
        } catch (e) {
          lines.push(`- ${label(pos)}: couldn't open (${e})`);
        }
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "where-is",
    "Say which chest(s) hold an item, from memory (no walking). Matches part of a name, e.g. 'iron' finds iron_ingot and raw_iron.",
    { itemName: z.string() },
    async ({ itemName }: { itemName: string }) => {
      const m = load();
      const q = norm(itemName).replace(/\s+/g, '_');
      const lines: string[] = [];
      for (const [k, rec] of Object.entries(m.chests)) {
        const hits = Object.entries(rec.items).filter(([n]) => n.includes(q));
        if (hits.length === 0) continue;
        const [x, y, zz] = k.split(',').map(Number);
        lines.push(`- ${label(new Vec3(x, y, zz))}: ${hits.map(([n, c]) => `${n} x${c}`).join(', ')}`);
      }
      return factory.createResponse(lines.length
        ? lines.join('\n')
        : `I don't remember any ${itemName} in a chest. Try check-chests to look again.`);
    }
  );
}
