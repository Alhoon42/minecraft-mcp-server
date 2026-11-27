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

const norm = (name: string) => name.trim().toLowerCase();
const key = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

export function resolvePlace(name: string): Vec3 | null {
  const p = load().places[norm(name)];
  return p ? new Vec3(p.x, p.y, p.z) : null;
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
        // Sign directly above a chest wins; otherwise the closest chest within 2 blocks
        const below = bot.blockAt(sp.offset(0, -1, 0));
        const chest = (below && containerIds(bot).includes(below.type))
          ? below
          : bot.findBlock({ matching: containerIds(bot), maxDistance: 2, point: sp });
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
      const pos = resolvePlace(name);
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
        const pos = resolvePlace(name);
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
