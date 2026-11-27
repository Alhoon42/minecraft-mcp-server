#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerWorkTools } from './tools/work-tools.js';
import { registerExtraTools } from './tools/extra-tools.js';
import { registerPlacesTools } from './tools/places-tools.js';
import { QwenBrain } from './qwen-brain.js';
import { registerDefenceTools } from './tools/defense-tools.js';
import * as http from 'http';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

/** Try to own the local port. Only one copy of the server may run the bot (two would kick each other). */
function claimPort(port: number): Promise<http.Server | null> {
  return new Promise(resolve => {
    if (port <= 0) { resolve(null); return; }
    const srv = http.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();
  let brain: QwenBrain | null = null;

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => {
        messageStore.addMessage(username, message);
        brain?.onChat(username, message);
      }
    }
  );

  const owned = await claimPort(config.brainPort);
  const isPrimary = config.brainPort <= 0 || owned !== null;
  if (isPrimary) {
    connection.connect();
    // Keep him in the game: if he's been kicked or the world wasn't open yet, rejoin by himself
    setInterval(() => { connection.checkConnectionAndReconnect().catch(() => {}); }, 15000);
  } else {
    log('info', 'Another copy already runs the bot; forwarding commands to it.');
  }

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerWorkTools(factory, getBot);
  registerExtraTools(factory, getBot);
  registerPlacesTools(factory, getBot);
  registerDefenceTools(factory, getBot);

  const startBrain = (srv: http.Server | undefined) => {
    brain = new QwenBrain(factory, () => connection.getBot(), {
      enabled: config.brain,
      ollamaUrl: config.ollamaUrl,
      model: config.model,
      httpPort: config.brainPort,
    });
    brain.start(srv);
  };

  if (isPrimary) {
    startBrain(owned ?? undefined);
  } else {
    factory.proxyUrl = `http://127.0.0.1:${config.brainPort}`;
    let takingOver = false;
    factory.onProxyLost = async () => {
      if (takingOver) return;
      takingOver = true;
      const srv = await claimPort(config.brainPort);
      if (srv) {
        log('info', 'The other copy has gone; this one now runs the bot.');
        factory.proxyUrl = null;
        connection.connect();
        setInterval(() => { connection.checkConnectionAndReconnect().catch(() => {}); }, 15000);
        startBrain(srv);
        await new Promise(r => setTimeout(r, 4000));
      }
      takingOver = false;
    };
  }

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
