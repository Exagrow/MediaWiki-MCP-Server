import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { getPageOutline } from '../../src/tools/get-page-outline.ts';
import { getPage } from '../../src/tools/get-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { ContentFormat } from '../../src/results/contentFormat.ts';
import { SectionServiceImpl } from '../../src/services/sectionService.ts';
import {
	assertStructuredData,
	assertStructuredError,
	assertStructuredSuccess,
} from '../helpers/structuredResult.ts';

const PAGE = {
	pageid: 7,
	title: 'Copper',
	revisions: [
		{ revid: 3, timestamp: '2026-01-01T00:00:00Z', contentmodel: 'wikitext', size: 1000 },
	],
};

const SECTIONS = [
	{ index: '1', level: '2', line: 'Uses', number: '1', toclevel: 1, byteoffset: 100 },
	{ index: '2', level: '3', line: 'Chemistry', number: '1.1', toclevel: 2, byteoffset: 300 },
	{ index: '3', level: '2', line: 'History', number: '2', toclevel: 1, byteoffset: 600 },
];

function contextFor(page: unknown = PAGE, sections: unknown[] = SECTIONS) {
	const mock = createMockMwn({
		read: vi.fn().mockResolvedValue(page),
		request: vi.fn().mockResolvedValue({ parse: { sections } }),
	});
	const ctx = fakeContext({
		mwn: async () => mock as never,
		sections: new SectionServiceImpl(),
	});
	return { mock, ctx };
}

interface Payload {
	sections: string[];
	[field: string]: unknown;
}

describe('get-page-outline', () => {
	// The tool is get-page with metadata=true and content="none", asking for the
	// sized section lines. The arithmetic and the line format are tested with
	// the service.
	it('returns the payload get-page returns for metadata=true and content="none", apart from sections', async () => {
		const outline = contextFor();
		const direct = contextFor();

		const viaAlias = assertStructuredData(
			await getPageOutline.handle({ title: 'Copper', depth: 0 }, outline.ctx),
		) as Payload;
		const viaGetPage = assertStructuredData(
			await getPage.handle(
				{ title: 'Copper', content: ContentFormat.none, metadata: true },
				direct.ctx,
			),
		) as Payload;

		const { sections: outlineSections, ...outlineRest } = viaAlias;
		const { sections: pageSections, ...pageRest } = viaGetPage;
		expect(outlineRest).toEqual(pageRest);
		expect(outlineRest).toMatchObject({
			pageId: 7,
			title: 'Copper',
			latestRevisionId: 3,
			size: 1000,
		});
		expect(pageSections).toEqual(['0 (Lead)', '1 (Uses)', '2 (Chemistry)', '3 (History)']);
		expect(outlineSections).toEqual([
			'0 (Lead), 100B',
			'1 (Uses), 500B',
			'  2 (Chemistry), 300B',
			'3 (History), 400B',
		]);
	});

	it('makes the same requests as get-page does for metadata=true and content="none"', async () => {
		const outline = contextFor();
		const direct = contextFor();

		await getPageOutline.handle({ title: 'Copper', depth: 0 }, outline.ctx);
		await getPage.handle(
			{ title: 'Copper', content: ContentFormat.none, metadata: true },
			direct.ctx,
		);

		expect(outline.mock.read.mock.calls).toEqual(direct.mock.read.mock.calls);
		expect(outline.mock.request.mock.calls).toEqual(direct.mock.request.mock.calls);
		expect(outline.mock.read).toHaveBeenCalledTimes(1);
		expect(outline.mock.request).toHaveBeenCalledTimes(1);
		expect(outline.mock.request).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'parse', prop: 'sections' }),
		);
	});

	it('renders one text line per section', async () => {
		const { ctx } = contextFor();

		const result = await getPageOutline.handle({ title: 'Copper', depth: 0 }, ctx);

		expect(assertStructuredSuccess(result)).toContain(
			'Sections:\n- 0 (Lead), 100B\n- 1 (Uses), 500B\n-   2 (Chemistry), 300B\n- 3 (History), 400B',
		);
	});

	it('shows headings as plain text and sizes to two significant figures', async () => {
		const page = { ...PAGE, revisions: [{ ...PAGE.revisions[0], size: 159429 }] };
		const { ctx } = contextFor(page, [
			{
				index: '1',
				level: '2',
				line: 'Events (<span>1990</span>-<span>1995</span>)',
				number: '1',
				toclevel: 1,
				byteoffset: 67,
			},
		]);

		const result = await getPageOutline.handle({ title: 'Copper', depth: 0 }, ctx);

		expect((assertStructuredData(result) as Payload).sections).toEqual([
			'0 (Lead), 67B',
			'1 (Events (1990-1995)), 160000B',
		]);
	});

	it('limits the sections to the top level at depth 1, without changing their sizes', async () => {
		const { ctx } = contextFor();

		const result = await getPageOutline.handle({ title: 'Copper', depth: 1 }, ctx);

		expect((assertStructuredData(result) as Payload).sections).toEqual([
			'0 (Lead), 100B',
			'1 (Uses), 500B',
			'3 (History), 400B',
		]);
	});

	it('adds subsections at depth 2 and lists every heading at depth 0', async () => {
		const two = await getPageOutline.handle({ title: 'Copper', depth: 2 }, contextFor().ctx);
		const all = await getPageOutline.handle({ title: 'Copper', depth: 0 }, contextFor().ctx);

		expect((assertStructuredData(two) as Payload).sections).toHaveLength(4);
		expect(assertStructuredData(all)).toEqual(assertStructuredData(two));
	});

	// Three nesting levels, and an h4 straight under an h2 (section 5), which is
	// one level deep. depth follows the indentation, not the heading level.
	describe('on a page with three nesting levels and a skipped heading level', () => {
		const page = {
			...PAGE,
			title: 'Sample article',
			revisions: [{ ...PAGE.revisions[0], size: 5000 }],
		};
		const sections = [
			{ index: '1', level: '2', line: 'Overview', number: '1', toclevel: 1, byteoffset: 120 },
			{ index: '2', level: '3', line: 'Origins', number: '1.1', toclevel: 2, byteoffset: 400 },
			{ index: '3', level: '4', line: 'Details', number: '1.1.1', toclevel: 3, byteoffset: 900 },
			{ index: '4', level: '2', line: 'Results', number: '2', toclevel: 1, byteoffset: 1500 },
			{ index: '5', level: '4', line: 'Notes', number: '2.1', toclevel: 2, byteoffset: 2100 },
			{ index: '6', level: '2', line: 'Sources', number: '3', toclevel: 1, byteoffset: 2600 },
		];
		const linesAt = async (depth: number) =>
			(
				assertStructuredData(
					await getPageOutline.handle(
						{ title: 'Sample article', depth },
						contextFor(page, sections).ctx,
					),
				) as Payload
			).sections;

		it('indents by outline depth', async () => {
			expect(await linesAt(0)).toEqual([
				'0 (Lead), 120B',
				'1 (Overview), 1400B',
				'  2 (Origins), 1100B',
				'    3 (Details), 600B',
				'4 (Results), 1100B',
				'  5 (Notes), 500B',
				'6 (Sources), 2400B',
			]);
		});

		it('keeps the skipped-level section at depth 2 and drops only the third level', async () => {
			expect(await linesAt(2)).toEqual([
				'0 (Lead), 120B',
				'1 (Overview), 1400B',
				'  2 (Origins), 1100B',
				'4 (Results), 1100B',
				'  5 (Notes), 500B',
				'6 (Sources), 2400B',
			]);
		});

		it('lists only top-level sections at depth 1', async () => {
			expect(await linesAt(1)).toEqual([
				'0 (Lead), 120B',
				'1 (Overview), 1400B',
				'4 (Results), 1100B',
				'6 (Sources), 2400B',
			]);
		});
	});

	it('falls back to the short lines when the revision has no size', async () => {
		const noSize = { ...PAGE, revisions: [{ ...PAGE.revisions[0], size: undefined }] };
		const { ctx } = contextFor(noSize);

		const result = await getPageOutline.handle({ title: 'Copper', depth: 0 }, ctx);

		expect((assertStructuredData(result) as Payload).sections).toEqual([
			'0 (Lead)',
			'1 (Uses)',
			'2 (Chemistry)',
			'3 (History)',
		]);
	});

	it('falls back to the short lines when a heading has no byte offset', async () => {
		const { ctx } = contextFor(PAGE, [
			{ index: '1', level: '2', line: 'Uses', number: '1' },
			{ index: '2', level: '2', line: 'History', number: '2', toclevel: 1, byteoffset: 600 },
		]);

		const result = await getPageOutline.handle({ title: 'Copper', depth: 0 }, ctx);

		expect((assertStructuredData(result) as Payload).sections).toEqual([
			'0 (Lead)',
			'1 (Uses)',
			'2 (History)',
		]);
	});

	it('returns not_found when the page does not exist', async () => {
		const { ctx } = contextFor({ title: 'Nope', missing: true });

		const result = await getPageOutline.handle({ title: 'Nope', depth: 0 }, ctx);

		assertStructuredError(result, 'not_found');
	});

	it('classifies an API failure through the dispatcher', async () => {
		const mock = createMockMwn({ read: vi.fn().mockRejectedValue(new Error('boom')) });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(getPageOutline, ctx)({ title: 'Copper', depth: 0 });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('Failed to retrieve page outline');
	});
});
