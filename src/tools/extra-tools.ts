import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { applyProtection } from './work-tools.js';
import { resolvePlace, recordChest, chestNearPlayer } from './places-tools.js';

/*
 * Extra everyday commands: craft (reliable, uses a crafting table), chests,
 * eating, torches, follow a player, sleep in a bed.
 */

let followTimer: ReturnType<typeof setInterval> | null = null;

export function stopFollowing(): void {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
}
let followTarget: string | null = null;

async function gotoNear(bot: mineflayer.Bot, pos: Vec3, range: number, ms = 30000): Promise<void> {
  applyProtection(bot);
  let id: ReturnType<typeof setTimeout> | null = null;
  const p = bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
  const t = new Promise<never>((_, reject) => {
    id = setTimeout(() => {
      bot.pathfinder.stop();
      reject(new Error('Could not get there in time'));
    }, ms);
  });
  try {
    await Promise.race([p, t]);
  } finally {
    if (id) clearTimeout(id);
    p.catch(() => {});
  }
}

function findBlockByName(bot: mineflayer.Bot, names: string[], maxDistance: number) {
  const mcData = minecraftData(bot.version);
  const ids = names.map(n => mcData.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
  if (ids.length === 0) return null;
  return bot.findBlock({ matching: ids, maxDistance });
}

function bedNames(bot: mineflayer.Bot): string[] {
  const mcData = minecraftData(bot.version);
  return Object.keys(mcData.blocksByName).filter(n => n.endsWith('_bed'));
}

async function placeNear(bot: mineflayer.Bot, itemName: string): Promise<boolean> {
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return false;
  const base = bot.entity.position.floored();
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [-1, 0, -1]];
  for (const [dx, , dz] of offsets) {
    const target = base.offset(dx, 0, dz);
    const at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (at && at.name === 'air' && below && below.name !== 'air') {
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        return true;
      } catch (e) {
        log('warn', `place ${itemName} failed: ${e}`);
      }
    }
  }
  return false;
}

export function registerExtraTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  // ---------- CRAFT ----------
  factory.registerTool(
    "craft",
    "Craft an item reliably. Uses a nearby crafting table (walks to it), or places one from inventory if needed. Example: craft 'oak_planks' x4, 'stick', 'wooden_sword', 'furnace', 'torch'.",
    {
      item: z.string().describe("Item to make, e.g. 'birch_planks', 'stick', 'stone_pickaxe', 'torch'"),
      times: z.coerce.number().int().positive().optional().describe("How many times to run the recipe (default 1)"),
    },
    async ({ item, times = 1 }: { item: string; times?: number }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemData = mcData.itemsByName[item];
      if (!itemData) return factory.createResponse(`Unknown item: ${item}`);

      // Try 2x2 first if possible
      const handRecipes = bot.recipesFor(itemData.id, null, 1, null);
      let table = findBlockByName(bot, ['crafting_table'], 32);
      const tableRecipes = bot.recipesFor(itemData.id, null, 1, table ?? true);

      if (handRecipes.length === 0 && tableRecipes.length === 0) {
        return factory.createResponse(`Can't craft ${item}: missing ingredients (or no recipe).`);
      }

      // Prefer a crafting table: the 2x2 inventory grid times out on some servers
      if (!table && tableRecipes.length > 0) {
        const placed = await placeNear(bot, 'crafting_table');
        if (placed) table = findBlockByName(bot, ['crafting_table'], 6);
      }

      if (table) {
        await gotoNear(bot, table.position, 2);
        const recipes = bot.recipesFor(itemData.id, null, 1, table);
        if (recipes.length === 0) return factory.createResponse(`Can't craft ${item}: missing ingredients.`);
        let made = 0;
        for (let i = 0; i < times; i++) {
          const r = bot.recipesFor(itemData.id, null, 1, table);
          if (r.length === 0) break;
          await bot.craft(r[0], 1, table);
          made++;
        }
        return factory.createResponse(`Crafted ${item} x${made} at the crafting table (${table.position.x}, ${table.position.y}, ${table.position.z})`);
      }

      if (handRecipes.length > 0) {
        let made = 0;
        for (let i = 0; i < times; i++) {
          const r = bot.recipesFor(itemData.id, null, 1, null);
          if (r.length === 0) break;
          await bot.craft(r[0], 1, undefined);
          made++;
        }
        return factory.createResponse(`Crafted ${item} x${made} (no crafting table)`);
      }

      return factory.createResponse(`${item} needs a crafting table. Give me one or put one nearby.`);
    }
  );

  // ---------- CHESTS ----------
  factory.registerTool(
    "deposit-to-chest",
    "Walk to the nearest chest (or the one at x,y,z) and put items in. itemName 'all' stores everything except tools and food.",
    {
      itemName: z.string().describe("Item to store, or 'all'"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: all of that item)"),
      x: z.coerce.number().optional(), y: z.coerce.number().optional(), z: z.coerce.number().optional(),
      place: z.string().optional().describe("Named place, e.g. 'chest 1' (see save-place)"),
      nearPlayer: z.boolean().optional().describe("Use the chest the player is standing on or next to"),
    },
    async ({ itemName, count, x, y, z: zz, place, nearPlayer }: { itemName: string; count?: number; x?: number; y?: number; z?: number; place?: string; nearPlayer?: boolean }) => {
      const bot = getBot();
      let named: Vec3 | null = null;
      if (nearPlayer) {
        named = chestNearPlayer(bot);
        if (!named) return factory.createResponse("I can't see a chest right next to you.");
      } else if (place) {
        named = resolvePlace(place, bot);
        if (!named) return factory.createResponse(`No place called "${place}". Use list-places.`);
      }
      const chestBlock = named
        ? bot.blockAt(named)
        : (x !== undefined && y !== undefined && zz !== undefined)
        ? bot.blockAt(new Vec3(x, y, zz))
        : findBlockByName(bot, ['chest', 'trapped_chest', 'barrel'], 32);
      if (!chestBlock) return factory.createResponse('No chest found nearby.');
      await gotoNear(bot, chestBlock.position, 2);
      const chest = await bot.openContainer(chestBlock);
      const keep = ['_pickaxe', '_shovel', '_axe', '_sword', '_hoe', 'shears', 'torch', 'bread', 'cooked_', 'apple'];
      let stored = 0;
      try {
        const items = bot.inventory.items().filter(i =>
          itemName === 'all' ? !keep.some(k => i.name.includes(k)) : i.name === itemName);
        for (const it of items) {
          const amount = (itemName !== 'all' && count !== undefined) ? Math.min(count - stored, it.count) : it.count;
          if (amount <= 0) break;
          try {
            await chest.deposit(it.type, null, amount);
            stored += amount;
          } catch (e) {
            log('warn', `deposit failed: ${e}`);
            break;
          }
        }
      } finally {
        try { recordChest(chestBlock.position, chest.containerItems()); } catch {}
        chest.close();
      }
      return factory.createResponse(`Stored ${stored} item(s) in the chest at (${chestBlock.position.x}, ${chestBlock.position.y}, ${chestBlock.position.z})`);
    }
  );

  factory.registerTool(
    "withdraw-from-chest",
    "Take items out of the nearest chest (or the one at x,y,z).",
    {
      itemName: z.string().describe("Item to take"),
      count: z.coerce.number().int().positive().optional().describe("How many (default: all)"),
      x: z.coerce.number().optional(), y: z.coerce.number().optional(), z: z.coerce.number().optional(),
      place: z.string().optional().describe("Named place, e.g. 'chest 1' (see save-place)"),
      nearPlayer: z.boolean().optional().describe("Use the chest the player is standing on or next to"),
    },
    async ({ itemName, count, x, y, z: zz, place, nearPlayer }: { itemName: string; count?: number; x?: number; y?: number; z?: number; place?: string; nearPlayer?: boolean }) => {
      const bot = getBot();
      let named: Vec3 | null = null;
      if (nearPlayer) {
        named = chestNearPlayer(bot);
        if (!named) return factory.createResponse("I can't see a chest right next to you.");
      } else if (place) {
        named = resolvePlace(place, bot);
        if (!named) return factory.createResponse(`No place called "${place}". Use list-places.`);
      }
      const chestBlock = named
        ? bot.blockAt(named)
        : (x !== undefined && y !== undefined && zz !== undefined)
        ? bot.blockAt(new Vec3(x, y, zz))
        : findBlockByName(bot, ['chest', 'trapped_chest', 'barrel'], 32);
      if (!chestBlock) return factory.createResponse('No chest found nearby.');
      await gotoNear(bot, chestBlock.position, 2);
      const chest = await bot.openContainer(chestBlock);
      try {
        const have = chest.containerItems().filter(i => i.name === itemName);
        const total = have.reduce((s, i) => s + i.count, 0);
        if (total === 0) {
          const what = [...new Set(chest.containerItems().map(i => i.name))].join(', ') || 'nothing';
          return factory.createResponse(`No ${itemName} in that chest. It has: ${what}`);
        }
        const amount = Math.min(count ?? total, total);
        await chest.withdraw(have[0].type, null, amount);
        return factory.createResponse(`Took ${amount} ${itemName} from the chest`);
      } finally {
        try { recordChest(chestBlock.position, chest.containerItems()); } catch {}
        chest.close();
      }
    }
  );

  // ---------- EAT ----------
  factory.registerTool(
    "eat",
    "Eat the best food in the inventory to restore hunger (and so health).",
    {},
    async () => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const foods: any = (mcData as any).foodsByName ?? {};
      const options = bot.inventory.items()
        .filter(i => foods[i.name])
        .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0));
      if (options.length === 0) return factory.createResponse(`I've got no food. Hunger ${bot.food}/20, health ${Math.round(bot.health)}/20.`);
      if (bot.food >= 20) return factory.createResponse(`Not hungry (hunger 20/20, health ${Math.round(bot.health)}/20).`);
      await bot.equip(options[0], 'hand');
      await bot.consume();
      return factory.createResponse(`Ate ${options[0].name}. Hunger ${bot.food}/20, health ${Math.round(bot.health)}/20.`);
    }
  );

  // ---------- TORCHES ----------
  factory.registerTool(
    "place-torch",
    "Place a torch at x,y,z (on the floor or on a wall next to it), or on the floor next to the bot if no position given.",
    {
      x: z.coerce.number().optional(), y: z.coerce.number().optional(), z: z.coerce.number().optional(),
      place: z.string().optional().describe("Named place, e.g. 'chest 1' (see save-place)"),
      nearPlayer: z.boolean().optional().describe("Use the chest the player is standing on or next to"),
    },
    async ({ x, y, z: zz }: { x?: number; y?: number; z?: number }) => {
      const bot = getBot();
      const torch = bot.inventory.items().find(i => i.name === 'torch');
      if (!torch) return factory.createResponse("I've got no torches. Craft some (coal + stick) or give me some.");
      const target = (x !== undefined && y !== undefined && zz !== undefined)
        ? new Vec3(x, y, zz)
        : bot.entity.position.floored().offset(1, 0, 0);
      if (target.distanceTo(bot.entity.position) > 4) await gotoNear(bot, target, 2);
      const faces: [Vec3, Vec3][] = [
        [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],
        [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],
        [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],
        [new Vec3(0, 0, 1), new Vec3(0, 0, -1)],
        [new Vec3(0, 0, -1), new Vec3(0, 0, 1)],
      ];
      await bot.equip(torch, 'hand');
      for (const [offset, face] of faces) {
        const ref = bot.blockAt(target.plus(offset));
        if (ref && ref.name !== 'air' && ref.boundingBox === 'block') {
          try {
            await bot.placeBlock(ref, face);
            return factory.createResponse(`Placed a torch at (${target.x}, ${target.y}, ${target.z})`);
          } catch (e) {
            log('warn', `torch place failed: ${e}`);
          }
        }
      }
      return factory.createResponse(`Couldn't place a torch at (${target.x}, ${target.y}, ${target.z}) – nothing solid to stick it to.`);
    }
  );

  // ---------- FOLLOW ----------
  factory.registerTool(
    "follow-player",
    "Keep following a player around (runs in the background until stop-following is called).",
    {
      playerName: z.string().optional().describe("Player to follow (default: nearest player)"),
      distance: z.coerce.number().optional().describe("How close to stay (default 3)"),
    },
    async ({ playerName, distance = 3 }: { playerName?: string; distance?: number }) => {
      const bot = getBot();
      let name = playerName;
      if (!name) {
        const others = Object.values(bot.players).filter(p => p.username !== bot.username && p.entity);
        others.sort((a, b) => a.entity.position.distanceTo(bot.entity.position) - b.entity.position.distanceTo(bot.entity.position));
        name = others[0]?.username;
      }
      if (!name || !bot.players[name]) return factory.createResponse("Can't see a player to follow.");
      if (followTimer) clearInterval(followTimer);
      followTarget = name;
      followTimer = setInterval(() => {
        const p = followTarget ? bot.players[followTarget] : null;
        if (!p || !p.entity) return;
        const dist = p.entity.position.distanceTo(bot.entity.position);
        if (dist > distance + 1) {
          bot.pathfinder.setGoal(new goals.GoalNear(p.entity.position.x, p.entity.position.y, p.entity.position.z, distance));
        }
      }, 1000);
      bot.chat(`Following ${name}!`);
      return factory.createResponse(`Now following ${name}. Use stop-following to stop.`);
    }
  );

  factory.registerTool(
    "stop-following",
    "Stop following a player.",
    {},
    async () => {
      const bot = getBot();
      if (followTimer) clearInterval(followTimer);
      followTimer = null;
      followTarget = null;
      bot.pathfinder.setGoal(null);
      return factory.createResponse('Stopped following.');
    }
  );

  // ---------- SLEEP ----------
  factory.registerTool(
    "sleep",
    "Find the nearest bed and sleep in it (only works at night or in a thunderstorm). Wakes up automatically in the morning.",
    {},
    async () => {
      const bot = getBot();
      const bed = findBlockByName(bot, bedNames(bot), 48);
      if (!bed) return factory.createResponse('No bed found nearby. Place a bed for me.');
      await gotoNear(bot, bed.position, 2);
      try {
        await bot.sleep(bed);
        return factory.createResponse(`Sleeping in the bed at (${bed.position.x}, ${bed.position.y}, ${bed.position.z}). Zzz`);
      } catch (e) {
        return factory.createResponse(`Couldn't sleep: ${e instanceof Error ? e.message : e}`);
      }
    }
  );

  factory.registerTool(
    "wake-up",
    "Get out of bed.",
    {},
    async () => {
      const bot = getBot();
      try {
        await bot.wake();
        return factory.createResponse('Woke up.');
      } catch (e) {
        return factory.createResponse(`Couldn't wake: ${e instanceof Error ? e.message : e}`);
      }
    }
  );
}
