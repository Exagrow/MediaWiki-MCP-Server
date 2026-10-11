// Converts the rendered HTML of a MediaWiki page into readable plain text:
// headings become `#` lines, list items become `-` bullets, table cells are
// joined with ` | `, and page chrome (edit links, table of contents,
// navigation boxes, style and script content) is dropped. Node has no HTML
// parser, so a small tag tokenizer walks the markup instead.

// Elements whose content never belongs in the readable text.
const SKIP_TAGS = new Set(['style', 'script', 'noscript']);
// MediaWiki chrome: edit links, the table of contents, navigation boxes.
const SKIP_CLASSES = new Set([
	'mw-editsection',
	'toc',
	'navbox',
	'navaid',
	'noprint',
	'mw-empty-elt',
]);
const BLOCK_TAGS = new Set([
	'p',
	'div',
	'ul',
	'ol',
	'dl',
	'table',
	'blockquote',
	'br',
	'dd',
	'dt',
	'caption',
]);
const HEADINGS: Record<string, string> = {
	h1: '# ',
	h2: '## ',
	h3: '### ',
	h4: '#### ',
	h5: '##### ',
	h6: '###### ',
};
// Tags with no closing tag, which must not affect skip depth.
const VOID_TAGS = new Set([
	'br',
	'img',
	'hr',
	'input',
	'meta',
	'link',
	'wbr',
	'col',
	'area',
	'source',
]);
// Elements whose content is raw text up to the matching close tag.
const RAW_TEXT_TAGS = new Set(['script', 'style']);

// Named entities MediaWiki output uses, as code points. Numbers rather than
// literal characters so the invisible ones (nbsp, shy, the thin spaces) are
// readable in source. Unknown names are left as written.
const NAMED_ENTITIES: Record<string, number> = {
	amp: 0x26,
	lt: 0x3c,
	gt: 0x3e,
	quot: 0x22,
	apos: 0x27,
	nbsp: 0xa0,
	lsquo: 0x2018,
	rsquo: 0x2019,
	ldquo: 0x201c,
	rdquo: 0x201d,
	ndash: 0x2013,
	mdash: 0x2014,
	minus: 0x2212,
	hellip: 0x2026,
	times: 0xd7,
	middot: 0xb7,
	bull: 0x2022,
	copy: 0xa9,
	reg: 0xae,
	deg: 0xb0,
	laquo: 0xab,
	raquo: 0xbb,
	shy: 0xad,
	thinsp: 0x2009,
	ensp: 0x2002,
	emsp: 0x2003,
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g,
		(match, dec, hex, name) => {
			if (name !== undefined) {
				const named = NAMED_ENTITIES[name];
				return named === undefined ? match : String.fromCodePoint(named);
			}
			const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
			return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
				? String.fromCodePoint(cp)
				: match;
		},
	);
}

function parseClasses(attrs: string): Set<string> {
	let value = '';
	const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
	for (const m of attrs.matchAll(attrPattern)) {
		if (m[1].toLowerCase() === 'class') {
			value = m[2] ?? m[3] ?? m[4] ?? '';
		}
	}
	return new Set(value.split(/\s+/).filter((c) => c !== ''));
}

// Index of the `>` closing the tag that starts at `from`, ignoring any inside
// a quoted attribute value; -1 when the tag never closes.
function findTagEnd(html: string, from: number): number {
	let quote = '';
	for (let i = from; i < html.length; i++) {
		const ch = html[i];
		if (quote !== '') {
			if (ch === quote) {
				quote = '';
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === '>') {
			return i;
		}
	}
	return -1;
}

export function htmlToText(html: string): string {
	const parts: string[] = [];
	let skipDepth = 0;

	const startTag = (tag: string, attrs: string): void => {
		if (VOID_TAGS.has(tag)) {
			if (tag === 'br' && skipDepth === 0) {
				parts.push('\n');
			}
			return;
		}
		if (skipDepth > 0) {
			skipDepth++;
			return;
		}
		const classes = parseClasses(attrs);
		if (SKIP_TAGS.has(tag) || [...classes].some((c) => SKIP_CLASSES.has(c))) {
			skipDepth = 1;
			return;
		}
		if (tag in HEADINGS) {
			parts.push('\n\n' + HEADINGS[tag]);
		} else if (tag === 'li') {
			parts.push('\n- ');
		} else if (tag === 'tr') {
			parts.push('\n');
		} else if (tag === 'td' || tag === 'th') {
			parts.push(' | ');
		} else if (BLOCK_TAGS.has(tag)) {
			parts.push('\n');
		}
	};

	const endTag = (tag: string): void => {
		if (VOID_TAGS.has(tag)) {
			return;
		}
		if (skipDepth > 0) {
			skipDepth--;
			return;
		}
		if (tag in HEADINGS) {
			parts.push('\n\n');
		} else if (BLOCK_TAGS.has(tag)) {
			parts.push('\n');
		}
	};

	const text = (data: string): void => {
		if (skipDepth === 0) {
			parts.push(decodeEntities(data).replace(/\n/g, ' '));
		}
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			text(html.slice(i));
			break;
		}
		if (lt > i) {
			text(html.slice(i, lt));
		}
		i = lt;

		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const next = html[i + 1] ?? '';
		if (next === '!' || next === '?') {
			const end = html.indexOf('>', i + 2);
			i = end === -1 ? html.length : end + 1;
			continue;
		}
		if (next === '/' && /[A-Za-z]/.test(html[i + 2] ?? '')) {
			const end = findTagEnd(html, i + 2);
			if (end === -1) {
				break;
			}
			const name = /^[^\s/>]+/.exec(html.slice(i + 2, end))?.[0] ?? '';
			endTag(name.toLowerCase());
			i = end + 1;
			continue;
		}
		if (/[A-Za-z]/.test(next)) {
			const end = findTagEnd(html, i + 1);
			if (end === -1) {
				break;
			}
			let inner = html.slice(i + 1, end);
			const selfClosing = inner.endsWith('/');
			if (selfClosing) {
				inner = inner.slice(0, -1);
			}
			const name = /^[^\s/>]+/.exec(inner)?.[0] ?? '';
			const tag = name.toLowerCase();
			startTag(tag, inner.slice(name.length));
			i = end + 1;
			if (selfClosing) {
				endTag(tag);
			} else if (RAW_TEXT_TAGS.has(tag)) {
				// The content is not markup: jump to the matching close tag.
				const close = html.toLowerCase().indexOf('</' + tag, i);
				i = close === -1 ? html.length : close;
			}
			continue;
		}
		// A lone `<` that opens no tag is text.
		text('<');
		i++;
	}

	const lines: string[] = [];
	for (const raw of parts.join('').replace(/ /g, ' ').split('\n')) {
		// A table row starts with a cell separator; drop the leading one.
		const line = raw
			.replace(/[ \t]+/g, ' ')
			.trim()
			.replace(/^\|\s*/, '');
		if (line !== '' || (lines.length > 0 && lines[lines.length - 1] !== '')) {
			lines.push(line);
		}
	}
	return lines.join('\n').trim();
}
