import { describe, it, expect } from 'vitest';
import { htmlToText } from '../../src/results/htmlText.ts';

describe('htmlToText', () => {
	it('strips tags and decodes entities', () => {
		expect(htmlToText('<p>Fish &amp; <b>Chips</b></p>')).toBe('Fish & Chips');
	});

	it('turns headings into markdown', () => {
		const html =
			'<h2><span class="mw-headline">History</span><span class="mw-editsection">[edit]</span></h2><p>Born in Hearthstone.</p>';
		expect(htmlToText(html)).toBe('## History\n\nBorn in Hearthstone.');
	});

	it('turns lists into bullets', () => {
		expect(htmlToText('<ul><li>Rashek</li><li>Marsh</li></ul>')).toBe('- Rashek\n- Marsh');
	});

	it('keeps table cells on one line per row', () => {
		const html =
			'<table><tr><th>Type</th><td>Ability</td></tr><tr><th>World</th><td>Scadrial</td></tr></table>';
		expect(htmlToText(html)).toBe('Type | Ability\nWorld | Scadrial');
	});

	it('drops style, script and page chrome', () => {
		const html =
			'<style>.a{color:red}</style><div class="toc"><ul><li>1 History</li></ul></div><p>Text</p><div class="navbox"><p>nav</p></div><script>x()</script>';
		expect(htmlToText(html)).toBe('Text');
	});

	it('does not leak void tags inside a skipped block', () => {
		const html = '<div class="navbox">a<br>b<img src="x">c</div><p>After</p>';
		expect(htmlToText(html)).toBe('After');
	});

	it('collapses blank lines and spaces', () => {
		expect(htmlToText('<p>One</p>\n\n\n<p>Two   words&nbsp;here</p>')).toBe(
			'One\n\nTwo words here',
		);
	});

	it('returns an empty string for empty input', () => {
		expect(htmlToText('')).toBe('');
	});

	it('does not read markup inside script content', () => {
		expect(htmlToText('<script>if (a < b) { x("</p>"); }</script><p>Kept</p>')).toBe('Kept');
	});

	it('decodes named dash and quote entities', () => {
		const dash = String.fromCodePoint(0x2014);
		const open = String.fromCodePoint(0x201c);
		const close = String.fromCodePoint(0x201d);
		expect(htmlToText('<p>&ldquo;Life before death&rdquo; &mdash; First Ideal</p>')).toBe(
			`${open}Life before death${close} ${dash} First Ideal`,
		);
	});

	it('leaves an unknown named entity as written', () => {
		expect(htmlToText('<p>a &notanentity; b</p>')).toBe('a &notanentity; b');
	});

	it('ignores a greater-than sign inside a quoted attribute value', () => {
		expect(htmlToText('<div title="a > b" class="navbox">gone</div><p>Kept</p>')).toBe('Kept');
	});
});
