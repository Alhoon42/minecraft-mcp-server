import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';

/*
 * Self-defence: when the bot gets hurt, it works out which mob did it and reacts by type.
 *  - creepers: run away
 *  - archers (skeletons etc.): find them and chase them down
 *  - endermen: only fought if one is right next to him (i.e. it attacked)
 *  - everything else hostile: fight
 * Background jobs (digging/mining) pause while he fights, then carry on.
 */

const FLEE = new Set(['creeper']);
const ARCHERS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch', 'drowned']);
const ONLY_IF_CLOSE = new Set(['enderman']);
const NEVER = new Set(['player', 'villager', 'iron_golem', 'wolf', 'cat', 'horse', 'item', 'experience_orb', 'arrow']);
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];

let enabled = true;
let fighting = false;
let cancelled = 0;

/** Stop fighting / running away straight away. */
export function cancelFight(): void {
  cancelled++;
  fighting = false;
}

/** True while the bot is fighting or running away; jobs wait for this. */
export function isFighting(): boolean {
  return fighting;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isHostile(e: any): boolean {
  if (!e || !e.name || NEVER.has(e.name)) return false;
  return e.type === 'hostile' || FLEE.has(e.name) || ARCHERS.has(e.name) || ONLY_IF_CLOSE.has(e.name);
}

/** Work out who probably hit us: something very close, otherwise the nearest archer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findAttacker(bot: mineflayer.Bot): any {
  const me = bot.entity.position;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mobs = Object.values(bot.entities).filter((e: any) => e !== bot.entity && isHostile(e)) as any[];
  const close = mobs
    .filter(e => e.position.distanceTo(me) <= 4.5)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  if (close.length) return close[0];
  const archers = mobs
    .filter(e => ARCHERS.has(e.name) && e.position.distanceTo(me) <= 32)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return archers[0] ?? null;
}

async function equipWeapon(bot: mineflayer.Bot): Promise<void> {
  for (const w of WEAPONS) {
    const item = bot.inventory.items().find(i => i.name === w);
    if (item) {
      try { await bot.equip(item, 'hand'); } catch { /* ignore */ }
      return;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runFrom(bot: mineflayer.Bot, mob: any, distance = 10): Promise<void> {
  const me = bot.entity.position;
  const away = me.minus(mob.position);
  const flat = new Vec3(away.x, 0, away.z);
  const len = Math.hypot(flat.x, flat.z) || 1;
  const target = me.plus(new Vec3(flat.x / len * distance, 0, flat.z / len * distance));
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
  const myTurn = cancelled;
  const until = Date.now() + 6000;
  while (Date.now() < until && cancelled === myTurn && mob.isValid && mob.position.distanceTo(bot.entity.position) < distance) {
    await sleep(250);
  }
  bot.pathfinder.setGoal(null);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fight(bot: mineflayer.Bot, mob: any, maxChase: number): Promise<void> {
  const myTurn = cancelled;
  await equipWeapon(bot);
  const until = Date.now() + 25000;
  while (Date.now() < until && mob.isValid && cancelled === myTurn) {
    const d = mob.position.distanceTo(bot.entity.position);
    if (d > maxChase) break;
    if (bot.health <= 6) {
      bot.chat('Too hurt to fight, running away!');
      await runFrom(bot, mob, 12);
      break;
    }
    if (d > 3) {
      bot.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true);
    } else {
      bot.pathfinder.setGoal(null);
      try {
        await bot.lookAt(mob.position.offset(0, (mob.height ?? 1.8) * 0.8, 0), true);
        bot.attack(mob);
      } catch { /* mob gone */ }
    }
    await sleep(600); // attack cooldown
  }
  bot.pathfinder.setGoal(null);
}

async function react(bot: mineflayer.Bot): Promise<void> {
  if (!enabled || fighting) return;
  const mob = findAttacker(bot);
  if (!mob) return;
  const dist = mob.position.distanceTo(bot.entity.position);
  if (ONLY_IF_CLOSE.has(mob.name) && dist > 3) return;

  fighting = true;
  try {
    // Stop whatever the pathfinder was doing (a job will retry its step afterwards)
    bot.pathfinder.setGoal(null);
    if (FLEE.has(mob.name)) {
      log('info', `defence: running from ${mob.name}`);
      await runFrom(bot, mob, 10);
    } else if (ARCHERS.has(mob.name)) {
      log('info', `defence: chasing ${mob.name}`);
      await fight(bot, mob, 32);
    } else {
      log('info', `defence: fighting ${mob.name}`);
      await fight(bot, mob, 12);
    }
  } catch (e) {
    log('warn', `defence error: ${e}`);
  } finally {
    fighting = false;
  }
}

const attached = new WeakSet<mineflayer.Bot>();

/** Hook the bot's health so he reacts when hurt. Safe to call repeatedly. */
export function attachDefence(bot: mineflayer.Bot | null | undefined): void {
  if (!bot || attached.has(bot)) return;
  attached.add(bot);
  let last = bot.health ?? 20;
  bot.on('health', () => {
    const now = bot.health;
    const hurt = now < last;
    last = now;
    if (hurt && now > 0) react(bot).catch(() => {});
  });
  bot.on('death', () => { fighting = false; });
}

export function registerDefenceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "self-defence",
    "Turn self-defence on or off. When on (the default), if a mob hurts the bot it fights back: runs from creepers, chases skeletons and other archers, only fights endermen that attack, and fights other hostile mobs.",
    { on: z.boolean().describe("true = defend himself, false = don't") },
    async ({ on }: { on: boolean }) => {
      enabled = on;
      attachDefence(getBot());
      return factory.createResponse(`Self-defence ${on ? 'on' : 'off'}`);
    }
  );

  factory.registerTool(
    "attack-nearest",
    "Attack the nearest hostile mob now (or the nearest of a type, e.g. 'zombie').",
    { mobType: z.string().optional().describe("e.g. 'zombie', 'skeleton' (default: any hostile mob)") },
    async ({ mobType }: { mobType?: string }) => {
      const bot = getBot();
      const me = bot.entity.position;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mob = (Object.values(bot.entities) as any[])
        .filter(e => e !== bot.entity && (mobType ? e.name === mobType : isHostile(e)) && e.position.distanceTo(me) <= 32)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
      if (!mob) return factory.createResponse(`No ${mobType ?? 'hostile mob'} nearby.`);
      if (FLEE.has(mob.name)) return factory.createResponse("That's a creeper. I'm not hitting that up close!");
      fighting = true;
      fight(bot, mob, 32).finally(() => { fighting = false; });
      return factory.createResponse(`Attacking the ${mob.name}!`);
    }
  );
}
