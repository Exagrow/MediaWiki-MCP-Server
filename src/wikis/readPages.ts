import type { ApiPage, ApiParams, ApiResponse, Mwn } from 'mwn';

/**
 * Page reads over GET.
 *
 * `mwn.read()` and `mwn.massQuery()` send every batch as a POST. A wiki that
 * accepts only GET for reads answers that POST with a page that is not JSON,
 * while the same query sent as GET succeeds. mwn then reports
 * `invalidjson`, and `massQuery` puts that error in its result array instead of
 * rejecting, so `read()` fails on `json.query.pages` with a TypeError that
 * names neither the wiki nor the cause. A query that changes nothing has no
 * reason to be a POST, so these helpers send the same query as a GET and
 * reject when a batch fails.
 */

/**
 * The longest request URL a read may produce. Apache's default request line
 * limit is 8190 bytes and nginx's default header buffer is 8k, so 8000 stays
 * under both.
 */
const MAX_URL_LENGTH = 8000;

/**
 * Room kept free for what this module does not count: the parameters mwn adds
 * itself (`format`, `formatversion`, `maxlag`), and the difference between the
 * length estimated here and the one axios produces.
 */
const URL_HEADROOM = 200;

/** A pipe between two titles, percent-encoded as `%7C`. */
const SEPARATOR_LENGTH = 3;

/** An upper bound on the length of `value` in a query string, as axios encodes it. */
function encodedLength(value: string): number {
	return encodeURIComponent(value).length;
}

interface Batch {
	values: string[];
	/** A single value too long for any URL: it cannot be split further. */
	oversized: boolean;
}

/**
 * Splits `values` into batches no larger than the API's per-request limit (50,
 * or 500 for an account with `apihighlimits`, as `massQuery` does) and short
 * enough that the request URL stays under `MAX_URL_LENGTH`. A title is at most
 * 255 bytes but percent-encoding can triple that, so 50 long or non-Latin
 * titles do not always fit in one URL.
 */
function planBatches(mwn: Mwn, query: ApiParams, field: string, values: string[]): Batch[] {
	const limit = mwn.hasApiHighLimit ? 500 : 50;
	const otherParams = Object.entries(query)
		.filter(([name, value]) => name !== field && value !== undefined && value !== false)
		.reduce(
			(length, [name, value]) =>
				length + name.length + encodedLength([value].flat().map(String).join('|')) + '=&'.length,
			0,
		);
	const budget =
		MAX_URL_LENGTH -
		URL_HEADROOM -
		(mwn.options.apiUrl?.length ?? 0) -
		otherParams -
		field.length -
		1;

	const batches: Batch[] = [];
	let batch: string[] = [];
	let used = 0;
	const close = (): void => {
		batches.push({ values: batch, oversized: batch.length === 1 && used > budget });
		batch = [];
		used = 0;
	};
	for (const value of values) {
		const cost = encodedLength(value) + SEPARATOR_LENGTH;
		if (batch.length > 0 && (batch.length === limit || used + cost > budget)) {
			close();
		}
		batch.push(value);
		used += cost;
	}
	if (batch.length > 0) {
		close();
	}
	return batches;
}

/**
 * Sends `query` once per batch of `query[batchField]`, as a GET, one batch
 * after another, and returns the responses in order. Unlike `mwn.massQuery`, a
 * failed batch rejects the whole call instead of appearing in the result.
 */
export async function queryInBatches(
	mwn: Mwn,
	query: ApiParams,
	batchField = 'titles',
): Promise<ApiResponse[]> {
	const values = query[batchField];
	if (!Array.isArray(values)) {
		throw new Error(`queryInBatches: ${batchField} must be an array`);
	}
	const batches = planBatches(
		mwn,
		query,
		batchField,
		values.map((value) => String(value)),
	);
	const responses: ApiResponse[] = [];
	for (const batch of batches) {
		const request = { ...query, [batchField]: batch.values };
		// The one case sent as a POST: no URL can carry an oversized value, and a
		// body has no length limit. A title that long is invalid on any wiki (the
		// limit is 255 bytes), so the answer does not depend on the method.
		responses.push(
			await (batch.oversized ? mwn.request(request, { method: 'post' }) : mwn.request(request)),
		);
	}
	return responses;
}

/**
 * Reads the latest revision of each of `titles`, as `mwn.read()` does but over
 * GET and rejecting when a batch fails. Each revision has its `slots.main`
 * fields (`content`, `contentmodel`, ...) copied onto it. Resolves with the
 * page itself when exactly one page came back and with an array otherwise, so a
 * caller reading several titles must accept both.
 */
export async function readPages(mwn: Mwn, titles: string, options?: ApiParams): Promise<ApiPage>;
export async function readPages(
	mwn: Mwn,
	titles: string[],
	options?: ApiParams,
): Promise<ApiPage | ApiPage[]>;
export async function readPages(
	mwn: Mwn,
	titles: string | string[],
	options?: ApiParams,
): Promise<ApiPage | ApiPage[]> {
	const responses = await queryInBatches(mwn, {
		action: 'query',
		titles: Array.isArray(titles) ? titles : [titles],
		prop: 'revisions',
		rvprop: 'content|timestamp',
		rvslots: 'main',
		redirects: true,
		...options,
	});
	const pages: ApiPage[] = [];
	for (const response of responses) {
		const batch: ApiPage[] | undefined = response.query?.pages;
		if (!Array.isArray(batch)) {
			throw new Error('The wiki answered a page read with no pages');
		}
		for (const page of batch) {
			for (const revision of page.revisions ?? []) {
				Object.assign(revision, revision.slots?.main);
			}
			pages.push(page);
		}
	}
	return pages.length === 1 ? pages[0] : pages;
}
