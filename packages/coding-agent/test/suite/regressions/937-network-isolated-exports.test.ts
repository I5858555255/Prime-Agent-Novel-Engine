import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../../../src/core/export-html/index.js";
import { createHarness, type Harness } from "../harness.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function findChromeExecutable(): string | undefined {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate));
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function dumpDom(chromePath: string, url: string, userDataDir: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let completedOutput: string | undefined;
		let pendingError: Error | undefined;
		let forceKill: NodeJS.Timeout | undefined;
		const child = spawn(
			chromePath,
			[
				"--headless=new",
				"--disable-gpu",
				"--disable-component-update",
				"--disable-default-apps",
				"--disable-dev-shm-usage",
				"--disable-sync",
				"--metrics-recording-only",
				"--no-first-run",
				"--host-resolver-rules=MAP network-isolation.test 127.0.0.1,EXCLUDE localhost",
				"--no-proxy-server",
				`--user-data-dir=${userDataDir}`,
				"--dump-dom",
				url,
			],
			{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		const stopBrowser = (signal: NodeJS.Signals): void => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				child.kill(signal);
			}
		};
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timeout = setTimeout(() => {
			if (settled) return;
			pendingError = new Error(
				`Timed out waiting for the export browser smoke test (stdout: ${Buffer.concat(stdout).length} bytes): ${Buffer.concat(stderr).toString("utf8")}`,
			);
			stopBrowser("SIGKILL");
		}, 20_000);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			const output = Buffer.concat(stdout).toString("utf8");
			if (!settled && !completedOutput && output.includes("</body></html>")) {
				completedOutput = output;
				clearTimeout(timeout);
				stopBrowser("SIGTERM");
				forceKill = setTimeout(() => stopBrowser("SIGKILL"), 1_000);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			if (pendingError) {
				reject(pendingError);
				return;
			}
			if (completedOutput) {
				resolve(completedOutput);
				return;
			}
			if (code !== 0) {
				reject(new Error(`Chrome exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
				return;
			}
			resolve(Buffer.concat(stdout).toString("utf8"));
		});
	});
}

describe("#937 network-isolated transcript exports", () => {
	let harness: Harness | undefined;
	const servers: Server[] = [];

	afterEach(async () => {
		harness?.cleanup();
		harness = undefined;
		await Promise.all(servers.splice(0).map((server) => close(server)));
	});

	it("ships a CSP that denies implicit network-capable subresources", () => {
		const templateHtml = readFileSync(
			new URL("../../../src/core/export-html/template.html", import.meta.url),
			"utf8",
		);
		expect(templateHtml).toContain("default-src 'none'");
		expect(templateHtml).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
		expect(templateHtml.indexOf('http-equiv="x-dns-prefetch-control"')).toBeLessThan(templateHtml.indexOf("<style>"));
		expect(templateHtml).not.toMatch(/rel=["']dns-prefetch["']/i);
		expect(templateHtml).toContain("img-src data: blob:");
		expect(templateHtml).toContain("connect-src 'none'");
		expect(templateHtml).toContain("media-src 'none'");
		expect(templateHtml).toContain("object-src 'none'");
		expect(templateHtml).toContain("frame-src 'none'");
		expect(templateHtml).toContain("base-uri 'none'");
		expect(templateHtml).toContain("form-action 'none'");
		expect(templateHtml).toContain('<meta name="referrer" content="no-referrer">');
	});

	it.skipIf(!findChromeExecutable())(
		"blocks HTTP, HTTPS, protocol-relative, malformed, and redirect images until explicit navigation",
		async () => {
			const chromePath = findChromeExecutable();
			if (!chromePath) throw new Error("Chrome executable disappeared during the test");

			const remoteRequests: string[] = [];
			let remoteConnections = 0;
			const remoteServer = createServer((request, response) => {
				remoteRequests.push(request.url ?? "");
				if (request.url === "/redirect.png") {
					response.writeHead(302, { Location: "/final.png" });
					response.end();
					return;
				}
				response.writeHead(200, { "Content-Type": "image/png" });
				response.end(Buffer.from(ONE_PIXEL_PNG, "base64"));
			});
			remoteServer.on("connection", () => {
				remoteConnections += 1;
			});
			servers.push(remoteServer);
			const remotePort = await listen(remoteServer);

			const httpUrl = `http://network-isolation.test:${remotePort}/http.png`;
			const httpsUrl = `https://network-isolation.test:${remotePort}/https.png`;
			const protocolRelativeUrl = `//network-isolation.test:${remotePort}/protocol-relative.png`;
			const redirectUrl = `http://network-isolation.test:${remotePort}/redirect.png`;
			const safeLinkUrl = `http://network-isolation.test:${remotePort}/docs`;
			const blobUrl = "blob:null/00000000-0000-4000-8000-000000000937";
			const markdown = [
				`![http-image](${httpUrl})`,
				`![https-image](${httpsUrl})`,
				`![protocol-relative-image](${protocolRelativeUrl})`,
				`![redirect-image](${redirectUrl})`,
				`![data-image](data:image/png;base64,${ONE_PIXEL_PNG})`,
				`![blob-image](${blobUrl})`,
				"![malformed-image](http://%)",
				`[safe-link](${safeLinkUrl})`,
				"[unsafe-link](javascript:alert(1))",
			].join("\n\n");

			harness = await createHarness({ persistSession: true });
			harness.setResponses([fauxAssistantMessage(markdown)]);
			await harness.session.prompt("render image policy fixtures");
			const outputPath = join(harness.tempDir, "network-isolation.html");
			await exportSessionToHtml(harness.sessionManager, undefined, { outputPath });

			const dom = await dumpDom(chromePath, pathToFileURL(outputPath).href, join(harness.tempDir, "chrome"));

			expect(remoteConnections).toBe(0);
			expect(remoteRequests).toEqual([]);
			expect(dom).toContain(`data-remote-url="${httpUrl}"`);
			expect(dom).toContain(`data-remote-url="${httpsUrl}"`);
			expect(dom).toContain(`data-remote-url="https://network-isolation.test:${remotePort}/protocol-relative.png"`);
			expect(dom).toContain(`data-remote-url="${redirectUrl}"`);
			expect(dom).toContain('<button type="button" class="remote-image-link" data-remote-url=');
			expect(dom).toContain(
				`<a href="${safeLinkUrl}" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">safe-link</a>`,
			);
			expect(dom).not.toContain(`src="${httpUrl}"`);
			expect(dom).not.toContain(`src="${httpsUrl}"`);
			expect(dom).not.toContain(`src="//network-isolation.test:${remotePort}/protocol-relative.png"`);
			expect(dom).not.toContain(`src="${redirectUrl}"`);
			expect(dom).not.toContain(`href="${httpUrl}"`);
			expect(dom).not.toContain(`href="${httpsUrl}"`);
			expect(dom).not.toContain(`href="https://network-isolation.test:${remotePort}/protocol-relative.png"`);
			expect(dom).not.toContain(`href="${redirectUrl}"`);
			expect(dom).toContain("Remote image blocked: http-image");
			expect(dom).toContain("Remote image blocked: https-image");
			expect(dom).toContain("Remote image blocked: protocol-relative-image");
			expect(dom).toContain("Remote image blocked: redirect-image");
			expect(dom).toContain('target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer"');
			expect(dom).toContain(`src="data:image/png;base64,${ONE_PIXEL_PNG}"`);
			expect(dom).toContain(`src="${blobUrl}"`);
			expect(dom).toContain("Image blocked: malformed-image");
			expect(dom).not.toContain('href="javascript:alert(1)"');

			await dumpDom(chromePath, redirectUrl, join(harness.tempDir, "chrome-explicit-navigation"));
			expect(remoteRequests.filter((path) => path !== "/favicon.ico")).toEqual(["/redirect.png", "/final.png"]);
		},
		30_000,
	);
});
