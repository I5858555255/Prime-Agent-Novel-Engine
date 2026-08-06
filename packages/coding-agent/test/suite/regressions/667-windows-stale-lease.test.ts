import { describe, expect, it } from "vitest";
import { isRenameTargetExistsError } from "../../../src/core/session-lease.js";

describe("issue #667 windows stale session lease", () => {
	it("classifies POSIX rename-target-exists codes on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(isRenameTargetExistsError("EEXIST", platform)).toBe(true);
			expect(isRenameTargetExistsError("ENOTEMPTY", platform)).toBe(true);
		}
	});

	it("treats Windows EPERM/EACCES as a rename-target-exists so stale leases are reclaimed", () => {
		expect(isRenameTargetExistsError("EPERM", "win32")).toBe(true);
		expect(isRenameTargetExistsError("EACCES", "win32")).toBe(true);
	});

	it("does not swallow EPERM/EACCES on POSIX platforms", () => {
		for (const platform of ["linux", "darwin"] as const) {
			expect(isRenameTargetExistsError("EPERM", platform)).toBe(false);
			expect(isRenameTargetExistsError("EACCES", platform)).toBe(false);
		}
	});

	it("rethrows unrelated rename failures", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(isRenameTargetExistsError("ENOENT", platform)).toBe(false);
			expect(isRenameTargetExistsError("EBADF", platform)).toBe(false);
			expect(isRenameTargetExistsError(undefined, platform)).toBe(false);
		}
	});
});
