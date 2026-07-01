import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

// Above core count because boots are IO-bound (cold imports), but capped so a
// fan-out can't thrash the FS past the port-resolve window.
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));
const MAX_KERNEL_BOOT_CONCURRENCY = 64;

function resolveKernelBootConcurrency(): number {
	const raw = process.env.PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS;
	// Only a clean positive integer overrides; anything malformed falls back to
	// the default rather than silently mis-bounding the gate.
	if (raw === undefined || !/^\d+$/.test(raw) || raw === "0") {
		return DEFAULT_KERNEL_BOOT_CONCURRENCY;
	}
	return Math.min(MAX_KERNEL_BOOT_CONCURRENCY, Number.parseInt(raw, 10));
}

const kernelBootSemaphore = new Semaphore(resolveKernelBootConcurrency());

export function withKernelBootPermit<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	return kernelBootSemaphore.run(boot, signal);
}
