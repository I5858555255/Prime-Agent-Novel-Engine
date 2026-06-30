import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

/**
 * Bounds how many IPython kernels boot at once. The weight of a boot is the cold
 * Python interpreter + ipykernel/IPython import graph (not the ports); spawning
 * too many at once makes them thrash during import and miss the port-resolve
 * window, so most fail to start. Boots are spawn/IO-bound rather than CPU-bound,
 * so we oversubscribe cores, but keep a conservative cap until warm-kernel reuse
 * makes a boot cheap enough to raise it. Override with the env var below.
 */
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));

function resolveKernelBootConcurrency(): number {
	const raw = process.env.PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS;
	if (raw === undefined || raw === "") {
		return DEFAULT_KERNEL_BOOT_CONCURRENCY;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_KERNEL_BOOT_CONCURRENCY;
	}
	return parsed;
}

let kernelBootSemaphore: Semaphore | undefined;

function getKernelBootSemaphore(): Semaphore {
	if (!kernelBootSemaphore) {
		kernelBootSemaphore = new Semaphore(resolveKernelBootConcurrency());
	}
	return kernelBootSemaphore;
}

/** Run `boot` while holding a kernel-boot permit, releasing it once the kernel is live (or boot throws). */
export function withKernelBootPermit<T>(boot: () => Promise<T>): Promise<T> {
	return getKernelBootSemaphore().run(boot);
}
