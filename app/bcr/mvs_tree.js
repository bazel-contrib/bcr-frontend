/**
 * @fileoverview MVS Dependency Tree component using template-based TreeView.
 */

goog.module("bcrfrontend.mvs_tree");

const Component = goog.require("goog.ui.Component");
const { TreeView } = goog.require("bcrfrontend.treeview");
const { MVS } = goog.require("bcrfrontend.mvs");

/**
 * Component that displays an MVS dependency tree using the new TreeView.
 */
class MvsDependencyTree extends Component {
	/**
	 * @param {string} moduleName The root module name
	 * @param {string} version The root module version
	 * @param {!MVS} mvs The MVS instance
	 * @param {(boolean|string)=} includeDev Whether to include dev dependencies: false (exclude), true (include all), 'only' (only dev)
	 * @param {?goog.dom.DomHelper=} opt_domHelper
	 */
	constructor(
		moduleName,
		version,
		mvs,
		includeDev = false,
		opt_domHelper = null,
	) {
		super(opt_domHelper);

		/** @private @const {string} */
		this.moduleName_ = moduleName;

		/** @private @const {string} */
		this.version_ = version;

		/** @private @const {!MVS} */
		this.mvs_ = mvs;

		/** @private @const {(boolean|string)} */
		this.includeDev_ = includeDev;

		/** @private {?TreeView} */
		this.treeView_ = null;
	}

	/** @override */
	createDom() {
		this.setElementInternal(this.dom_.createDom("div", "mvs-tree-container"));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		// Compute the dependency tree - pass directly to TreeView
		const dependencyTree = this.mvs_.computeDependencyTree(
			this.moduleName_,
			this.version_,
			this.includeDev_,
		);

		if (!dependencyTree) {
			console.error(
				`Failed to compute dependency tree for ${this.moduleName_}@${this.version_}`,
			);
			return;
		}

		// Create and render the TreeView with the DependencyTree directly
		this.treeView_ = new TreeView(dependencyTree);
		this.addChild(this.treeView_, true);
	}

	/** @override */
	disposeInternal() {
		if (this.treeView_) {
			this.treeView_.dispose();
			this.treeView_ = null;
		}
		super.disposeInternal();
	}
}

exports = { MvsDependencyTree };
