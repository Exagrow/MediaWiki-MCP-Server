import { vi, type Mock } from 'vitest';

type Params = { action?: string; prop?: string };

/**
 * What `mwn.read()` used to resolve with for one page: revision fields at the
 * top level of each revision, `slots.main` already copied onto it.
 */
interface ReadShapedPage {
	revisions?: Array<Record<string, unknown>>;
	[field: string]: unknown;
}

/**
 * The same page as the API sends it: the main slot's `contentmodel` and
 * `content` live under `slots.main`, which `readPages` copies onto the revision.
 */
export function toApiPage(page: ReadShapedPage): Record<string, unknown> {
	if (!page.revisions) {
		return page;
	}
	return {
		...page,
		revisions: page.revisions.map(({ contentmodel, content, ...revision }) => ({
			...revision,
			slots: {
				main: {
					...(contentmodel !== undefined ? { contentmodel } : {}),
					...(content !== undefined ? { content } : {}),
				},
			},
		})),
	};
}

/** One batch's response to a revisions query, as `action=query` returns it. */
export function revisionsResponse(options: {
	pages?: unknown[];
	redirects?: Array<{ from: string; to: string }>;
	normalized?: Array<{ from: string; to: string }>;
}): unknown {
	return {
		query: {
			...(options.pages ? { pages: options.pages } : {}),
			...(options.redirects ? { redirects: options.redirects } : {}),
			...(options.normalized ? { normalized: options.normalized } : {}),
		},
	};
}

/**
 * A `request` mock that answers a revisions query with `revisions` and any
 * other call with `other`, so a test can stub the page read and the section
 * outline separately now that both go through `mwn.request`.
 */
export function routeRequest(revisions: Mock, other?: Mock): Mock {
	return vi.fn((params: Params, options?: unknown) => {
		if (params.action === 'query' && params.prop === 'revisions') {
			return options === undefined ? revisions(params) : revisions(params, options);
		}
		if (other === undefined) {
			return Promise.reject(new Error(`unexpected request: ${JSON.stringify(params)}`));
		}
		return options === undefined ? other(params) : other(params, options);
	});
}

/** A `request` mock whose revisions query returns one page, or fails with an `Error`. */
export function readRequest(page: ReadShapedPage | Error, other?: Mock): Mock {
	const revisions =
		page instanceof Error
			? vi.fn().mockRejectedValue(page)
			: vi.fn().mockResolvedValue(revisionsResponse({ pages: [toApiPage(page)] }));
	return routeRequest(revisions, other);
}
