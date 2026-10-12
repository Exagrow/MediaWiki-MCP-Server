import { describe, it, expect, vi } from 'vitest';
import { Mwn, type RawRequestParams } from 'mwn';
import { queryInBatches, readPages } from '../../src/wikis/readPages.ts';
import { withCallBounds } from '../../src/wikis/abortableMwn.ts';
import { callDeadline } from '../../src/runtime/callDeadline.ts';
import { getPage } from '../../src/tools/get-page.ts';
import { getPages, BatchContentFormat } from '../../src/tools/get-pages.ts';
import { ContentFormat } from '../../src/results/contentFormat.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.ts';
import { rejectionOf } from '../helpers/rejectionOf.ts';

const API_URL = 'https://wiki.example/w/api.php';

/** The query string a request carries, whether mwn sent it as a GET or a POST body. */
function paramsOf(options: RawRequestParams): URLSearchParams {
	const { params, data } = options as { params?: Record<string, string>; data?: string };
	return new URLSearchParams(params ?? data);
}

/** The length of the URL a request would have, with the encoding most generous to the wiki. */
function urlLength(options: RawRequestParams): number {
	return `${options.url}?${paramsOf(options).toString()}`.length;
}

interface FakeWiki {
	bot: Mwn;
	/** Every request that reached the network layer, in order. */
	sent: RawRequestParams[];
}

/**
 * A real `Mwn` whose network layer is replaced, so the method, URL and query
 * string are the ones mwn itself builds. Nothing leaves the process.
 */
function fakeWiki(answer: (options: RawRequestParams) => unknown): FakeWiki {
	const bot = new Mwn({ apiUrl: API_URL, silent: true });
	const sent: RawRequestParams[] = [];
	bot.rawRequest = async (options: RawRequestParams) => {
		sent.push(options);
		// The response axios would build around the fixture; mwn reads `data` only.
		return { data: answer(options), status: 200, statusText: 'OK', headers: {} } as never;
	};
	return { bot, sent };
}

function revision(content: string, extra: Record<string, unknown> = {}) {
	return {
		revid: 10,
		parentid: 9,
		timestamp: '2026-04-01T00:00:00Z',
		slots: { main: { contentmodel: 'wikitext', contentformat: 'text/x-wiki', content } },
		...extra,
	};
}

/** Answers a revisions query for the titles it names, from a table of pages. */
function wikiWith(
	pages: Record<string, unknown>,
	redirects: Record<string, string> = {},
): (options: RawRequestParams) => unknown {
	return (options) => {
		const query = paramsOf(options);
		const titles = (query.get('titles') ?? '').split('|');
		const follow = query.get('redirects') === '1';
		const found: unknown[] = [];
		const moved: Array<{ from: string; to: string }> = [];
		for (const title of titles) {
			const target = follow ? (redirects[title] ?? title) : title;
			if (target !== title) {
				moved.push({ from: title, to: target });
			}
			found.push(
				structuredClone(
					pages[target] ?? {
						ns: 0,
						title: target,
						missing: true,
					},
				),
			);
		}
		return {
			batchcomplete: true,
			query: { ...(moved.length > 0 ? { redirects: moved } : {}), pages: found },
		};
	};
}

const PAGES = {
	Copper: {
		pageid: 64,
		ns: 0,
		title: 'Copper',
		revisions: [revision('Copper is a metal.', { size: 18 })],
	},
	'Copper (disambiguation)': {
		pageid: 65,
		ns: 0,
		title: 'Copper (disambiguation)',
		revisions: [revision('#REDIRECT [[Copper]]')],
	},
	Multi: {
		pageid: 66,
		ns: 0,
		title: 'Multi',
		revisions: [
			{
				...revision('main body'),
				slots: {
					main: { contentmodel: 'wikitext', content: 'main body', size: 9 },
					notes: { contentmodel: 'wikitext', content: 'a second slot', size: 13 },
				},
			},
		],
	},
	'Bad[title': { title: 'Bad[title', invalidreason: 'bad characters', invalid: true },
};

describe('readPages', () => {
	describe('request method', () => {
		it('sends the read as a GET and never as a POST', async () => {
			const { bot, sent } = fakeWiki(wikiWith(PAGES));
			const massQuery = vi.spyOn(bot, 'massQuery');
			const read = vi.spyOn(bot, 'read');

			await readPages(bot, 'Copper', { rvprop: 'ids|size' });

			expect(sent).toHaveLength(1);
			expect(sent[0].method).toBe('get');
			expect(sent[0].url).toBe(API_URL);
			expect(Object.fromEntries(paramsOf(sent[0]))).toMatchObject({
				action: 'query',
				prop: 'revisions',
				titles: 'Copper',
				rvprop: 'ids|size',
				rvslots: 'main',
				redirects: '1',
				formatversion: '2',
			});
			expect(massQuery).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		});

		it('sends every batch of queryInBatches as a GET', async () => {
			const { bot, sent } = fakeWiki(wikiWith(PAGES));

			await queryInBatches(bot, {
				action: 'query',
				titles: Array.from({ length: 120 }, (_, i) => `Page ${i}`),
				prop: 'revisions',
			});

			expect(sent.map((request) => request.method)).toEqual(['get', 'get', 'get']);
		});

		it('returns the pages through get-pages on a wiki that serves the GET', async () => {
			const { bot } = fakeWiki(wikiWith(PAGES));
			const ctx = fakeContext({ mwn: async () => bot });

			const result = await dispatch(
				getPages,
				ctx,
			)({
				titles: ['Copper'],
				content: BatchContentFormat.source,
				metadata: false,
				followRedirects: true,
			});

			expect(assertStructuredData(result).pages[0].source).toBe('Copper is a metal.');
		});

		// What mwn.read() does, shown on the same fake wiki, so the test above is
		// known to be able to tell the two apart.
		it('differs from mwn.read, which sends a POST', async () => {
			const { bot, sent } = fakeWiki(wikiWith(PAGES));

			await bot.read('Copper', { rvprop: 'ids|size|content' });

			expect(sent[0].method).toBe('post');
		});
	});

	describe('a failed batch', () => {
		// A wiki that rejects the POST answers with an HTML page instead of JSON,
		// which mwn reports as invalidjson.
		const htmlPage = '<!DOCTYPE html><title>Method not allowed</title>';

		it('rejects with the wiki failure instead of returning it as data', async () => {
			const { bot } = fakeWiki(() => htmlPage);

			const error = await rejectionOf(readPages(bot, 'Copper'));

			expect(error).toMatchObject({ code: 'invalidjson' });
			expect(error).not.toBeInstanceOf(TypeError);
		});

		it('rejects when a later batch fails, and sends no batch after it', async () => {
			let calls = 0;
			const answer = wikiWith(PAGES);
			const { bot, sent } = fakeWiki((options) => (++calls === 2 ? htmlPage : answer(options)));

			const error = await rejectionOf(
				readPages(
					bot,
					Array.from({ length: 120 }, (_, i) => `Page ${i}`),
				),
			);

			expect(error).toMatchObject({ code: 'invalidjson' });
			expect(sent).toHaveLength(2);
		});

		it('rejects when the wiki answers with no pages', async () => {
			const { bot } = fakeWiki(() => ({ batchcomplete: true }));

			const error = await rejectionOf(readPages(bot, 'Copper'));

			expect((error as Error).message).toContain('no pages');
		});

		it('surfaces through get-page as the tool error result, not a TypeError', async () => {
			const { bot } = fakeWiki(() => htmlPage);
			const ctx = fakeContext({ mwn: async () => bot });

			const result = await dispatch(
				getPage,
				ctx,
			)({ title: 'Copper', content: ContentFormat.source, metadata: false });

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).not.toContain('Cannot read properties');
		});

		it('surfaces through get-pages as the tool error result, not missing pages', async () => {
			const { bot } = fakeWiki(() => htmlPage);
			const ctx = fakeContext({ mwn: async () => bot });

			const result = await dispatch(
				getPages,
				ctx,
			)({
				titles: ['Copper'],
				content: BatchContentFormat.source,
				metadata: false,
				followRedirects: true,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).not.toContain('Cannot read properties');
		});
	});

	describe('batching', () => {
		const titles = Array.from({ length: 120 }, (_, i) => `Page ${i}`);
		const pages = Object.fromEntries(
			titles.map((title, i) => [
				title,
				{ pageid: i + 1, ns: 0, title, revisions: [revision(title)] },
			]),
		);

		it('splits 120 titles into batches of 50, 50 and 20 and keeps their order', async () => {
			const { bot, sent } = fakeWiki(wikiWith(pages));

			const result = await readPages(bot, titles);

			expect(sent.map((request) => paramsOf(request).get('titles')!.split('|').length)).toEqual([
				50, 50, 20,
			]);
			expect(Array.isArray(result) && result.map((page) => page.title)).toEqual(titles);
		});

		it('uses batches of 500 for an account with apihighlimits', async () => {
			const { bot, sent } = fakeWiki(wikiWith(pages));
			bot.hasApiHighLimit = true;

			await readPages(bot, titles);

			expect(sent).toHaveLength(1);
		});

		it('reassembles the responses of queryInBatches in request order', async () => {
			const { bot } = fakeWiki(wikiWith(pages));

			const responses = await queryInBatches(bot, {
				action: 'query',
				titles,
				prop: 'revisions',
				formatversion: '2',
			});

			expect(
				responses.flatMap((response) =>
					response.query?.pages.map((page: { title: string }) => page.title),
				),
			).toEqual(titles);
		});

		it('rejects a batch field that is not an array', async () => {
			const { bot } = fakeWiki(wikiWith(pages));

			const error = await rejectionOf(queryInBatches(bot, { action: 'query', titles: 'Copper' }));

			expect((error as Error).message).toContain('must be an array');
		});

		it('keeps every URL under 8000 characters when 50 titles would not fit', async () => {
			// 80 CJK characters is 240 bytes, inside the 255 a title may have, and
			// percent-encodes to 720 characters.
			const long = Array.from({ length: 50 }, (_, i) => `${'漢'.repeat(79)}${i % 10}`);
			const { bot, sent } = fakeWiki(wikiWith({}));

			await readPages(bot, long);

			expect(sent.length).toBeGreaterThan(1);
			for (const request of sent) {
				expect(request.method).toBe('get');
				expect(urlLength(request)).toBeLessThanOrEqual(8000);
			}
			expect(sent.flatMap((request) => paramsOf(request).get('titles')!.split('|'))).toEqual(long);
		});

		it('keeps 50 ordinary titles in a single request', async () => {
			const ordinary = Array.from({ length: 50 }, (_, i) => `An ordinary page title ${i}`);
			const { bot, sent } = fakeWiki(wikiWith({}));

			await readPages(bot, ordinary);

			expect(sent).toHaveLength(1);
		});

		// A title past 255 bytes is not a valid title, and no URL can carry it, so
		// this one request is the single case sent as a POST.
		it('sends a single title too long for any URL as a POST', async () => {
			const enormous = 'a'.repeat(9000);
			const { bot, sent } = fakeWiki(wikiWith({}));

			await readPages(bot, ['Copper', enormous, 'Multi']);

			expect(sent.map((request) => request.method)).toEqual(['get', 'post', 'get']);
			expect(sent.every((request) => urlLength(request) <= 8000 || request.method === 'post')).toBe(
				true,
			);
		});
	});

	// Each case runs the same fixture through mwn.read() and through readPages()
	// on a fake wiki and requires the same answer, so "same shape as read()" is
	// measured and not asserted.
	describe('output matches mwn.read()', () => {
		async function both(
			titles: string | string[],
			options: Record<string, string | number | boolean>,
			redirects: Record<string, string> = {},
		) {
			const viaRead = fakeWiki(wikiWith(PAGES, redirects));
			const viaHelper = fakeWiki(wikiWith(PAGES, redirects));
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- both overloads of read() resolve to the same runtime value
			const expected = await (
				viaRead.bot.read as (t: unknown, o: unknown) => Promise<unknown>
			).call(viaRead.bot, titles, options);
			const actual = await readPages(viaHelper.bot, titles as string, options);
			return { expected, actual };
		}

		it('for a normal page', async () => {
			const { expected, actual } = await both('Copper', { rvprop: 'ids|size|content' });
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({
				title: 'Copper',
				revisions: [{ revid: 10, content: 'Copper is a metal.', contentmodel: 'wikitext' }],
			});
		});

		it('for a missing page', async () => {
			const { expected, actual } = await both('Nowhere', { rvprop: 'ids|content' });
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({ title: 'Nowhere', missing: true });
		});

		it('for an invalid title', async () => {
			const { expected, actual } = await both('Bad[title', { rvprop: 'ids|content' });
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({ invalid: true });
		});

		it('for a redirect that is followed', async () => {
			const { expected, actual } = await both(
				'Copper (disambiguation)',
				{ rvprop: 'ids|content' },
				{ 'Copper (disambiguation)': 'Copper' },
			);
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({ title: 'Copper' });
		});

		it('for a redirect that is not followed', async () => {
			const { expected, actual } = await both(
				'Copper (disambiguation)',
				{ rvprop: 'ids|content', redirects: false },
				{ 'Copper (disambiguation)': 'Copper' },
			);
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({
				title: 'Copper (disambiguation)',
				revisions: [{ content: '#REDIRECT [[Copper]]' }],
			});
		});

		it('for a page with more than one content slot', async () => {
			const { expected, actual } = await both('Multi', { rvprop: 'ids|content|size' });
			expect(actual).toEqual(expected);
			expect(actual).toMatchObject({ revisions: [{ content: 'main body', size: 9 }] });
		});

		it('for several titles, returning an array in request order', async () => {
			const { expected, actual } = await both(['Multi', 'Nowhere', 'Copper'], {
				rvprop: 'ids|content',
			});
			expect(actual).toEqual(expected);
			expect((actual as unknown as Array<{ title: string }>).map((page) => page.title)).toEqual([
				'Multi',
				'Nowhere',
				'Copper',
			]);
		});

		// The one input read() cannot take: a revision with no slots, which the API
		// sends when rvprop asks for neither content nor a slot property.
		it('and reads a revision without slots, which mwn.read() cannot', async () => {
			const slotless = {
				pageid: 64,
				ns: 0,
				title: 'Copper',
				revisions: [{ revid: 227322, parentid: 225708, size: 6338 }],
			};
			const { bot } = fakeWiki(wikiWith({ Copper: slotless }));
			const viaRead = fakeWiki(wikiWith({ Copper: slotless }));

			await expect(readPages(bot, 'Copper', { rvprop: 'ids|size' })).resolves.toEqual(slotless);
			await expect(viaRead.bot.read('Copper', { rvprop: 'ids|size' })).rejects.toThrow(TypeError);
		});
	});

	describe('call bounds', () => {
		function hangingWiki() {
			const wiki = fakeWiki(wikiWith(PAGES));
			wiki.bot.rawRequest = async (options: RawRequestParams) => {
				wiki.sent.push(options);
				return new Promise((_, reject) => {
					options.signal?.addEventListener?.('abort', () => reject(new Error('aborted')));
				});
			};
			return wiki;
		}

		it('reaches rawRequest through the call-bounded view, so the signal travels with the GET', async () => {
			const controller = new AbortController();
			const wiki = fakeWiki(wikiWith(PAGES));
			const bounded = withCallBounds(wiki.bot, callDeadline(60_000, 'calling'), controller.signal);

			await readPages(bounded, 'Copper');

			expect(wiki.sent[0].method).toBe('get');
			const signal = wiki.sent[0].signal!;
			expect(signal.aborted).toBe(false);
			controller.abort();
			expect(signal.aborted).toBe(true);
		});

		it('stops a read in flight when the caller cancels', async () => {
			const controller = new AbortController();
			const wiki = hangingWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(60_000, 'calling'), controller.signal);

			const pending = rejectionOf(readPages(bounded, 'Copper'));
			await vi.waitFor(() => expect(wiki.sent).toHaveLength(1));
			controller.abort();

			expect(await pending).toBeInstanceOf(Error);
		});

		it('stops a multi-batch read when the deadline passes, without starting the next batch', async () => {
			const wiki = hangingWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(20, 'calling'));

			const error = await rejectionOf(
				readPages(
					bounded,
					Array.from({ length: 120 }, (_, i) => `Page ${i}`),
				),
			);

			expect(error).toBeInstanceOf(Error);
			expect(wiki.sent).toHaveLength(1);
		});
	});
});
