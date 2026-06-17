import { describe, expect, test } from "vitest";

import {
	collectMarkedImages,
	formatImageMarker,
	imageMarkerIds,
	pruneMarkedImages,
} from "../src/modes/interactive/image-markers.js";

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

	test("pruneMarkedImages drops entries whose marker is gone", () => {
		const pending = new Map([
			[1, "a"],
			[2, "b"],
			[3, "c"],
		]);
		pruneMarkedImages(pending, "still have [image #2] and [image #3]");
		expect([...pending.keys()]).toEqual([2, 3]);
	});

	test("pruneMarkedImages clears everything when no markers remain", () => {
		const pending = new Map([[1, "a"]]);
		pruneMarkedImages(pending, "user deleted the marker");
		expect(pending.size).toBe(0);
	});
});
