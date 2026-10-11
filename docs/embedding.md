# Embedding the server

For developers who import this package to serve its wiki tools from their own MCP server, alongside tools of their own and over a transport they control. To run the server as a standalone process, see the [README](../README.md).

The package's main entry, `@professional-wiki/mediawiki-mcp-server`, starts nothing on import. The `mediawiki-mcp-server` command is unchanged.

## Exports

| Export | Purpose |
| --- | --- |
| `createServer( ctx, options? )` | Builds the `McpServer` with the standard tools and resources |
| `CreateServerOptions`, `ChangePublisher` | Types for `createServer`'s options |
| `SERVER_INSTRUCTIONS` | The default instructions, for appending to |
| `createToolContext( { logger, state, transport } )` | Builds the context `createServer` takes |
| `createAppState( config )` | Builds the wiki state from a `Config` |
| `loadConfigFromFile()` | Reads `config.json` or `CONFIG`, as the command does |
| `Config`, `WikiConfig`, `ToolContext`, `AppState` | Types |
| `logger`, `Logger` | The structured stderr logger `createToolContext` takes |
| `guardStdout()` | Routes stray stdout writes from `mwn` to the log; call it first when using stdio |
| `registerShutdownHandlers( deps )` | The command's signal handling |

`@modelcontextprotocol/server` is a dependency of this package. Declare the same version range in your own `package.json` so that npm installs one copy; two copies give two `McpServer` classes.

## Usage

Build a `Config` in code or load one, then compose the server and connect any transport:

```ts
import { createAppState, createServer, createToolContext, logger } from '@professional-wiki/mediawiki-mcp-server';
import type { Config } from '@professional-wiki/mediawiki-mcp-server';

const config: Config = {
	wikis: {
		'en.wikipedia.org': {
			sitename: 'Wikipedia',
			server: 'https://en.wikipedia.org',
			articlepath: '/wiki',
			scriptpath: '/w',
			readOnly: true,
		},
	},
	defaultWiki: 'en.wikipedia.org',
	uploadDirs: [],
};

const ctx = createToolContext( { logger, state: createAppState( config ), transport: 'stdio' } );
const server = await createServer( ctx, {
	serverInfo: { name: 'my-server', version: '1.0.0' },
	// The OAuth tools are meaningless when the host handles sign-in.
	toolFilter: ( name ) => !name.startsWith( 'oauth-' ),
} );

// Tools of your own register directly on the returned server.
await server.connect( transport );
```

`transport` on the context is `'stdio'` or `'http'`. It gates `oauth-status` and `oauth-logout`, which are listed for `'stdio'` only, and the sign-in handling for wikis that require OAuth, so pass the one your server actually uses. See [configuration](configuration.md) for the `Config` fields.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `serverInfo` | The name, title, version and description of this package | Each field you give replaces the matching one the client sees |
| `instructions` | `SERVER_INSTRUCTIONS` | Replaces the instructions sent to the client |
| `toolFilter` | Every standard tool is registered | Called with each standard tool's name; a tool it rejects is never registered or listed |
| `publisher` | Pushes resource list changes on the server's own connection | Delivers list-changed events when your transport cannot receive pushes |

Tools you register on the returned server do not pass through the standard tools' error classification, telemetry, result byte cap, `wiki` argument handling or read-only gating.

## Environment

`MCP_USER_AGENT` is read when the package is first imported. Set it before that import if you want your own `User-Agent` on wiki requests.
