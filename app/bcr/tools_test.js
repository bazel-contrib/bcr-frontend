goog.module("bcrfrontend.toolsTest");
goog.setTestOnly();

const Aborted = goog.require("proto.build_event_stream.Aborted");
const ActionExecuted = goog.require("proto.build_event_stream.ActionExecuted");
const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildEventId = goog.require("proto.build_event_stream.BuildEventId");
const BuildFinished = goog.require("proto.build_event_stream.BuildFinished");
const BuildMetrics = goog.require("proto.build_event_stream.BuildMetrics");
const FailureDetail = goog.require("proto.failure_details.FailureDetail");
const NamedSetOfFiles = goog.require("proto.build_event_stream.NamedSetOfFiles");
const Progress = goog.require("proto.build_event_stream.Progress");
const testSuite = goog.require("goog.testing.testSuite");
const { FrontierMark, InvocationProgress, decodeDelimitedMessages, invocationFailure } = goog.require("bcrfrontend.invocationEvents");
const { InvocationTerminal, formatTerminalText, renderTerminalText } = goog.require("bcrfrontend.invocationTerminal");
const { createBuildStatCards, parseCriticalPath } = goog.require("bcrfrontend.invocationMetrics");
const { expectedFrontierLabel, frontierFlightFrames, frontierWait, layoutFrontier } = goog.require("bcrfrontend.invocationFrontier");
goog.require("bcrfrontend.tools");
goog.require("goog.testing.jsunit");

/**
 * @param {string} output
 * @return {!BuildEventId}
 */
function actionId(output) {
	const action = new BuildEventId.ActionCompletedId();
	action.setLabel("//:lib");
	action.setPrimaryOutput(output);
	const id = new BuildEventId();
	id.setActionCompleted(action);
	return id;
}

/**
 * @param {number} index
 * @param {!Array<!BuildEventId>} children
 * @return {!BuildEvent}
 */
function progressEvent(index, children) {
	const progressId = new BuildEventId.ProgressId();
	progressId.setOpaqueCount(index);
	const id = new BuildEventId();
	id.setProgress(progressId);
	const event = new BuildEvent();
	event.setId(id);
	event.setChildrenList(children);
	return event;
}

/**
 * @param {number} code
 * @param {string} message
 * @return {!BuildEvent}
 */
function finishedEvent(code, message) {
	const detail = new FailureDetail();
	detail.setMessage(message);
	const exit = new BuildFinished.ExitCode();
	exit.setCode(code);
	const finished = new BuildFinished();
	finished.setExitCode(exit);
	finished.setFailureDetail(detail);
	const id = new BuildEventId();
	id.setBuildFinished(new BuildEventId.BuildFinishedId());
	const event = new BuildEvent();
	event.setId(id);
	event.setFinished(finished);
	return event;
}

testSuite({
	testFrontierFlightsSpreadEightActionsFromTheSameOrigin() {
		const origin = {x: 360, y: 70};
		const target = {x: 14, y: 250};
		/** @type {!Set<string>} */
		const midpoints = new Set();
		for (let lane = 0; lane < 8; lane++) {
			const frames = frontierFlightFrames(origin, target, lane);
			const transforms = frames.map((frame) => /** @type {{transform: string}} */ (frame).transform);
			assertEquals("translate(360px,70px)", transforms[0]);
			assertEquals("translate(14px,250px)", transforms[transforms.length - 1]);
			midpoints.add(transforms[7]);
		}
		assertEquals(8, midpoints.size);
	},

	testBuildStatCardsUseGraphTotalsAndSummarizeReportedMetrics() {
		const metrics = new BuildMetrics();
		assertFalse(createBuildStatCards(metrics).hasChildNodes());
		const actions = new BuildMetrics.ActionSummary();
		actions.setActionsExecuted(9);
		actions.setActionsCreated(30);
		metrics.setActionSummary(actions);
		const graph = new BuildMetrics.BuildGraphMetrics();
		graph.setActionCount(17);
		metrics.setBuildGraphMetrics(graph);
		const timing = new BuildMetrics.TimingMetrics();
		timing.setWallTimeInMs(4000);
		timing.setCpuTimeInMs(8000);
		timing.setExecutionPhaseTimeInMs(2000);
		metrics.setTimingMetrics(timing);
		const artifacts = new BuildMetrics.ArtifactMetrics();
		const output = new BuildMetrics.ArtifactMetrics.FilesMetric();
		output.setCount(12);
		output.setSizeInBytes(2048);
		artifacts.setOutputArtifactsSeen(output);
		metrics.setArtifactMetrics(artifacts);
		const cache = new BuildMetrics.RemoteAnalysisCacheStatistics();
		cache.setCacheHits(4);
		cache.setCacheMisses(1);
		metrics.setRemoteAnalysisCacheStatistics(cache);
		/** @type {!Array<number>} */
		const counts = [3, 5, 1, 16];
		metrics.setWorkerMetricsList(counts.map((count, index) => {
			const worker = new BuildMetrics.WorkerMetrics();
			worker.setMnemonic("Scalac");
			worker.setActionsExecuted(count);
			worker.setWorkerIdsList(index === 0 ? [1, 2] : [index + 2]);
			return worker;
		}));
		const cards = createBuildStatCards(metrics);
		assertArrayEquals(["9", "17"], Array.from(cards.querySelectorAll('[aria-label="Actions"] dd'), (value) => value.textContent));
		assertEquals("12 · 2.0 KiB", cards.querySelector('[aria-label="Artifacts"] dd')?.textContent);
		assertEquals("80.0%", cards.querySelector('[aria-label="Remote analysis cache"] dd')?.textContent);
		assertEquals("50%", cards.querySelector(".bes-build-timing-wall")?.getAttribute("style")?.match(/50%/)?.[0]);
		const workers = cards.querySelectorAll('[aria-label="Scalac workers"] li');
		assertArrayEquals(["3", "5", "1", "16"], Array.from(workers, (worker) => worker.textContent));
		assertEquals("Workers 1, 2 · 3 executed", workers[0].getAttribute("title"));
	},

	testFrontierDeduplicatesAnnouncementsAndResolvesAbortedEvents() {
		const frontier = new InvocationProgress();
		frontier.add(progressEvent(1, [actionId("one.o"), actionId("two.o")]));
		/** @type {!FrontierMark} */
		const first = frontier.history[0].children[0];
		const actionOutline = first.color;
		frontier.add(progressEvent(2, [actionId("one.o"), actionId("one.o")]));
		assertEquals(2, frontier.pending.size);
		assertEquals(2, first.parents.length);

		const action = new BuildEvent();
		const executed = new ActionExecuted();
		executed.setType("CppLink");
		executed.setSuccess(true);
		action.setAction(executed);
		action.setId(actionId("one.o"));
		frontier.add(action);
		assertEquals(1, frontier.pending.size);
		assertEquals(first, frontier.history[2]);
		assertNotEquals(actionOutline, first.color);
		assertEquals("#f7ba13", first.color);

		const aborted = new BuildEvent();
		aborted.setAborted(new Aborted());
		aborted.setId(actionId("two.o"));
		frontier.add(aborted);
		assertEquals(0, frontier.pending.size);
		assertEquals(aborted, frontier.history[3].event);
	},

	testFrontierKeepsTheTerminalEventAndAcceptsLateParents() {
		const frontier = new InvocationProgress();
		const finished = new BuildEvent();
		finished.setFinished(new BuildFinished());
		const finishId = new BuildEventId();
		finishId.setBuildFinished(new BuildEventId.BuildFinishedId());
		finished.setId(finishId);
		frontier.add(finished);
		assertEquals(finished, frontier.finished);
		assertNull(frontier.last);

		const terminal = progressEvent(2, [finishId]);
		terminal.setLastMessage(true);
		frontier.add(terminal);
		frontier.add(progressEvent(1, [finishId]));
		assertEquals(0, frontier.pending.size);
		assertNotNull(frontier.last);
		assertEquals(terminal, frontier.last && frontier.last.event);
		assertEquals(2, frontier.history[0].parents.length);
	},

	testFrontierExcisesCompletedActionsAndReconnectsTheirDependencies() {
		const progress = new InvocationProgress();
		const childId = actionId("shared.o");
		const left = progressEvent(2, [childId]);
		const right = progressEvent(3, [childId]);
		left.setProgress(new Progress());
		right.setProgress(new Progress());
		progress.add(progressEvent(1, [
			/** @type {!BuildEventId} */ (left.getId()),
			/** @type {!BuildEventId} */ (right.getId()),
		]));
		progress.add(left);
		progress.add(right);
		const before = layoutFrontier(progress);
		const expected = /** @type {!FrontierMark} */ (before.columns[0][0]);
		assertEquals(1, before.columns[0].length);
		assertEquals(0, before.cells.get(expected)?.column);
		assertEquals(0, progress.receivedActions);
		assertEquals(2, expected.parents.length);

		const action = new BuildEvent();
		const executed = new ActionExecuted();
		executed.setType("CppCompile");
		executed.setSuccess(true);
		action.setAction(executed);
		action.setId(childId);
		const next = progressEvent(4, []);
		action.setChildrenList([/** @type {!BuildEventId} */ (next.getId())]);
		progress.add(action);
		progress.add(action);
		const after = layoutFrontier(progress, 3);
		assertFalse(after.cells.has(expected));
		assertTrue(after.departures.has(expected));
		assertFalse(after.cells.has(progress.history[1]));
		assertFalse(after.cells.has(progress.history[2]));
		assertEquals(1, after.cells.get(progress.history[0])?.column);
		assertArrayEquals([progress.history[0]], after.parents.get(/** @type {!FrontierMark} */ (after.columns[0][0])));
		assertEquals(1, progress.receivedActions);
		assertEquals(1, progress.mnemonics.get("CppCompile")?.count);
		assertEquals(expected.color, progress.mnemonics.get("CppCompile")?.color);

		next.setLastMessage(true);
		progress.add(next);
		const complete = layoutFrontier(progress);
		assertEquals(0, complete.columns[0].length);
		assertEquals(progress.last, complete.columns[1][0]);
		assertEquals(2, complete.cells.size);
		assertArrayEquals([progress.history[0]], complete.parents.get(progress.history[4]));
	},

	testFrontierSuppressesArtifactSetsAndTheirAnnouncersOnAnnouncement() {
		const progress = new InvocationProgress();
		const namedSet = new BuildEventId.NamedSetOfFilesId();
		namedSet.setId("outputs");
		const artifactId = new BuildEventId();
		artifactId.setNamedSet(namedSet);
		const next = progressEvent(3, []);
		const announcer = progressEvent(2, [artifactId, /** @type {!BuildEventId} */ (next.getId())]);
		announcer.setProgress(new Progress());
		progress.add(progressEvent(1, [/** @type {!BuildEventId} */ (announcer.getId())]));
		progress.add(announcer);
		const pending = layoutFrontier(progress, 0);
		assertFalse(pending.cells.has(progress.history[1]));
		assertFalse(pending.departures.has(progress.history[1]));
		assertEquals(1, pending.columns[0].length);
		const expected = /** @type {!FrontierMark} */ (pending.columns[0][0]);
		assertEquals(next.getId(), expected.id);
		assertArrayEquals([progress.history[0]], pending.parents.get(expected));

		const artifact = new BuildEvent();
		artifact.setId(artifactId);
		artifact.setNamedSetOfFiles(new NamedSetOfFiles());
		progress.add(artifact);
		const received = layoutFrontier(progress, 0);
		assertFalse(received.cells.has(progress.history[2]));
		assertFalse(received.departures.has(progress.history[2]));
		assertEquals(3, progress.history.length);
	},

	testProgressAndBuildEndpointsUseTopRowEvenWhenTheyShareADepth() {
		const progress = new InvocationProgress();
		const first = progressEvent(1, []);
		const second = progressEvent(2, []);
		const finished = finishedEvent(0, "");
		const metricsId = new BuildEventId();
		metricsId.setBuildMetrics(new BuildEventId.BuildMetricsId());
		const metrics = new BuildEvent();
		metrics.setId(metricsId);
		const startedId = new BuildEventId();
		startedId.setStarted(new BuildEventId.BuildStartedId());
		const started = new BuildEvent();
		started.setId(startedId);
		// Receive a branch before the progress events to test ordering within a depth.
		started.setChildrenList([metricsId, /** @type {!BuildEventId} */ (first.getId()),
			/** @type {!BuildEventId} */ (second.getId()), /** @type {!BuildEventId} */ (finished.getId())]);
		progress.add(started);
		progress.add(metrics);
		progress.add(first);
		progress.add(second);
		progress.add(finished);
		const layout = layoutFrontier(progress);
		assertEquals(1, layout.cells.get(progress.history[1])?.row);
		assertEquals(0, layout.cells.get(progress.history[0])?.row);
		assertEquals(0, layout.cells.get(progress.history[2])?.row);
		assertEquals(0, layout.cells.get(progress.history[3])?.row);
		assertEquals(0, layout.cells.get(progress.history[4])?.row);
		assertNotEquals(layout.cells.get(progress.history[2])?.column, layout.cells.get(progress.history[3])?.column);
	},

	testExpectedFrontierShowsDetailsAndSortsByFirstAnnouncement() {
		const progress = new InvocationProgress();
		const action = actionId("bazel-out/objects/later.o");
		const target = new BuildEventId.TargetCompletedId();
		target.setLabel("//:earlier");
		const targetId = new BuildEventId();
		targetId.setTargetCompleted(target);
		progress.add(progressEvent(1, [action]), 16000);
		progress.add(progressEvent(2, [targetId]), 12000);
		progress.add(progressEvent(3, [targetId]), 19000);
		const [older, newer] = layoutFrontier(progress).columns[0];
		assertEquals(targetId, older.id);
		assertEquals(action, newer.id);
		assertEquals("Completed target", expectedFrontierLabel(older.id).type);
		assertEquals("//:earlier", expectedFrontierLabel(older.id).detail);
		assertEquals("Action", expectedFrontierLabel(newer.id).type);
		assertEquals("//:lib · later.o", expectedFrontierLabel(newer.id).detail);

		const last = progressEvent(4, []);
		last.setLastMessage(true);
		progress.add(last, 20000);
		assertEquals(8, frontierWait(older, progress.frontierNow()));
		assertEquals(4, frontierWait(newer, progress.frontierNow()));
		assertEquals("Progress", expectedFrontierLabel(last.getId() || null).type);
		assertEquals("#4", expectedFrontierLabel(last.getId() || null).detail);
	},

	testSingleMessage() {
		const result = decodeDelimitedMessages(
			new Uint8Array([3, 1, 2, 3]),
			(bytes) => Array.from(bytes),
		);
		assertEquals(1, result.length);
		assertArrayEquals([1, 2, 3], result[0]);
	},

	testFailurePrefersActualDiagnosticFromTheFailedAction() {
		const progress = new InvocationProgress();
		const action = new BuildEvent();
		const executed = new ActionExecuted();
		executed.setType("CppLink");
		executed.setExitCode(1);
		action.setAction(executed);
		action.setId(actionId("lib.o"));
		progress.add(action);
		const output = new Progress();
		output.setStderr("other.cc: error: unrelated\nERROR: CppLink //:lib failed: command failed\n" +
			"\x1b[31mcollect2: fatal error: cannot find 'ld'\x1b[0m\nERROR: Build did NOT complete successfully\n");
		const log = progressEvent(1, []);
		log.setProgress(output);
		progress.add(log);
		assertNull(invocationFailure(progress));
		progress.add(finishedEvent(1, "local spawn failed for CppLink"));
		const failure = invocationFailure(progress);
		assertNotNull(failure);
		assertEquals("CppLink · //:lib", failure && failure.context);
		assertEquals("collect2: fatal error: cannot find 'ld'", failure && failure.message);
	},

	testFailureUsesFinishedDetailAndIgnoresSuccessfulBuilds() {
		const failed = new InvocationProgress();
		failed.add(finishedEvent(1, "no such target '//:missing'"));
		const failure = invocationFailure(failed);
		assertEquals("no such target '//:missing'", failure && failure.message);
		const succeeded = new InvocationProgress();
		succeeded.add(finishedEvent(0, "transient error"));
		assertNull(invocationFailure(succeeded));
	},

	testMultipleMessagesAndMultibyteLength() {
		const input = new Uint8Array(1 + 1 + 2 + 130);
		input[0] = 1;
		input[1] = 7;
		input[2] = 0x82;
		input[3] = 0x01;
		input.fill(9, 4);
		const result = decodeDelimitedMessages(input, (bytes) => bytes.length);
		assertArrayEquals([1, 130], result);
	},

	testRejectsTruncatedLength() {
		assertThrows(() =>
			decodeDelimitedMessages(new Uint8Array([0x80]), () => null),
		);
	},

	testRejectsTruncatedMessage() {
		assertThrows(() =>
			decodeDelimitedMessages(new Uint8Array([3, 1, 2]), () => null),
		);
	},

	testRejectsEmptyMessage() {
		assertThrows(() =>
			decodeDelimitedMessages(new Uint8Array([0]), () => null),
		);
	},

	testTerminalCarriageReturnReplacesCurrentLine() {
		assertEquals(
			"Analyzing 2/2\nDone",
			formatTerminalText("Analyzing 1/2\rAnalyzing 2/2\r\nDone"),
		);
	},

	testTerminalSgrRendersSafeStyledText() {
		const rendered = renderTerminalText("plain \x1b[31mred\x1b[0m text");
		assertEquals("plain red text", rendered.textContent);
		assertEquals(1, rendered.querySelectorAll("span").length);
		const span = /** @type {!HTMLElement} */ (rendered.querySelector("span"));
		assertEquals("rgb(205, 49, 49)", span.style.color);
	},

	testFullTerminalAppendsAcrossBatchesAndKeepsAnsiStyle() {
		const root = /** @type {!HTMLElement} */ (document.createElement("div"));
		const terminal = new InvocationTerminal(root);
		terminal.update(["first\n", "\x1b[31msecond\n", "par"]);
		terminal.update(["first\n", "\x1b[31msecond\n", "par", "tial\rfinal\x1b[0m\n"]);
		assertEquals("first\nsecond\nfinal\n", root.textContent);
		const colored = root.querySelectorAll("span[style]");
		assertEquals(2, colored.length);
		assertEquals("final", colored[1].textContent);
	},

	testParseCriticalPath() {
		const path = parseCriticalPath(
			"Critical Path: 0.06s, Remote (0.00% of the time)\n" +
			"  0.01s action 'Compile foo'\n" +
			"  0.05s action 'Link foo'",
		);
		assertEquals(60, path.timeMillis);
		assertEquals(2, path.items.length);
		assertEquals("Link foo", path.items[0].action);
		assertEquals(0, path.items[0].startMillis);
		assertEquals(50, path.items[1].startMillis);
	},
	testParseCriticalPathKeepsZeroDurationActions() {
		const path = parseCriticalPath(
			"Critical Path: 1,200.00s, Remote (0.00% of the time)\r\n" +
			"  1,200.00s action 'Link app' \r\n" +
			"  0.00s action 'Prepare inputs'\r\n",
		);
		assertEquals(1200000, path.timeMillis);
		assertEquals(2, path.items.length);
		assertEquals("Prepare inputs", path.items[0].action);
		assertEquals(0, path.items[0].timeMillis);
	},
});
