/**
 * @fileoverview MVS Dependency Tree component using template-based TreeView.
 */

goog.module('centrl.mvs_tree');

const Component = goog.require('goog.ui.Component');
const { TreeView } = goog.require('centrl.treeview');
const { MVS } = goog.require('centrl.mvs');

/**
 * Component that displays an MVS dependency tree using the new TreeView.
 */
class MvsDependencyTree extends Component {
    /**
     * @param {string} moduleName The root module name
     * @param {string} version The root module version
     * @param {!MVS} mvs The MVS instance
     * @param {boolean=} includeDev Whether to include dev dependencies (default: false)
     * @param {?goog.dom.DomHelper=} opt_domHelper
     * @param {boolean=} expanded Whether to start expanded (default: false)
     */
    constructor(moduleName, version, mvs, includeDev = false, opt_domHelper = null, expanded = false) {
        super(opt_domHelper);

        /** @private @const {string} */
        this.moduleName_ = moduleName;

        /** @private @const {string} */
        this.version_ = version;

        /** @private @const {!MVS} */
        this.mvs_ = mvs;

        /** @private @const {boolean} */
        this.includeDev_ = includeDev;

        /** @private @const {boolean} */
        this.expanded_ = expanded;

        /** @private {?TreeView} */
        this.treeView_ = null;
    }

    /** @override */
    createDom() {
        this.setElementInternal(this.dom_.createDom('div', 'mvs-tree-container'));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        // Compute the dependency tree - pass directly to TreeView
        const dependencyTree = this.mvs_.computeDependencyTree(
            this.moduleName_,
            this.version_,
            this.includeDev_
        );

        if (!dependencyTree) {
            console.error(`Failed to compute dependency tree for ${this.moduleName_}@${this.version_}`);
            return;
        }

        // Create and render the TreeView with the DependencyTree directly
        this.treeView_ = new TreeView(dependencyTree, this.expanded_);
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

    /**
     * Expands all nodes in the tree.
     */
    expandAll() {
        if (this.treeView_) {
            this.treeView_.expandAll();
        }
    }

    /**
     * Collapses all nodes in the tree.
     */
    collapseAll() {
        if (this.treeView_) {
            this.treeView_.collapseAll();
        }
    }
}

exports = { MvsDependencyTree };
