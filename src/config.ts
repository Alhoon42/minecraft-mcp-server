import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  brain: boolean;
  ollamaUrl: string;
  model: string;
  brainPort: number;
}

export function parseConfig(): ServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('brain', {
      type: 'boolean',
      description: 'Let players talk to the bot directly via a local Ollama model',
      default: true
    })
    .option('ollama-url', {
      type: 'string',
      description: 'Ollama address',
      default: 'http://localhost:11434'
    })
    .option('model', {
      type: 'string',
      description: 'Ollama model for the brain',
      default: 'qwen3:8b'
    })
    .option('brain-port', {
      type: 'number',
      description: 'Local HTTP port for voice apps (POST /say); 0 to disable',
      default: 3456
    })
    .help()
    .alias('help', 'h')
    .parseSync() as Record<string, unknown>;
  return {
    host: String(argv.host),
    port: Number(argv.port),
    username: String(argv.username),
    brain: argv.brain !== false,
    ollamaUrl: String(argv['ollama-url'] ?? 'http://localhost:11434'),
    model: String(argv.model ?? 'qwen3:8b'),
    brainPort: Number(argv['brain-port'] ?? 3456),
  };
}
