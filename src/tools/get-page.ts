import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { readPages } from '../wikis/readPages.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import { htmlToText } from '../results/htmlText.ts';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.ts';
import {
	findSectionByHeading,
	outlineLines,
	toOutlineLines,
	type SectionEntry,
} from '../services/sectionService.ts';
import { sectionContentTruncation } from '../services/sectionMarker.ts';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	content: z
		.nativeEnum(ContentFormat)
		.optional()
		.default(ContentFormat.source)
		.describe('Type of content to return'),
	metadata: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Whether to include metadata (page ID, revision info, size, section outline) in the response',
		),
	section: z
		.union([z.number().int().nonnegative(), z.string().min(1)])
		.optional()
		.describe(
			'Narrows content to one section: a section number (0 = lead; 1..N = heading sections) or a heading, matched case-insensitively against the editable sections. A heading that matches no section or more than one is rejected; the error lists the sections.',
		),
} as const;

type SectionResolution =
	| { section: number | undefined; entries: SectionEntry[] | undefined }
	| { error: CallToolResult };

// A heading is looked up in the page's section list, which is returned so the
// caller does not fetch it a second time. A number, or digits in a string,
// needs no lookup.
async function resolveSection(
	requested: number | string | undefined,
	title: string,
	mwn: Awaited<ReturnType<ToolContext['mwn']>>,
	ctx: ToolContext,
): Promise<SectionResolution> {
	if (requested === undefined || typeof requested === 'number') {
		return { section: requested, entries: undefined };
	}
	const heading = requested.trim();
	if (heading === '') {
		return { error: ctx.format.invalidInput('section must not be empty') };
	}
	if (/^\d+$/.test(heading)) {
		return { section: Number.parseInt(heading, 10), entries: undefined };
	}
	const entries = await ctx.sections.list(mwn, title);
	const match = findSectionByHeading(entries, heading);
	if (match.kind === 'one') {
		return { section: match.index, entries };
	}
	const byIndex = new Map(entries.map((e) => [Number.parseInt(e.index, 10), e]));
	// The short lines, not the sized ones: this is a list to choose from.
	const outline = toOutlineLines(entries);
	if (match.kind === 'none') {
		return {
			error: ctx.format.notFound(
				`Page "${title}" has no section headed "${heading}". Sections: ${outline.join('; ')}`,
			),
		};
	}
	const candidates = match.indexes.map((i) => `${i} (${byIndex.get(i)?.line ?? ''})`);
	return {
		error: ctx.format.invalidInput(
			`Heading "${heading}" matches ${match.indexes.length} sections on page "${title}": ${candidates.join('; ')}. Pass the section number to choose one.`,
		),
	};
}

type GetPageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * The whole of get-page, kept apart from the descriptor so that
 * get-page-outline is this same call under another name instead of a second
 * implementation. `outline` is the one thing a caller can add, and get-page
 * never sets it: it swaps the short `sections` lines for the sized ones
 * (outlineLines), limited to `depth` heading levels. It changes nothing else,
 * so it never changes which requests are made.
 */
export async function readPage(
	{ title, content, metadata, section: requestedSection }: GetPageArgs,
	ctx: ToolContext,
	{ outline }: { readonly outline?: { readonly depth: number } } = {},
): Promise<CallToolResult> {
	if (content === ContentFormat.none && !metadata) {
		return ctx.format.invalidInput('When content is set to "none", metadata must be true');
	}
	if (requestedSection !== undefined && content === ContentFormat.none) {
		return ctx.format.invalidInput('section is not compatible with content="none"');
	}

	const mwn = await ctx.mwn();

	const payload: {
		pageId?: number;
		title?: string;
		latestRevisionId?: number;
		latestRevisionTimestamp?: string;
		contentModel?: string;
		size?: number;
		url?: string;
		sections?: string[];
		source?: string;
		html?: string;
		text?: string;
		truncation?: TruncationInfo;
	} = {};

	const needsReadCall =
		metadata || content === ContentFormat.source || content === ContentFormat.none;
	const needsSource = content === ContentFormat.source;

	const resolution = await resolveSection(requestedSection, title, mwn, ctx);
	if ('error' in resolution) {
		return resolution.error;
	}
	const { section } = resolution;
	let entries = resolution.entries;

	if (needsReadCall) {
		const rvprop = needsSource
			? 'ids|timestamp|contentmodel|size|content'
			: 'ids|timestamp|contentmodel|size';
		const readParams: Record<string, string | number> = { rvprop };
		if (needsSource && section !== undefined) {
			readParams.rvsection = section;
		}
		const page = await readPages(mwn, title, readParams);

		if (page.missing) {
			return ctx.format.notFound(`Page "${title}" not found`);
		}

		const rev = page.revisions?.[0];

		if (metadata) {
			entries ??= await ctx.sections.list(mwn, title);
		}

		// The revision ID rides on every read that fetches content, and a write
		// scoped to a section needs it to say which revision its section
		// number was read from. Withholding it behind metadata=true made the
		// natural read-modify-write sequence fail on the write and then need a
		// second read to recover, so it is reported whenever content is.
		if (needsSource && rev?.revid !== undefined) {
			payload.latestRevisionId = rev.revid;
		}

		if (metadata || content === ContentFormat.none) {
			payload.pageId = page.pageid;
			payload.title = page.title;
			payload.latestRevisionId = rev?.revid;
			payload.latestRevisionTimestamp = rev?.timestamp;
			payload.contentModel = rev?.contentmodel;
			if (rev?.size !== undefined) {
				payload.size = rev.size;
			}
			if (entries !== undefined) {
				// Sizes come from the heading byte offsets and the revision size,
				// both already fetched, so the outline makes no request of its own.
				payload.sections =
					outline === undefined
						? toOutlineLines(entries)
						: outlineLines(entries, rev?.size, outline.depth);
			}
			payload.url = await buildPageUrl(ctx, page.title);
		}

		if (needsSource && rev?.content !== undefined) {
			const truncated = truncateByBytes(rev.content);
			payload.source = truncated.text;
			if (truncated.truncated) {
				entries ??= await ctx.sections.list(mwn, title);
				payload.truncation = sectionContentTruncation({
					entries,
					section,
					itemNoun: 'wikitext',
					toolName: 'get-page',
					returnedBytes: truncated.returnedBytes,
					totalBytes: truncated.totalBytes,
				});
			}
		}
	}

	if (content === ContentFormat.html || content === ContentFormat.text) {
		const parseParams: Record<string, string | number> = {
			action: 'parse',
			page: title,
			prop: 'text',
			formatversion: '2',
		};
		if (section !== undefined) {
			parseParams.section = section;
		}
		const parseResult = await mwn.request(parseParams);
		const html: string | undefined = parseResult.parse?.text;

		if (html !== undefined) {
			const asText = content === ContentFormat.text;
			const truncated = truncateByBytes(asText ? htmlToText(html) : html);
			if (asText) {
				payload.text = truncated.text;
			} else {
				payload.html = truncated.text;
			}

			if (payload.title === undefined) {
				const resolvedTitle: string = parseResult.parse?.title ?? title;
				payload.title = resolvedTitle;
				if (parseResult.parse?.pageid !== undefined) {
					payload.pageId = parseResult.parse.pageid;
				}
				payload.url = await buildPageUrl(ctx, resolvedTitle);
			}

			if (truncated.truncated) {
				entries ??= await ctx.sections.list(mwn, title);
				payload.truncation = sectionContentTruncation({
					entries,
					section,
					itemNoun: asText ? 'text' : 'HTML',
					toolName: 'get-page',
					returnedBytes: truncated.returnedBytes,
					totalBytes: truncated.totalBytes,
				});
			}
		}
	}

	return ctx.format.ok(payload);
}

export const getPage: Tool<typeof inputSchema> = {
	name: 'get-page',
	description:
		'Returns a single wiki page (wikitext source, rendered HTML, readable plain text, or metadata only). If the title does not exist, an error is returned. Use metadata=true to retrieve the revision ID (for edit-conflict detection), page size, and section outline. Set content="none" to fetch only metadata. Use content="text" to read the page as prose: the rendered page with headings as # lines, lists as - bullets, table cells joined with |, and edit links, the table of contents and navigation boxes left out; it is not wikitext, so choose "source" to edit and "html" for markup. Large content is truncated at 75000 bytes by default, with a marker reporting how much of it was returned and which sections a narrower read can target; a follow-up call with section=N, or section set to a heading, fetches a specific section. For the sections of a long page and their sizes, call get-page-outline first. For more than one page at a time, use get-pages. For a specific historical revision, use get-revision.',
	inputSchema,
	annotations: {
		title: 'Get page',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve page data',
	target: (a) => a.title,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		return readPage(args, ctx);
	},
};
