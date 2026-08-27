goog.module("bcrfrontend.toolsTest");
goog.setTestOnly();

const testSuite = goog.require("goog.testing.testSuite");
const {
	decodeDelimitedMessages,
	formatTerminalText,
	parseCriticalPath,
	renderTerminalText,
} = goog.require("bcrfrontend.tools");
goog.require("goog.testing.jsunit");

testSuite({
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
});
