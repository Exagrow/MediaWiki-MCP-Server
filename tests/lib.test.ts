import { describe, expect, it } from 'vitest';
import * as lib from '../src/lib.ts';

describe('library entry point', () => {
	it('exports the embedding surface and nothing else', () => {
		expect(Object.keys(lib).sort()).toEqual([
			'SERVER_INSTRUCTIONS',
			'createAppState',
			'createServer',
			'createToolContext',
			'guardStdout',
			'loadConfigFromFile',
			'logger',
			'registerShutdownHandlers',
		]);
	});
});
