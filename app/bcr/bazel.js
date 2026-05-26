goog.module("bcrfrontend.bazel");

const Module = goog.requireType("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const {
	computeTopPrimaryLanguages,
	computeTotalBazelVersions,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	bazelOverviewSelectNav,
	bazelSelect,
	bazelVersionDetail,
	bazelVersionsTree,
} = goog.require("soy.bcrfrontend.app");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");
const { BazelFlagsByCommandComponent, BazelFlagsSelect } = goog.require(
	"bcrfrontend.bazelFlags",
);

const BAZEL_TOOLS = "bazel_tools";

/**
 * @enum {string}
 */
const TabName = {
	VERSIONS: "versions",
	FLAGS: "flags",
	COMMAND: "command",
};

/**
 * Top-level container for the /bazel route. Routes the literal "versions"
 * to the timeline overview; any other segment is treated as a Bazel version
 * string and resolved against bazel_tools.
 */
class BazelSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelSelect));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.VERSIONS, route.add(TabName.VERSIONS));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.VERSIONS) {
			this.addTab(
				TabName.VERSIONS,
				new BazelOverviewSelectNav(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		if (name === TabName.FLAGS) {
			this.addTab(
				TabName.FLAGS,
				new BazelFlagsSelect(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		if (name === TabName.COMMAND) {
			this.addTab(
				TabName.COMMAND,
				new BazelCommandSelect(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		const bazelTools = findBazelToolsModule(this.registry_);
		if (bazelTools) {
			const moduleVersion = bazelTools
				.getVersionsList()
				.find((v) => v.getVersion() === name);
			if (moduleVersion) {
				this.addTab(
					name,
					new BazelVersionDetailComponent(
						this.registry_,
						moduleVersion,
						this.dom_,
					),
				);
				this.select(name, route);
				return;
			}
		}

		super.selectFail(name, route);
	}
}
exports.BazelSelect = BazelSelect;

/**
 * Sub-Select at /bazel/command/. Consumes the next path segment as the command
 * name and instantiates BazelFlagsByCommandComponent for it.
 */
class BazelCommandSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelSelect));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		this.addTab(
			name,
			new BazelFlagsByCommandComponent(this.registry_, name, this.dom_),
		);
		this.select(name, route);
	}
}

/**
 * Tabbed overview at /bazel/versions. The single registered tab today is the
 * Versions timeline; the SelectNav shape leaves room for future siblings.
 */
class BazelOverviewSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const modules = createModuleMap(this.registry_);
		const maintainers = createMaintainersMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}

		this.setElementInternal(
			soy.renderAsElement(bazelOverviewSelectNav, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalSymbols: computeTotalSymbols(this.registry_),
				topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return TabName.VERSIONS;
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addNavTabLazy(
			TabName.VERSIONS,
			"Versions",
			"Bazel Versions",
			undefined,
			`${this.getPathUrl()}/${TabName.VERSIONS}`,
			() => new BazelVersionsComponent(this.registry_, this.dom_),
		);

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}
}

class BazelVersionsComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(bazelVersionsTree, {
				majors: computeBazelVersionsTree(this.registry_),
			}),
		);
	}
}

/**
 * Detail page for a single Bazel release at /bazel/<version>.
 */
class BazelVersionDetailComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, moduleVersion, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;
	}

	/**
	 * @override
	 */
	createDom() {
		const modules = createModuleMap(this.registry_);
		const maintainers = createMaintainersMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}

		this.setElementInternal(
			soy.renderAsElement(bazelVersionDetail, {
				registry: this.registry_,
				moduleVersion: this.moduleVersion_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalSymbols: computeTotalSymbols(this.registry_),
				topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}
}

/**
 * @param {!Registry} registry
 * @returns {?Module}
 */
function findBazelToolsModule(registry) {
	const modules = createModuleMap(registry);
	return modules.get(BAZEL_TOOLS) || null;
}

/**
 * Splits "8.7.0rc2" into numeric major/minor/patch plus the pre-release tail
 * decomposed as (prePrefix, preNum). Returns null when the version doesn't
 * match the expected X.Y.Z[suffix] shape.
 *
 * @param {string} v
 * @returns {?{major: number, minor: number, patch: number, pre: string, prePrefix: string, preNum: number}}
 */
function parseBazelSemver(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
	if (!m) return null;
	const pre = m[4];
	let prePrefix = pre;
	let preNum = 0;
	const preMatch = /^([a-zA-Z]+)(\d+)$/.exec(pre);
	if (preMatch) {
		prePrefix = preMatch[1];
		preNum = +preMatch[2];
	}
	return {
		major: +m[1],
		minor: +m[2],
		patch: +m[3],
		pre,
		prePrefix,
		preNum,
	};
}

/**
 * @param {!ModuleVersion} v
 * @returns {!{moduleVersion: !ModuleVersion, commitDate: string, linkUrl: string, pullRequestUrl: string}}
 */
function makeBazelVersionRow(v) {
	const pr = v.getCommit().getPullRequest();
	return {
		moduleVersion: v,
		commitDate: formatRelativeShort(v.getCommit().getDate()),
		linkUrl: `/bazel/${v.getVersion()}`,
		pullRequestUrl: pr ? `https://github.com/bazelbuild/bazel/pull/${pr}` : "",
	};
}

/**
 * @typedef {{moduleVersion: !ModuleVersion, commitDate: string, linkUrl: string, pullRequestUrl: string}}
 */
let BazelVersionRow;

/**
 * @typedef {{prePrefix: string, preNum: number}}
 */
let PreParts;

/**
 * Internal patch bucket — one per X.Y.Z identifier, accumulates the final
 * release and all pre-releases observed.
 *
 * @typedef {{
 *   major: number,
 *   minor: number,
 *   patch: number,
 *   final: ?BazelVersionRow,
 *   prereleases: !Array<!BazelVersionRow>,
 *   preParts: !Array<!PreParts>
 * }}
 */
let PatchBucket;

/**
 * @typedef {{patch: number, final: ?BazelVersionRow, prereleases: !Array<!BazelVersionRow>}}
 */
let PatchOutput;

/**
 * @typedef {{minor: number, count: number, patches: !Array<!PatchOutput>}}
 */
let MinorOutput;

/**
 * @typedef {{major: number, count: number, isLatest: boolean, minors: !Array<!MinorOutput>}}
 */
let MajorOutput;

/**
 * Buckets every bazel_tools version with a commit date into a semver tree:
 * major → minor → patch → {final, prereleases}. Each level is sorted
 * descending so the latest releases appear first. The highest major is
 * marked isLatest so the template can default-expand it.
 *
 * @param {!Registry} registry
 * @returns {!Array<!MajorOutput>}
 */
function computeBazelVersionsTree(registry) {
	const bazelTools = findBazelToolsModule(registry);
	if (!bazelTools) return [];

	/** @type {!Map<string, !PatchBucket>} */
	const patchMap = new Map();

	for (const v of bazelTools.getVersionsList()) {
		const commit = v.getCommit();
		if (!commit || !commit.getDate()) continue;
		const parts = parseBazelSemver(v.getVersion());
		if (!parts) continue;

		const key = parts.major + "." + parts.minor + "." + parts.patch;
		let bucket = patchMap.get(key);
		if (!bucket) {
			bucket = {
				major: parts.major,
				minor: parts.minor,
				patch: parts.patch,
				final: null,
				prereleases: [],
				preParts: [],
			};
			patchMap.set(key, bucket);
		}

		const row = makeBazelVersionRow(v);
		if (parts.pre === "") {
			bucket.final = row;
		} else {
			bucket.prereleases.push(row);
			bucket.preParts.push({
				prePrefix: parts.prePrefix,
				preNum: parts.preNum,
			});
		}
	}

	/** @type {!Array<!PatchBucket>} */
	const buckets = Array.from(patchMap.values());

	// Sort prereleases inside each bucket: prePrefix asc, preNum desc.
	for (const bucket of buckets) {
		/** @type {!Array<!{row: !BazelVersionRow, parts: !PreParts}>} */
		const indexed = bucket.prereleases.map((row, i) => ({
			row,
			parts: bucket.preParts[i],
		}));
		indexed.sort((a, b) => {
			if (a.parts.prePrefix !== b.parts.prePrefix) {
				return a.parts.prePrefix < b.parts.prePrefix ? -1 : 1;
			}
			return b.parts.preNum - a.parts.preNum;
		});
		bucket.prereleases = indexed.map((x) => x.row);
	}

	// Sort all buckets by (major desc, minor desc, patch desc).
	buckets.sort((a, b) => {
		if (a.major !== b.major) return b.major - a.major;
		if (a.minor !== b.minor) return b.minor - a.minor;
		return b.patch - a.patch;
	});

	// Group consecutive buckets sharing the same major/minor.
	/** @type {!Array<!MajorOutput>} */
	const majors = [];
	/** @type {?MajorOutput} */
	let curMajor = null;
	/** @type {?MinorOutput} */
	let curMinor = null;
	for (const bucket of buckets) {
		const leafCount = (bucket.final ? 1 : 0) + bucket.prereleases.length;
		if (curMajor === null || curMajor.major !== bucket.major) {
			curMajor = {
				major: bucket.major,
				count: 0,
				isLatest: false,
				minors: [],
			};
			majors.push(curMajor);
			curMinor = null;
		}
		if (curMinor === null || curMinor.minor !== bucket.minor) {
			curMinor = { minor: bucket.minor, count: 0, patches: [] };
			curMajor.minors.push(curMinor);
		}
		curMinor.patches.push({
			patch: bucket.patch,
			final: bucket.final,
			prereleases: bucket.prereleases,
		});
		curMinor.count += leafCount;
		curMajor.count += leafCount;
	}

	if (majors.length > 0) {
		majors[0].isLatest = true;
	}

	return majors;
}
