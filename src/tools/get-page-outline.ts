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
		'Returns a wiki page\'s section outline without its content: the same as get-page with metadata=true and content="none", offered under its own name so it is easy to find, but with each section line carrying its size and indented by nesting, and a depth limit on the headings listed. The result carries the title, page ID, revision ID and timestamp, content model, page size in bytes, URL, and the sections. Each section line reads "<section number> (<heading>), <size>B", for example "4 (Alloys), 570B": the leading number is the value get-page accepts as section, two spaces of indentation per level show nesting (a subsection sits one step in from its parent), and the size is approximate, to two significant figures, in bytes of the section\'s wikitext including its subsections. The heading is plain text, with markup removed. The lead, section 0, is not indented: "0 (Lead), 760B". A wiki that reports no heading offsets gives the short form "<section number> (<heading>)". Headings that come from transcluded templates are left out, because no section number addresses them. For a long page, call get-page-outline first to see its shape, then get-page with section=N to read only the section needed. If the title does not exist, an error is returned.',
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
