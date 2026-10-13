import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { createServer, SERVER_INSTRUCTIONS } from '../src/server.ts';
import { fakeContext } from './helpers/fakeContext.ts';

const { version: packagedVersion } = createRequire(import.meta.url)('../server.json') as {
	version: string;
};

async function connect(server: Awaited<ReturnType<typeof createServer>>): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'server-test', version: '0.0.0' });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	tags: null,
};

describe('createServer capabilities', () => {
	it('does not advertise the logging capability', async () => {
		const server = await createServer(fakeContext());
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'server-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		try {
			// The positive assertion anchors the negative one: without it, a
			// capabilities object that never arrived would also pass.
			expect(client.getServerCapabilities()?.tools).toBeDefined();
			expect(client.getServerCapabilities()?.logging).toBeUndefined();
		} finally {
			await client.close();
		}
	});

	it('rejects construction when the initial gating pass fails', async () => {
		const ctx = fakeContext({
			wikiProbe: {
				hasExtension: (async () => false) as never,
				// Fails the construction-time gating pass, after tool registration.
				hasAnyExtension: (async () => {
					throw new Error('probe exploded');
				}) as never,
				inspect: (() => {}) as never,
				invalidate: (() => {}) as never,
			},
		});
		await expect(createServer(ctx)).rejects.toThrow('probe exploded');
	});
});

describe('createServer identity', () => {
	it('identifies as mediawiki-mcp-server with the packaged version and instructions by default', async () => {
		const client = await connect(await createServer(fakeContext()));
		try {
			expect(client.getServerVersion()?.name).toBe('mediawiki-mcp-server');
			expect(client.getServerVersion()?.version).toBe(packagedVersion);
			expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
		} finally {
			await client.close();
		}
	});

	it('lets serverInfo override single fields and keeps the rest', async () => {
		const server = await createServer(fakeContext(), {
			serverInfo: { name: 'embedding-server', title: 'Embedding Server' },
		});
		const client = await connect(server);
		try {
			expect(client.getServerVersion()?.name).toBe('embedding-server');
			expect(client.getServerVersion()?.title).toBe('Embedding Server');
			expect(client.getServerVersion()?.version).toBe(packagedVersion);
		} finally {
			await client.close();
		}
	});

	it('replaces the instructions when supplied', async () => {
		const instructions = `${SERVER_INSTRUCTIONS}\n\nExtra guidance.`;
		const client = await connect(await createServer(fakeContext(), { instructions }));
		try {
			expect(client.getInstructions()).toBe(instructions);
		} finally {
			await client.close();
		}
	});
});

describe('createServer toolFilter', () => {
	it('lists every standard tool when no toolFilter is given', async () => {
		const client = await connect(await createServer(fakeContext()));
		try {
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).toContain('oauth-status');
			expect(names).toContain('oauth-logout');
		} finally {
			await client.close();
		}
	});

	it('omits tools the toolFilter rejects and keeps the rest, write gating included', async () => {
		const unfiltered = await connect(await createServer(fakeContext()));
		const all = (await unfiltered.listTools()).tools.map((t) => t.name);
		await unfiltered.close();

		const server = await createServer(fakeContext(), {
			toolFilter: (name) => !name.startsWith('oauth-'),
		});
		const client = await connect(server);
		try {
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).toEqual(all.filter((name) => !name.startsWith('oauth-')));
			expect(names).toContain('create-page');
		} finally {
			await client.close();
		}
	});

	it('still gates the write tools by wiki when a toolFilter hides others', async () => {
		const readOnlyWiki = { ...wikiConfig, readOnly: true };
		const ctx = fakeContext({
			wikis: {
				getAll: () => ({ 'test-wiki': readOnlyWiki }) as never,
				get: (() => readOnlyWiki) as never,
				add: vi.fn() as never,
				remove: vi.fn() as never,
				isManagementAllowed: () => false,
			},
		});
		const server = await createServer(ctx, { toolFilter: (name) => name !== 'get-page' });
		const client = await connect(server);
		try {
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).not.toContain('get-page');
			expect(names).not.toContain('create-page');
			expect(names).toContain('get-pages');
		} finally {
			await client.close();
		}
	});
});

describe('createServer change publishing', () => {
	it('does not publish during construction', async () => {
		const publisher = { toolsChanged: vi.fn(), resourcesChanged: vi.fn() };
		await createServer(fakeContext(), { publisher });
		expect(publisher.toolsChanged).not.toHaveBeenCalled();
		expect(publisher.resourcesChanged).not.toHaveBeenCalled();
	});

	it('publishes through the supplied publisher when a management tool reconciles', async () => {
		const wikis: Record<string, typeof wikiConfig> = {
			'test-wiki': wikiConfig,
			'fr.wikipedia.org': wikiConfig,
			'de.wikipedia.org': wikiConfig,
		};
		const ctx = fakeContext({
			wikis: {
				getAll: () => wikis as never,
				get: ((key: string) => (Object.hasOwn(wikis, key) ? wikis[key] : undefined)) as never,
				add: vi.fn() as never,
				remove: ((key: string) => {
					delete wikis[key];
				}) as never,
				isManagementAllowed: () => true,
			},
			wikiCache: { invalidate: vi.fn() as never },
		});
		const publisher = { toolsChanged: vi.fn(), resourcesChanged: vi.fn() };
		const server = await createServer(ctx, { publisher });

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'server-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		try {
			const result = await client.callTool({
				name: 'remove-wiki',
				arguments: { uri: 'mcp://wikis/fr.wikipedia.org' },
			});
			expect(result.isError ?? false).toBe(false);
			expect(publisher.resourcesChanged).toHaveBeenCalledTimes(1);
			expect(publisher.toolsChanged).toHaveBeenCalledTimes(1);
			expect(publisher.resourcesChanged.mock.invocationCallOrder[0]).toBeLessThan(
				publisher.toolsChanged.mock.invocationCallOrder[0],
			);
		} finally {
			await client.close();
		}
	});
});
