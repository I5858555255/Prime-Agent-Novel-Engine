import { describe, expect, it, vi } from "vitest";
import { parseStreamingJson, StreamingJsonAccumulator } from "../src/utils/json-parse.js";

function appendByCodeUnit(accumulator: StreamingJsonAccumulator<Record<string, unknown>>, json: string): void {
	for (let index = 0; index < json.length; index++) {
		accumulator.append(json[index]);
	}
}

describe("StreamingJsonAccumulator", () => {
	it.each([1024, 64 * 1024, 2 * 1024 * 1024])(
		"bounds full-prefix parsing for %i-byte streams with tiny deltas",
		(payloadSize) => {
			let parsedCharacters = 0;
			const parser = vi.fn((json: string) => {
				parsedCharacters += json.length;
				return parseStreamingJson(json);
			});
			const accumulator = new StreamingJsonAccumulator<Record<string, unknown>>("", parser);
			const payload = "x".repeat(payloadSize);
			const json = JSON.stringify({ payload });

			appendByCodeUnit(accumulator, json);
			const result = accumulator.finish();

			expect(result).toEqual({ payload });
			expect(parser.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(json.length)) + 2);
			expect(parsedCharacters).toBeLessThan(json.length * 4);
		},
	);

	it("preserves nested JSON, escapes, and Unicode split across code units", () => {
		const expected = {
			nested: { quotes: 'say "hello"', slash: "C:\\tmp", emoji: "🫠", line: "one\ntwo" },
			items: [1, true, null, { value: "café" }],
		};
		const json = JSON.stringify(expected);
		const accumulator = new StreamingJsonAccumulator<Record<string, unknown>>();

		appendByCodeUnit(accumulator, json);

		expect(accumulator.finish()).toEqual(expected);
	});

	it.each(['{"outer":{"value":"unfinished', String.raw`{"path":"A\H","text":"col1	col2"}`, '{"items":[1,2,'])(
		"matches tolerant final parsing for incomplete or malformed JSON: %s",
		(json) => {
			const accumulator = new StreamingJsonAccumulator<Record<string, unknown>>();
			appendByCodeUnit(accumulator, json);

			expect(accumulator.finish()).toEqual(parseStreamingJson(json));
		},
	);

	it("uses a replacement final value authoritatively and caches repeated finalization", () => {
		const parser = vi.fn(parseStreamingJson<Record<string, unknown>>);
		const accumulator = new StreamingJsonAccumulator<Record<string, unknown>>("", parser);
		appendByCodeUnit(accumulator, '{"value":"partial');
		const finalJson = '{"value":"final","complete":true}';
		const callsBeforeFinish = parser.mock.calls.length;

		expect(accumulator.finish(finalJson)).toEqual({ value: "final", complete: true });
		expect(accumulator.finish(finalJson)).toEqual({ value: "final", complete: true });
		expect(parser.mock.calls.length).toBe(callsBeforeFinish + 1);
	});
});
