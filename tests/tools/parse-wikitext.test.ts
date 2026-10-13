import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { parseWikitext } from '../../src/tools/parse-wikitext.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

describe('parse-wikitext', () => {
	it('returns HTML for parsed wikitext', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>Hello</p>', parsewarnings: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle(
			{ wikitext: "'''Hello'''", applyPreSaveTransform: true },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('HTML: <p>Hello</p>');
	});

	it('includes parse warnings when present', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>Body</p>',
					parsewarnings: ['Unclosed tag', 'Bad template'],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle(
			{ wikitext: 'anything', applyPreSaveTransform: true },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Parse warnings:\n- Unclosed tag\n- Bad template');
	});

	it("defaults title to 'API' when omitted", async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>x</p>', parsewarnings: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		expect(mock.request).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'parse',
				text: 'x',
				title: 'API',
				pst: true,
				formatversion: '2',
			}),
			{ method: 'get' },
		);
	});

	it('passes provided title through to the API call', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>x</p>', parsewarnings: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await parseWikitext.handle(
			{ wikitext: 'x', title: 'Custom Title', applyPreSaveTransform: true },
			ctx,
		);

		expect(mock.request).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Custom Title',
			}),
			{ method: 'get' },
		);
	});

	it('passes applyPreSaveTransform=false through as pst: false', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>x</p>', parsewarnings: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: false }, ctx);

		expect(mock.request).toHaveBeenCalledWith(
			expect.objectContaining({
				pst: false,
			}),
			{ method: 'get' },
		);
	});

	it('wraps mwn errors as isError with message via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('Network down')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			parseWikitext,
			ctx,
		)({
			wikitext: 'x',
			applyPreSaveTransform: true,
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toBe('Failed to preview wikitext: Network down');
	});

	it('preserves categories with hidden flag', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					categories: [
						{ sortkey: '', category: 'Foo' },
						{ sortkey: '', category: 'Hidden', hidden: true },
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Categories:');
		expect(text).toContain('- Category: Foo');
		expect(text).toContain('- Category: Hidden');
		expect(text).toContain('  Hidden: true');
	});

	it('preserves links with exists flag (defaults missing exists to true)', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					links: [
						{ ns: 0, title: 'Foo', exists: true },
						{ ns: 0, title: 'RedLink', exists: false },
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Links:');
		expect(text).toContain('- Title: Foo');
		expect(text).toContain('  Exists: true');
		expect(text).toContain('- Title: RedLink');
		expect(text).toContain('  Exists: false');
	});

	it('preserves templates with exists flag', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					templates: [
						{ ns: 10, title: 'Template:Infobox', exists: true },
						{ ns: 10, title: 'Template:Broken', exists: false },
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Templates:');
		expect(text).toContain('- Title: Template:Infobox');
		expect(text).toContain('  Exists: true');
		expect(text).toContain('- Title: Template:Broken');
		expect(text).toContain('  Exists: false');
	});

	it('preserves external links as a simple array', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					externallinks: ['https://example.org', 'https://example.com/page'],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('External links:\n- https://example.org\n- https://example.com/page');
	});

	it('includes displayTitle only when it differs from the input title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					displaytitle: '<i>Custom Display</i>',
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle(
			{ wikitext: 'x', title: 'Custom Title', applyPreSaveTransform: true },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Display title: <i>Custom Display</i>');
	});

	it('omits displayTitle when it matches the input title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					displaytitle: 'API',
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Display title:');
	});

	it('omits empty sections entirely', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					categories: [],
					links: [],
					templates: [],
					externallinks: [],
					displaytitle: 'API',
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(formatPayload({ html: '<p>x</p>' }));
	});

	it('attaches content-truncated truncation when HTML exceeds the byte cap', async () => {
		const bigHtml = '<p>' + 'x'.repeat(85000) + '</p>';
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: {
					text: bigHtml,
					parsewarnings: [],
					categories: [{ sortkey: '', category: 'Foo' }],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toMatch(/HTML:\n\n<p>x+/);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).toContain('  Returned bytes: 75000');
		expect(text).toContain('  Total bytes: 85007');
		expect(text).toContain('  Item noun: HTML');
		expect(text).toContain('  Tool name: parse-wikitext');
		expect(text).toContain('Categories:\n- Category: Foo');
	});

	it('omits truncation when HTML is exactly at the byte cap', async () => {
		const exact = 'y'.repeat(75000);
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: exact, parsewarnings: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await parseWikitext.handle({ wikitext: 'x', applyPreSaveTransform: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toMatch(/HTML:\n\ny{75000}/);
		expect(text).not.toContain('Truncation:');
	});

	describe('request method', () => {
		async function methodFor(wikitext: string): Promise<unknown> {
			const mock = createMockMwn({
				request: vi.fn().mockResolvedValue({ parse: { text: '<p>x</p>', parsewarnings: [] } }),
			});
			const ctx = fakeContext({ mwn: async () => mock as never });

			await parseWikitext.handle({ wikitext, applyPreSaveTransform: true }, ctx);

			expect(mock.request).toHaveBeenCalledTimes(1);
			return mock.request.mock.calls[0][1];
		}

		it('sends 1 kB of wikitext as a GET', async () => {
			expect(await methodFor('a'.repeat(1_000))).toEqual({ method: 'get' });
		});

		it('sends 6 kB of plain text as a GET', async () => {
			expect(await methodFor('a'.repeat(6_000))).toEqual({ method: 'get' });
		});

		it('sends 60 kB of wikitext as a POST, which no URL can carry', async () => {
			expect(await methodFor('a'.repeat(60_000))).toEqual({ method: 'post' });
		});

		it('counts the percent-encoded length, which spaces and markup triple', async () => {
			// 3,000 characters, but 9,000 once each is encoded as %20.
			expect(await methodFor(' '.repeat(3_000))).toEqual({ method: 'post' });
		});
	});
});
