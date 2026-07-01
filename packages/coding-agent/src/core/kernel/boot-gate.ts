import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

// Above core count because boots are IO-bound (cold imports), but capped so a
// fan-out can't thrash the FS past the port-resolve window.
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

export function withKernelBootPermit<T>(boot: () => Promise<T>): Promise<T> {
	return getKernelBootSemaphore().run(boot);
}
