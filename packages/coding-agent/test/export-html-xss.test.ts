import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML markdown link sanitization", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("overrides the marked link renderer to block javascript: protocol", () => {
		expect(templateJs).toMatch(/link\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/getSafeNavigation\(token\.href\)/);
		expect(templateJs).toMatch(/SAFE_NAVIGATION_PROTOCOLS/);
	});

	it("overrides the marked image renderer to isolate remote resources", () => {
		expect(templateJs).toMatch(/image\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/getEmbeddedImageHref\(token\.href\)/);
		expect(templateJs).toMatch(/renderBlockedImage\(token, getRemoteImageHref\(token\.href\)\)/);
	});

	it("escapes href attributes in the custom link renderer", () => {
		expect(templateJs).toMatch(/escapeHtml\(navigation\.href\)/);
		expect(templateJs).toMatch(/escapeHtml\(remoteHref\)/);
	});

	it("allowlists embedded session image MIME types", () => {
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		expect(templateJs).toMatch(/\['image\/avif', 'image\/gif', 'image\/jpeg', 'image\/png', 'image\/webp'\]/);
	});

	it("escapes image data attributes", () => {
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	it("adds no-referrer isolation to external links and embedded images", () => {
		expect(templateJs).toContain('rel="noopener noreferrer nofollow" referrerpolicy="no-referrer"');
		expect(templateJs).toContain('referrerpolicy="no-referrer" loading="lazy" decoding="async"');
	});

	it("escapes entry IDs before inserting them into attributes", () => {
		// Session entry IDs are embedded in id and data-entry-id attributes.
		expect(templateJs).not.toMatch(/id="\$\{entryId\}"/);
		expect(templateJs).not.toMatch(/data-entry-id="\$\{entryId\}"/);
		expect(templateJs).toMatch(/entry-\$\{escapeHtml\(entry\.id\)\}/);
		expect(templateJs).toMatch(/data-entry-id="\$\{escapeHtml\(entryId\)\}"/);
	});

	it("escapes tree metadata rendered from session fields", () => {
		// The tree renders session metadata via innerHTML, so dynamic fields must be escaped.
		expect(templateJs).not.toMatch(/\[\$\{msg\.toolName \|\| 'tool'\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{msg\.role\}\]/);
		expect(templateJs).not.toMatch(/\[model: \$\{entry\.modelId\}\]/);
		expect(templateJs).not.toMatch(/\[thinking: \$\{entry\.thinkingLevel\}\]/);
		expect(templateJs).not.toMatch(/\[service tier: \$\{entry\.serviceTier\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{entry\.type\}\]/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.toolName \|\| 'tool'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.role\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.modelId\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.thinkingLevel\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.serviceTier \|\| 'default'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.type\)\}/);
	});

	it("escapes model names in the exported header", () => {
		// Assistant message provider/model values are collected from the session and rendered with innerHTML.
		expect(templateJs).not.toMatch(/\$\{globalStats\.models\.join\(', '\) \|\| 'unknown'\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(globalStats\.models\.join\(', '\) \|\| 'unknown'\)\}/);
	});
});
