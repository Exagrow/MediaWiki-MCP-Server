// Library entry point: what another package imports to embed the server.
// Importing it starts nothing; src/index.ts remains the command-line entry.
export { createServer, SERVER_INSTRUCTIONS } from './server.ts';
export type { ChangePublisher, CreateServerOptions } from './server.ts';
export { createToolContext } from './runtime/createContext.ts';
export type { ToolContext } from './runtime/context.ts';
export { createAppState } from './wikis/state.ts';
export type { AppState } from './wikis/state.ts';
export { loadConfigFromFile } from './config/loadConfig.ts';
export type { Config, WikiConfig } from './config/loadConfig.ts';
export { logger } from './runtime/logger.ts';
export type { Logger } from './runtime/logger.ts';
export { guardStdout } from './runtime/stdoutGuard.ts';
export { registerShutdownHandlers } from './runtime/shutdown.ts';
