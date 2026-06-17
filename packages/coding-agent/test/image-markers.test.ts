import { describe, expect, test } from "vitest";

import { collectMarkedImages, formatImageMarker, imageMarkerIds } from "../src/modes/interactive/image-markers.js";

describe("image markers", () => {
	test("formatImageMarker round-trips through imageMarkerIds", () => {
		expect(formatImageMarker(7)).toBe("[image #7]");
		expect(imageMarkerIds(`see ${formatImageMarker(7)}`)).toEqual([7]);
	});

	test("imageMarkerIds returns ids in order of appearance", () => {
		expect(imageMarkerIds("a [image #2] b [image #1] c")).toEqual([2, 1]);
		expect(imageMarkerIds("no markers here")).toEqual([]);
	});

	test("collectMarkedImages returns images in paste order, not text order", () => {
		const pending = new Map([
			[1, "first"],
			[2, "second"],
		]);
		// Markers appear reversed in the text, but paste order is preserved.
		expect(collectMarkedImages(pending, "[image #2] then [image #1]")).toEqual(["first", "second"]);
	});

	test("collectMarkedImages skips images whose marker was deleted", () => {
		const pending = new Map([
			[1, "a"],
			[2, "b"],
		]);
		expect(collectMarkedImages(pending, "kept [image #1] only")).toEqual(["a"]);
	});

	test("collectMarkedImages returns each image at most once for duplicate markers", () => {
		const pending = new Map([[1, "a"]]);
		expect(collectMarkedImages(pending, "[image #1] [image #1]")).toEqual(["a"]);
	});

	test("collectMarkedImages returns nothing for empty input", () => {
		expect(collectMarkedImages(new Map(), "[image #1]")).toEqual([]);
		expect(collectMarkedImages(new Map([[1, "a"]]), "")).toEqual([]);
	});

	test("a restored marker still resolves its image (undo-safe)", () => {
		const pending = new Map([[1, "a"]]);
		// Marker deleted then brought back (e.g. via editor undo). Because images are
		// never pruned mid-edit, the restored marker still resolves at submit time.
		expect(collectMarkedImages(pending, "no marker")).toEqual([]);
		expect(collectMarkedImages(pending, "back [image #1]")).toEqual(["a"]);
	});
});
