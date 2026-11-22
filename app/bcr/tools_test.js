goog.module("bcrfrontend.toolsTest");
goog.setTestOnly();

const Aborted = goog.require("proto.build_event_stream.Aborted");
const ActionExecuted = goog.require("proto.build_event_stream.ActionExecuted");
const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildEventId = goog.require("proto.build_event_stream.BuildEventId");
const BuildFinished = goog.require("proto.build_event_stream.BuildFinished");
const testSuite = goog.require("goog.testing.testSuite");
const {
	FrontierMark,
	InvocationProgress,
	InvocationTerminal,
	decodeDelimitedMessages,
	formatTerminalText,
	parseCriticalPath,
	renderTerminalText,
} = goog.require("bcrfrontend.tools");
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

testSuite({
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

	testSingleMessage() {
		const result = decodeDelimitedMessages(
			new Uint8Array([3, 1, 2, 3]),
			(bytes) => Array.from(bytes),
		);
		assertEquals(1, result.length);
		assertArrayEquals([1, 2, 3], result[0]);
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
