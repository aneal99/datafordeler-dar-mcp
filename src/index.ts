#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { authFromEnv } from "./client.js";
import { createServer } from "./server.js";

const server = createServer(authFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);
