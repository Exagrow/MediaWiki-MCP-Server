import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import { readPage } from './get-page.ts';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	depth: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.default(0)
		.describe(
			'How many heading levels to list: 1 for top-level sections only, 2 to add their subsections, and so on. 0 lists every heading.',
		),
} as const;

export const getPageOutline: Tool<typeof inputSchema> = {
	name: 'get-page-outline',
	description:
		'Returns a wiki page\'s sections without its content, to show the shape of a long page before reading part of it. Each line reads "<section number> (<heading>), <size> bytes": the leading number is the value get-page accepts as section, two spaces of indentation per level show nesting, and the size is approximate (two significant figures), in bytes of wikitext including subsections. depth limits the nesting levels listed. Makes the same read as get-page with metadata=true and content="none", so the result also carries the page ID, revision and page size. If the title does not exist, an error is returned.',
	inputSchema,
	annotations: {
		title: 'Get page outline',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve page outline',
	target: (a) => a.title,

	async handle({ title, depth }, ctx: ToolContext): Promise<CallToolResult> {
		return readPage({ title, content: ContentFormat.none, metadata: true }, ctx, {
			outline: { depth },
		});
	},
};
