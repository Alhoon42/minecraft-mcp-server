import mineflayer from 'mineflayer';
import * as http from 'http';
import { ZodType } from 'zod';
import { ToolFactory } from './tool-factory.js';
import { log } from './logger.js';

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
  'dig-block', 'place-block', 'equip-item', 'toss-item', 'dig-area', 'mine-ore', 'stop-work',
  'work-status', 'craft', 'smelt-item', 'deposit-to-chest', 'withdraw-from-chest', 'eat',
  'place-torch', 'follow-player', 'stop-following', 'sleep', 'wake-up', 'protect-blocks',
  'set-home', 'save-place', 'list-places', 'go-to-place', 'check-chests', 'where-is',
  'read-signs', 'name-chests-from-signs',
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

function sayInGame(bot: mineflayer.Bot | null | undefined, text: string): void {
  if (!bot || !text) return;
  const clean = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < clean.length && i < 600; i += 240) bot.chat(clean.slice(i, i + 240));
}

export class QwenBrain {
  private history: Msg[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private enabled: boolean;

  constructor(
    private factory: ToolFactory,
    private getBot: () => mineflayer.Bot | null | undefined,
    private config: BrainConfig
  ) {
    this.enabled = config.enabled;
  }

  start(): void {
    if (this.config.httpPort > 0) this.startHttp();
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
    if (low === 'brain off') { this.enabled = false; sayInGame(this.getBot(), 'Qwen brain off. Claude only now.'); return; }
    if (low === 'brain on') { this.enabled = true; sayInGame(this.getBot(), 'Qwen brain on. Talk to me!'); return; }
    if (!this.enabled || m.startsWith('/')) return;
    this.enqueue(username, m).catch(() => {});
  }

  /**
   * Queue a message. Resolves with the bot's first spoken reply as soon as Qwen gives one,
   * while the commands keep running afterwards (so voice apps aren't kept waiting).
   */
  private enqueue(player: string, text: string): Promise<string> {
    let firstSay: (t: string) => void = () => {};
    const replied = new Promise<string>(r => { firstSay = r; });
    const job = this.queue.then(() => this.handle(player, text, firstSay));
    this.queue = job.catch(() => {});
    job.then(r => firstSay(r), () => firstSay(''));
    return replied;
  }

  private cachedSystem = '';

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
- Never dig straight down. Don't break stone bricks, chests, furnaces, ladders, doors or beds.
- Item names use Minecraft ids, e.g. coal, raw_iron, oak_log, birch_planks, cobblestone.
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

  private async handle(player: string, text: string, onSay: (t: string) => void): Promise<string> {
    const bot = this.getBot();
    this.history.push({ role: 'user', content: `${player}: ${text}` });
    this.history = this.history.slice(-8);

    let reply = '';
    try {
      for (let round = 0; round < 3; round++) {
        // Live info goes last so the long fixed prompt at the start stays cached in Ollama
        const live: Msg = { role: 'user', content: `[Current info]\n${this.context(player)}` };
        const plan = await this.askQwen([{ role: 'system', content: this.systemPrompt() }, ...this.history, live]);
        this.history.push({ role: 'assistant', content: JSON.stringify(plan) });
        if (plan.say) {
          reply = plan.say;
          sayInGame(bot, plan.say);
          onSay(plan.say);
        }

        const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 5) : [];
        if (actions.length === 0) break;

        const results: string[] = [];
        let needAnswer = false;
        for (const a of actions) {
          const tool = this.factory.registry.get(a.command);
          if (!tool || !ALLOWED.includes(a.command)) {
            results.push(`${a.command}: not a command I have`);
            continue;
          }
          log('info', `Qwen -> ${a.command} ${JSON.stringify(a.args ?? {})}`);
          const r = await tool.run(a.args ?? {});
          const out = r.content.map(c => c.text).join('\n');
          results.push(`${a.command}: ${out}`);
          if (LOOKUPS.has(a.command) || r.isError) needAnswer = true;
        }
        this.history.push({ role: 'user', content: `Command results:\n${results.join('\n').slice(0, 2000)}` });
        if (!needAnswer) break;
      }
    } catch (e) {
      const msg = String(e).includes('fetch failed')
        ? "I can't reach Qwen. Is Ollama running?"
        : `Qwen problem: ${String(e).slice(0, 150)}`;
      log('warn', msg);
      sayInGame(bot, msg);
      onSay(msg);
      return msg;
    }
    return reply;
  }

  private startHttp(): void {
    const server = http.createServer((req, res) => {
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
        const reply = text.trim() ? await this.enqueue(player, text.trim()) : '';
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
