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
	const metricWindows = [];
	let pageSize;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, "http://127.0.0.1:" + port);
		if (url.pathname.endsWith("/metrics")) metricWindows.push(url.searchParams.get("window_days"));
		if (pageSize && url.pathname === "/api/invocations") url.searchParams.set("page_size", pageSize);
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
		metricWindows,
		limitPages(size) { pageSize = size; },
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
	await page.getByRole("form", {name: "Backend"}).getByText("Connected", {exact: true}).waitFor({timeout: 30000});
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
		await page.getByText(/Watching invocation|Following .* events/).waitFor({ state: "attached" });
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

	await page.getByRole("navigation", { name: "Build event views" }).getByRole("link", { name: "Group", exact: true }).click();
	await page.getByRole("table", { name: "Invocation runs" }).getByRole("button", { name: id }).waitFor();
	await page.getByRole("button", { name: id, exact: true }).click();

	const filePage = await browser.newPage();
	filePage.on("pageerror", (error) => errors.push(error.message));
	await filePage.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
	await filePage.goto(site + "/tools/invocations");
	const macShortcuts = filePage.getByRole("region", { name: "Keyboard Shortcuts" });
	assert.equal(await macShortcuts.locator("kbd", { hasText: /^Option$/ }).count(), 6);
	assert.equal(await filePage.getByRole("link", { name: "build event stream backend", exact: true }).getAttribute("href"),
		"https://github.com/bazel-contrib/bcr-frontend");
	await filePage.getByText("Upload a build events file or connect to a build event stream backend.", { exact: true }).waitFor();
	const fileInput = filePage.getByLabel("Choose a binary build event file");
	const uploadTab = filePage.getByRole("navigation", {name: "Build event views"}).getByRole("link", {name: "Upload", exact: true});
	await uploadTab.click();
	await filePage.getByRole("button", {name: "Choose File", exact: true}).waitFor();
	await fileInput.setInputFiles(binaryEvents);
	await filePage.getByRole("heading", { name: id, exact: true }).waitFor();
	await filePage.locator(".bes-invocation-state").getByText("SUCCESS", { exact: true }).waitFor();
	assert.equal(await filePage.getByLabel("Build elapsed time").getAttribute("datetime"), await buildElapsed.getAttribute("datetime"));
	await filePage.getByText(/events\.bep ·/).waitFor();
	await filePage.getByRole("region", { name: "Build statistics" }).getByRole("article", { name: "Actions" }).waitFor();
	await filePage.getByRole("region", { name: "Build frontier" }).waitFor();
	// A length-delimited BuildEvent with an empty Progress payload and no start or finish.
	await filePage.getByRole("region", { name: "Upload build events", exact: true }).evaluate((target) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([new Uint8Array([2, 26, 0])], "partial.bep"));
		target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
		target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
	});
	await filePage.getByRole("heading", { name: /^file-[0-9a-f]{16}$/ }).waitFor();
	await filePage.locator(".bes-invocation-state").getByText("Incomplete", { exact: true }).waitFor();
	assert.equal(await filePage.getByLabel("Build elapsed time").innerText(), "—");
	assert.equal(new URL(filePage.url()).pathname, "/tools/invocations/-/upload");
	assert.equal(await filePage.getByRole("heading", {name: id, exact: true}).count(), 0);
	await fileInput.setInputFiles(binaryEvents);
	await filePage.getByRole("heading", {name: id, exact: true}).waitFor();
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
	const backendStatus = backendForm;
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
	const viewNav = page.getByRole("navigation", { name: "Build event views" });
	const sidebar = page.locator(".bes-events-sidebar");
	const groupView = (name) => viewNav.getByRole("link", { name, exact: true });
	await backendStatus.getByText("Disconnected", { exact: true }).waitFor();
	assert.ok((await page.getByRole("region", { name: "Groups", exact: true }).boundingBox()).x >
		(await sidebar.boundingBox()).x);
	for (const name of ["Invocation", "Group", "Tests"]) {
		await groupView(name).click();
		await page.getByRole("region", { name, exact: true }).getByText(/Connect to a backend and choose a group/).first().waitFor();
		assert.equal(await groupView(name).getAttribute("aria-current"), "location");
	}
	await page.keyboard.press("Alt+Shift+Digit5");
	const usage = page.getByRole("region", { name: "Usage", exact: true });
	await usage.getByRole("figure", { name: "Build event flow from Bazel to the viewer" }).waitFor();
	for (const snippet of [
		"bazel build //cmd/besserver",
		"bazel build -c opt //tools/invocation-iroh",
		"--backend-port 1974 --key-file ./iroh.key",
		"--build_metadata=igroup=release",
	]) {
		await usage.locator("pre:visible").filter({ hasText: snippet }).waitFor();
	}
	assert.match(await usage.innerText(), /bcr-iroh-v1:eyJlbmRwb2ludCI6…/);
	assert.match(await usage.innerText(), /Paste the full ticket into Backend URL or iroh ticket in the Backend form/);
	assert.match(await usage.innerText(), /Reuse the same key file across restarts to keep a stable Iroh address/);
	assert.equal(await usage.locator("details[open]").count(), 0);
	await usage.locator("summary").click();
	await usage.locator("pre").filter({ hasText: "bazel run //app/bcr:release" }).waitFor();
	await groupView("Invocation").click();
	await backendForm.getByLabel("Backend URL or iroh ticket").fill("ftp://localhost");
	await backendForm.getByRole("button", { name: "Connect" }).click();
	await backendStatus.getByText("Connection failed", { exact: true }).waitFor();
	await backendStatus.getByText(/Enter an HTTP or HTTPS backend URL/).waitFor();
	await backendForm.getByLabel("Backend URL or iroh ticket").fill(groupTicket);
	await backendForm.getByRole("button", { name: "Connect" }).click();
	await page.getByRole("button", { name: "saved", exact: true }).waitFor();
	await backendForm.getByLabel("Group", { exact: true }).fill("release");
	await page.getByRole("button", { name: "Connect" }).click();
	await backendStatus.getByText("Connected", { exact: true }).waitFor();
	await backendStatus.getByText("Watching group release", {exact: true}).waitFor();
	await backendStatus.getByText("Set --build_metadata=igroup=release on a build to add it to the release group.", {exact: true}).waitFor();
	assert.equal(await backendStatus.getByRole("status").locator("..").getByRole("button", {name: "Connect"}).count(), 1);
	assert.equal(await backendStatus.locator("strong.text-mono").innerText(), "release");
	assert.equal(await backendStatus.locator("code").innerText(), "--build_metadata=igroup=release");
	await groupView("Invocation").click();
	await page.getByText("release · Waiting for the next build", { exact: true }).waitFor();
	const runsTab = groupView("Group");
	const currentTab = groupView("Invocation");
	const lastTab = currentTab;
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
		assert.equal(new URL(page.url()).pathname, "/tools/invocations/release/" + firstRun.id + "/current");
		assert.equal(new URL(page.url()).searchParams.get("follow"), "auto");
		const activeFrontier = page.getByRole("region", { name: "Build frontier" });
		const inspectWaitingEvent = async () => {
			await activeFrontier.getByText(/^[1-9]\d* expected · /).waitFor();
			const canvas = await activeFrontier.locator("canvas").elementHandle();
			await page.waitForFunction((canvas) => {
				const timer = document.querySelector('time[aria-label="Time waiting for event"]:not([hidden])');
				if (timer && Number(timer.getAttribute("datetime")?.slice(2, -1)) >= 2) return true;
				// A new event can replace the selected node while the build is running.
				canvas.dispatchEvent(new KeyboardEvent("keydown", {key: "Home", bubbles: true, cancelable: true}));
				return false;
			}, canvas, {polling: 200});
		};
		await inspectWaitingEvent();
		await page.reload();
		await invocationHeading(firstRun.id).waitFor();
		await buildStatus.getByText("Building", { exact: true }).waitFor();
		await inspectWaitingEvent();
		nextRun = startGroupedBuild();
		await runsTab.click();
		await runs.locator("summary").click();
		await runs.getByRole("checkbox", {name: "Running", exact: true}).check();
		const runningRow = runs.getByRole("row", { name: new RegExp(nextRun.id) });
		await runningRow.getByRole("img", { name: "Running", exact: true }).waitFor();
		await runningRow.locator(".color-fg-attention .bes-invocation-spinner").waitFor();
		await runningRow.getByText("bazel build //:hello", { exact: true }).waitFor();
		assert.equal(await runningRow.locator("time").innerText(), "just now");
		assert.match(await runningRow.locator("time").getAttribute("title"), /^Started /);
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
	assert.match(await savedRow.locator("time").getAttribute("title"), /^Finished /);
	assert.equal(await savedRow.locator("time").evaluate((time) => getComputedStyle(time).whiteSpace), "nowrap");
	await savedRow.getByRole("button", { name: firstRun.id }).press("Enter");
	await invocationHeading(firstRun.id).waitFor();
	const selected = new URL(page.url());
	assert.equal(selected.pathname, "/tools/invocations/release/" + firstRun.id + "/current");
	assert.equal(selected.searchParams.has("group"), false);
	assert.equal(selected.searchParams.has("invocation"), false);
	assert.equal(selected.searchParams.get("follow"), "manual");
	assert.equal(await followBuilds.isChecked(), false);
	assert.ok(!Array.from(selected.searchParams.values()).includes(groupTicket));
	await page.goto(firstRunUrl);
	await invocationHeading(firstRun.id).waitFor();
	assert.equal(await followBuilds.isChecked(), false);
	for (const [view, link] of [["group", runsTab], ["groups", groupView("Groups")], ["tests", groupView("Tests")], ["current", lastTab]]) {
		await link.click();
		assert.equal(new URL(page.url()).pathname, selected.pathname.replace(/current$/, view));
		await page.reload();
		await page.waitForFunction((view) => {
			const panel = document.getElementById("igroup-panel-" + view);
			return panel && !panel.hidden;
		}, view);
		assert.equal(await link.getAttribute("aria-current"), "location");
		assert.equal(new URL(page.url()).searchParams.get("follow"), "manual");
		if (view === "current") await invocationHeading(firstRun.id).waitFor();
	}
	await followBuilds.check();
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
	await groupView("Group").click();
	const builds = page.getByRole("region", { name: "Group", exact: true });
	await runs.getByLabel("Time", { exact: true }).selectOption("7");
	await builds.getByText("Average build time", { exact: true }).waitFor();
	assert.equal(api.metricWindows.at(-1), "7");
	const invocationCount = builds.locator("dl > div").filter({ has: page.getByText("Invocations", { exact: true }) });
	assert.equal(await invocationCount.locator("dd").innerText(), "3");
	await runs.locator("summary").click();
	const successFilter = builds.getByRole("checkbox", { name: "SUCCESS", exact: true });
	assert.ok(await successFilter.isChecked());
	assert.equal(await builds.getByLabel("Metric", { exact: true }).inputValue(), "0");
	const metricValues = runs.locator(".bes-group-run-value");
	await metricValues.nth(2).waitFor();
	assert.equal(await metricValues.count(), 3);
	const groupBy = builds.getByLabel("Group by", { exact: true });
	await groupBy.selectOption("86400000");
	assert.ok(await runs.locator(".bes-group-bin").first().isVisible());
	assert.equal(await metricValues.count(), 3);
	await groupBy.selectOption("0");
	await runs.getByRole("button", {name: shortRun.id, exact: true}).press("Enter");
	await invocationHeading(shortRun.id).waitFor();
	assert.equal(new URL(page.url()).pathname, "/tools/invocations/release/" + shortRun.id + "/current");
	assert.equal(new URL(page.url()).searchParams.get("follow"), "manual");
	await followBuilds.check();
	await groupView("Group").click();
	assert.equal(await builds.getByText("Action cache hit rate", {exact: true}).count(), 0);
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
	const terminalPanel = page.getByRole("tabpanel", { name: "Terminal" });
	assert.match(await terminalPanel.innerText(), /missing test symbol/);
	const terminalSearch = terminalPanel.getByRole("searchbox", { name: "Search terminal" });
	await terminalSearch.pressSequentially("FIXTURE.C:7");
	await terminalPanel.getByRole("status").getByText(/^1 of \d+$/).waitFor();
	assert.equal(await page.evaluate(() => [...CSS.highlights.get("bes-terminal-match")][0].toString()), "fixture.c:7");
	assert.equal(await terminalSearch.evaluate((input) => document.activeElement === input), true);
	await terminalSearch.press("Shift+Enter");
	const lastMatch = await terminalPanel.getByRole("status").innerText();
	assert.match(lastMatch, /^(\d+) of \1$/);
	await terminalSearch.press("Enter");
	await terminalPanel.getByRole("status").getByText(/^1 of \d+$/).waitFor();
	await terminalSearch.fill("missing-needle-for-terminal-search");
	await terminalPanel.getByRole("status").getByText("No matches").waitFor();
	await terminalSearch.fill("");
	assert.equal(await page.evaluate(() => CSS.highlights.has("bes-terminal-match")), false);
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
	await page.getByText("Select a run from the Group tab.", { exact: true }).waitFor();
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
	await groupView("Group").click();
	await runs.locator("summary").click();
	const failureFilter = builds.getByRole("checkbox", { name: "BUILD_FAILURE", exact: true });
	await failureFilter.waitFor();
	assert.equal(await failureFilter.isChecked(), false);
	await failureFilter.check();
	const failedRow = runs.getByRole("row", {name: new RegExp(failedRun.id)});
	await failedRow.getByRole("img", {name: "BUILD_FAILURE", exact: true}).waitFor();
	await successFilter.uncheck();
	assert.equal(await runs.locator(".bes-group-run").count(), 1);
	await failureFilter.uncheck();
	await builds.getByText("No loaded invocations match these filters.", { exact: true }).waitFor();
	await successFilter.check();
	await failureFilter.check();
	await backendForm.getByLabel("Group", { exact: true }).fill("saved");
	await connectGroup.click();
	await backendStatus.getByText(/Watching group saved/).waitFor();
	assert.equal(await backendStatus.locator("code").innerText(), "--build_metadata=igroup=saved");
	const savedRunPath = "/tools/invocations/saved/" + id;
	await page.waitForURL((url) => url.pathname === savedRunPath + "/group");
	await groupView("Upload").click();
	await page.getByLabel("Choose a binary build event file").setInputFiles(binaryEvents);
	await page.getByText(/events\.bep ·/).waitFor();
	assert.equal(new URL(page.url()).pathname, savedRunPath + "/upload");
	await backendStatus.getByText(/Watching group saved/).waitFor();
	await page.getByRole("region", {name: "Upload", exact: true}).getByRole("heading", {name: id, exact: true}).waitFor();
	api.limitPages(2);
	await backendForm.getByLabel("Group", { exact: true }).fill("release");
	await connectGroup.click();
	await backendStatus.getByText(/Watching group release/).waitFor();
	await runsTab.click();
	const older = page.getByRole("button", { name: "Load older runs" });
	await older.waitFor();
	assert.equal(await runs.locator("tbody tr").count(), 2);
	await older.click();
	await page.getByText("All runs loaded.", { exact: true }).waitFor();
	assert.equal(await runs.locator("tbody tr").count(), 4);
	await runs.getByRole("button", { name: firstRun.id, exact: true }).waitFor();

	assert.deepEqual(errors, []);
});

test("group Follow picks up the next invocation across views", async (t) => {
	const web = launch(t, command("RELEASESERVER"), [
		"--host=127.0.0.1", "--port=0", command("FRONTEND_ARCHIVE"),
	]);
	const site = await web.ready(/Starting server on (http:\/\/[^\s]+)/);
	const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
	t.after(() => browser.close());
	const page = await browser.newPage();
	page.setDefaultTimeout(8000);
	const backend = "http://localhost:1974";
	const cors = {"Access-Control-Allow-Origin": "*"};
	const group = "release";
	const groupPath = "/tools/invocations/" + group;
	const running = "INVOCATION_STATE_IN_PROGRESS";
	const complete = "INVOCATION_STATE_COMPLETE";
	const run = (invocationId, state) => ({
		invocationId, invocationGroup: group, state, command: "build",
		targetPatterns: ["//:" + invocationId],
		startedAt: new Date().toISOString(),
		result: state === complete ? {exitCodeName: "SUCCESS", exitCode: 0} : undefined,
	});
	const first = run("first", running);
	const fast = run("fast", complete);
	fast.targetPatterns.push("//:" + "long_target_".repeat(20));
	const next = run("next", running);
	const latest = run("latest", running);
	const older = run("older", complete);
	older.startedAt = new Date(Date.now() - 10 * 86400000).toISOString();
	let invocations = [first];
	let activeInvocation = first;

	await page.addInitScript(({backend, group}) => {
		sessionStorage.setItem("bcr.viewer.backend.group." + group, backend);
	}, {backend, group});
	await page.route(backend + "/api/**", (route) => {
		const {pathname} = new URL(route.request().url());
		if (pathname.endsWith("/events"))
			return route.fulfill({headers: cors, contentType: "text/event-stream", body: ": connected\n\n"});
		if (pathname === "/api/invocations")
			return route.fulfill({headers: cors, json: {invocations, activeInvocation}});
		if (pathname === "/api/invocation-groups")
			return route.fulfill({headers: cors, json: {groups: [
				{name: group, invocationCount: "12", latestInvocationAt: first.startedAt},
				{name: "archive", invocationCount: "0"},
			]}});
		if (pathname.endsWith("/metrics"))
			return route.fulfill({headers: cors, json: {
				invocationCount: invocations.length,
				cache: {actionCacheHits: 3, actionCacheMisses: 1, actionCacheInvocationCount: 1},
				builds: invocations.map((build) => ({invocationId: build.invocationId, durationMs: 2000, cpuMs: 1000})),
			}});
		const invocation = invocations.find(({invocationId}) => pathname.endsWith("/" + invocationId));
		return route.fulfill({headers: cors, json: invocation || {}});
	});

	await page.goto(site + "/tools/invocations");
	const viewNav = page.getByRole("navigation", {name: "Build event views"});
	assert.equal(await page.locator(".bes-events-sidebar").getByRole("navigation").count(), 0);
	assert.deepEqual(await viewNav.getByRole("link").allTextContents(), ["Invocation", "Group", "Groups", "Tests", "Upload", "Usage"]);
	await viewNav.getByRole("link", {name: "Invocation", exact: true}).click();
	await page.getByRole("region", {name: "Invocation", exact: true}).waitFor();
	await viewNav.getByRole("link", {name: "Groups", exact: true}).click();
	await page.getByRole("button", {name: "Connect", exact: true}).click();
	const catalog = page.getByRole("table", {name: "Available invocation groups"});
	await catalog.getByRole("button", {name: group, exact: true}).waitFor();
	assert.deepEqual(await catalog.getByRole("button").allTextContents(), [group, "archive"]);
	const newestGroupRow = catalog.locator("tbody tr").first();
	assert.equal(await newestGroupRow.getByRole("cell").nth(1).innerText(), "12");
	assert.equal(await newestGroupRow.locator("time").getAttribute("datetime"), first.startedAt);
	assert.ok(await newestGroupRow.locator("time").getAttribute("title"));
	assert.equal(await catalog.locator("tbody tr").last().getByRole("cell").nth(1).innerText(), "0");
	await catalog.getByRole("button", {name: group, exact: true}).click();
	await page.waitForURL((url) => url.pathname === groupPath + "/first/group");
	const backendForm = page.getByRole("form", {name: "Backend"});
	const connected = backendForm.getByRole("status").getByText("Connected", {exact: true});
	assert.equal(await connected.locator("xpath=..").getByRole("button", {name: "Connect"}).count(), 1);
	const details = backendForm.locator(".bes-backend-detail > div");
	assert.deepEqual(await details.allTextContents(), [
		"Watching group release",
		"Set --build_metadata=igroup=release on a build to add it to the release group.",
	]);
	await page.goto(site + groupPath + "/first/current?follow=auto");
	await page.getByText(/Watching group release/).waitFor();
	const goToView = (view) => page.locator("#igroup-nav-" + view).click();
	const waitForRun = (id, view) => page.waitForURL((url) => url.pathname === groupPath + "/" + id + "/" + view);
	await goToView("group");
	await waitForRun("first", "group");
	invocations = [fast, first];
	await page.getByRole("button", {name: "fast", exact: true}).waitFor();
	await waitForRun("first", "group");

	first.state = complete;
	activeInvocation = undefined;
	await waitForRun("fast", "group");
	assert.equal(await page.locator("#igroup-nav-group").getAttribute("aria-current"), "location");

	await goToView("tests");
	await waitForRun("fast", "tests");
	invocations = [next, fast, first];
	activeInvocation = next;
	await waitForRun("next", "tests");

	await goToView("current");
	await waitForRun("next", "current");
	next.state = complete;
	invocations = [latest, next, fast, first];
	activeInvocation = latest;
	await waitForRun("latest", "current");
	assert.equal(new URL(page.url()).searchParams.get("follow"), "auto");

	invocations = [latest, fast, older];
	await goToView("group");
	const table = page.getByRole("table", {name: "Invocation runs"});
	const row = (id) => table.locator("tr[data-invocation-id=" + id + "]");
	await row("older").waitFor();
	const metricCell = row("fast").getByRole("cell").last();
	await metricCell.getByText("2 s", {exact: true}).waitFor();
	assert.equal(await metricCell.locator("[title]").getAttribute("title"), "Build time: 2 s");
	assert.ok((await row("fast").boundingBox()).height <= 24);
	const commandText = row("fast").getByText(/^bazel build/);
	assert.ok(await commandText.evaluate((element) => element.scrollWidth > element.clientWidth));
	assert.match(await commandText.getAttribute("title"), /long_target_/);
	const statusHeading = table.getByRole("columnheader", {name: "Status", exact: true});
	assert.ok((await statusHeading.boundingBox()).width < 96);
	assert.match(await row("fast").evaluate((element) => getComputedStyle(element).backgroundImage), /linear-gradient/);
	assert.match(await row("fast").evaluate((element) => getComputedStyle(element).backgroundSize), /calc\(100% - 4px\)/);
	await table.getByLabel("Invocation", {exact: true}).fill("fa");
	await row("older").waitFor({state: "hidden"});
	await table.getByLabel("Invocation", {exact: true}).fill("");
	const commandFilter = table.getByLabel("Command", {exact: true});
	assert.ok(await page.locator("#igroup-command-options option[value='bazel build //:older']").count());
	await commandFilter.fill("//:older");
	await row("fast").waitFor({state: "hidden"});
	await commandFilter.fill("");
	await table.getByLabel("Time", {exact: true}).selectOption("7");
	await row("older").waitFor({state: "hidden"});
	const metricFilter = page.getByLabel("Metric", {exact: true});
	const groupByFilter = page.getByLabel("Group by", {exact: true});
	for (const filter of [metricFilter, groupByFilter])
		assert.equal(await filter.evaluate((element) => getComputedStyle(element.parentElement).columnGap), "8px");
	await metricFilter.selectOption({label: "CPU time"});
	await table.getByRole("columnheader", {name: "CPU time", exact: true}).waitFor();
	await row("fast").getByText("1 s", {exact: true}).waitFor();
	await groupByFilter.selectOption({label: "Day (UTC)"});
	await table.getByText("Average 1 s", {exact: true}).waitFor();
	await table.getByText("Status", {exact: true}).click();
	await table.getByRole("checkbox", {name: "Running", exact: true}).check();
	await row("latest").waitFor();
	await table.getByRole("checkbox", {name: "SUCCESS", exact: true}).uncheck();
	await row("fast").waitFor({state: "hidden"});

	const groupView = page.getByRole("region", {name: "Group", exact: true});
	const cacheRate = groupView.locator("dl > div").filter({
		has: page.getByText("Action cache hit rate", {exact: true}),
	});
	await cacheRate.getByText("75.0%", {exact: true}).waitFor();
	assert.equal(await table.getByLabel("Time", {exact: true}).inputValue(), "7");

	await goToView("upload");
	const upload = page.getByRole("region", {name: "Upload", exact: true});
	const chooser = upload.getByRole("button", {name: "Choose File", exact: true});
	const [fileChooser] = await Promise.all([page.waitForEvent("filechooser"), chooser.click()]);
	await fileChooser.setFiles({name: "first.bep", mimeType: "application/octet-stream", buffer: Buffer.from([2, 26, 0])});
	await upload.getByText("Loaded first.bep.", {exact: true}).waitFor();
	const replay = upload.getByRole("heading", {name: /^file-/});
	const firstFileId = await replay.innerText();
	const dropTarget = upload.getByRole("region", {name: "Upload build events"});
	await dropTarget.evaluate((target) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([new Uint8Array([2, 26, 0])], "second.bep"));
		target.dispatchEvent(new DragEvent("dragenter", {bubbles: true, cancelable: true, dataTransfer}));
		target.dispatchEvent(new DragEvent("drop", {bubbles: true, cancelable: true, dataTransfer}));
	});
	await upload.getByText("Loaded second.bep.", {exact: true}).waitFor();
	assert.notEqual(await replay.innerText(), firstFileId);
	assert.equal(await replay.count(), 1);
	await goToView("current");
	await waitForRun("latest", "current");
	assert.equal(await page.getByRole("region", {name: "Invocation", exact: true}).getByRole("heading", {name: "latest", exact: true}).count(), 1);
	await page.goto(site + groupPath + "/latest/cache?follow=auto");
	await waitForRun("latest", "group");
	await cacheRate.getByText("75.0%", {exact: true}).waitFor();
});

test("test attempt details keep large output lists collapsed", async (t) => {
	const web = launch(t, command("RELEASESERVER"), [
		"--host=127.0.0.1", "--port=0", command("FRONTEND_ARCHIVE"),
	]);
	const site = await web.ready(/Starting server on (http:\/\/[^\s]+)/);
	const browser = await chromium.launch(process.env.CHROME_BIN ? {executablePath: process.env.CHROME_BIN} : {});
	t.after(() => browser.close());
	const page = await browser.newPage();
	page.setDefaultTimeout(8000);

	function varint(value) {
		const bytes = [];
		while (value >= 128) {
			bytes.push((value & 127) | 128);
			value >>>= 7;
		}
		return Buffer.from([...bytes, value]);
	}
	function bytesField(field, data) {
		const bytes = Buffer.from(data);
		return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
	}
	const fileCount = 64;
	const uri = "bytestream://cache.example/blobs/" + "a".repeat(64) + "/10";
	const status = "Assertion failed. " + "Additional test context. ".repeat(20).trim();
	const outputs = Array.from({length: fileCount}, (_, index) =>
		bytesField(2, Buffer.concat([bytesField(1, `output-${index}.log`), bytesField(2, uri)])),
	);
	// Length-delimited BuildEvent with a TestResultId and TestResult payload.
	const attempt = bytesField(8, Buffer.concat([bytesField(1, "//:large_outputs"), Buffer.from([16, 1, 32, 1])]));
	const result = Buffer.concat([Buffer.from([40, 4]), bytesField(9, status), ...outputs]);
	const event = Buffer.concat([bytesField(1, attempt), bytesField(10, result)]);
	const buffer = Buffer.concat([varint(event.length), event]);

	await page.goto(site + "/tools/invocations/-/upload");
	await page.getByLabel("Choose a binary build event file").setInputFiles({
		name: "test-outputs.bep", mimeType: "application/octet-stream", buffer,
	});
	await page.getByRole("tab", {name: "Tests", exact: true}).click();
	await page.getByText("//:large_outputs", {exact: true}).click();
	const details = page.getByRole("tabpanel", {name: "Tests"}).getByRole("cell").last();
	const preview = details.getByText(status, {exact: true});
	assert.equal(await preview.getAttribute("title"), status);
	assert.ok(await preview.evaluate((element) => element.scrollWidth > element.clientWidth));
	assert.equal(await details.getByRole("listitem", {includeHidden: true}).count(), 0);
	await details.getByText("64 output files", {exact: true}).click();
	const list = details.getByRole("list");
	await list.getByText("output-0.log", {exact: true}).waitFor();
	assert.equal(await list.getByRole("listitem").count(), fileCount);
	assert.ok((await list.getByText("output-0.log", {exact: true}).getAttribute("title")).includes(uri));
	assert.equal((await list.innerText()).includes(uri), false);
	assert.ok(await list.evaluate((element) => element.scrollHeight > element.clientHeight));
});
