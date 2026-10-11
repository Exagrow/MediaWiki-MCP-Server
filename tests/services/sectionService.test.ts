import { describe, it, expect, vi } from 'vitest';
import {
	SectionServiceImpl,
	buildOutline,
	formatApproxBytes,
	formatOutlineLine,
	outlineLines,
	plainHeading,
	findSectionByHeading,
	toOutlineLines,
	type SectionEntry,
} from '../../src/services/sectionService.ts';

function mockWithSections(sections: unknown[]) {
	return {
		request: vi.fn().mockResolvedValue({ parse: { sections } }),
	};
}

describe('SectionServiceImpl', () => {
	it('carries the section id, heading level and text', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'Etymology' },
			{ index: '2', level: '2', line: 'History' },
			{ index: '3', level: '3', line: 'Feudal era' },
		]);

		expect(await new SectionServiceImpl().list(mock as never, 'Japan')).toEqual([
			{ index: '1', level: 2, line: 'Etymology', editable: true },
			{ index: '2', level: 2, line: 'History', editable: true },
			{ index: '3', level: 3, line: 'Feudal era', editable: true },
		]);
	});

	// A transcluded section carries a `T-` prefixed id and cannot be edited on
	// the host page, so a caller must never be handed it as a section number.
	it('marks a transcluded section as not editable', async () => {
		const mock = mockWithSections([
			{ index: 'T-1', level: '2', line: 'About administrators' },
			{ index: '1', level: '2', line: 'Current nominations' },
		]);

		const result = await new SectionServiceImpl().list(mock as never, 'RfA');
		expect(result[0]).toMatchObject({ index: 'T-1', editable: false });
		expect(result[1]).toMatchObject({ index: '1', editable: true });
	});

	it('carries the byte offset, outline number and outline depth the API reports', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'History', number: '1', toclevel: 1, byteoffset: 120 },
			{ index: '2', level: '3', line: 'Feudal era', number: '1.1', toclevel: 2, byteoffset: 480 },
		]);

		const result = await new SectionServiceImpl().list(mock as never, 'Japan');

		expect(result[0]).toMatchObject({ byteOffset: 120, number: '1', tocLevel: 1 });
		expect(result[1]).toMatchObject({ byteOffset: 480, number: '1.1', tocLevel: 2 });
	});

	it('leaves the outline depth absent when the API gives none', async () => {
		const mock = mockWithSections([{ index: '1', level: '2', line: 'History' }]);

		const [entry] = await new SectionServiceImpl().list(mock as never, 'Japan');

		expect(entry.tocLevel).toBeUndefined();
	});

	// MediaWiki reports a null `byteoffset` for a transcluded section: the
	// heading has no position in this page's wikitext.
	it('leaves the byte offset absent when the API reports null', async () => {
		const mock = mockWithSections([
			{ index: 'T-1', level: '2', line: 'From a template', number: '', byteoffset: null },
		]);

		const [entry] = await new SectionServiceImpl().list(mock as never, 'RfA');

		expect(entry.byteOffset).toBeUndefined();
	});

	it('returns an empty list for a page with no headings', async () => {
		expect(await new SectionServiceImpl().list(mockWithSections([]) as never, 'Empty')).toEqual([]);
	});
});

describe('listInSource', () => {
	it('sends the source to be parsed in the context of the named page', async () => {
		const mock = mockWithSections([]);

		await new SectionServiceImpl().listInSource(mock as never, 'Japan', '== History ==\nBody.');

		expect(mock.request).toHaveBeenCalledWith({
			action: 'parse',
			text: '== History ==\nBody.',
			title: 'Japan',
			contentmodel: 'wikitext',
			prop: 'sections',
			formatversion: '2',
		});
	});

	it('carries the section id, heading level and text', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'History' },
			{ index: '2', level: '3', line: 'Feudal era' },
		]);

		expect(
			await new SectionServiceImpl().listInSource(mock as never, 'Japan', 'irrelevant'),
		).toEqual([
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: '2', level: 3, line: 'Feudal era', editable: true },
		]);
	});

	// A template in the source expands to sections the caller did not write;
	// the parser reports them with `T-` ids, exactly as on a stored page.
	it('marks a template-expanded section as not editable', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'History' },
			{ index: 'T-1', level: '3', line: 'Transcluded child' },
		]);

		const result = await new SectionServiceImpl().listInSource(
			mock as never,
			'Japan',
			'== History ==\n{{Probe}}',
		);

		expect(result[1]).toMatchObject({ index: 'T-1', editable: false });
	});
});

describe('toOutlineLines', () => {
	it('numbers each entry with the section number it is edited by', () => {
		expect(
			toOutlineLines([
				{ index: '1', level: 2, line: 'Etymology', editable: true },
				{ index: '2', level: 2, line: 'History', editable: true },
			]),
		).toEqual(['0 (Lead)', '1 (Etymology)', '2 (History)']);
	});

	// A transcluded heading occupies a position in the outline but is not
	// addressable by section number, so listing it shifts every later heading
	// away from the number that edits it.
	it('omits transcluded headings, which no section number addresses', () => {
		expect(
			toOutlineLines([
				{ index: 'T-1', level: 2, line: 'From a template', editable: false },
				{ index: '1', level: 2, line: 'Etymology', editable: true },
			]),
		).toEqual(['0 (Lead)', '1 (Etymology)']);
	});

	it('renders a page with no headings as the lead alone', () => {
		expect(toOutlineLines([])).toEqual(['0 (Lead)']);
	});
});

describe('formatOutlineLine', () => {
	it('renders the lead and a top-level section without indentation', () => {
		expect(formatOutlineLine({ index: 0, heading: 'Lead', approxBytes: 4300 })).toBe(
			'0 (Lead), 4300B',
		);
		expect(
			formatOutlineLine({ index: 1, nesting: 0, heading: 'Overview', approxBytes: 1400 }),
		).toBe('1 (Overview), 1400B');
	});

	it('indents two spaces per nesting level', () => {
		expect(formatOutlineLine({ index: 2, nesting: 1, heading: 'Origins', approxBytes: 500 })).toBe(
			'  2 (Origins), 500B',
		);
		expect(formatOutlineLine({ index: 8, nesting: 2, heading: 'Details', approxBytes: 600 })).toBe(
			'    8 (Details), 600B',
		);
	});

	it('keeps the size to two significant figures', () => {
		expect(formatOutlineLine({ index: 4, nesting: 0, heading: 'Alloys', approxBytes: 574 })).toBe(
			'4 (Alloys), 570B',
		);
	});

	it('shows the heading as plain text', () => {
		expect(
			formatOutlineLine({
				index: 2,
				nesting: 0,
				heading: 'Events (<span>1990</span>-<span>1995</span>)',
				approxBytes: 15622,
			}),
		).toBe('2 (Events (1990-1995)), 16000B');
		expect(
			formatOutlineLine({ index: 3, heading: 'Fish &amp; <i>Chips</i>', approxBytes: 67 }),
		).toBe('3 (Fish & Chips), 67B');
	});

	it('never prints an outline number', () => {
		expect(
			formatOutlineLine({ index: 5, nesting: 1, heading: 'Notes', approxBytes: 12 }),
		).not.toMatch(/\d\.\d/);
	});
});

describe('formatApproxBytes', () => {
	// Two significant figures, halves away from zero, plain integer, capital B.
	it.each([
		[0, '0B'],
		[5, '5B'],
		[67, '67B'],
		[99, '99B'],
		[100, '100B'],
		[311, '310B'],
		[990, '990B'],
		[994, '990B'],
		[995, '1000B'],
		[1050, '1100B'],
		[1162, '1200B'],
		[15622, '16000B'],
		[99499, '99000B'],
		[99500, '100000B'],
		[159429, '160000B'],
	])('renders %i as %s', (bytes, expected) => {
		expect(formatApproxBytes(bytes)).toBe(expected);
	});
});

describe('plainHeading', () => {
	it('removes tags and decodes entities, keeping case', () => {
		expect(plainHeading('Events (<span>1990</span>-<span>1995</span>)')).toBe('Events (1990-1995)');
		expect(plainHeading(' <i>Further Reading</i> ')).toBe('Further Reading');
		expect(plainHeading('R&amp;D caf&#233; &#x41;')).toBe('R&D caf\u00e9 A');
	});
});

function entry(
	index: string,
	level: number,
	line: string,
	byteOffset?: number,
	number?: string,
	tocLevel?: number,
): SectionEntry {
	return {
		index,
		level,
		line,
		editable: /^[1-9]\d*$/.test(index),
		...(byteOffset !== undefined ? { byteOffset } : {}),
		...(number !== undefined ? { number } : {}),
		...(tocLevel !== undefined ? { tocLevel } : {}),
	};
}

const OUTLINE_ENTRIES = [
	entry('1', 2, 'Uses', 100, '1', 1),
	entry('2', 3, 'Chemistry', 300, '1.1', 2),
	entry('3', 2, 'History', 600, '2', 1),
];

// Three nesting levels, and a page that skips a heading level: section 6 is an
// h4 straight under the h2 "Results", so it is one level deep, not two.
const DEEP_ENTRIES = [
	entry('1', 2, 'Overview', 120, '1', 1),
	entry('2', 3, 'Origins', 400, '1.1', 2),
	entry('3', 4, 'Details', 900, '1.1.1', 3),
	entry('4', 2, 'Results', 1500, '2', 1),
	entry('5', 4, 'Notes', 2100, '2.1', 2),
	entry('6', 2, 'Sources', 2600, '3', 1),
];

describe('buildOutline', () => {
	it('sizes the lead by the bytes before the first heading and each section through its subsections', () => {
		expect(buildOutline(OUTLINE_ENTRIES, 1000)).toEqual([
			{ index: 0, heading: 'Lead', approxBytes: 100 },
			{ index: 1, nesting: 0, heading: 'Uses', approxBytes: 500 },
			{ index: 2, nesting: 1, heading: 'Chemistry', approxBytes: 300 },
			{ index: 3, nesting: 0, heading: 'History', approxBytes: 400 },
		]);
	});

	it('sizes the lead as the whole page when there are no headings', () => {
		expect(buildOutline([], 1000)).toEqual([{ index: 0, heading: 'Lead', approxBytes: 1000 }]);
	});

	it('sizes the last section through the end of the page', () => {
		const [, only] = buildOutline([entry('1', 2, 'Only', 250, '1', 1)], 1000);

		expect(only.approxBytes).toBe(750);
	});

	it('limits to top-level sections at depth 1 and keeps their sizes', () => {
		expect(buildOutline(OUTLINE_ENTRIES, 1000, 1).map((s) => [s.index, s.approxBytes])).toEqual([
			[0, 100],
			[1, 500],
			[3, 400],
		]);
	});

	it('adds subsections at depth 2 and lists every heading at depth 0', () => {
		expect(buildOutline(OUTLINE_ENTRIES, 1000, 2)).toHaveLength(4);
		expect(buildOutline(OUTLINE_ENTRIES, 1000, 0)).toHaveLength(4);
		expect(buildOutline(OUTLINE_ENTRIES, 1000)).toHaveLength(4);
	});

	it('ends a section at the next heading of the same or a higher level, not a deeper one', () => {
		const sized = buildOutline(
			[entry('1', 3, 'A', 100), entry('2', 4, 'B', 200), entry('3', 3, 'C', 500)],
			1000,
		);

		expect(sized.map((s) => s.approxBytes)).toEqual([100, 400, 300, 500]);
	});

	// A transcluded heading has no section number and no byte offset; it must
	// neither appear nor end the section before it.
	it('leaves out transcluded headings and does not let one end the section before it', () => {
		const sized = buildOutline(
			[
				entry('1', 2, 'Uses', 100, '1', 1),
				entry('T-1', 2, 'From a template', undefined, ''),
				entry('2', 2, 'History', 600, '2', 1),
			],
			1000,
		);

		expect(sized.map((s) => s.heading)).toEqual(['Lead', 'Uses', 'History']);
		expect(sized[1].approxBytes).toBe(500);
	});

	it('never reports a negative size', () => {
		expect(buildOutline([entry('1', 2, 'Odd', 900, '1', 1)], 500)[1].approxBytes).toBe(0);
	});

	describe('nesting', () => {
		const nestingOf = (entries: SectionEntry[]) =>
			buildOutline(entries, 5000)
				.slice(1)
				.map((s) => s.nesting);

		it('is the outline depth the API reports, less one', () => {
			expect(nestingOf(DEEP_ENTRIES)).toEqual([0, 1, 2, 0, 1, 0]);
		});

		// An h4 straight under an h2 is one level deep. The heading level alone
		// would say two.
		it('counts a skipped heading level as one level, not two', () => {
			expect(
				nestingOf([entry('1', 2, 'A', 100, '1', 1), entry('2', 4, 'B', 200, '1.1', 2)]),
			).toEqual([0, 1]);
		});

		it('falls back to the dots in the outline number when the API gave no depth', () => {
			expect(
				nestingOf([
					entry('1', 2, 'A', 100, '1'),
					entry('2', 4, 'B', 200, '1.1'),
					entry('3', 5, 'C', 300, '1.1.1'),
				]),
			).toEqual([0, 1, 2]);
		});

		it('falls back to the heading level less two when there is neither', () => {
			expect(
				nestingOf([entry('1', 2, 'A', 100), entry('2', 3, 'B', 200, ''), entry('3', 4, 'C', 300)]),
			).toEqual([0, 1, 2]);
		});

		it('never goes below zero', () => {
			expect(nestingOf([entry('1', 1, 'A', 100), entry('2', 2, 'B', 200, undefined, 0)])).toEqual([
				0, 0,
			]);
		});
	});

	// The depth filter uses the same nesting the lines are indented by, so
	// depth 2 lists exactly the lines indented at most one level.
	describe('depth on a page that skips a heading level', () => {
		const indexesAt = (depth: number) =>
			buildOutline(DEEP_ENTRIES, 5000, depth).map((s) => s.index);

		it('keeps the skipped-level section at depth 2, because it is one level deep', () => {
			expect(indexesAt(2)).toEqual([0, 1, 2, 4, 5, 6]);
		});

		it('keeps only top-level sections at depth 1 and everything at depth 3 or 0', () => {
			expect(indexesAt(1)).toEqual([0, 1, 4, 6]);
			expect(indexesAt(3)).toEqual([0, 1, 2, 3, 4, 5, 6]);
			expect(indexesAt(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		});
	});
});

describe('outlineLines', () => {
	it('renders the sized lines, indented by nesting', () => {
		expect(outlineLines(OUTLINE_ENTRIES, 1000)).toEqual([
			'0 (Lead), 100B',
			'1 (Uses), 500B',
			'  2 (Chemistry), 300B',
			'3 (History), 400B',
		]);
	});

	it('renders three nesting levels and a skipped level', () => {
		expect(outlineLines(DEEP_ENTRIES, 5000)).toEqual([
			'0 (Lead), 120B',
			'1 (Overview), 1400B',
			'  2 (Origins), 1100B',
			'    3 (Details), 600B',
			'4 (Results), 1100B',
			'  5 (Notes), 500B',
			'6 (Sources), 2400B',
		]);
	});

	it('applies depth to the sized lines', () => {
		expect(outlineLines(OUTLINE_ENTRIES, 1000, 1)).toEqual([
			'0 (Lead), 100B',
			'1 (Uses), 500B',
			'3 (History), 400B',
		]);
	});

	it('gives the short lines when the page size is unknown', () => {
		expect(outlineLines(OUTLINE_ENTRIES, undefined)).toEqual(toOutlineLines(OUTLINE_ENTRIES));
	});

	it('gives the short lines for every section when any editable heading has no byte offset', () => {
		expect(
			outlineLines(
				[entry('1', 2, 'Uses', undefined, '1', 1), entry('2', 2, 'History', 600, '2', 1)],
				1000,
			),
		).toEqual(['0 (Lead)', '1 (Uses)', '2 (History)']);
	});

	it('does not count a transcluded heading as a missing byte offset', () => {
		expect(
			outlineLines([entry('1', 2, 'Uses', 100, '1', 1), entry('T-1', 2, 'Templated')], 1000),
		).toEqual(['0 (Lead), 100B', '1 (Uses), 900B']);
	});

	it('applies depth to the short lines too, by the same nesting', () => {
		expect(
			outlineLines(
				[
					entry('1', 2, 'Uses', undefined, '1', 1),
					entry('2', 4, 'Skipped', undefined, '1.1', 2),
					entry('3', 5, 'Deep', undefined, '1.1.1', 3),
				],
				1000,
				2,
			),
		).toEqual(['0 (Lead)', '1 (Uses)', '2 (Skipped)']);
	});
});

describe('findSectionByHeading', () => {
	const entry = (index: string, line: string, editable = true): SectionEntry => ({
		index,
		level: 2,
		line,
		editable,
	});

	it('finds one section, ignoring case and surrounding whitespace', () => {
		const entries = [entry('1', 'History'), entry('2', 'Geography')];
		expect(findSectionByHeading(entries, '  geography ')).toEqual({ kind: 'one', index: 2 });
	});

	it('compares the visible text of a heading that carries markup and entities', () => {
		const entries = [entry('1', '<i>Further Reading</i>'), entry('2', 'R&amp;D caf&#233;')];
		expect(findSectionByHeading(entries, 'further reading')).toEqual({ kind: 'one', index: 1 });
		expect(findSectionByHeading(entries, 'R&D caf\u00e9')).toEqual({ kind: 'one', index: 2 });
	});

	it('reports every match when a heading is ambiguous', () => {
		const entries = [entry('1', 'Trivia'), entry('2', 'Plot'), entry('3', 'TRIVIA')];
		expect(findSectionByHeading(entries, 'trivia')).toEqual({ kind: 'many', indexes: [1, 3] });
	});

	it('reports none when nothing matches, and skips transcluded sections', () => {
		const entries = [entry('T-1', 'Shared', false), entry('1', 'History')];
		expect(findSectionByHeading(entries, 'Shared')).toEqual({ kind: 'none' });
		expect(findSectionByHeading(entries, 'Missing')).toEqual({ kind: 'none' });
	});
});
