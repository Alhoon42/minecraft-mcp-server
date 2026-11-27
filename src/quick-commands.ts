import mineflayer from 'mineflayer';

/*
 * Quick commands: everyday orders are understood straight away by simple pattern matching,
 * without asking Qwen. Instant and reliable. Anything that doesn't match goes to Qwen.
 */

export interface QuickAction { command: string; args: Record<string, unknown> }
export interface QuickPlan {
  say: string;
  actions: QuickAction[];
  /** Speak the result of the last action instead of a fixed reply (for questions). */
  speakResult?: boolean;
  /** Answer computed directly, no actions. */
  answer?: string;
}

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, fifty: 50, hundred: 100, stack: 64, 'a stack': 64 };

function toNum(s?: string): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUM[t];
}

const ALL_WORDS = /^(all|everything|all (of )?(your|my|the) (stuff|gear|things|items)|(your|my|the) (stuff|gear|things|items)|it all|all of it)$/;
const HERE_CHEST = /^(this chest|the chest (i'?m|i am) (standing )?(on|next to|by|at)|chest (i'?m|i am) (standing )?(on|next to|by)|the chest next to me|chest next to me|this one|here)$/;
const ORES = 'diamonds?|coal|iron|gold|redstone|lapis|emeralds?|copper|trees?|wood|logs?|quartz';

function clean(text: string): string {
  return text.toLowerCase()
    .replace(/^\s*(hey\s+)?(claude\s*bot|claudebot|claude)[\s,:!.-]*/i, '')
    .replace(/\b(please|can you|could you|would you|will you|i want you to|i need you to|go and|just|now|mate)\b/g, ' ')
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitItems(s: string): string[] {
  return s.split(/\s*(?:,|\band\b|&)\s*/).map(x => x.replace(/^(the|your|my|all|all the|some)\s+/, '').trim()).filter(Boolean);
}

export function quickCommand(bot: mineflayer.Bot | null | undefined, player: string, raw: string): QuickPlan | null {
  if (!bot?.entity) return null;
  const t = clean(raw);
  if (!t) return null;
  const pl = bot.players[player]?.entity?.position?.floored();
  let m: RegExpMatchArray | null;

  // come here
  if (/^(come|come here|come to me|come back|come back (here|to me)|over here|here boy|get over here|come over here)$/.test(t)) {
    if (!pl) return { say: "I can't see you. Where are you?", actions: [] };
    return { say: 'Coming!', actions: [{ command: 'move-to-position', args: { x: pl.x, y: pl.y, z: pl.z, range: 2, timeoutMs: 120000 } }] };
  }
  if (/^(follow me|follow|keep up)$/.test(t)) return { say: 'Following you!', actions: [{ command: 'follow-player', args: { playerName: player } }] };
  if (/^(stop following( me)?|stay|stay (here|there)|wait here)$/.test(t)) return { say: 'Staying put.', actions: [{ command: 'stop-following', args: {} }] };

  // base / bed / eat
  if (/^(go )?(back )?(to )?(base|home)$|^go back$|^return to base$/.test(t)) return { say: 'Heading back to base.', actions: [{ command: 'go-home', args: {} }] };
  if (/^(go to )?(bed|sleep)$|^go to sleep$/.test(t)) return { say: 'Off to bed.', actions: [{ command: 'sleep', args: {} }] };
  if (/^(wake up|get up)$/.test(t)) return { say: 'Awake!', actions: [{ command: 'wake-up', args: {} }] };
  if (/^(eat|eat something|have something to eat|are you hungry eat)$/.test(t)) return { say: 'Eating.', actions: [{ command: 'eat', args: {} }] };

  // questions answered directly
  if (/^(what'?s|what is) in your (bag|inventory|pockets?)$|^what (have|do) you (got|have)$|^(show|list) (me )?your (bag|inventory)$/.test(t)) {
    const inv = bot.inventory.items();
    const counts = new Map<string, number>();
    for (const i of inv) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    const list = [...counts].map(([n, c]) => `${c} ${n.replace(/_/g, ' ')}`).join(', ');
    return { say: '', actions: [], answer: list ? `I've got ${list}.` : 'My bag is empty.' };
  }
  if (/^(what level are you( on)?|what y are you( on)?|how deep are you|where are you|what'?s your (level|position))$/.test(t)) {
    const p = bot.entity.position.floored();
    return { say: '', actions: [], answer: `I'm on Y ${p.y}, at ${p.x}, ${p.z}.` };
  }
  if (/^(how'?s the (dig|job|mining) going|what are you doing|status|how are you getting on)$/.test(t)) {
    return { say: '', actions: [{ command: 'work-status', args: {} }], speakResult: true };
  }

  // chests
  if (/^check (the |all the )?chests$/.test(t)) return { say: 'Checking the chests.', actions: [{ command: 'check-chests', args: {} }], speakResult: true };
  if (/^(sort (your|my|the)? ?(stuff|things|gear|items|bag|inventory|it)|sort everything|put everything in the right chests?|sort it out)$/.test(t)) {
    return { say: 'Sorting it into the chests.', actions: [{ command: 'sort-into-chests', args: {} }], speakResult: true };
  }
  if ((m = t.match(/^(?:where'?s|where is|where are|which chest has) (?:the |my |some )?(.+)$/))) {
    return { say: '', actions: [{ command: 'where-is', args: { itemName: m[1] } }], speakResult: true };
  }
  if ((m = t.match(/^(?:put|store|stick|place|drop|chuck) (.+?) (?:in|into|inside) (?:the )?(.+)$/))) {
    const what = m[1].replace(/^(all )?(of )?(the |your |my )?/, '').trim();
    const where = m[2].trim();
    const target: Record<string, unknown> = HERE_CHEST.test(where) || HERE_CHEST.test(`the ${where}`) ? { nearPlayer: true } : { place: where };
    const items = ALL_WORDS.test(what) || ALL_WORDS.test(m[1].trim()) ? ['all'] : splitItems(what);
    return { say: 'Putting it away.', speakResult: true, actions: items.map(i => ({ command: 'deposit-to-chest', args: { itemName: i, ...target } })) };
  }
  if ((m = t.match(/^(?:get|take|grab|fetch|pick up|collect) (?:me )?(\d+|a stack of|one|two|three|four|five|ten|twenty)? ?(?:of )?(.+?) (?:from|out of) (?:the )?(.+)$/))) {
    const n = m[1] ? (m[1].startsWith('a stack') ? 64 : toNum(m[1])) : undefined;
    const where = m[3].trim();
    const target: Record<string, unknown> = HERE_CHEST.test(where) || HERE_CHEST.test(`the ${where}`) ? { nearPlayer: true } : { place: where };
    return { say: 'Getting it.', speakResult: true, actions: splitItems(m[2]).map(i => ({ command: 'withdraw-from-chest', args: { itemName: i, ...(n ? { count: n } : {}), ...target } })) };
  }

  // give / drop
  if (/^(drop|throw|dump) (everything|it all|all (your|of your) (stuff|gear))$|^drop all$/.test(t)) {
    return { say: 'Dropping everything.', actions: [{ command: 'toss-item', args: { itemName: 'all', ...(pl ? { lookAtX: pl.x, lookAtY: pl.y, lookAtZ: pl.z } : {}) } }] };
  }
  if ((m = t.match(/^(?:give me|throw me|pass me|hand me|drop me|chuck me) (\d+|one|two|three|four|five|ten|a stack of)? ?(?:of )?(?:the |your |some )?(.+)$/))) {
    if (!pl) return { say: "I can't see you.", actions: [] };
    const n = m[1] ? (m[1].startsWith('a stack') ? 64 : toNum(m[1])) : undefined;
    const acts: QuickAction[] = [{ command: 'move-to-position', args: { x: pl.x, y: pl.y, z: pl.z, range: 3, timeoutMs: 120000 } }];
    for (const i of splitItems(m[2])) acts.push({ command: 'toss-item', args: { itemName: i, ...(n ? { count: n } : {}), lookAtX: pl.x, lookAtY: pl.y, lookAtZ: pl.z } });
    return { say: 'Here you go!', actions: acts, speakResult: true };
  }

  // mining
  if ((m = t.match(new RegExp(`^(?:find|mine|get|go get|go find|collect|dig|chop|go mine|look for|search for|fetch)(?: me)?(?: some| more| up)? ?(\\d+|ten|twenty|a stack of|one|two|three|five)? ?(?:more )?(${ORES})(?: ore)?$`)))) {
    const n = m[1] ? (m[1].startsWith('a stack') ? 64 : toNum(m[1])) : undefined;
    const kind = m[2].replace(/s$/, '');
    const blockType = /^(tree|wood|log)$/.test(kind) ? 'trees' : kind;
    const target = n ?? (blockType === 'diamond' ? 10 : blockType === 'trees' ? 20 : 32);
    return { say: `Going to get ${blockType === 'trees' ? 'wood' : blockType}!`, actions: [{ command: 'mine-ore', args: { blockType, target } }] };
  }
  if ((m = t.match(/^dig (?:some )?stairs (?:down |up )?to (?:y |level )?(-?\d+)$/))) {
    return { say: `Digging stairs to Y ${m[1]}.`, actions: [{ command: 'dig-stairs', args: { targetY: Number(m[1]) } }] };
  }
  if ((m = t.match(/^dig (?:out )?(?:inside|in) (?:the )?(?:crystal|amethyst) blocks?(?: down)? to (?:y |level )?(-?\d+)(?: including the edge)?$/))) {
    return { say: `Digging inside the crystal blocks down to Y ${m[1]}.`, actions: [{ command: 'dig-inside-markers', args: { bottomY: Number(m[1]), includeEdge: /including the edge/.test(t) } }] };
  }
  if (/^(place|put down|put up) (a )?torch(es)?$/.test(t)) return { say: 'Torch down.', actions: [{ command: 'place-torch', args: {} }] };
  if ((m = t.match(/^(?:craft|make|build) (?:me )?(\d+|a|an|one|two|three|four|five)? ?(.+)$/)) && !/\b(house|base|wall|room|bunker|hole)\b/.test(m[2])) {
    const n = toNum(m[1]) ?? 1;
    const item = m[2].replace(/^(a|an|some)\s+/, '').trim();
    return { say: `Making ${n > 1 ? `${n} ` : ''}${item}.`, speakResult: true, actions: [{ command: 'craft', args: { item, times: n } }] };
  }
  return null;
}
