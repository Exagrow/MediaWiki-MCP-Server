import type { Mwn } from 'mwn';

export interface SectionEntry {
	/** MediaWiki's own section id, as sent to `section=`. Non-numeric when transcluded. */
	index: string;
	/** Heading depth as an `=` count, 2..6, from the API's `level`. */
	level: number;
	/** Heading text. */
	line: string;
	/** False when the section is transcluded and cannot be edited on this page. */
	editable: boolean;
	/** Byte offset of the heading in the page's wikitext, from the API's `byteoffset`. Absent when transcluded. */
	byteOffset?: number;
	/** Outline number such as `2.1`, from the API's `number`. */
	number?: string;
	/** Depth in the page's outline, 1 for a top-level section, from the API's `toclevel`. */
	tocLevel?: number;
}

export interface SectionService {
	list(mwn: Mwn, title: string, revisionId?: number): Promise<SectionEntry[]>;
	listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]>;
}

interface PageSectionsApi {
	index?: string;
	level?: string;
	line?: string;
	byteoffset?: number | null;
	number?: string;
	toclevel?: number;
}

// The API reports `index` as `T-1`, `T-2`, … for sections that arrive by
// transclusion. Those cannot be edited on the host page, and their presence
// shifts every later entry's position away from its section number.
function isEditableIndex(index: string): boolean {
	return /^[1-9]\d*$/.test(index);
}

export class SectionServiceImpl implements SectionService {
	// `revisionId` asks for the outline as that revision had it. A write scoped
	// to a section resolves the number against the revision it names, so a guard
	// reading the current outline judges a different section than the one the
	// write will replace.
	public async list(mwn: Mwn, title: string, revisionId?: number): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			...(revisionId === undefined ? { page: title } : { oldid: String(revisionId) }),
			prop: 'sections',
			formatversion: '2',
		});
	}

	// Parses `source` the way the wiki itself will when an edit lands, so the
	// sections found here agree with the outline `list` reports for the page —
	// one parser decides what counts as a heading on both sides. `title` gives
	// templates in the source their page context.
	public async listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			text: source,
			title,
			contentmodel: 'wikitext',
			prop: 'sections',
			formatversion: '2',
		});
	}

	private async parseSections(mwn: Mwn, params: Record<string, string>): Promise<SectionEntry[]> {
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await mwn.request(params)) as { parse?: { sections?: PageSectionsApi[] } } | undefined;
		return (response?.parse?.sections ?? []).map((s) => {
			const index = s.index ?? '';
			return {
				index,
				level: Number.parseInt(s.level ?? '', 10) || 0,
				line: s.line ?? '',
				editable: isEditableIndex(index),
				...(typeof s.byteoffset === 'number' ? { byteOffset: s.byteoffset } : {}),
				...(s.number !== undefined ? { number: s.number } : {}),
				...(typeof s.toclevel === 'number' ? { tocLevel: s.toclevel } : {}),
			};
		});
	}
}

// The published outline: one line per section, each labelled with the number
// that edits it. Transcluded headings are left out — they appear on the page but
// no `section=` value addresses them, so listing them shifts every later heading
// away from its own number. Kept separate from the service so the richer entries
// stay available internally to the guards and markers that need levels.
export function toOutlineLines(entries: readonly SectionEntry[]): string[] {
	return ['0 (Lead)', ...entries.filter((e) => e.editable).map((e) => `${e.index} (${e.line})`)];
}

// One section of the get-page-outline listing, before it is flattened to a line.
// `nesting` is 0 for the lead and for a top-level section, 1 for a subsection of
// one, and so on.
export interface OutlineEntry {
	index: number;
	nesting?: number;
	heading: string;
	approxBytes: number;
}

const NAMED_ENTITIES: Record<string, string> = {
	'&lt;': '<',
	'&gt;': '>',
	'&amp;': '&',
	'&quot;': '"',
	'&apos;': "'",
	'&nbsp;': ' ',
};

function codePoint(code: string, radix: number): string {
	const cp = Number.parseInt(code, radix);
	return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

// The API sends a heading as the HTML the parser rendered, so `<i>Further
// Reading</i>` and `Fish &amp; Chips` reach us as markup. This is what a reader
// sees on the page: tags removed, entities decoded, surrounding whitespace
// trimmed. Case is kept.
export function plainHeading(html: string): string {
	return html
		.replace(/<[^>]+>/g, '')
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => codePoint(code, 16))
		.replace(/&#(\d+);/g, (_, code: string) => codePoint(code, 10))
		.replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => NAMED_ENTITIES[m] ?? m)
		.trim();
}

// A size to two significant figures, as a plain integer with a `B` unit and no
// space: 159429 is "160000B", 1162 is "1200B", 67 is "67B". Halves round away
// from zero (Math.round, on a count that is never negative), so 995 is "1000B".
// The figure is a guide to scale, not a measurement.
export function formatApproxBytes(bytes: number): string {
	if (bytes < 100) {
		return `${bytes}B`;
	}
	const unit = 10 ** (String(Math.trunc(bytes)).length - 2);
	return `${Math.round(bytes / unit) * unit}B`;
}

// The one place a get-page-outline line is laid out. It extends the
// toOutlineLines shape, "<index> (<heading>)", with the size, and shows nesting
// by indenting two spaces per level: "  2 (Origins), 500B" is a subsection of
// the top-level "1 (Overview), 1400B". The heading is shown as plain text. The
// lead and top-level sections are not indented. One string per section renders
// as one line, where an object renders as a line per field.
export function formatOutlineLine(entry: OutlineEntry): string {
	const indent = '  '.repeat(entry.nesting ?? 0);
	return `${indent}${entry.index} (${plainHeading(entry.heading)}), ${formatApproxBytes(entry.approxBytes)}`;
}

// How deep a section sits in the page's outline: 0 for a top-level section. A
// page can skip heading levels (an h2 followed directly by an h4), so this is
// not the heading level less two. The API's `toclevel` is the outline depth;
// where it is absent the dots in the outline number count it, and where that is
// absent too the heading level does.
function nestingOf(entry: SectionEntry): number {
	if (entry.tocLevel !== undefined) {
		return Math.max(0, entry.tocLevel - 1);
	}
	if (entry.number !== undefined && entry.number !== '') {
		return entry.number.split('.').length - 1;
	}
	return Math.max(0, entry.level - 2);
}

// Depth 0 keeps every heading. Otherwise depth 1 keeps the top-level sections,
// depth 2 adds their subsections, and so on, by the same nesting the lines are
// indented by.
function withinDepth(entry: SectionEntry, depth: number): boolean {
	return depth === 0 || nestingOf(entry) < depth;
}

// Sizes every editable section from the byte offsets of the headings and the
// size of the whole page. A section runs to the next heading at the same or a
// higher level, so its size includes its subsections; the lead runs to the
// first heading. `depth` only drops lines, after the sizes are worked out, so a
// top-level section still counts the subsections it hides. Transcluded
// headings have no index or byte offset on this page and are left out.
export function buildOutline(
	entries: readonly SectionEntry[],
	totalBytes: number,
	depth = 0,
): OutlineEntry[] {
	const placed = entries.filter(
		(e): e is SectionEntry & { byteOffset: number } => e.editable && e.byteOffset !== undefined,
	);
	const leadBytes = placed.length > 0 ? placed[0].byteOffset : totalBytes;
	const sections: OutlineEntry[] = [{ index: 0, heading: 'Lead', approxBytes: leadBytes }];

	placed.forEach((entry, position) => {
		if (!withinDepth(entry, depth)) {
			return;
		}
		const next = placed.slice(position + 1).find((later) => later.level <= entry.level);
		const end = next?.byteOffset ?? totalBytes;
		sections.push({
			index: Number.parseInt(entry.index, 10),
			nesting: nestingOf(entry),
			heading: entry.line,
			approxBytes: Math.max(0, end - entry.byteOffset),
		});
	});
	return sections;
}

// The section lines get-page-outline publishes: the sized lines of
// buildOutline when the sizes can be worked out, else the short toOutlineLines
// ones. They cannot when the page size is unknown (`totalBytes` undefined) or
// when an editable heading has no byte offset, as on a wiki whose API does not
// report one; sizing only some sections would leave the rest looking empty.
// `depth` filters either form the same way.
export function outlineLines(
	entries: readonly SectionEntry[],
	totalBytes: number | undefined,
	depth = 0,
): string[] {
	if (totalBytes === undefined || entries.some((e) => e.editable && e.byteOffset === undefined)) {
		return toOutlineLines(entries.filter((e) => withinDepth(e, depth)));
	}
	return buildOutline(entries, totalBytes, depth).map(formatOutlineLine);
}

export type HeadingMatch =
	| { kind: 'one'; index: number }
	| { kind: 'none' }
	| { kind: 'many'; indexes: number[] };

// Finds the editable section a heading names, ignoring case and surrounding
// whitespace. Transcluded sections are skipped: no `section=` value addresses
// them. More than one match is reported rather than resolved, since picking
// either would read a section the caller may not have meant.
export function findSectionByHeading(
	entries: readonly SectionEntry[],
	heading: string,
): HeadingMatch {
	const wanted = heading.trim().toLowerCase();
	const indexes = entries
		.filter((e) => e.editable && plainHeading(e.line).toLowerCase() === wanted)
		.map((e) => Number.parseInt(e.index, 10));
	if (indexes.length === 0) {
		return { kind: 'none' };
	}
	return indexes.length === 1 ? { kind: 'one', index: indexes[0] } : { kind: 'many', indexes };
}
