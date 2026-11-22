import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

function command(name) {
	const path = process.env[name];
	assert.ok(path, `Set ${name} to the built executable or archive.`);
	return path;
}

function launch(t, file, args, options = {}) {
	const process = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
	const exited = once(process, "exit");
	// The awaited startup or exit check reports spawn errors.
	exited.catch(() => {});
	let output = "";
	for (const channel of [process.stdout, process.stderr]) {
		channel.setEncoding("utf8");
		channel.on("data", (bytes) => { output = (output + bytes).slice(-40000); });
	}
	const stop = async () => {
		if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
		await exited.catch(() => {});
	};
	t.after(stop);
	return {
		stop,
		async ready(pattern) {
			for (let attempt = 0; attempt < 300; attempt++) {
				const match = pattern.exec(output);
				if (match) return match[1];
				if (process.exitCode !== null || process.signalCode !== null) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(`Waiting for ${file} to start.`);
		},
		async success() {
			const [code] = await exited;
			assert.equal(code, 0, output);
		},
	};
}

async function proxyInvocationApi(t, port) {
	let activeWatch;
	let watchPaused;
	let resumeWatch = () => {};
	const cursors = [];
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, "http://127.0.0.1:" + port);
		if (url.pathname.endsWith("/events")) {
			cursors.push(url.searchParams.get("after"));
			activeWatch = response;
			await watchPaused;
			if (response.destroyed) return;
		}
		const upstream = get(url, (reply) => {
			response.writeHead(reply.statusCode, reply.headers);
			reply.on("error", () => response.destroy());
			reply.pipe(response);
		});
		upstream.on("error", () => response.destroy());
		response.on("close", () => upstream.destroy());
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => {
		server.close();
		server.closeAllConnections();
	});
	return {
		port: server.address().port,
		cursors,
		interruptWatch() {
			watchPaused = new Promise((resolve) => { resumeWatch = resolve; });
			activeWatch.destroy();
		},
		resumeWatch: () => resumeWatch(),
	};
}

test("browser Iroh viewer lists, follows and resumes real Bazel events", { timeout: 120000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bcr-iroh-e2e-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const relay = launch(t, command("IROH_RELAY"), []);
	const relayUrl = await relay.ready(/Relay URL: (http:\/\/[^\s]+)/);
	const bes = launch(t, command("BESSERVER"), [
		"--listen=127.0.0.1:0", "--http_listen=127.0.0.1:0", "--sqlite=" + join(dir, "invocations.sqlite"),
	]);
	const publishAddr = await bes.ready(/BES listening on ([^\s]+)/);
	const backendPort = await bes.ready(/invocation API listening on http:\/\/127\.0\.0\.1:(\d+)/);
	const api = await proxyInvocationApi(t, backendPort);

	const web = launch(t, command("RELEASESERVER"), [
		"--host=127.0.0.1", "--port=0", command("FRONTEND_ARCHIVE"),
	]);
	const site = await web.ready(/Starting server on (http:\/\/[^\s]+)/);
	const id = randomUUID();
	const key = join(dir, "iroh.key");
	const startCompanion = (ttl) => launch(t, command("IROH_COMPANION"), [
		"--backend-port=" + api.port, "--relay=" + relayUrl, "--key-file=" + key, "--invocation=" + id,
		"--ttl-seconds=" + ttl,
	]);
	const server = startCompanion(120);
	const endpoint = await server.ready(/Iroh endpoint: ([^\s]+)/);
	const ticket = await server.ready(/Viewer ticket: ([^\s]+)/);

	const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
	t.after(() => browser.close());
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(site + "/tools/invocation");
	await page.getByLabel("Backend URL or Iroh ticket").fill(ticket);
	await page.getByLabel("Invocation ID").fill(id);
	await page.getByRole("button", { name: "Replay and follow" }).click();
	await page.getByText(/Connected over Iroh/).waitFor({ timeout: 30000 });

	const finishBuild = join(dir, "finish-build");
	await writeFile(join(dir, "WORKSPACE"), "");
	await writeFile(join(dir, "BUILD.bazel"),
		'genrule(name = "hello", outs = ["hello.txt"], cmd = "while [ ! -f \\"$$BCR_IROH_TEST_GATE\\" ]; do sleep 0.1; done; echo hello > $@")\n',
	);
	const build = launch(t, process.env.BAZEL || "bazel", [
		"--batch", "--ignore_all_rc_files", "--output_base=" + join(dir, "bazel-out"),
		"build", "--enable_bzlmod=false", "--enable_workspace=true", "--bes_backend=grpc://" + publishAddr,
		"--spawn_strategy=local", "--action_env=BCR_IROH_TEST_GATE=" + finishBuild,
		"--invocation_id=" + id, "//:hello",
	], { cwd: dir, env: { ...process.env, USE_BAZEL_VERSION: "8.5.0" } });
	try {
		await page.getByText("Building", { exact: true }).waitFor();
		assert.deepEqual(api.cursors, ["0"]);
		api.interruptWatch();
		// The viewer collapses its connection controls after the first build event.
		await page.getByText(/reconnecting from the last event/).waitFor({ state: "attached" });
		api.resumeWatch();
		await page.getByText(/Connected over Iroh|Following .* events/).waitFor({ state: "attached" });
		assert.equal(api.cursors.length, 2);
		assert.match(api.cursors[1], /^[1-9]\d*$/);
	} finally {
		api.resumeWatch();
		await writeFile(finishBuild, "");
	}
	await build.success();
	await page.getByText("Succeeded", { exact: true }).waitFor();
	await page.getByText(/Stream ended/).waitFor();

	await page.getByText("Open an invocation", { exact: true }).click();
	await page.getByRole("button", { name: "Refresh saved runs" }).click();
	await page.getByText("1 saved invocations", { exact: true }).waitFor();
	assert.equal(await page.getByLabel("Saved run").locator("option").last().getAttribute("value"), id);

	const [first, resumed] = await page.evaluate(async ({ ticket, id }) => {
		async function next(after) {
			const backend = window.bcrIrohInvocation(ticket);
			try {
				return await new Promise((resolve, reject) => {
					const deadline = setTimeout(() => reject(new Error("Timed out reading Iroh replay.")), 10000);
					backend.watch(id, () => after, (cursor) => {
						clearTimeout(deadline);
						backend.close();
						resolve(cursor);
					}, () => {});
				});
			} finally {
				backend.close();
			}
		}
		const first = await next("0");
		return [first, await next(first)];
	}, { ticket, id });
	assert.ok(BigInt(first) > 0n);
	assert.ok(BigInt(resumed) > BigInt(first));

	const summary = await page.evaluate(async ({ ticket, id }) => {
		const backend = window.bcrIrohInvocation(ticket);
		try { return await backend.get(id); }
		finally { backend.close(); }
	}, { ticket, id });
	assert.equal(summary.invocationId, id);
	assert.equal(summary.result.exitCode, 0);
	assert.equal(summary.state, "INVOCATION_STATE_COMPLETE");

	const unauthorized = await page.evaluate(async (ticket) => {
		const backend = window.bcrIrohInvocation(ticket);
		try { await backend.get("another-invocation"); return ""; }
		catch (error) { return error.message; }
		finally { backend.close(); }
	}, ticket);
	assert.match(unauthorized, /HTTP 403/);

	await server.stop();
	const restarted = startCompanion(2);
	assert.equal(await restarted.ready(/Iroh endpoint: ([^\s]+)/), endpoint);
	const expiredTicket = await restarted.ready(/Viewer ticket: ([^\s]+)/);
	await new Promise((resolve) => setTimeout(resolve, 2200));
	const expired = await page.evaluate(async (ticket) => {
		const backend = window.bcrIrohInvocation(ticket);
		try { await backend.list(); return ""; }
		catch (error) { return error.message; }
		finally { backend.close(); }
	}, expiredTicket);
	assert.match(expired, /HTTP 403/);
	await page.getByLabel("Backend URL or Iroh ticket").fill(expiredTicket);
	await page.getByRole("button", { name: "Replay and follow" }).click();
	await page.getByText("The Iroh viewer ticket or invocation was denied.", { exact: true }).waitFor();
	assert.deepEqual(errors, []);
});
