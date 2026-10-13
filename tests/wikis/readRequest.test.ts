import { describe, it, expect, vi } from 'vitest';
import { Mwn, type RawRequestParams } from 'mwn';
import { encodedLength, readRequest, urlBudget } from '../../src/wikis/readRequest.ts';
import { withCallBounds } from '../../src/wikis/abortableMwn.ts';
import { callDeadline } from '../../src/runtime/callDeadline.ts';
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

/**
 * A real `Mwn` whose network layer is replaced, so the method, URL and query
 * string are the ones mwn itself builds. Nothing leaves the process.
 */
function fakeWiki(answer: unknown = { compare: { body: '' } }) {
	const bot = new Mwn({ apiUrl: API_URL, silent: true });
	const sent: RawRequestParams[] = [];
	bot.rawRequest = async (options: RawRequestParams) => {
		sent.push(options);
		return { data: answer, status: 200, statusText: 'OK', headers: {} } as never;
	};
	return { bot, sent };
}

function hangingWiki() {
	const wiki = fakeWiki();
	wiki.bot.rawRequest = async (options: RawRequestParams) => {
		wiki.sent.push(options);
		return new Promise((_, reject) => {
			options.signal?.addEventListener?.('abort', () => reject(new Error('aborted')));
		});
	};
	return wiki;
}

/** The most text a `compare` request can carry before its URL is over budget. */
function largestFittingText(bot: Mwn): number {
	return urlBudget(bot, { action: 'compare', fromtext: '' });
}

describe('encodedLength', () => {
	it('counts three characters for a space, a brace or a newline', () => {
		expect(encodedLength('a b')).toBe(5);
		expect(encodedLength('{')).toBe(3);
		expect(encodedLength('\n')).toBe(3);
	});

	it('counts a non-Latin character at the length of its UTF-8 bytes, percent-encoded', () => {
		expect(encodedLength('é')).toBe(6);
	});
});

describe('urlBudget', () => {
	it('shrinks by the encoded length of each parameter and by the API URL', () => {
		const { bot } = fakeWiki();
		const empty = urlBudget(bot, {});

		expect(urlBudget(bot, { action: 'ask' })).toBe(empty - ('action'.length + 'ask'.length + 2));
		expect(urlBudget(bot, { query: 'a b' })).toBe(empty - ('query'.length + 5 + 2));
	});

	it('joins an array the way mwn does, with an encoded pipe between the values', () => {
		const { bot } = fakeWiki();

		expect(urlBudget(bot, { ids: ['Q1', 'Q2'] })).toBe(urlBudget(bot, { ids: 'Q1|Q2' }));
	});

	it('leaves out a parameter that is false, as mwn does', () => {
		const { bot } = fakeWiki();

		expect(urlBudget(bot, { redirects: false })).toBe(urlBudget(bot, {}));
	});

	it('leaves out the parameter named in except', () => {
		const { bot } = fakeWiki();

		expect(urlBudget(bot, { action: 'query', titles: 'a'.repeat(500) }, 'titles')).toBe(
			urlBudget(bot, { action: 'query' }),
		);
	});
});

describe('readRequest', () => {
	it('sends a request that fits as a GET, whatever mwn would choose for the action', async () => {
		const { bot, sent } = fakeWiki();

		await readRequest(bot, { action: 'compare', fromrev: 1, torev: 2, prop: 'diff' });

		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe('get');
		expect(sent[0].url).toBe(API_URL);
		expect(paramsOf(sent[0]).get('action')).toBe('compare');
	});

	it('control: mwn alone sends this action as a POST', async () => {
		// The control for the test above: with no method given, mwn picks a POST
		// for this action. Only readRequest's explicit method moves it to a GET.
		const { bot, sent } = fakeWiki();

		await bot.request({ action: 'compare', fromrev: 1, torev: 2, prop: 'diff' });

		expect(sent[0].method).toBe('post');
	});

	it('sends a request exactly at the budget as a GET, under the URL limit', async () => {
		const { bot, sent } = fakeWiki();

		await readRequest(bot, {
			action: 'compare',
			fromtext: 'a'.repeat(largestFittingText(bot)),
		});

		expect(sent[0].method).toBe('get');
		expect(urlLength(sent[0])).toBeLessThanOrEqual(8000);
	});

	it('sends a request one character over the budget as a POST', async () => {
		const { bot, sent } = fakeWiki();

		await readRequest(bot, {
			action: 'compare',
			fromtext: 'a'.repeat(largestFittingText(bot) + 1),
		});

		expect(sent[0].method).toBe('post');
	});

	it('sends 60 kB of text as a POST', async () => {
		const { bot, sent } = fakeWiki();

		await readRequest(bot, { action: 'parse', text: 'b'.repeat(60_000) });

		expect(sent[0].method).toBe('post');
	});

	it('counts the encoded length, so text with spaces goes by POST at a third of the size', async () => {
		const { bot, sent } = fakeWiki();

		await readRequest(bot, { action: 'parse', text: ' '.repeat(3_000) });

		expect(sent[0].method).toBe('post');
	});

	it('resolves with the wiki response', async () => {
		const { bot } = fakeWiki({ compare: { body: 'diff' } });

		await expect(readRequest(bot, { action: 'compare', fromrev: 1 })).resolves.toEqual({
			compare: { body: 'diff' },
		});
	});

	describe('call bounds', () => {
		it('reaches rawRequest through the call-bounded view, so the signal travels with the GET', async () => {
			const controller = new AbortController();
			const wiki = fakeWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(60_000, 'calling'), controller.signal);

			await readRequest(bounded, { action: 'compare', fromrev: 1 });

			expect(wiki.sent[0].method).toBe('get');
			const signal = wiki.sent[0].signal!;
			expect(signal.aborted).toBe(false);
			controller.abort();
			expect(signal.aborted).toBe(true);
		});

		it('carries the signal on the POST fallback too', async () => {
			const controller = new AbortController();
			const wiki = fakeWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(60_000, 'calling'), controller.signal);

			await readRequest(bounded, { action: 'parse', text: 'c'.repeat(60_000) });

			expect(wiki.sent[0].method).toBe('post');
			controller.abort();
			expect(wiki.sent[0].signal?.aborted).toBe(true);
		});

		it('stops a GET in flight when the caller cancels', async () => {
			const controller = new AbortController();
			const wiki = hangingWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(60_000, 'calling'), controller.signal);

			const pending = rejectionOf(readRequest(bounded, { action: 'compare', fromrev: 1 }));
			await vi.waitFor(() => expect(wiki.sent).toHaveLength(1));
			controller.abort();

			expect(await pending).toBeInstanceOf(Error);
			expect(wiki.sent[0].method).toBe('get');
		});

		it('stops a GET when the deadline passes', async () => {
			const wiki = hangingWiki();
			const bounded = withCallBounds(wiki.bot, callDeadline(20, 'calling'));

			const error = await rejectionOf(readRequest(bounded, { action: 'compare', fromrev: 1 }));

			expect(error).toBeInstanceOf(Error);
			expect(wiki.sent[0].method).toBe('get');
		});
	});
});
