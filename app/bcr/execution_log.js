/** @fileoverview Browser viewer for Bazel's compact execution log. */
goog.module("bcrfrontend.ExecutionLog");

const Digest = goog.requireType("proto.tools.protos.Digest");
const Duration = goog.requireType("proto.google.protobuf.Duration");
const ExecLogEntry = goog.require("proto.tools.protos.ExecLogEntry");
const dom = goog.require("goog.dom");
const events = goog.requireType("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { ExecutionLogGraph, GraphNode, GraphSide } = goog.require(
	"bcrfrontend.executionLogGraph",
);
const {
	SpawnTimeline,
	SpawnWaterfall,
	buildSpawnTimeline,
	formatTime,
	renderTimingLegend,
	timingExtentDetails,
} = goog.require("bcrfrontend.executionLogMetrics");
const { executionLog } = goog.require("soy.bcrfrontend.executionLog");
const { mnemonicColor } = goog.require("bcrfrontend.actionColors");
const { renderMnemonicFilters } = goog.require("bcrfrontend.mnemonicFilters");

const CHUNK_BYTES = 32 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 100;

/**
 * @typedef {{
 *   mnemonic: string,
 *   target: string,
 *   runner: string,
 *   outcome: string,
 *   duration: ?number,
 *   outputs: !Array<string>,
 *   outputPaths: !Array<string>,
 *   producedPaths: !Array<string>,
 *   search: string,
 *   spawn: ?ExecLogEntry.Spawn,
 *   symlinkInput: string,
 * }}
 */
let LogAction;

/**
 * @typedef {{
 *   invocation: ?ExecLogEntry.Invocation,
 *   actions: !Array<!LogAction>,
 *   references: !Map<number, !ExecLogEntry>,
 *   dependencies: ?Array<!Set<number>>,
 * }}
 */
let ExecutionData;

/** @typedef {function(new:Object, function(!Uint8Array, boolean):void)} */
let ZstdDecoder;

/** @type {?Promise<!ZstdDecoder>} */
let decoderPromise = null;

/** @return {!Promise<!ZstdDecoder>} */
function loadZstd() {
	if (!decoderPromise) {
		decoderPromise = new Promise(
			(
				/** function(!ZstdDecoder):void */ resolve,
				/** function(!Error):void */ reject,
			) => {
				const script = document.createElement("script");
				script.src = "/fzstd-0.1.1-bounded.js";
				script.onload = () => {
					const library = /** @type {?Object<string, *>} */ (window["fzstd"]);
					const decoder = /** @type {?ZstdDecoder} */ (library?.["Decompress"]);
					if (decoder) resolve(decoder);
					else reject(new Error("The compact log decoder did not initialize."));
					script.remove();
				};
				script.onerror = () => {
					decoderPromise = null;
					script.remove();
					reject(new Error("The compact log decoder could not be loaded."));
				};
				document.head.appendChild(script);
			},
		);
	}
	return decoderPromise;
}

/** Parses protobuf length framing across decompressed chunks. */
class CompactRecords {
	/** @param {function(!ExecLogEntry):void} onEntry */
	constructor(onEntry) {
		/** @private @const */
		this.onEntry_ = onEntry;
		/** @private */
		this.size_ = 0;
		/** @private */
		this.shift_ = 0;
		/** @private {?Uint8Array} */
		this.payload_ = null;
		/** @private */
		this.offset_ = 0;
		/** @private */
		this.expanded_ = 0;
	}

	/** @param {!Uint8Array} chunk */
	push(chunk) {
		this.expanded_ += chunk.length;
		if (this.expanded_ > MAX_EXPANDED_BYTES)
			throw new Error("The expanded log exceeds 256 MiB.");
		let pos = 0;
		while (pos < chunk.length) {
			if (!this.payload_) {
				const byte = chunk[pos++];
				this.size_ += (byte & 127) * 2 ** this.shift_;
				if (this.size_ > MAX_RECORD_BYTES || this.shift_ >= 28)
					throw new Error("Invalid compact log record size.");
				if (byte & 128) {
					this.shift_ += 7;
					continue;
				}
				if (!this.size_) throw new Error("Empty compact log record.");
				this.payload_ = new Uint8Array(this.size_);
			}
			const copied = Math.min(this.size_ - this.offset_, chunk.length - pos);
			this.payload_.set(chunk.subarray(pos, pos + copied), this.offset_);
			this.offset_ += copied;
			pos += copied;
			if (this.offset_ === this.size_) {
				this.onEntry_(ExecLogEntry.deserializeBinary(this.payload_));
				this.payload_ = null;
				this.size_ = this.shift_ = this.offset_ = 0;
			}
		}
	}

	finish() {
		if (this.payload_ || this.shift_)
			throw new Error("The compact log ends in the middle of a record.");
	}
}

/**
 * @param {!ExecLogEntry} entry
 * @return {string}
 */
function referencePath(entry) {
	const file = entry.getFile();
	const directory = entry.getDirectory();
	const symlink = entry.getUnresolvedSymlink();
	const runfiles = entry.getRunfilesTree();
	return (
		file?.getPath() ||
		directory?.getPath() ||
		symlink?.getPath() ||
		runfiles?.getPath() ||
		""
	);
}

/**
 * @param {!File} file
 * @param {function():boolean} current
 * @return {!Promise<?ExecutionData>}
 */
async function parseLog(file, current) {
	const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	if (
		header.length !== 4 ||
		new DataView(header.buffer).getUint32(0, true) !== 0xfd2fb528
	) {
		throw new Error("Choose a file created with --execution_log_compact_file.");
	}
	const Decoder = await loadZstd();
	if (!current()) return null;
	/** @type {!ExecutionData} */
	const log = {
		invocation: null,
		actions: [],
		references: new Map(),
		dependencies: null,
	};
	let entryCount = 0;
	const records = new CompactRecords((entry) => {
		entryCount++;
		if (entryCount > 1000000)
			throw new Error("The log exceeds 1,000,000 records.");
		const invocation = entry.getInvocation();
		if (invocation) {
			if (entryCount !== 1)
				throw new Error("Unexpected invocation header in the compact log.");
			log.invocation = invocation;
			return;
		}
		const spawn = entry.getSpawn();
		const symlink = entry.getSymlinkAction();
		if (!spawn && !symlink) {
			const id = entry.getId();
			if (
				id &&
				(referencePath(entry) ||
					entry.getInputSet() ||
					entry.getSymlinkEntrySet())
			)
				log.references.set(id, entry);
			return;
		}
		const mnemonic = spawn?.getMnemonic() || symlink?.getMnemonic() || "";
		const target = spawn?.getTargetLabel() || symlink?.getTargetLabel() || "";
		const runner = spawn?.getRunner() || "";
		const outcome = spawn
			? spawn.getStatus() || spawn.getExitCode()
				? "failed"
				: spawn.getCacheHit()
					? "cache"
					: "executed"
			: "symlink";
		const time = spawn?.getMetrics()?.getTotalTime();
		/** @type {!Array<string>} */
		const outputPaths = [];
		/** @type {!Array<string>} */
		const producedPaths = [];
		const outputs = spawn
			? spawn.getOutputsList().map((output) => {
					const invalid = output.getInvalidOutputPath();
					if (invalid) {
						outputPaths.push(invalid);
						return invalid + " (missing or wrong type)";
					}
					const id = output.getOutputId();
					const reference = log.references.get(id);
					const path = reference && referencePath(reference);
					if (path) {
						outputPaths.push(path);
						producedPaths.push(path);
					}
					return path || "Output #" + id;
				})
			: [symlink?.getOutputPath() || ""];
		if (symlink?.getOutputPath()) {
			outputPaths.push(symlink.getOutputPath());
			producedPaths.push(symlink.getOutputPath());
		}
		log.actions.push({
			mnemonic,
			target,
			runner,
			outcome,
			outputs,
			outputPaths,
			producedPaths,
			duration: time
				? time.getSeconds() * 1000 + time.getNanos() / 1000000
				: null,
			search: [mnemonic, target, runner, ...outputs].join(" ").toLowerCase(),
			spawn: spawn || null,
			symlinkInput: symlink?.getInputPath() || "",
		});
	});
	const decoder = new Decoder((/** !Uint8Array */ chunk) =>
		records.push(chunk),
	);
	const push = /** @type {function(!Uint8Array, boolean):void} */ (
		decoder["push"]
	).bind(decoder);
	for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
		const end = Math.min(offset + CHUNK_BYTES, file.size);
		const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
		if (!current()) return null;
		push(bytes, end === file.size);
	}
	records.finish();
	if (!log.invocation && !log.actions.length)
		throw new Error("No compact execution log records were found.");
	return log;
}

/**
 * @param {!ExecutionData} log
 * @param {number} root
 * @return {!Array<!ExecLogEntry>}
 */
function inputReferences(log, root) {
	/** @type {!Array<number>} */
	const pending = root ? [root] : [];
	/** @type {!Set<number>} */
	const seen = new Set();
	/** @type {!Array<!ExecLogEntry>} */
	const entries = [];
	while (pending.length) {
		const id = /** @type {number} */ (pending.pop());
		if (seen.has(id)) continue;
		seen.add(id);
		const entry = log.references.get(id);
		if (!entry) continue;
		const set = entry.getInputSet();
		const runfiles = entry.getRunfilesTree();
		const symlinks = entry.getSymlinkEntrySet();
		if (set) {
			const inputs = set.getInputIdsList();
			const children = set.getTransitiveSetIdsList();
			for (let i = inputs.length - 1; i >= 0; i--) pending.push(inputs[i]);
			for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
		} else if (symlinks) {
			symlinks.getDirectEntriesMap().forEach((value) => pending.push(value));
			for (const child of symlinks.getTransitiveSetIdsList())
				pending.push(child);
		} else {
			entries.push(entry);
			if (runfiles) {
				pending.push(
					runfiles.getInputSetId(),
					runfiles.getSymlinksId(),
					runfiles.getRootSymlinksId(),
				);
			}
		}
	}
	return entries;
}

/**
 * @param {?Digest|undefined} digest
 * @return {string}
 */
function digestText(digest) {
	if (!digest) return "";
	return [
		digest.getHashFunctionName(),
		digest.getHash(),
		digest.getSizeBytes() + " bytes",
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * @param {!ExecLogEntry.File} file
 * @return {string}
 */
function fileText(file) {
	const digest = digestText(file.getDigest());
	return file.getPath() + (digest ? " [" + digest + "]" : "");
}

/**
 * @param {!ExecLogEntry} entry
 * @return {string}
 */
function referenceText(entry) {
	const file = entry.getFile();
	if (file) return fileText(file);
	const dir = entry.getDirectory();
	if (dir)
		return [
			dir.getPath(),
			...dir
				.getFilesList()
				.map((child) => "  " + fileText(child))
				.sort(),
		].join("\n");
	const link = entry.getUnresolvedSymlink();
	if (link) return link.getPath() + " → " + link.getTargetPath();
	const runfiles = entry.getRunfilesTree();
	if (!runfiles) return referencePath(entry);
	const manifest = runfiles.getRepoMappingManifest();
	return [
		runfiles.getPath(),
		...runfiles
			.getEmptyFilesList()
			.slice()
			.sort()
			.map((path) => "  empty: " + path),
		...(manifest
			? ["  _repo_mapping: " + digestText(manifest.getDigest())]
			: []),
	].join("\n");
}

/**
 * @param {!ExecutionData} log
 * @param {number} id
 * @return {!Array<string>}
 */
function inputDetails(log, id) {
	return Array.from(
		new Set(inputReferences(log, id).map(referenceText).filter(Boolean)),
	);
}

/**
 * @param {?Duration|undefined} duration
 * @return {string}
 */
function durationText(duration) {
	return duration
		? duration.getSeconds() * 1000 + duration.getNanos() / 1000000 + " ms"
		: "";
}

/**
 * @param {!LogAction} action
 * @param {!ExecutionData} log
 * @return {!Map<string, !Array<string>>}
 */
function spawnFields(action, log) {
	/** @type {!Map<string, !Array<string>>} */
	const fields = new Map();
	const put = (/** string */ name, /** string|number|boolean */ value) =>
		fields.set(name, [String(value)]);
	put("Mnemonic", action.mnemonic);
	put("Target label", action.target);
	const spawn = action.spawn;
	if (!spawn) {
		put("Symlink target", action.symlinkInput);
		fields.set("Outputs", action.outputs);
		return fields;
	}
	put("Runner", spawn.getRunner());
	put("Status", spawn.getStatus());
	put("Exit code", spawn.getExitCode());
	put("Cache hit", spawn.getCacheHit());
	put("Remotable", spawn.getRemotable());
	put("Cacheable", spawn.getCacheable());
	put("Remote cacheable", spawn.getRemoteCacheable());
	put("Action digest", digestText(spawn.getDigest()));
	put("Timeout (ms)", spawn.getTimeoutMillis());
	put("Input set ID", spawn.getInputSetId());
	put("Tool set ID", spawn.getToolSetId());
	fields.set("Command arguments", spawn.getArgsList());
	fields.set(
		"Environment variables",
		spawn
			.getEnvVarsList()
			.map((entry) => entry.getName() + "=" + entry.getValue())
			.sort(),
	);
	const platform = spawn.getPlatform();
	fields.set(
		"Execution platform",
		platform
			? platform
					.getPropertiesList()
					.map((property) => property.getName() + "=" + property.getValue())
					.sort()
			: [],
	);
	fields.set("Inputs", inputDetails(log, spawn.getInputSetId()));
	fields.set("Tools", inputDetails(log, spawn.getToolSetId()));
	fields.set(
		"Outputs",
		spawn.getOutputsList().map((output, index) => {
			const ref = log.references.get(output.getOutputId());
			return ref ? referenceText(ref) : action.outputs[index];
		}),
	);
	fields.set(
		"Output IDs",
		spawn
			.getOutputsList()
			.map((output) => output.getOutputId())
			.filter(Boolean)
			.map(String),
	);
	const metrics = spawn.getMetrics();
	if (!metrics) return fields;
	put("Metrics · Total time", durationText(metrics.getTotalTime()));
	put("Metrics · Parse time", durationText(metrics.getParseTime()));
	put("Metrics · Network time", durationText(metrics.getNetworkTime()));
	put("Metrics · Fetch time", durationText(metrics.getFetchTime()));
	put("Metrics · Queue time", durationText(metrics.getQueueTime()));
	put("Metrics · Setup time", durationText(metrics.getSetupTime()));
	put("Metrics · Upload time", durationText(metrics.getUploadTime()));
	put(
		"Metrics · Execution wall time",
		durationText(metrics.getExecutionWallTime()),
	);
	put(
		"Metrics · Process outputs time",
		durationText(metrics.getProcessOutputsTime()),
	);
	put("Metrics · Retry time", durationText(metrics.getRetryTime()));
	put("Metrics · Input bytes", metrics.getInputBytes());
	put("Metrics · Input files", metrics.getInputFiles());
	put("Metrics · Memory estimate bytes", metrics.getMemoryEstimateBytes());
	put("Metrics · Input bytes limit", metrics.getInputBytesLimit());
	put("Metrics · Input files limit", metrics.getInputFilesLimit());
	put("Metrics · Output bytes limit", metrics.getOutputBytesLimit());
	put("Metrics · Output files limit", metrics.getOutputFilesLimit());
	put("Metrics · Memory bytes limit", metrics.getMemoryBytesLimit());
	put("Metrics · Time limit", durationText(metrics.getTimeLimit()));
	const start = metrics.getStartTime();
	if (start)
		put(
			"Metrics · Start time",
			start.getSeconds() +
				"." +
				String(start.getNanos()).padStart(9, "0") +
				" Unix s",
		);
	put(
		"Metrics · Measured peak memory bytes",
		metrics.getMeasuredMemoryPeakBytes(),
	);
	return fields;
}

/**
 * @param {string} field
 * @return {boolean}
 */
function comparableField(field) {
	return (
		field !== "Input set ID" &&
		field !== "Tool set ID" &&
		field !== "Output IDs" &&
		field !== "Metrics · Start time"
	);
}

/**
 * @param {string} field
 * @param {!Array<string>} a
 * @param {!Array<string>} b
 * @return {boolean}
 */
function equalValues(field, a, b) {
	if (a.length !== b.length) return false;
	if (field === "Inputs" || field === "Tools" || field === "Outputs") {
		const right = b.slice().sort();
		return a
			.slice()
			.sort()
			.every((value, i) => value === right[i]);
	}
	return a.every((value, i) => value === b[i]);
}

/**
 * @param {!LogAction} action
 * @param {!ExecutionData} log
 * @return {string}
 */
function actionSignature(action, log) {
	/** @type {!Array<{name:string, values:!Array<string>}>} */
	const fields = [];
	spawnFields(action, log).forEach((values, name) => {
		if (!comparableField(name)) return;
		const sorted =
			name === "Inputs" || name === "Tools" || name === "Outputs"
				? values.slice().sort()
				: values;
		fields.push({ name, values: sorted });
	});
	return JSON.stringify(fields);
}

/**
 * @typedef {{a: ?LogAction, b: ?LogAction, changed: boolean}}
 */
let ActionPair;

/**
 * Match only unique candidates at each level. Identical repeats are
 * interchangeable and can be paired without guessing about changed repeats.
 * @param {!ExecutionData} a
 * @param {!ExecutionData} b
 * @return {!Array<!ActionPair>}
 */
function compareLogs(a, b) {
	const matches = new Int32Array(a.actions.length).fill(-1);
	const used = new Uint8Array(b.actions.length);
	/**
	 * @param {function(!LogAction):string} keyFor
	 * @param {boolean=} exact
	 */
	const match = (keyFor, exact = false) => {
		/** @type {!Map<string, !Array<number>>} */
		const left = new Map();
		/** @type {!Map<string, !Array<number>>} */
		const right = new Map();
		a.actions.forEach((action, i) => {
			if (matches[i] >= 0) return;
			const key = keyFor(action);
			if (!key) return;
			const group = left.get(key) || [];
			group.push(i);
			left.set(key, group);
		});
		b.actions.forEach((action, j) => {
			if (used[j]) return;
			const key = keyFor(action);
			if (!key) return;
			const group = right.get(key) || [];
			group.push(j);
			right.set(key, group);
		});
		left.forEach((group, key) => {
			const other = right.get(key);
			if (!other) return;
			if (group.length === 1 && other.length === 1) {
				matches[group[0]] = other[0];
				used[other[0]] = 1;
			} else if (exact) {
				/** @type {!Map<string, !Array<number>>} */
				const duplicates = new Map();
				for (const j of other) {
					const signature = actionSignature(b.actions[j], b);
					const list = duplicates.get(signature) || [];
					list.push(j);
					duplicates.set(signature, list);
				}
				for (const i of group) {
					const candidates = duplicates.get(actionSignature(a.actions[i], a));
					const j = candidates?.pop();
					if (j === undefined) continue;
					matches[i] = j;
					used[j] = 1;
				}
			}
		});
	};
	match(
		(action) =>
			action.target || action.outputPaths.length
				? JSON.stringify([
						action.target,
						action.mnemonic,
						action.outputPaths.slice().sort(),
					])
				: "",
		true,
	);
	match(
		(action) =>
			action.target && JSON.stringify([action.target, action.mnemonic]),
	);
	match((action) => action.target);
	/** @type {!Array<!ActionPair>} */
	const pairs = a.actions.map((action, i) => {
		const other = matches[i] >= 0 ? b.actions[matches[i]] : null;
		return {
			a: action,
			b: other,
			changed:
				!other || actionSignature(action, a) !== actionSignature(other, b),
		};
	});
	b.actions.forEach((action, j) => {
		if (!used[j]) pairs.push({ a: null, b: action, changed: true });
	});
	return pairs;
}

/**
 * @param {!ExecutionData} log
 * @return {!Array<!Set<number>>}
 */
function dependencies(log) {
	if (log.dependencies) return log.dependencies;
	/** @type {!Map<string, !Array<number>>} */
	const producers = new Map();
	log.actions.forEach((action, i) => {
		for (const path of action.producedPaths) {
			const owners = producers.get(path) || [];
			owners.push(i);
			producers.set(path, owners);
		}
	});
	/** @type {!Map<number, !Array<!Array<number>>>} */
	const inputOwners = new Map();
	/**
	 * @param {number} id
	 * @return {!Array<!Array<number>>}
	 */
	const ownersFor = (id) => {
		const known = inputOwners.get(id);
		if (known) return known;
		/** @type {!Set<!Array<number>>} */
		const owners = new Set();
		for (const entry of inputReferences(log, id)) {
			const path = referencePath(entry);
			const direct = producers.get(path);
			if (direct) owners.add(direct);
			// A file inside a tree artifact may be logged separately.
			for (
				let end = path.lastIndexOf("/");
				end > 0;
				end = path.lastIndexOf("/", end - 1)
			) {
				const tree = producers.get(path.slice(0, end));
				if (!tree) continue;
				owners.add(tree);
				break;
			}
		}
		const list = Array.from(owners);
		inputOwners.set(id, list);
		return list;
	};
	log.dependencies = log.actions.map((action, consumer) => {
		/** @type {!Set<number>} */
		const inputs = new Set();
		const add = (/** !Array<number> */ owners) => {
			// Prefer the nearest preceding record when several spawns wrote a path.
			let low = 0;
			let high = owners.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (owners[middle] < consumer) low = middle + 1;
				else high = middle;
			}
			const index =
				low > 0
					? owners[low - 1]
					: owners[0] === consumer
						? owners[1]
						: owners[0];
			if (index !== undefined && index !== consumer) inputs.add(index);
		};
		const spawn = action.spawn;
		if (spawn) {
			ownersFor(spawn.getInputSetId()).forEach(add);
			ownersFor(spawn.getToolSetId()).forEach(add);
		} else {
			const owner = producers.get(action.symlinkInput);
			if (owner) add(owner);
		}
		return inputs;
	});
	return log.dependencies;
}

/**
 * @param {string} outcome
 * @return {string}
 */
function outcomeLabel(outcome) {
	switch (outcome) {
		case "failed":
			return "Failed";
		case "cache":
			return "Cache hit";
		case "symlink":
			return "Symlink";
		default:
			return "Executed";
	}
}

/**
 * @typedef {{
 *   name: string, log: ?ExecutionData, upload: number, message: string, failed: boolean,
 *   query: string, outcome: string, suppressed: !Set<string>,
 *   timeline: ?SpawnTimeline,
 * }}
 */
let LogSlot;

/** @type {!Array<string>} */
const TAB_NAMES = ["a", "b", "diff", "metrics"];
const DIFF_TAB = 2;
const METRICS_TAB = 3;

/** @return {!LogSlot} */
function newSlot() {
	return {
		name: "",
		log: null,
		upload: 0,
		message: "",
		failed: false,
		query: "",
		outcome: "",
		suppressed: new Set(),
		timeline: null,
	};
}

class ExecutionLog extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
		/** @private @const {!Array<!LogSlot>} */
		this.slots_ = [newSlot(), newSlot()];
		/** @private */
		this.tab_ = 0;
		/** @private */
		this.pickerSlot_ = -1;
		/** @private {!Array<!LogAction>} */
		this.filtered_ = [];
		/** @private */
		this.page_ = 0;
		/** @private {?ExecutionLogGraph} */
		this.graph_ = null;
		/** @private {?ResizeObserver} */
		this.resize_ = null;
		/** @private {?Array<!ActionPair>} */
		this.comparison_ = null;
		/** @private {!Array<!ActionPair>} */
		this.pairs_ = [];
		/** @private {!Array<number>} */
		this.changes_ = [];
		/** @private */
		this.diffPage_ = 0;
		/** @private {number} */
		this.metricsSlot_ = 0;
		/** @private {?SpawnWaterfall} */
		this.waterfall_ = null;
		/** @private {?ResizeObserver} */
		this.metricsResize_ = null;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(executionLog));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const input = /** @type {!HTMLInputElement} */ (this.el_("file"));
		const host = this.el_("content");
		const handler = this.getHandler();
		const choose = (/** number */ index) => {
			this.pickerSlot_ = index;
			input.click();
		};
		handler.listen(this.el_("choose"), "click", () => choose(this.tab_));
		handler.listen(this.el_("replace"), "click", () => choose(this.tab_));
		handler.listen(this.el_("load-a"), "click", () => choose(0));
		handler.listen(this.el_("load-b"), "click", () => choose(1));
		handler.listen(input, "change", () => {
			const file = input.files?.[0];
			const index = this.pickerSlot_ >= 0 ? this.pickerSlot_ : this.dropSlot_();
			this.pickerSlot_ = -1;
			input.value = "";
			if (file) {
				this.switchTab_(index);
				void this.load_(index, file);
			}
		});
		handler.listen(input, "cancel", () => {
			this.pickerSlot_ = -1;
		});
		TAB_NAMES.forEach((name, index) => {
			const tab = this.el_("tab-" + name);
			handler.listen(tab, "click", () => this.switchTab_(index));
			handler.listen(tab, "keydown", (/** !events.BrowserEvent */ event) => {
				let next = index;
				switch (event.key) {
					case "ArrowLeft":
						next = (index + TAB_NAMES.length - 1) % TAB_NAMES.length;
						break;
					case "ArrowRight":
						next = (index + 1) % TAB_NAMES.length;
						break;
					case "Home":
						next = 0;
						break;
					case "End":
						next = TAB_NAMES.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				this.switchTab_(next);
				this.el_("tab-" + TAB_NAMES[next]).focus();
			});
		});
		handler.listen(
			host,
			["dragenter", "dragover"],
			(/** !events.BrowserEvent */ event) => {
				const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
				if (!drag.dataTransfer?.types.includes("Files")) return;
				event.preventDefault();
				drag.dataTransfer.dropEffect = "copy";
				host.classList.add("is-dragging");
			},
		);
		handler.listen(host, "dragleave", (/** !events.BrowserEvent */ event) => {
			if (!host.contains(/** @type {?Node} */ (event.relatedTarget)))
				host.classList.remove("is-dragging");
		});
		handler.listen(host, "drop", (/** !events.BrowserEvent */ event) => {
			const drop = /** @type {!DragEvent} */ (event.getBrowserEvent());
			host.classList.remove("is-dragging");
			if (!drop.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			const file = drop.dataTransfer.files[0];
			if (file) {
				const index = this.dropSlot_();
				this.switchTab_(index);
				void this.load_(index, file);
				const second = drop.dataTransfer.files[1];
				if (second) void this.load_(1 - index, second);
			}
		});
		handler.listen(this.el_("search"), "input", () => this.filter_());
		handler.listen(this.el_("outcome"), "change", () => this.filter_());
		handler.listen(
			this.el_("mnemonics"),
			"change",
			(/** !events.BrowserEvent */ event) => {
				const checkbox = /** @type {!HTMLInputElement} */ (event.target);
				const suppressed = this.slots_[this.tab_].suppressed;
				if (checkbox.checked) suppressed.delete(checkbox.value);
				else suppressed.add(checkbox.value);
				this.filter_();
			},
		);
		handler.listen(this.el_("prev"), "click", () => this.changePage_(-1));
		handler.listen(this.el_("next"), "click", () => this.changePage_(1));
		handler.listen(
			this.el_("rows"),
			"click",
			(/** !events.BrowserEvent */ event) => {
				const target = /** @type {!Element} */ (event.target);
				const button = target.closest("button[data-entry]");
				if (!button) return;
				this.select_(this.filtered_[Number(button.getAttribute("data-entry"))]);
				for (const row of this.el_("rows").querySelectorAll(
					"button[data-entry]",
				)) {
					row.setAttribute("aria-pressed", String(row === button));
				}
				this.el_("detail-heading").focus();
			},
		);
		const canvas = /** @type {!HTMLCanvasElement} */ (this.el_("diff-canvas"));
		const graph = new ExecutionLogGraph(canvas, (index) =>
			this.selectDiff_(index, "diff", false),
		);
		this.graph_ = graph;
		handler.listen(this.el_("diff-fit"), "click", () => graph.fit());
		handler.listen(canvas, "wheel", (/** !events.BrowserEvent */ event) => {
			event.preventDefault();
			graph.wheel(/** @type {!WheelEvent} */ (event.getBrowserEvent()));
		});
		handler.listen(canvas, "pointerdown", (/** !events.BrowserEvent */ event) =>
			graph.start(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(canvas, "pointermove", (/** !events.BrowserEvent */ event) =>
			graph.move(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(
			canvas,
			["pointerup", "lostpointercapture"],
			(/** !events.BrowserEvent */ event) =>
				graph.end(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(canvas, "keydown", (/** !events.BrowserEvent */ event) => {
			if (graph.key(event.key)) event.preventDefault();
		});
		this.resize_ = new ResizeObserver(() => graph.draw());
		this.resize_.observe(canvas);
		handler.listen(this.el_("include-a"), "change", () => this.renderDiff_());
		handler.listen(this.el_("include-b"), "change", () => this.renderDiff_());
		handler.listen(this.el_("diff-prev"), "click", () =>
			this.renderChanges_(this.diffPage_ - 1),
		);
		handler.listen(this.el_("diff-next"), "click", () =>
			this.renderChanges_(this.diffPage_ + 1),
		);
		handler.listen(
			this.el_("diff-rows"),
			"click",
			(/** !events.BrowserEvent */ event) => {
				const target = /** @type {!Element} */ (event.target);
				const button = target.closest("button[data-entry]");
				if (!button) return;
				this.selectDiff_(
					Number(button.getAttribute("data-entry")),
					button.getAttribute("data-mode") || "diff",
					true,
				);
			},
		);
		for (let index = 0; index < 2; index++) {
			handler.listen(this.el_("metrics-" + TAB_NAMES[index]), "change", () => {
				this.metricsSlot_ = index;
				this.renderMetrics_();
			});
		}
		handler.listen(this.el_("metrics-shared"), "change", () =>
			this.renderMetrics_(),
		);
		const legend = this.el_("metrics-legend");
		if (!legend.children.length) renderTimingLegend(legend);
		const timingCanvas = /** @type {!HTMLCanvasElement} */ (
			this.el_("metrics-canvas")
		);
		const viewport = this.el_("metrics-viewport");
		const waterfall = new SpawnWaterfall(
			timingCanvas,
			viewport,
			this.el_("metrics-detail"),
		);
		this.waterfall_ = waterfall;
		handler.listen(this.el_("metrics-fit"), "click", () => waterfall.fit());
		handler.listen(this.el_("metrics-zoom-in"), "click", () =>
			waterfall.zoom(1.5),
		);
		handler.listen(this.el_("metrics-zoom-out"), "click", () =>
			waterfall.zoom(1 / 1.5),
		);
		handler.listen(viewport, "scroll", () => waterfall.clearHover());
		handler.listen(
			timingCanvas,
			"wheel",
			(/** !events.BrowserEvent */ event) => {
				if (
					waterfall.wheel(/** @type {!WheelEvent} */ (event.getBrowserEvent()))
				)
					event.preventDefault();
			},
		);
		handler.listen(
			timingCanvas,
			"pointerdown",
			(/** !events.BrowserEvent */ event) =>
				waterfall.start(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(
			timingCanvas,
			"pointermove",
			(/** !events.BrowserEvent */ event) =>
				waterfall.move(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(
			timingCanvas,
			["pointerup", "pointercancel", "lostpointercapture"],
			(/** !events.BrowserEvent */ event) =>
				waterfall.end(/** @type {!PointerEvent} */ (event.getBrowserEvent())),
		);
		handler.listen(timingCanvas, "pointerleave", () => waterfall.clearHover());
		handler.listen(
			timingCanvas,
			"keydown",
			(/** !events.BrowserEvent */ event) => {
				if (waterfall.key(event.key)) event.preventDefault();
			},
		);
		this.metricsResize_ = new ResizeObserver(() => waterfall.draw());
		this.metricsResize_.observe(viewport);
		this.switchTab_(this.tab_);
	}

	/** @override */
	exitDocument() {
		for (const slot of this.slots_) {
			slot.upload++;
			if (!slot.failed) slot.message = "";
		}
		this.graph_?.dispose();
		this.graph_ = null;
		this.resize_?.disconnect();
		this.resize_ = null;
		this.waterfall_?.dispose();
		this.waterfall_ = null;
		this.metricsResize_?.disconnect();
		this.metricsResize_ = null;
		super.exitDocument();
	}

	/**
	 * @private
	 * @param {string} id
	 * @return {!HTMLElement}
	 */
	el_(id) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector("#execution-log-" + id)
		);
	}

	/**
	 * @private
	 * @return {number}
	 */
	dropSlot_() {
		if (this.tab_ < DIFF_TAB) return this.tab_;
		if (this.tab_ === METRICS_TAB) return this.metricsSlot_;
		return this.slots_[0].log && !this.slots_[1].log ? 1 : 0;
	}

	/**
	 * @private
	 * @param {number} index
	 */
	switchTab_(index) {
		this.tab_ = index;
		TAB_NAMES.forEach((name, i) => {
			const tab = this.el_("tab-" + name);
			tab.setAttribute("aria-selected", String(i === index));
			tab.tabIndex = i === index ? 0 : -1;
		});
		const panel = this.el_("slot-panel");
		panel.hidden = index >= DIFF_TAB;
		this.el_("diff-panel").hidden = index !== DIFF_TAB;
		this.el_("metrics-panel").hidden = index !== METRICS_TAB;
		if (panel.hidden) {
			this.el_("summary").textContent = "";
			dom.removeChildren(this.el_("invocation"));
			this.el_("filters").hidden = true;
			if (index === DIFF_TAB) this.renderDiff_();
			else this.renderMetrics_();
		} else {
			panel.setAttribute(
				"aria-labelledby",
				"execution-log-tab-" + TAB_NAMES[index],
			);
			this.renderSlot_();
		}
	}

	/** @private */
	renderSlot_() {
		const slot = this.slots_[this.tab_];
		const log = slot.log;
		this.el_("drop").hidden = !!log;
		this.el_("results").hidden = !log;
		this.renderSlotStatus_();
		const metadata = this.el_("invocation");
		dom.removeChildren(metadata);
		const count = log?.actions.length || 0;
		const list = this.el_("mnemonics");
		renderMnemonicFilters(
			list,
			log ? log.actions.map((action) => action.mnemonic) : [],
		);
		for (const element of list.querySelectorAll("input")) {
			const checkbox = /** @type {!HTMLInputElement} */ (element);
			checkbox.checked = !slot.suppressed.has(checkbox.value);
		}
		this.el_("filters").hidden = !count;
		const summary = this.el_("summary");
		summary.textContent = "";
		if (!log) return;
		let hits = 0;
		let failures = 0;
		for (const action of log.actions) {
			if (action.outcome === "cache") hits++;
			if (action.outcome === "failed") failures++;
		}
		summary.textContent =
			slot.name +
			" · " +
			count.toLocaleString() +
			(count === 1 ? " entry · " : " entries · ") +
			hits.toLocaleString() +
			(hits === 1 ? " cache hit · " : " cache hits · ") +
			failures.toLocaleString() +
			" failed";
		const invocation = log.invocation;
		if (invocation?.getId())
			metadata.appendChild(
				dom.createDom("p", null, "Invocation " + invocation.getId()),
			);
		if (invocation?.getHashFunctionName()) {
			metadata.appendChild(
				dom.createDom("p", null, "Digest " + invocation.getHashFunctionName()),
			);
		}
		/** @type {!HTMLInputElement} */ (this.el_("search")).value = slot.query;
		/** @type {!HTMLSelectElement} */ (this.el_("outcome")).value =
			slot.outcome;
		this.filter_();
	}

	/** @private */
	renderSlotStatus_() {
		const slot = this.slots_[this.tab_];
		const status = this.el_("status");
		status.hidden = !slot.message;
		status.classList.toggle("color-fg-danger", slot.failed);
		status.textContent = slot.message;
	}

	/**
	 * @private
	 * @param {number} index
	 * @param {!File} file
	 * @return {!Promise<void>}
	 */
	async load_(index, file) {
		const slot = this.slots_[index];
		const upload = ++slot.upload;
		/** @type {function():boolean} */
		const current = () => slot.upload === upload;
		slot.failed = false;
		slot.message = "Reading " + file.name + "…";
		if (this.tab_ === index) this.renderSlotStatus_();
		try {
			const log = await parseLog(file, current);
			if (!log || !current()) return;
			const name = TAB_NAMES[index];
			const include = /** @type {!HTMLInputElement} */ (
				this.el_("include-" + name)
			);
			if (!slot.log) include.checked = true;
			include.disabled = false;
			this.el_("tab-" + name).title = file.name;
			this.el_("load-" + name).textContent = "Replace " + name.toUpperCase();
			include.title = file.name;
			slot.log = log;
			slot.name = file.name;
			slot.timeline = null;
			slot.message = "";
			slot.suppressed.clear();
			slot.query = slot.outcome = "";
			this.comparison_ = null;
			if (this.tab_ === index) this.renderSlot_();
			if (this.tab_ === DIFF_TAB) this.renderDiff_();
			if (this.tab_ === METRICS_TAB) this.renderMetrics_();
		} catch (/** @type {*} */ error) {
			if (!current()) return;
			slot.failed = true;
			slot.message =
				"Could not read " +
				file.name +
				". " +
				(error instanceof Error
					? error.message
					: "The compact log may be damaged.");
			if (this.tab_ === index) this.renderSlotStatus_();
		}
	}

	/** @private */
	filter_() {
		const slot = this.slots_[this.tab_];
		const log = slot.log;
		if (!log) return;
		slot.query = /** @type {!HTMLInputElement} */ (this.el_("search")).value;
		slot.outcome = /** @type {!HTMLSelectElement} */ (
			this.el_("outcome")
		).value;
		const query = slot.query.trim().toLowerCase();
		this.filtered_ = log.actions.filter(
			(action) =>
				!slot.suppressed.has(action.mnemonic) &&
				(!slot.outcome || action.outcome === slot.outcome) &&
				(!query || action.search.includes(query)),
		);
		this.page_ = 0;
		this.select_(null);
		this.renderRows_();
	}

	/**
	 * @private
	 * @param {number} delta
	 */
	changePage_(delta) {
		this.page_ += delta;
		this.select_(null);
		this.renderRows_();
	}

	/** @private */
	renderRows_() {
		const rows = this.el_("rows");
		dom.removeChildren(rows);
		const total = this.filtered_.length;
		const start = this.page_ * PAGE_SIZE;
		const end = Math.min(start + PAGE_SIZE, total);
		for (let i = start; i < end; i++) {
			const action = this.filtered_[i];
			const swatch = dom.createDom("span", {
				"class": "action-query-swatch",
				"aria-hidden": "true",
			});
			if (action.mnemonic)
				swatch.style.backgroundColor = mnemonicColor(action.mnemonic);
			const button = dom.createDom(
				"button",
				{
					"type": "button",
					"class": "btn-link execution-log-action",
					"data-entry": String(i),
					"aria-pressed": "false",
				},
				swatch,
				action.mnemonic || "Action",
			);
			const target = dom.createDom("td", null, action.target);
			if (action.outputs[0])
				target.appendChild(
					dom.createDom("div", "text-small color-fg-muted", action.outputs[0]),
				);
			const outcome =
				action.outcome === "failed"
					? "color-fg-danger"
					: action.outcome === "cache"
						? "color-fg-success"
						: "";
			rows.appendChild(
				dom.createDom(
					"tr",
					null,
					dom.createDom("td", null, button),
					target,
					dom.createDom("td", outcome, outcomeLabel(action.outcome)),
					dom.createDom("td", null, action.runner || "—"),
					dom.createDom(
						"td",
						null,
						action.duration === null
							? "—"
							: action.duration.toLocaleString(undefined, {
									maximumFractionDigits: 1,
								}) + " ms",
					),
				),
			);
		}
		this.el_("table").hidden = !total;
		const empty = this.el_("empty");
		empty.hidden = !!total;
		empty.textContent = this.slots_[this.tab_].log?.actions.length
			? "No entries match these filters."
			: "This log contains no recorded actions.";
		this.el_("pagination").hidden = total <= PAGE_SIZE;
		this.el_("page").textContent =
			(start + 1).toLocaleString() +
			"–" +
			end.toLocaleString() +
			" of " +
			total.toLocaleString();
		/** @type {!HTMLButtonElement} */ (this.el_("prev")).disabled = start === 0;
		/** @type {!HTMLButtonElement} */ (this.el_("next")).disabled =
			end >= total;
	}

	/** @private */
	renderMetrics_() {
		const a = /** @type {!HTMLInputElement} */ (this.el_("metrics-a"));
		const b = /** @type {!HTMLInputElement} */ (this.el_("metrics-b"));
		a.disabled = !this.slots_[0].log;
		b.disabled = !this.slots_[1].log;
		const shared = /** @type {!HTMLInputElement} */ (
			this.el_("metrics-shared")
		);
		shared.disabled = a.disabled || b.disabled;
		this.el_("metrics-shared-option").hidden = shared.disabled;
		if (this.metricsSlot_ === 0 && a.disabled && !b.disabled)
			this.metricsSlot_ = 1;
		if (this.metricsSlot_ === 1 && b.disabled && !a.disabled)
			this.metricsSlot_ = 0;
		a.checked = this.metricsSlot_ === 0;
		b.checked = this.metricsSlot_ === 1;

		const slot = this.slots_[this.metricsSlot_];
		const status = this.el_("metrics-status");
		const chart = this.el_("metrics-chart");
		const timeline = this.timeline_(slot);
		const total = timeline?.rows.length || 0;
		chart.hidden = !total;
		status.title = "";
		if (!timeline || !total) {
			this.waterfall_?.setTimeline(null, 1);
			status.textContent = slot.log
				? slot.name + " contains no spawns."
				: "Load a compact execution log to see spawn timings.";
			return;
		}
		const base =
			slot.name +
			" · " +
			total.toLocaleString() +
			(total === 1 ? " spawn" : " spawns");
		const missing = timeline.unknownStart - timeline.skippedCacheStarts;
		const cache = timeline.skippedCacheStarts;
		const other =
			shared.checked && !shared.disabled
				? this.timeline_(this.slots_[1 - this.metricsSlot_])
				: null;
		const extent = Math.max(1, timeline.extent, other?.extent || 0);
		const summary = [base];
		if (missing)
			summary.push(missing.toLocaleString() + " without a recorded start");
		if (cache)
			summary.push(
				cache.toLocaleString() +
					(cache === 1 ? " cached start ignored" : " cached starts ignored"),
			);
		if (timeline.recordedSpan !== null)
			summary.push("Recorded spawn span " + formatTime(timeline.recordedSpan));
		if (other) summary.push("Shared scale " + formatTime(extent));
		else if (
			timeline.recordedSpan !== null &&
			timeline.extent > timeline.recordedSpan
		) {
			summary.push("Scale includes longer duration-only spawns");
		}
		status.textContent = summary.join(" · ");
		status.title = timingExtentDetails(timeline);
		this.waterfall_?.setTimeline(timeline, extent);
	}

	/**
	 * @private
	 * @param {!LogSlot} slot
	 * @return {?SpawnTimeline}
	 */
	timeline_(slot) {
		const log = slot.log;
		if (!log || slot.timeline) return slot.timeline;
		/** @type {!Array<!ExecLogEntry.Spawn>} */
		const spawns = [];
		for (const action of log.actions)
			if (action.spawn) spawns.push(action.spawn);
		slot.timeline = buildSpawnTimeline(spawns);
		return slot.timeline;
	}

	/** @private */
	renderDiff_() {
		const a = /** @type {!HTMLInputElement} */ (this.el_("include-a")).checked
			? this.slots_[0].log
			: null;
		const b = /** @type {!HTMLInputElement} */ (this.el_("include-b")).checked
			? this.slots_[1].log
			: null;
		if (a && b) {
			this.comparison_ ||= compareLogs(a, b);
			this.pairs_ = this.comparison_;
		} else if (a) {
			this.pairs_ = a.actions.map((action) => ({
				a: action,
				b: null,
				changed: false,
			}));
		} else if (b) {
			this.pairs_ = b.actions.map((action) => ({
				a: null,
				b: action,
				changed: false,
			}));
		} else {
			this.pairs_ = [];
		}
		const pairs = this.pairs_;
		/** @type {!Array<!GraphNode>} */
		const nodes = pairs.map((pair) => ({
			label: pair.b?.mnemonic || pair.a?.mnemonic || "Action",
			unchanged: !!a && !!b && !pair.changed,
			a: this.graphSide_(pair.a),
			b: this.graphSide_(pair.b),
			inputs: new Set(),
			x: 0,
			y: 0,
			radius: 0,
		}));
		if (a) this.connectGraph_(a, nodes, true);
		if (b) this.connectGraph_(b, nodes, false);
		const visible = !!nodes.length;
		this.el_("diff-canvas").hidden = !visible;
		this.el_("diff-fit").hidden = !visible;
		this.el_("diff-help").hidden = !visible;
		this.el_("diff-key").hidden = !visible || !a || !b;
		this.el_("diff-detail").hidden = true;
		this.graph_?.setNodes(nodes);
		this.changes_ = [];
		if (a && b)
			pairs.forEach((pair, index) => {
				if (pair.changed) this.changes_.push(index);
			});
		const status = this.el_("diff-status");
		if (!a && !b) {
			status.textContent = this.slots_.some((slot) => slot.log)
				? "Check an invocation to show its graph."
				: "Load a compact execution log to see its dependency graph.";
		} else if (!visible) {
			status.textContent = "The selected logs contain no recorded actions.";
		} else {
			status.textContent =
				nodes.length.toLocaleString() +
				(nodes.length === 1 ? " node" : " nodes");
			if (a && b) {
				status.textContent +=
					" · " + this.changes_.length.toLocaleString() + " changed";
			} else {
				status.textContent +=
					" · " + (a ? this.slots_[0].name : this.slots_[1].name);
			}
		}
		this.renderChanges_(0);
	}

	/**
	 * @private
	 * @param {?LogAction} action
	 * @return {?GraphSide}
	 */
	graphSide_(action) {
		if (!action) return null;
		return {
			color: action.mnemonic ? mnemonicColor(action.mnemonic) : "",
			cached: !!action.spawn?.getCacheHit(),
			failed: action.outcome === "failed",
			duration: action.duration,
		};
	}

	/**
	 * @private
	 * @param {!ExecutionData} log
	 * @param {!Array<!GraphNode>} nodes
	 * @param {boolean} left
	 */
	connectGraph_(log, nodes, left) {
		/** @type {!Map<!LogAction, number>} */
		const indices = new Map();
		this.pairs_.forEach((pair, i) => {
			const action = left ? pair.a : pair.b;
			if (action) indices.set(action, i);
		});
		/** @type {!Array<number|undefined>} */
		const mapped = log.actions.map((action) => indices.get(action));
		dependencies(log).forEach((inputs, i) => {
			const consumer = mapped[i];
			if (consumer === undefined) return;
			for (const input of inputs) {
				const producer = mapped[input];
				if (producer !== undefined && producer !== consumer)
					nodes[consumer].inputs.add(producer);
			}
		});
	}

	/**
	 * @private
	 * @param {number} page
	 */
	renderChanges_(page) {
		this.diffPage_ = page;
		const total = this.changes_.length;
		this.el_("diff-list").hidden = !total;
		const rows = this.el_("diff-rows");
		dom.removeChildren(rows);
		const start = page * PAGE_SIZE;
		const end = Math.min(start + PAGE_SIZE, total);
		for (let i = start; i < end; i++) {
			const index = this.changes_[i];
			const pair = this.pairs_[index];
			const left = this.diffCell_(pair.a, index, "A");
			left.appendChild(
				dom.createDom(
					"button",
					{
						"type": "button",
						"class": "btn-link ml-2",
						"data-entry": String(index),
						"data-mode": "diff",
					},
					"Diff",
				),
			);
			rows.appendChild(
				dom.createDom("tr", null, left, this.diffCell_(pair.b, index, "B")),
			);
		}
		this.el_("diff-pagination").hidden = total <= PAGE_SIZE;
		this.el_("diff-page").textContent =
			(start + 1).toLocaleString() +
			"–" +
			end.toLocaleString() +
			" of " +
			total.toLocaleString();
		/** @type {!HTMLButtonElement} */ (this.el_("diff-prev")).disabled =
			start === 0;
		/** @type {!HTMLButtonElement} */ (this.el_("diff-next")).disabled =
			end >= total;
	}

	/**
	 * @private
	 * @param {?LogAction} action
	 * @param {number} index
	 * @param {string} side
	 * @return {!Element}
	 */
	diffCell_(action, index, side) {
		if (!action)
			return dom.createDom(
				"td",
				"color-fg-muted",
				dom.createDom("span", null, "No matching entry"),
			);
		return dom.createDom(
			"td",
			null,
			dom.createDom("div", "text-bold", action.mnemonic || "Action"),
			dom.createDom("div", "text-small", action.target),
			dom.createDom(
				"div",
				"text-small color-fg-muted",
				action.outputs[0] || "",
			),
			dom.createDom(
				"button",
				{
					"type": "button",
					"class": "btn-link",
					"data-entry": String(index),
					"data-mode": side.toLowerCase(),
				},
				"Spawn " + side,
			),
		);
	}

	/**
	 * @private
	 * @param {number} index
	 * @param {string} mode
	 * @param {boolean} focus
	 */
	selectDiff_(index, mode, focus) {
		const pair = this.pairs_[index];
		this.graph_?.highlight(index);
		if (!pair) return;
		const body = this.el_("diff-body");
		const heading = this.el_("diff-heading");
		dom.removeChildren(body);
		this.el_("diff-detail").hidden = false;
		const a = this.slots_[0].log;
		const b = this.slots_[1].log;
		if (
			mode === "a" ||
			(mode === "diff" && pair.a && !pair.b && !pair.changed)
		) {
			if (a && pair.a) {
				heading.textContent = (pair.a.mnemonic || "Action") + " · Invocation A";
				this.renderSpawn_(body, pair.a, a);
			}
		} else if (
			mode === "b" ||
			(mode === "diff" && pair.b && !pair.a && !pair.changed)
		) {
			if (b && pair.b) {
				heading.textContent = (pair.b.mnemonic || "Action") + " · Invocation B";
				this.renderSpawn_(body, pair.b, b);
			}
		} else {
			heading.textContent =
				(pair.b?.mnemonic || pair.a?.mnemonic || "Action") + " · Spawn diff";
			this.renderFieldDiff_(
				body,
				pair.a && a ? spawnFields(pair.a, a) : new Map(),
				pair.b && b ? spawnFields(pair.b, b) : new Map(),
			);
		}
		if (focus) heading.focus();
	}

	/**
	 * @private
	 * @param {!HTMLElement} body
	 * @param {!Map<string, !Array<string>>} a
	 * @param {!Map<string, !Array<string>>} b
	 */
	renderFieldDiff_(body, a, b) {
		/** @type {!Set<string>} */
		const names = new Set([...a.keys(), ...b.keys()]);
		const columns = dom.createDom(
			"div",
			"execution-log-field-values text-bold mb-2",
			dom.createDom("span", null, "Invocation A"),
			dom.createDom("span", null, "Invocation B"),
		);
		const metadata = dom.createDom(
			"details",
			"mt-3",
			dom.createDom("summary", null, "Log-local metadata"),
		);
		let changes = 0;
		for (const name of names) {
			const before = a.get(name) || [];
			const after = b.get(name) || [];
			if (equalValues(name, before, after)) continue;
			const field = dom.createDom(
				"section",
				"mb-2",
				dom.createDom("h3", "h5 mb-1", name),
				dom.createDom(
					"div",
					"execution-log-field-values",
					dom.createDom(
						"pre",
						{
							"class": "action-query-command execution-log-before",
							"aria-label": "Invocation A",
						},
						before.join("\n") || "—",
					),
					dom.createDom(
						"pre",
						{
							"class": "action-query-command execution-log-after",
							"aria-label": "Invocation B",
						},
						after.join("\n") || "—",
					),
				),
			);
			if (comparableField(name)) {
				if (!changes) body.appendChild(columns);
				body.appendChild(field);
				changes++;
			} else {
				metadata.appendChild(field);
			}
		}
		if (!changes)
			body.appendChild(
				dom.createDom("p", "color-fg-muted", "No spawn differences."),
			);
		if (metadata.children.length > 1) body.appendChild(metadata);
	}

	/**
	 * @private
	 * @param {?LogAction} action
	 */
	select_(action) {
		const body = this.el_("detail-body");
		dom.removeChildren(body);
		this.el_("detail").hidden = !action;
		const log = this.slots_[this.tab_].log;
		if (!action || !log) return;
		this.el_("detail-heading").textContent = action.mnemonic || "Action";
		this.renderSpawn_(body, action, log);
	}

	/**
	 * @private
	 * @param {!HTMLElement} body
	 * @param {!LogAction} action
	 * @param {!ExecutionData} log
	 */
	renderSpawn_(body, action, log) {
		if (action.target)
			body.appendChild(dom.createDom("p", null, action.target));
		const spawn = action.spawn;
		if (action.outcome === "failed" && spawn) {
			body.appendChild(
				dom.createDom(
					"p",
					"color-fg-danger",
					(spawn.getStatus() || "Failed") +
						" · Exit code " +
						spawn.getExitCode(),
				),
			);
		}
		/** @type {!Array<string>} */
		const metrics = [];
		/** @type {!Array<string>} */
		const summary = [];
		const fields = spawnFields(action, log);
		/** @type {!Set<string>} */
		const lists = new Set([
			"Command arguments",
			"Environment variables",
			"Execution platform",
			"Inputs",
			"Tools",
			"Outputs",
			"Symlink target",
		]);
		fields.forEach((values, name) => {
			if (name.startsWith("Metrics · ")) {
				metrics.push(
					name.slice("Metrics · ".length) + " = " + (values[0] || "—"),
				);
			} else if (
				!lists.has(name) &&
				name !== "Target label" &&
				name !== "Mnemonic"
			) {
				summary.push(name + " = " + (values.join(", ") || "—"));
			}
		});
		this.appendDetails_(body, "Spawn fields", summary);
		for (const name of lists)
			this.appendDetails_(body, name, fields.get(name) || []);
		this.appendDetails_(body, "Execution metrics", metrics);
	}

	/**
	 * @private
	 * @param {!HTMLElement} body
	 * @param {string} title
	 * @param {!Array<string>} values
	 */
	appendDetails_(body, title, values) {
		if (!values.length) return;
		body.appendChild(
			dom.createDom(
				"details",
				"mb-2",
				dom.createDom(
					"summary",
					"text-bold",
					title + " (" + values.length.toLocaleString() + ")",
				),
				dom.createDom("pre", "action-query-command mt-2", values.join("\n")),
			),
		);
	}
}

exports = ExecutionLog;
