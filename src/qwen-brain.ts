import mineflayer from 'mineflayer';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ZodType } from 'zod';
import { ToolFactory } from './tool-factory.js';
import { log } from './logger.js';
import { resolveBlockNames, applyProtection, stopEverything, jobSummary } from './tools/work-tools.js';

/*
 * Qwen brain: lets the player talk to the bot directly, without Claude.
 *
 * - In-game chat: anything a player types in chat is sent to a local Ollama model,
 *   which picks commands for the bot to run. Type "brain off" / "brain on" to toggle.
 * - HTTP: POST http://localhost:3456/say  with JSON {"text": "...", "player": "name"}
 *   (or plain text). Lets a voice app (e.g. Design Loader) forward speech. The reply
 *   comes back as JSON {"reply": "..."} and is also said in game chat.
 */

export interface BrainConfig {
  enabled: boolean;
  ollamaUrl: string;
  model: string;
  httpPort: number;
}

// Commands Qwen may use (others, like send-chat or fly-to, are left out on purpose)
const ALLOWED = [
  'get-position', 'move-to-position', 'list-inventory', 'find-blocks', 'find-entity',
  'dig-block', 'place-block', 'equip-item', 'toss-item', 'dig-area', 'dig-stairs', 'dig-inside-markers', 'dig-limits', 'protect-level', 'protect-zone', 'list-zones', 'mine-ore', 'stop-work',
  'work-status', 'craft', 'smelt-item', 'deposit-to-chest', 'withdraw-from-chest', 'eat',
  'place-torch', 'follow-player', 'stop-following', 'sleep', 'wake-up', 'protect-blocks',
  'set-home', 'save-place', 'list-places', 'go-to-place', 'check-chests', 'where-is',
  'read-signs', 'name-chests-from-signs', 'self-defence', 'attack-nearest', 'sort-into-chests',
];

// Commands that just look things up: their results are fed back so Qwen can answer questions
const LOOKUPS = new Set([
  'get-position', 'list-inventory', 'find-blocks', 'find-entity', 'work-status',
  'list-places', 'where-is', 'read-signs', 'check-chests',
]);

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
interface Action { command: string; args?: Record<string, unknown> }
interface Plan { say?: string; actions?: Action[] }

function describeSchema(schema: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(schema)) {
    let desc = '';
    let optional = false;
    if (v instanceof ZodType) {
      desc = v.description ?? '';
      optional = v.isOptional();
    }
    parts.push(`${k}${optional ? '?' : ''}${desc ? ` (${desc})` : ''}`);
  }
  return parts.length ? parts.join('; ') : 'no args';
}

function buildToolList(factory: ToolFactory): string {
  const lines: string[] = [];
  for (const name of ALLOWED) {
    const t = factory.registry.get(name);
    if (!t) continue;
    const short = t.description.split(/(?<=\.)\s/)[0];
    lines.push(`- ${name}: ${short} Args: ${describeSchema(t.schema)}`);
  }
  return lines.join('\n');
}

// Everything the bot says in chat, so a voice app can read out messages he says by himself
// (job finished, lava, full bag...). Replies to the player are marked so they aren't read twice.
interface BotEvent { id: number; text: string; reply: boolean; at: number }
const events: BotEvent[] = [];
let nextEventId = 1;
let replyDepth = 0;
const eventWaiters: (() => void)[] = [];
const patched = new WeakSet<object>();

function recordEvent(text: string, reply: boolean): void {
  events.push({ id: nextEventId++, text, reply, at: Date.now() });
  if (events.length > 200) events.splice(0, events.length - 200);
  const waiting = eventWaiters.splice(0);
  for (const w of waiting) w();
}

function patchChat(bot: mineflayer.Bot | null | undefined): void {
  if (!bot || patched.has(bot)) return;
  patched.add(bot);
  const original = bot.chat.bind(bot);
  bot.chat = (message: string) => {
    recordEvent(message, replyDepth > 0);
    original(message);
  };
}

function sayInGame(bot: mineflayer.Bot | null | undefined, text: string): void {
  if (!bot || !text) return;
  patchChat(bot);
  const clean = text.replace(/\s+/g, ' ').trim();
  replyDepth++;
  try {
    for (let i = 0; i < clean.length && i < 600; i += 240) bot.chat(clean.slice(i, i + 240));
  } finally {
    replyDepth--;
  }
}

const MODELS: Record<string, string> = {
  fast: 'qwen3:8b',        // quick replies, good enough for commands
  big: 'qwen3.6:latest',   // smarter but slower
};
const brainFile = path.join(os.homedir(), '.claudebot', 'brain.json');

function loadSavedModel(): string | null {
  try { return (JSON.parse(fs.readFileSync(brainFile, 'utf8')) as { model?: string }).model ?? null; } catch { return null; }
}
function saveModel(model: string): void {
  try {
    fs.mkdirSync(path.dirname(brainFile), { recursive: true });
    fs.writeFileSync(brainFile, JSON.stringify({ model }, null, 2));
  } catch (e) { log('warn', `could not save brain model: ${e}`); }
}

// "stop", "claude stop", "stop it", "cancel", "halt", "freeze" (optionally with punctuation)
const STOP_RE = /^\s*(hey\s+)?(claude(bot)?[\s,]*)?(stop|stop it|stop now|stop that|cancel|halt|freeze|wait)[\s!.]*$/i;

export class QwenBrain {
  private history: Msg[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped by every new message: older commands give up so the newest one wins. */
  private generation = 0;
  private enabled: boolean;

  constructor(
    private factory: ToolFactory,
    private getBot: () => mineflayer.Bot | null | undefined,
    private config: BrainConfig
  ) {
    this.enabled = config.enabled;
    const saved = loadSavedModel();
    if (saved) this.config.model = saved;
  }

  private setModel(model: string): void {
    this.config.model = model;
    saveModel(model);
    sayInGame(this.getBot(), `Brain switched to ${model}. First reply may take a moment while it loads.`);
    this.askQwen([{ role: 'system', content: this.systemPrompt() }, { role: 'user', content: 'Player: hi (warm-up)' }])
      .catch(e => sayInGame(this.getBot(), this.explain(e)));
  }

  private explain(e: unknown): string {
    const m = String(e);
    if (m.includes('fetch failed')) return "I can't reach Qwen. Is Ollama running?";
    if (m.includes('not found')) return `Ollama doesn't have ${this.config.model} yet. Type in a command prompt: ollama pull ${this.config.model}`;
    return `Qwen problem: ${m.slice(0, 150)}`;
  }

  start(): void {
    if (this.config.httpPort > 0) this.startHttp();
    // Keep watching the bot's chat (the bot object changes when it reconnects)
    setInterval(() => patchChat(this.getBot()), 1000);
    log('info', `Qwen brain ${this.enabled ? 'on' : 'off'} (model ${this.config.model})`);
    // Warm up: load Qwen into the graphics card and pre-read the long fixed prompt,
    // so the first real message is quick.
    if (this.enabled) {
      setTimeout(() => {
        this.askQwen([{ role: 'system', content: this.systemPrompt() }, { role: 'user', content: 'Player: hi (warm-up, reply briefly)' }])
          .then(() => log('info', 'Qwen warmed up'))
          .catch(e => log('warn', `Qwen warm-up failed: ${e}`));
      }, 3000);
    }
  }

  /** Called for every chat message from a player (not the bot itself). */
  onChat(username: string, message: string): void {
    const m = message.trim();
    const low = m.toLowerCase();
    if (STOP_RE.test(m)) { this.emergencyStop(); return; }
    if (low === 'brain off') { this.enabled = false; this.history = []; sayInGame(this.getBot(), 'Qwen brain off. Claude only now.'); return; }
    if (low === 'brain fast') { this.setModel(MODELS.fast); return; }
    if (low === 'brain big') { this.setModel(MODELS.big); return; }
    if (low.startsWith('brain model ')) { this.setModel(m.slice('brain model '.length).trim()); return; }
    if (low === 'brain timing') { this.showTiming = !this.showTiming; sayInGame(this.getBot(), `Timing ${this.showTiming ? 'on' : 'off'}`); return; }
    if (low === 'brain reset') { this.history = []; sayInGame(this.getBot(), 'Memory of our chat cleared.'); return; }
    if (low === 'brain which') { sayInGame(this.getBot(), `Using ${this.config.model}`); return; }
    if (low === 'brain on') { this.enabled = true; this.history = []; sayInGame(this.getBot(), 'Qwen brain on. Talk to me!'); return; }
    if (!this.enabled || m.startsWith('/')) return;
    this.enqueue(username, m).catch(() => {});
  }

  /**
   * Queue a message. Resolves with the bot's first spoken reply as soon as Qwen gives one,
   * while the commands keep running afterwards (so voice apps aren't kept waiting).
   */
  /** Stop everything right now, including commands still waiting. */
  emergencyStop(): void {
    this.generation++;
    const bot = this.getBot();
    if (bot) stopEverything(bot);
    sayInGame(bot, 'Stopped.');
    this.history.push({ role: 'user', content: 'Player said STOP. You stopped everything.' });
  }

  private enqueue(player: string, text: string): Promise<string> {
    let firstSay: (t: string) => void = () => {};
    const replied = new Promise<string>(r => { firstSay = r; });
    // Newest command wins: cancel whatever the previous command is doing (walking etc.),
    // so this one doesn't have to wait for it to finish. Background jobs keep going.
    const gen = ++this.generation;
    const bot = this.getBot();
    try { bot?.pathfinder.stop(); } catch { /* ignore */ }
    const job = this.queue.then(() => this.handle(player, text, firstSay, gen));
    this.queue = job.catch(() => {});
    job.then(r => firstSay(r), () => firstSay(''));
    return replied;
  }

  private cachedSystem = '';
  private showTiming = false;

  /** Fixed part of the prompt. Kept identical between calls so Ollama can reuse it (much faster). */
  private systemPrompt(): string {
    if (this.cachedSystem) return this.cachedSystem;
    this.cachedSystem = `You are ClaudeBot, a friendly Minecraft helper bot. The player talks to you; their name and position are given with each message.
Turn what they say into commands for yourself. Reply ONLY with JSON like:
{"say": "short friendly reply (under 15 words)", "actions": [{"command": "name", "args": {...}}]}
Use "actions": [] when no command is needed (chatting, or answering from command results).
Rules:
- Only use commands from the list, with the exact arg names.
- "come here"/"come to me": move-to-position with the player's position and range 2.
- "give me X"/"throw me X": move-to-position near the player (range 3), then toss-item with lookAt set to the player's position.
- "Dig inside the crystal/amethyst blocks": dig-inside-markers with bottomY (ask how deep if not said).
- "What level are you on?" / "how deep are you?": answer with your Y from the current info (e.g. "I'm on Y 32"). If a dig job is running, also say which layer it's on. No actions needed.
- "Don't dig at Y 25" / "leave my floor alone" (while standing on it): protect-level (y, or no y for the floor under the player).
- Only say you have items that are listed in your inventory (current info). "Mined 12" means blocks dug, not items carried. If asked to drop something you don't have, say so.
- Inside a ring of stone bricks (same level) you never break or build — that's automatic. "Protect inside the gold blocks" = protect-zone with marker gold_block.
- "Put X in chest 3": deposit-to-chest with place "chest 3" (signs on chests are read automatically). "Put it in the chest I'm standing on / next to me": deposit-to-chest with nearPlayer true. Never guess a chest by walking off.
- "Sort your stuff" / "put everything in the right chests": sort-into-chests (uses the signs on the chests).
- To craft with things from a chest: withdraw-from-chest each ingredient first (e.g. stick, iron_ingot), then craft. Use where-is if you don't know which chest. Iron pickaxe = 3 iron_ingot + 2 stick each.
- Never dig straight down. To go deeper (e.g. for diamonds), use dig-stairs with a targetY (diamonds: -58), then mine-ore. Don't break stone bricks, chests, furnaces, ladders, doors or beds.
- Item names use Minecraft ids, e.g. coal, raw_iron, oak_log, birch_planks, cobblestone.
- To get ores (diamonds, iron, coal...), use mine-ore, e.g. {"blockType": "diamond_ore", "target": 10}. Deep versions are included automatically. Diamonds are deep (below Y 0); if none are found, tell the player to send you deeper.
- For wood, use mine-ore with {"blockType": "trees", "target": 20} (finds every kind of log). Trees are on the surface, so if you're underground and none are found, say so.
- If unsure what they mean, ask in "say" and use no actions.

Commands:
${buildToolList(this.factory)}`;
    return this.cachedSystem;
  }

  private context(player: string): string {
    const bot = this.getBot();
    let context = '';
    if (bot?.entity) {
      const p = bot.entity.position.floored();
      context += `Your position: (${p.x}, ${p.y}, ${p.z}).\n`;
      const pl = bot.players[player]?.entity;
      if (pl) {
        const q = pl.position.floored();
        context += `${player}'s position: (${q.x}, ${q.y}, ${q.z}).\n`;
      }
      const inv = bot.inventory.items().map(i => `${i.name} x${i.count}`).join(', ');
      context += `Your inventory: ${inv || 'empty'}.\n`;
      context += `Health ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20.\n`;
      context += `${jobSummary()}\n`;
    }
    return context;
  }

  private async askQwen(messages: Msg[]): Promise<Plan> {
    const res = await fetch(`${this.config.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        format: 'json',
        think: false,
        keep_alive: '30m',
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama said ${res.status}: ${await res.text()}`);
    const data = await res.json() as { message?: { content?: string } };
    const text = data.message?.content ?? '';
    try {
      return JSON.parse(text) as Plan;
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as Plan;
      return { say: text.slice(0, 200), actions: [] };
    }
  }

  private async handle(player: string, text: string, onSay: (t: string) => void, gen: number): Promise<string> {
    const bot = this.getBot();
    if (gen !== this.generation) return '';
    this.history.push({ role: 'user', content: `${player}: ${text}` });
    this.history = this.history.slice(-8);

    let reply = '';
    try {
      for (let round = 0; round < 3; round++) {
        // Live info goes last so the long fixed prompt at the start stays cached in Ollama
        const live: Msg = { role: 'user', content: `[Current info]\n${this.context(player)}` };
        const t0 = Date.now();
        const plan = await this.askQwen([{ role: 'system', content: this.systemPrompt() }, ...this.history, live]);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log('info', `Qwen answered in ${secs}s`);
        // Qwen sometimes copies old "[0.5s]" tags from the chat history: strip them
        if (plan.say) plan.say = plan.say.replace(/\s*\[\d+(\.\d+)?s\]/g, '').trim();
        // History gets the clean reply, so Qwen doesn't learn to add times itself
        this.history.push({ role: 'assistant', content: JSON.stringify(plan) });
        if (this.showTiming && plan.say) plan.say = `${plan.say} [${secs}s]`;
        if (plan.say) {
          reply = plan.say;
          sayInGame(bot, plan.say);
          onSay(plan.say);
        }

        const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 5) : [];
        if (actions.length === 0) break;

        const results: string[] = [];
        let needAnswer = false;
        // A newer message arrived while Qwen was thinking: drop this one
        if (gen !== this.generation) break;
        for (const a of actions) {
          if (gen !== this.generation) break;
          const tool = this.factory.registry.get(a.command);
          if (!tool || !ALLOWED.includes(a.command)) {
            results.push(`${a.command}: not a command I have`);
            continue;
          }
          // Fix loose block names for find-blocks ("diamonds" -> deepslate_diamond_ore etc.)
          if (a.command === 'find-blocks' && a.args && typeof a.args.blockType === 'string' && bot) {
            const names = resolveBlockNames(bot.version, a.args.blockType);
            const dist = Number(a.args.maxDistance ?? 64);
            const pick = names.find(n => {
              const id = bot.registry.blocksByName[n]?.id;
              return id !== undefined && bot.findBlock({ matching: id, maxDistance: dist }) !== null;
            });
            if (pick) a.args.blockType = pick;
            else if (names.length) a.args.blockType = names[0];
            a.args.maxDistance ??= 64;
          }
          if (bot) applyProtection(bot);
          log('info', `Qwen -> ${a.command} ${JSON.stringify(a.args ?? {})}`);
          const a0 = Date.now();
          const r = await tool.run(a.args ?? {});
          const took = (Date.now() - a0) / 1000;
          if (this.showTiming && took > 3) sayInGame(bot, `(${a.command} took ${took.toFixed(1)}s)`);
          const out = r.content.map(c => c.text).join('\n');
          results.push(`${a.command}: ${out}`);
          if (LOOKUPS.has(a.command) || r.isError) needAnswer = true;
        }
        this.history.push({ role: 'user', content: `Command results:\n${results.join('\n').slice(0, 2000)}` });
        if (!needAnswer) break;
      }
    } catch (e) {
      const msg = this.explain(e);
      log('warn', msg);
      sayInGame(bot, msg);
      onSay(msg);
      return msg;
    }
    return reply;
  }

  private startHttp(): void {
    const server = http.createServer((req, res) => {
      // GET /events?after=<id>: things the bot said by himself since that id.
      // Waits up to 25 s for something new (long poll). after=0 on first call returns only the latest id.
      if (req.method === 'GET' && req.url?.startsWith('/events')) {
        const url = new URL(req.url, 'http://localhost');
        const after = Number(url.searchParams.get('after') ?? '0');
        const send = () => {
          const list = after > 0 ? events.filter(e => e.id > after && !e.reply).map(e => ({ id: e.id, text: e.text })) : [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: list, last: nextEventId - 1 }));
        };
        const hasNew = () => after > 0 && events.some(e => e.id > after && !e.reply);
        if (after === 0 || hasNew()) { send(); return; }
        let done = false;
        const finish = () => { if (!done) { done = true; send(); } };
        const wake = () => { if (hasNew()) finish(); else eventWaiters.push(wake); };
        eventWaiters.push(wake);
        setTimeout(finish, 25000);
        req.on('close', () => { done = true; });
        return;
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/say')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST /say with {"text": "..."}' }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
      req.on('end', async () => {
        let text = body;
        let player = '';
        try {
          const j = JSON.parse(body) as { text?: string; player?: string };
          text = j.text ?? '';
          player = j.player ?? '';
        } catch { /* plain text body */ }
        if (!player) {
          const bot = this.getBot();
          player = Object.keys(bot?.players ?? {}).find(n => n !== bot?.username) ?? 'Player';
        }
        let reply = '';
        if (STOP_RE.test(text)) { this.emergencyStop(); reply = 'Stopped.'; }
        else if (text.trim()) reply = await this.enqueue(player, text.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      });
    });
    server.on('error', e => log('warn', `Brain HTTP server error: ${e}`));
    // Only listen on this PC, not the network
    server.listen(this.config.httpPort, '127.0.0.1', () =>
      log('info', `Brain listening on http://localhost:${this.config.httpPort}/say`));
  }
}
