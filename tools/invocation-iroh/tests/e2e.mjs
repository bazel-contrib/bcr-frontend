import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		async expectExit(expected = 0) {
			const [code] = await exited;
			assert.equal(code, expected, output);
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

test("browser Iroh viewer follows real Bazel events and invocation groups", { timeout: 120000 }, async (t) => {
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
	const buildIcon = page.locator(".bes-invocation-icon");
	const buildTitle = page.locator(".bes-invocation-title");
	const buildStatus = page.locator(".bes-invocation-state");
	const buildElapsed = page.getByLabel("Build elapsed time");
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(site + "/tools/invocation/" + id);
	await page.getByLabel("Backend URL or iroh ticket").fill(ticket);
	await page.getByRole("button", { name: "Connect" }).click();
	await page.getByText(/Connected over Iroh/).waitFor({ timeout: 30000 });
	const waitingIcon = await buildIcon.boundingBox();

	const finishBuild = join(dir, "finish-build");
	const binaryEvents = join(dir, "events.bep");
	await writeFile(join(dir, "WORKSPACE"), "");
	await writeFile(join(dir, "BUILD.bazel"),
		'genrule(name = "hello", outs = ["hello.txt"], cmd = "while [ ! -f \\"$$BCR_IROH_TEST_GATE\\" ]; do sleep 0.1; done; echo hello > $@")\n',
	);
	const build = launch(t, process.env.BAZEL || "bazel", [
		"--batch", "--ignore_all_rc_files", "--output_base=" + join(dir, "bazel-out"),
		"build", "--enable_bzlmod=false", "--enable_workspace=true", "--bes_backend=grpc://" + publishAddr,
		"--build_event_binary_file=" + binaryEvents,
		"--bes_results_url=" + site + "/tools/invocation/",
		"--spawn_strategy=local", "--action_env=BCR_IROH_TEST_GATE=" + finishBuild,
		"--invocation_id=" + id, "--build_metadata=igroup=saved", "//:hello",
	], { cwd: dir, env: { ...process.env, USE_BAZEL_VERSION: "8.5.0" } });
	try {
		assert.equal(await build.ready(/Streaming build results to: ([^\s]+)/), site + "/tools/invocation/" + id);
		await page.getByText("Building", { exact: true }).waitFor();
		const spinner = buildIcon.locator(".color-fg-attention .bes-invocation-spinner");
		await spinner.waitFor();
		const animation = () => spinner.evaluate((icon) => getComputedStyle(icon, "::after").animationName);
		assert.equal(await animation(), "bes-invocation-spin");
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await animation(), "none");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		assert.deepEqual(api.cursors, ["0"]);
		api.interruptWatch();
		await page.getByText(/reconnecting from the last event/).waitFor({ state: "attached" });
		api.resumeWatch();
		await page.getByText(/Connected over Iroh|Following .* events/).waitFor({ state: "attached" });
		assert.equal(api.cursors.length, 2);
		assert.match(api.cursors[1], /^[1-9]\d*$/);
	} finally {
		api.resumeWatch();
		await writeFile(finishBuild, "");
	}
	await build.expectExit();
	await buildStatus.getByText("SUCCESS", { exact: true }).waitFor();
	assert.equal(await buildIcon.locator(".color-fg-success svg").count(), 1);
	assert.match(await buildStatus.getAttribute("class"), /color-fg-success/);
	await buildElapsed.waitFor();
	assert.match(await buildElapsed.innerText(), /^(?:\d+m )?\d+\.\d{3}s$/);
	const [icon, title, status, elapsed] = await Promise.all(
		[buildIcon, buildTitle, buildStatus, buildElapsed].map((item) => item.boundingBox()),
	);
	assert.equal(icon.width, waitingIcon.width);
	assert.ok(icon.x < title.x && title.x < status.x && status.x < elapsed.x);
	const headerTabs = await page.locator(".bes-invocation-heading").getByRole("tablist", { name: "Invocation views" }).boundingBox();
	assert.ok(title.x < headerTabs.x && headerTabs.x < status.x);
	await page.getByText(/Stream ended/).waitFor();
	const invocationUrl = new URL(page.url());
	assert.equal(invocationUrl.pathname, "/tools/invocation/" + id);
	assert.equal(invocationUrl.searchParams.has("invocation"), false);
	assert.ok(!Array.from(invocationUrl.searchParams.values()).includes(ticket));
	await page.reload();
	await buildStatus.getByText("SUCCESS", { exact: true }).waitFor();
	await page.getByText(/Stream ended/).waitFor();

	await page.getByRole("navigation", { name: "Build event views" }).getByRole("link", { name: "Runs", exact: true }).click();
	await page.getByRole("table", { name: "Invocation runs" }).getByRole("button", { name: id }).waitFor();
	await page.getByRole("button", { name: id, exact: true }).click();

	const filePage = await browser.newPage();
	filePage.on("pageerror", (error) => errors.push(error.message));
	await filePage.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
	await filePage.goto(site + "/tools/invocations");
	const macShortcuts = filePage.getByRole("region", { name: "Keyboard Shortcuts" });
	assert.equal(await macShortcuts.locator("kbd", { hasText: /^Option$/ }).count(), 6);
	assert.equal(await filePage.getByRole("link", { name: "build event stream backend", exact: true }).getAttribute("href"),
		"https://github.com/bazel-contrib/bcr-frontend/releases");
	await filePage.getByText("Upload a build events file or connect to a build event stream backend.", { exact: true }).waitFor();
	const fileInput = filePage.getByLabel("Choose a binary build event file");
	const uploadsTab = filePage.getByRole("region", { name: "Upload", exact: true }).getByRole("link", { name: "Uploads", exact: true });
	await uploadsTab.click();
	await filePage.getByText("Upload a build events file to see it here.").waitFor();
	await fileInput.setInputFiles(binaryEvents);
	await filePage.getByRole("heading", { name: id, exact: true }).waitFor();
	await filePage.locator(".bes-invocation-state").getByText("SUCCESS", { exact: true }).waitFor();
	assert.equal(await filePage.getByLabel("Build elapsed time").getAttribute("datetime"), await buildElapsed.getAttribute("datetime"));
	await filePage.getByText(/events\.bep ·/).waitFor();
	await filePage.getByRole("region", { name: "Build statistics" }).getByRole("article", { name: "Actions" }).waitFor();
	await filePage.getByRole("region", { name: "Build frontier" }).waitFor();
	// A length-delimited BuildEvent with an empty Progress payload and no start or finish.
	await filePage.getByRole("region", { name: "Current", exact: true }).evaluate((target) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([new Uint8Array([2, 26, 0])], "partial.bep"));
		target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
		target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
	});
	await filePage.getByRole("heading", { name: /^file-[0-9a-f]{16}$/ }).waitFor();
	await filePage.locator(".bes-invocation-state").getByText("Incomplete", { exact: true }).waitFor();
	assert.equal(await filePage.getByLabel("Build elapsed time").innerText(), "—");
	assert.equal(new URL(filePage.url()).pathname, "/tools/invocations");
	await uploadsTab.click();
	const uploads = filePage.getByRole("table", { name: "Uploaded invocations" });
	assert.equal(await uploads.locator("tbody tr").count(), 2);
	await uploads.getByRole("row", { name: /partial.bep/ }).getByRole("img", { name: "Incomplete" }).waitFor();
	await uploads.getByRole("button", { name: id, exact: true }).press("Enter");
	await filePage.getByRole("heading", { name: id, exact: true }).waitFor();
	await filePage.close();

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
	assert.equal(summary.invocationGroup, "saved");

	const unauthorized = await page.evaluate(async (ticket) => {
		const backend = window.bcrIrohInvocation(ticket);
		try { await backend.get("another-invocation"); return ""; }
		catch (error) { return error.message; }
		finally { backend.close(); }
	}, ticket);
	assert.match(unauthorized, /HTTP 403/);

	const groupsDenied = await page.evaluate(async (ticket) => {
		const backend = window.bcrIrohInvocation(ticket);
		try { await backend.listGroups(); return ""; }
		catch (error) { return error.message; }
		finally { backend.close(); }
	}, ticket);
	assert.match(groupsDenied, /HTTP 403/);

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
	await page.getByLabel("Backend URL or iroh ticket").fill(expiredTicket);
	await page.getByRole("button", { name: "Connect" }).click();
	await page.getByText("The Iroh viewer ticket or invocation was denied.", { exact: true }).waitFor();

	const groupServer = launch(t, command("IROH_COMPANION"), [
		"--backend-port=" + api.port, "--relay=" + relayUrl, "--key-file=" + join(dir, "groups.key"),
	]);
	const groupTicket = await groupServer.ready(/Viewer ticket: ([^\s]+)/);
	await page.goto(site + "/tools/invocations");
	await page.getByRole("heading", { level: 1, name: "Build Events" }).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Tools", exact: true }).count(), 0);
	const backendForm = page.getByRole("form", { name: "Backend" });
	const backendStatus = backendForm.getByRole("status");
	const connectGroup = backendForm.getByRole("button", { name: "Connect" });
	const followBuilds = backendForm.getByRole("checkbox", { name: "Follow" });
	const showLastRun = backendForm.getByRole("checkbox", { name: "Show last" });
	assert.ok(await followBuilds.isChecked());
	assert.ok(await showLastRun.isChecked());
	const groupDefaults = new URL(page.url()).searchParams;
	assert.equal(groupDefaults.get("follow"), "auto");
	assert.equal(groupDefaults.get("showLast"), "1");
	assert.match(await followBuilds.locator("xpath=..").getAttribute("title"), /Open new group builds automatically/);
	assert.match(await showLastRun.locator("xpath=..").getAttribute("title"), /Open the latest finished run/);
	assert.equal((await connectGroup.boundingBox()).x, (await backendForm.getByLabel("Backend URL or iroh ticket").boundingBox()).x);
	const uploadTarget = page.getByRole("region", { name: "Upload build events" });
	const backendBox = await backendForm.boundingBox();
	assert.ok((await uploadTarget.boundingBox()).y > backendBox.y + backendBox.height);
	const viewNav = page.getByRole("navigation", { name: "Build event views" });
	const sidebar = page.locator(".bes-events-sidebar");
	const groupView = (name) => viewNav.getByRole("link", { name, exact: true });
	await backendStatus.getByText("Disconnected", { exact: true }).waitFor();
	assert.ok((await page.getByRole("region", { name: "Current", exact: true }).boundingBox()).x >
		(await sidebar.boundingBox()).x);
	for (const name of ["Current", "Runs", "Metrics", "Tests"]) {
		await groupView(name).click();
		await page.getByRole("region", { name, exact: true }).getByText(/Connect to a backend and choose a group/).first().waitFor();
		assert.equal(await groupView(name).getAttribute("aria-current"), "location");
	}
	await page.keyboard.press("Alt+Shift+Digit5");
	const usage = page.getByRole("region", { name: "Usage", exact: true });
	await usage.getByRole("figure", { name: "Build event flow from Bazel to the viewer" }).waitFor();
	for (const snippet of ["besserver", "invocation-iroh --backend-port", "--build_metadata=igroup=release"]) {
		await usage.locator("pre:visible").filter({ hasText: snippet }).waitFor();
	}
	assert.match(await usage.innerText(), /bcr-iroh-v1:eyJlbmRwb2ludCI6…/);
	assert.match(await usage.innerText(), /Paste the full ticket into Backend URL or iroh ticket in the Backend form/);
	assert.match(await usage.innerText(), /Reuse the same key file across restarts to keep a stable Iroh address/);
	assert.equal(await usage.locator("details[open]").count(), 0);
	await usage.locator("summary").click();
	await usage.locator("pre").filter({ hasText: "bazel run //app/bcr:release" }).waitFor();
	await groupView("Current").click();
	await backendForm.getByLabel("Backend URL or iroh ticket").fill("ftp://localhost");
	await backendForm.getByRole("button", { name: "Connect" }).click();
	await backendStatus.getByText("Connection failed", { exact: true }).waitFor();
	await backendStatus.getByText(/Enter an HTTP or HTTPS backend URL/).waitFor();
	await backendForm.getByLabel("Backend URL or iroh ticket").fill(groupTicket);
	await backendForm.getByRole("button", { name: "Connect" }).click();
	await page.getByRole("button", { name: "saved", exact: true }).waitFor();
	await page.getByLabel("Group", { exact: true }).fill("release");
	await page.getByRole("button", { name: "Connect" }).click();
	await backendStatus.getByText("Connected", { exact: true }).waitFor();
	await backendStatus.getByText("Connected over Iroh · Watching group release (Set --build_metadata=igroup=release on a build to add it to the release group.)").waitFor();
	assert.equal(await backendStatus.locator("strong.text-mono").innerText(), "release");
	assert.equal(await backendStatus.locator("code").innerText(), "--build_metadata=igroup=release");
	await page.getByText("release · Waiting for the next build", { exact: true }).waitFor();
	const runsTab = groupView("Runs");
	const currentTab = groupView("Current");
	const lastTab = groupView("Last");
	const runs = page.getByRole("table", { name: "Invocation runs" });
	const invocationHeading = (id) => page.getByRole("heading", { name: id, exact: true });

	const startGroupedBuild = (...targets) => {
		const id = randomUUID();
		const gate = join(dir, id + ".finish");
		const build = launch(t, process.env.BAZEL || "bazel", [
			"--batch", "--ignore_all_rc_files", "--output_base=" + join(dir, id + ".out"),
			"build", "--enable_bzlmod=false", "--enable_workspace=true", "--bes_backend=grpc://" + publishAddr,
			"--bes_results_url=" + site + "/tools/invocations/release/",
			"--spawn_strategy=local", "--action_env=BCR_IROH_TEST_GATE=" + gate, "--symlink_prefix=/",
			"--invocation_id=" + id, "--build_metadata=igroup=release", "--build_event_publish_all_actions",
			"--nokeep_going",
			...(targets.length ? targets : ["//:hello"]),
		], { cwd: dir, env: { ...process.env, USE_BAZEL_VERSION: "8.5.0" } });
		return { id, build, finish: () => writeFile(gate, "") };
	};
	const firstRun = startGroupedBuild();
	const firstRunUrl = site + "/tools/invocations/release/" + firstRun.id;
	let nextRun;
	try {
		assert.equal(await firstRun.build.ready(/Streaming build results to: ([^\s]+)/), firstRunUrl);
		await invocationHeading(firstRun.id).waitFor();
		await buildStatus.getByText("Building", { exact: true }).waitFor();
		assert.equal(await currentTab.getAttribute("aria-current"), "location");
		assert.ok(await page.locator(".bes-invocation-heading").getByLabel("Build elapsed time").isVisible());
		assert.equal(new URL(page.url()).pathname, "/tools/invocations/release/" + firstRun.id);
		assert.equal(new URL(page.url()).searchParams.get("follow"), "auto");
		const activeFrontier = page.getByRole("region", { name: "Build frontier" });
		const waitTimer = activeFrontier.locator('time[aria-label="Time waiting for event"]');
		await activeFrontier.locator("canvas").click({ position: { x: 25, y: 35 } });
		await waitTimer.waitFor();
		await page.waitForFunction(() => {
			const timer = document.querySelector('time[aria-label="Time waiting for event"]:not([hidden])');
			return timer && Number(timer.getAttribute("datetime")?.slice(2, -1)) >= 2;
		});
		await page.reload();
		await invocationHeading(firstRun.id).waitFor();
		await buildStatus.getByText("Building", { exact: true }).waitFor();
		await activeFrontier.locator("canvas").press("Home");
		assert.ok(Number((await waitTimer.getAttribute("datetime")).slice(2, -1)) >= 2);
		nextRun = startGroupedBuild();
		await runsTab.click();
		const runningRow = runs.getByRole("row", { name: new RegExp(nextRun.id) });
		await runningRow.getByRole("img", { name: "Running", exact: true }).waitFor();
		await runningRow.locator(".color-fg-attention .bes-invocation-spinner").waitFor();
		await runningRow.getByText("bazel build //:hello", { exact: true }).waitFor();
		assert.match(await runningRow.locator("time").innerText(), /^Started /);
		assert.equal(await runningRow.evaluate(row => getComputedStyle(row).display), "table-row");
		assert.ok(!(await invocationHeading(firstRun.id).isVisible()));
		await currentTab.click();
		await invocationHeading(firstRun.id).waitFor();
		await followBuilds.uncheck();
		await firstRun.finish();
		await lastTab.waitFor();
		assert.ok(await invocationHeading(firstRun.id).isVisible());
		assert.equal(new URL(page.url()).searchParams.get("follow"), "off");
		await followBuilds.check();
		await invocationHeading(nextRun.id).waitFor();
	} finally {
		await firstRun.finish();
		if (nextRun) await nextRun.finish();
	}
	await firstRun.build.expectExit();
	await nextRun.build.expectExit();
	await invocationHeading(nextRun.id).waitFor();
	await lastTab.waitFor();
	assert.equal(await lastTab.getAttribute("aria-current"), "location");
	await buildStatus.getByText("SUCCESS", { exact: true }).waitFor();
	await runsTab.click();
	assert.equal(await page.getByText("Invocation history", { exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "Return to group" }).count(), 0);
	const savedRow = runs.getByRole("row", { name: new RegExp(firstRun.id) });
	const savedIcon = savedRow.getByRole("img", { name: "SUCCESS", exact: true });
	await savedIcon.waitFor();
	assert.equal(await savedIcon.getAttribute("title"), "SUCCESS (0)");
	assert.equal(await savedRow.locator("td").first().innerText(), "");
	assert.equal(await savedRow.locator(".color-fg-success svg").count(), 1);
	assert.match(await savedRow.locator("time").innerText(), /^Finished /);
	assert.equal(await savedRow.locator("time").evaluate((time) => getComputedStyle(time).whiteSpace), "nowrap");
	await savedRow.getByRole("button", { name: firstRun.id }).press("Enter");
	await invocationHeading(firstRun.id).waitFor();
	const selected = new URL(page.url());
	assert.equal(selected.pathname, "/tools/invocations/release/" + firstRun.id);
	assert.equal(selected.searchParams.has("group"), false);
	assert.equal(selected.searchParams.has("invocation"), false);
	assert.equal(selected.searchParams.get("follow"), "manual");
	assert.equal(await followBuilds.isChecked(), false);
	assert.ok(!Array.from(selected.searchParams.values()).includes(groupTicket));
	await page.goto(firstRunUrl);
	await invocationHeading(firstRun.id).waitFor();
	assert.equal(await followBuilds.isChecked(), false);
	await runsTab.click();
	assert.equal(new URL(page.url()).searchParams.get("follow"), "auto");
	assert.ok(await followBuilds.isChecked());
	await lastTab.click();
	const longTargets = Array.from({length: 16}, (_, index) => "long_invocation_command_target_" + index);
	await appendFile(join(dir, "BUILD.bazel"),
		longTargets.map((name) => 'alias(name = "' + name + '", actual = ":hello")\n').join(""));
	const flightLayer = page.locator(".bes-frontier-flights");
	await flightLayer.evaluate((layer) => {
		let flights = 0;
		new MutationObserver((records) => {
			for (const record of records) {
				for (const dot of record.addedNodes) {
					if (!(dot instanceof HTMLElement) || dot.classList.contains("is-progress")) continue;
					const frames = dot.getAnimations()[0]?.effect?.getKeyframes();
					if (!frames?.length) continue;
					const from = new DOMMatrix(frames[0].transform);
					const to = new DOMMatrix(frames.at(-1).transform);
					layer.setAttribute("data-fixture-direction", to.m41 < from.m41 ? "left" : "right");
					if (to.m42 <= from.m42) layer.setAttribute("data-fixture-upward", "true");
					flights++;
				}
			}
			layer.setAttribute("data-fixture-flights", String(flights));
		}).observe(layer, {childList: true});
	});
	const shortRun = startGroupedBuild(...longTargets.map((name) => "//:" + name));
	await shortRun.finish();
	await shortRun.build.expectExit();
	await invocationHeading(shortRun.id).waitFor();
	await buildStatus.getByText("SUCCESS", { exact: true }).waitFor();
	const successReader = page.getByRole("group", { name: "Last successful action", exact: true });
	await successReader.getByText("Genrule", { exact: true }).waitFor();
	await successReader.getByText("hello.txt", { exact: true }).waitFor();
	const flightCount = Number(await flightLayer.getAttribute("data-fixture-flights"));
	assert.ok(flightCount > 0);
	assert.equal(await flightLayer.getAttribute("data-fixture-direction"), "left");
	assert.equal(await successReader.getByText("Succeeded", { exact: true }).count(), 0);
	const genruleSwatch = page.locator(".bes-mnemonic-counts li")
		.filter({ has: page.getByText("Genrule", { exact: true }) }).locator(".bes-mnemonic-swatch");
	assert.equal(await successReader.locator(".bes-frontier-reader-dot").evaluate((dot) =>
		getComputedStyle(dot).backgroundColor), await genruleSwatch.evaluate((dot) =>
		getComputedStyle(dot).backgroundColor));
	await page.setViewportSize({width: 390, height: 844});
	const expand = page.getByRole("button", { name: "Expand command" });
	await expand.waitFor();
	const commandHeading = page.locator(".bes-invocation-command");
	const collapsedHeight = await commandHeading.evaluate((heading) => heading.clientHeight);
	await expand.click();
	const collapse = page.getByRole("button", { name: "Collapse command" });
	assert.equal(await collapse.getAttribute("aria-expanded"), "true");
	assert.ok(await commandHeading.evaluate((heading) => heading.clientHeight) > collapsedHeight);
	await collapse.click();
	assert.equal(await commandHeading.evaluate((heading) => heading.clientHeight), collapsedHeight);
	await page.setViewportSize({width: 1280, height: 720});
	await groupView("Metrics").click();
	const builds = page.getByRole("region", { name: "Metrics", exact: true });
	await builds.getByText("Average build time", { exact: true }).waitFor();
	const invocationCount = builds.locator("dl > div").filter({ has: page.getByText("Invocations", { exact: true }) });
	assert.equal(await invocationCount.locator("dd").innerText(), "3");
	assert.ok(await builds.locator(".bes-group-totals + .bes-group-chart").isVisible());
	const successFilter = builds.getByRole("checkbox", { name: "SUCCESS", exact: true });
	assert.ok(await successFilter.isChecked());
	assert.equal(await builds.getByLabel("Metric", { exact: true }).inputValue(), "0");
	const metricBars = builds.locator('.bes-chart-segment[aria-label*=" · Build time · "]');
	const track = builds.locator(".bes-chart-track").first();
	const lightTrack = await track.evaluate((element) => getComputedStyle(element).backgroundColor);
	await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
	const darkTrack = await track.evaluate((element) => getComputedStyle(element).backgroundColor);
	assert.notEqual(darkTrack, lightTrack);
	assert.notEqual(darkTrack, "rgb(255, 255, 255)");
	await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "light"));
	assert.equal(await metricBars.count(), 3);
	assert.match(await metricBars.first().getAttribute("title"), new RegExp(shortRun.id));
	const newestBuildBar = builds.getByRole("link", { name: new RegExp(shortRun.id + ".*Build time") });
	assert.match(await newestBuildBar.getAttribute("href"), new RegExp("/tools/invocations/release/" + shortRun.id + "\\?follow=manual"));
	assert.ok(await builds.locator(".bes-chart-separator").first().isVisible());
	assert.ok(await metricBars.first().evaluate((bar) => parseFloat(bar.style.width) > 0));
	const barValue = (title) => Number(title.match(/ · Build time · ([\d,.]+) s/)[1].replaceAll(",", ""));
	const individualValues = (await metricBars.evaluateAll((bars) => bars.map((bar) => bar.getAttribute("title")))).map(barValue);
	const groupBy = builds.getByLabel("Group by", { exact: true });
	for (const option of ["Hourly average (UTC)", "Daily average (UTC)"]) {
		await groupBy.selectOption({ label: option });
		assert.equal(await builds.locator(".bes-chart-separator").count(), await builds.locator(".bes-chart-row").count());
		const titles = await metricBars.evaluateAll((bars) => bars.map((bar) => bar.getAttribute("title")));
		const measurementCount = (title) => Number(title.match(/\((\d+) measured\)$/)[1]);
		assert.equal(titles.reduce((total, title) => total + measurementCount(title), 0), 3);
		const binnedTotal = titles.reduce((total, title) => total + barValue(title) * measurementCount(title), 0);
		assert.ok(Math.abs(binnedTotal - individualValues.reduce((total, value) => total + value, 0)) < 0.004);
	}
	await groupBy.selectOption({ label: "Per build" });
	await builds.getByLabel("Metric 2", { exact: true }).selectOption({ label: "Actions executed" });
	await builds.getByLabel("Metric 3", { exact: true }).selectOption({ label: "CPU time" });
	await builds.getByLabel("Metric 4", { exact: true }).selectOption({ label: "Configured targets" });
	assert.equal(await builds.locator(".bes-chart-axis").count(), 2);
	assert.equal(await builds.locator(".bes-chart-row").first().locator(".bes-chart-lane").count(), 4);
	assert.equal(await builds.getByRole("link", { name: / · Actions executed · \d+ count/ }).count(), 3);
	assert.ok(await builds.getByLabel("Metric 4", { exact: true }).locator('option', { hasText: "Output size" }).isDisabled());
	await newestBuildBar.press("Enter");
	await invocationHeading(shortRun.id).waitFor();
	assert.equal(new URL(page.url()).pathname, "/tools/invocations/release/" + shortRun.id);
	assert.equal(new URL(page.url()).searchParams.get("follow"), "manual");
	await followBuilds.check();
	await groupView("Metrics").click();
	await builds.getByText(/No action cache lookups recorded/).waitFor();
	await page.keyboard.press("Alt+Shift+Digit4");
	await page.getByRole("region", { name: "Tests", exact: true }).getByText("No test summaries recorded.").waitFor();
	await lastTab.click();
	await buildStatus.getByText("SUCCESS", { exact: true }).waitFor();
	await appendFile(join(dir, "BUILD.bazel"),
		'genrule(name = "broken", outs = ["broken.txt"], cmd = "echo \'fixture.c:7: error: missing test symbol\' >&2; exit 1")\n',
	);
	const failedRun = startGroupedBuild("//:broken");
	await failedRun.build.expectExit(1);
	const failure = page.getByRole("region", { name: "Build failure" });
	await failure.getByText("Genrule · //:broken", { exact: true }).waitFor();
	await failure.getByText("fixture.c:7: error: missing test symbol", { exact: true }).waitFor();
	assert.equal(await failure.evaluate((section) =>
		section.previousElementSibling.matches(".bes-invocation-log")), true);
	await buildStatus.getByText("BUILD_FAILURE", { exact: true }).waitFor();
	const failedReader = page.getByRole("group", { name: "Last failed action", exact: true });
	await failedReader.getByText("Genrule", { exact: true }).waitFor();
	await failedReader.getByText("broken.txt", { exact: true }).waitFor();
	assert.ok(Number(await flightLayer.getAttribute("data-fixture-flights")) > flightCount);
	assert.equal(await flightLayer.getAttribute("data-fixture-direction"), "right");
	assert.equal(await flightLayer.getAttribute("data-fixture-upward"), null);
	assert.equal(await page.locator(".bes-frontier-reader").count(), 1);
	assert.equal(await buildIcon.locator(".color-fg-danger svg").count(), 1);
	assert.equal(await page.getByText("Browse events", { exact: true }).count(), 0);
	const frontier = page.getByRole("region", { name: "Build frontier" });
	const genrule = frontier.getByRole("listitem").filter({ hasText: "Genrule" });
	assert.match(await genrule.innerText(), /Genrule\s*1/);
	await frontier.locator("canvas").press("End");
	await frontier.getByText(/Received · Build started/).waitFor();
	assert.equal(await frontier.getByText("Announced children", { exact: true }).count(), 0);
	assert.equal(await frontier.getByText("Event ID", { exact: true }).count(), 0);
	await frontier.locator("canvas").press("ArrowLeft");
	assert.ok(!(await frontier.getByText(/Received · Build started/).isVisible()));
	await frontier.locator("canvas").press("ArrowRight");
	await frontier.getByText(/Received · Build started/).waitFor();
	const selectRootChild = async (name) => {
		const canvas = frontier.locator("canvas");
		const eventType = frontier.locator(".bes-event-type h3");
		await canvas.press("End");
		await canvas.press("ArrowLeft");
		for (let row = 0; row < 16 && (await eventType.innerText()) !== name; row++) {
			await canvas.press("ArrowDown");
		}
		assert.equal(await eventType.innerText(), name);
	};
	await selectRootChild("Options parsed");
	const commandFlags = frontier.locator(".bes-command-arguments li");
	assert.equal(await commandFlags.getByRole("link", { name: "--nokeep_going", exact: true }).first().getAttribute("href"),
		"/bazel/flags/keep_going");
	assert.match(await commandFlags.filter({ has: page.getByRole("link", { name: "--build_metadata", exact: true }) }).first().innerText(),
		/^--build_metadata=igroup=release$/);
	await selectRootChild("Structured command line");
	assert.equal(await commandFlags.getByRole("link", { name: "--build_metadata", exact: true }).first().getAttribute("href"),
		"/bazel/flags/build_metadata");
	await frontier.locator("canvas").press("Home");
	await frontier.getByText(/Final event · /).waitFor();
	const inlineLog = page.getByRole("tabpanel", { name: "Overview" }).getByRole("region", { name: "Build terminal output", exact: true });
	await inlineLog.getByText(/missing test symbol/).waitFor();
	assert.equal(await page.getByRole("heading", { name: "Build output", exact: true }).count(), 0);
	const openTerminal = failure.getByRole("button", { name: "Open terminal" });
	assert.match(await openTerminal.getAttribute("class"), /\bbtn btn-sm\b/);
	const statistics = page.getByRole("region", { name: "Build statistics" });
	const invocationTabs = page.getByRole("tablist", { name: "Invocation views" });
	for (const title of ["Actions", "Targets", "Timing"]) {
		await statistics.getByRole("article", { name: title, exact: true }).waitFor();
	}
	const overview = page.getByRole("tabpanel", { name: "Overview" });
	const workspace = overview.locator(".bes-invocation-workspace");
	const metadata = overview.locator(".bes-invocation-metadata");
	const overviewOrder = await Promise.all([
		overview.locator(".bes-invocation-command"), workspace, metadata, inlineLog, statistics, frontier,
	].map((item) => item.boundingBox()));
	assert.ok(overviewOrder.every((item, index) => index === 0 || item.y > overviewOrder[index - 1].y));
	assert.equal(await workspace.evaluate((item) => getComputedStyle(item).whiteSpace), "nowrap");
	assert.match(await workspace.innerText(), /^Workspace /);
	assert.ok((await invocationTabs.boundingBox()).y < overviewOrder[0].y);
	await openTerminal.click();
	assert.match(await page.getByRole("tabpanel", { name: "Terminal" }).innerText(), /missing test symbol/);
	assert.equal(await inlineLog.isVisible(), false);
	assert.equal(await statistics.isVisible(), false);
	assert.ok(await invocationTabs.isVisible());
	await invocationHeading(failedRun.id).waitFor();
	await invocationTabs.getByRole("tab", { name: "Metrics" }).click();
	const invocationMetrics = page.getByRole("tabpanel", { name: "Metrics" });
	await invocationMetrics.locator("summary").getByText("Timing", { exact: true }).click();
	const timingCell = invocationMetrics.getByRole("cell", { name: "Wall time (ms)", exact: true });
	await timingCell.waitFor();
	assert.equal(await timingCell.evaluate((cell) => getComputedStyle(cell.parentElement).backgroundColor), "rgba(0, 0, 0, 0)");
	assert.ok(await invocationMetrics.getByRole("heading", { name: "Remote cache" }).isVisible());
	await followBuilds.uncheck();
	await showLastRun.uncheck();
	assert.equal(new URL(page.url()).searchParams.get("follow"), "off");
	assert.equal(new URL(page.url()).searchParams.get("showLast"), "0");
	await page.goto(site + "/tools/invocations/release?follow=off&showLast=0");
	await page.getByText("Select a run from the Runs tab.", { exact: true }).waitFor();
	assert.equal(await followBuilds.isChecked(), false);
	assert.equal(await showLastRun.isChecked(), false);
	assert.equal(new URL(page.url()).pathname, "/tools/invocations/release");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(site + "/tools/invocations/release?follow=off&showLast=1");
	assert.ok(await showLastRun.isChecked());
	await invocationHeading(failedRun.id).waitFor();
	await failedReader.getByText("broken.txt", { exact: true }).waitFor();
	assert.equal(await flightLayer.locator(".bes-frontier-particle").count(), 0);
	assert.equal(new URL(page.url()).searchParams.get("follow"), "off");
	await groupView("Metrics").click();
	const failureFilter = builds.getByRole("checkbox", { name: "BUILD_FAILURE", exact: true });
	await failureFilter.waitFor();
	assert.equal(await failureFilter.isChecked(), false);
	assert.equal(await metricBars.count(), 3);
	await failureFilter.check();
	assert.equal(await metricBars.count(), 4);
	assert.match(await metricBars.first().getAttribute("class"), /color-fg-danger/);
	const days = await metricBars.evaluateAll((bars) => new Set(bars.map((bar) => bar.title.split(" · ")[1].slice(0, 10))).size);
	await groupBy.selectOption({ label: "Daily average (UTC)" });
	assert.equal(await builds.locator(".bes-chart-row").count(), days);
	if (days === 1) {
		const stack = builds.locator(".bes-chart-track");
		assert.equal(await stack.locator(".bes-chart-segment").count(), 2);
		assert.equal(await stack.locator(".color-fg-success").count(), 1);
		assert.equal(await stack.locator(".color-fg-danger").count(), 1);
		const totalWidth = await stack.locator(".bes-chart-segment").evaluateAll((segments) =>
			segments.reduce((sum, segment) => sum + parseFloat(segment.style.width), 0));
		assert.ok(totalWidth > 0 && totalWidth <= 100.001);
	}
	await groupBy.selectOption({ label: "Per build" });
	await successFilter.uncheck();
	assert.equal(await metricBars.count(), 1);
	assert.match(await metricBars.getAttribute("title"), new RegExp(failedRun.id));
	await failureFilter.uncheck();
	await builds.getByText("No completed builds match the selected statuses.", { exact: true }).waitFor();
	await backendForm.getByLabel("Group", { exact: true }).fill("saved");
	await connectGroup.click();
	await backendStatus.getByText(/Watching group saved/).waitFor();
	assert.equal(await backendStatus.locator("code").innerText(), "--build_metadata=igroup=saved");
	const savedGroupPath = new URL(page.url()).pathname;
	await page.getByLabel("Choose a binary build event file").setInputFiles(binaryEvents);
	await page.getByText(/events\.bep ·/).waitFor();
	assert.equal(new URL(page.url()).pathname, savedGroupPath);
	await backendStatus.getByText(/Watching group saved/).waitFor();
	await page.getByRole("region", { name: "Upload", exact: true }).getByRole("link", { name: "Uploads", exact: true }).click();
	await page.getByRole("table", { name: "Uploaded invocations" }).getByRole("button", { name: id, exact: true }).waitFor();
	assert.deepEqual(errors, []);
});
