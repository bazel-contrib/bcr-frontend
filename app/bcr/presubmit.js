goog.module("bcrfrontend.presubmit");

const Presubmit = goog.require("proto.build.stack.bazel.registry.v1.Presubmit");
const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { MarkdownComponent } = goog.require("bcrfrontend.markdown");
const { Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { presubmitComponent, presubmitSelect } = goog.require(
	"soy.bcrfrontend.app",
);
const { computeAllPresubmitFacets } = goog.require("bcrfrontend.registry");
const { highlightAll } = goog.require("bcrfrontend.syntax");

/**
 * @enum {string}
 */
const TabName = {
	OVERVIEW: "overview",
};

class PresubmitSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?Presubmit} presubmit
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, presubmit, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {?Presubmit} */
		this.presubmit_ = presubmit;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(presubmitSelect, {}));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.OVERVIEW, route.add(TabName.OVERVIEW));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (this.presubmit_) {
			if (name === TabName.OVERVIEW) {
				this.addTab(
					name,
					new PresubmitOverviewComponent(
						this.registry_,
						this.moduleVersion_,
						this.presubmit_,
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
exports.PresubmitSelect = PresubmitSelect;

class PresubmitOverviewComponent extends MarkdownComponent {
	/**
	 * @param {!Registry} registry
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Presubmit} presubmit
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, moduleVersion, presubmit, opt_domHelper) {
		super(opt_domHelper);

		/** @protected @const */
		this.registry_ = registry;

		/** @protected @const */
		this.moduleVersion_ = moduleVersion;

		/** @protected @const */
		this.presubmit_ = presubmit;
	}

	/**
	 * @override
	 */
	createDom() {
		const facets = computeAllPresubmitFacets(this.registry_);
		const matrix =
			this.presubmit_.getBcrTestModule()?.getMatrix() ||
			this.presubmit_.getMatrix();
		const activePlatforms = new Set(matrix ? matrix.getPlatformList() : []);
		const activeBazelVersions = new Set(matrix ? matrix.getBazelList() : []);
		const platforms = facets.platforms.map((value) => ({
			value,
			active: activePlatforms.has(value),
		}));
		const bazelVersions = facets.bazelVersions.map((value) => ({
			value,
			active: activeBazelVersions.has(value),
		}));

		this.setElementInternal(
			soy.renderAsElement(presubmitComponent, {
				moduleVersion: this.moduleVersion_,
				presubmit: this.presubmit_,
				platforms,
				bazelVersions,
			}),
		);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		highlightAll(this.getElementStrict());
	}
}
