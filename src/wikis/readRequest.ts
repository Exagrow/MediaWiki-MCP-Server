import type { ApiParams, ApiResponse, Mwn } from 'mwn';

/**
 * Read-only API requests over GET.
 *
 * `mwn.request` chooses POST for every action except `query` and a `parse` with
 * no `text`. A wiki that accepts only GET for reads rejects that POST to `api.php`,
 * while the same request sent as GET
 * succeeds, so a read that changes nothing is sent as a GET here. A request too
 * long for a URL is the one case still sent as a POST.
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

/** An upper bound on the length of `value` in a query string, as axios encodes it. */
export function encodedLength(value: string): number {
	return encodeURIComponent(value).length;
}

/**
 * How many more characters of query string `params` could take before the
 * request URL passes the budget: negative when it is already over. `except`
 * leaves one parameter out, for a caller that sizes that one itself.
 */
export function urlBudget(mwn: Mwn, params: ApiParams, except?: string): number {
	const used = Object.entries(params)
		.filter(([name, value]) => name !== except && value !== undefined && value !== false)
		.reduce(
			(length, [name, value]) =>
				length + name.length + encodedLength([value].flat().map(String).join('|')) + '=&'.length,
			0,
		);
	return MAX_URL_LENGTH - URL_HEADROOM - (mwn.options.apiUrl?.length ?? 0) - used;
}

/**
 * Sends a request that changes nothing on the wiki, as a GET when its URL fits
 * and as a POST when it does not. A POST is never better than a GET for a read:
 * it is what a bot-protected wiki refuses. The fallback exists because a URL
 * has a length limit and a body has none, so on a wiki that refuses POSTs a
 * request too long for a URL still fails; nothing sends that request any other
 * way.
 *
 * The request goes through `mwn.request`, which ends in `rawRequest`, so the
 * call's deadline and cancellation (`withCallBounds`) bound it as they bound
 * any other call.
 */
export async function readRequest(mwn: Mwn, params: ApiParams): Promise<ApiResponse> {
	return mwn.request(params, { method: urlBudget(mwn, params) >= 0 ? 'get' : 'post' });
}
