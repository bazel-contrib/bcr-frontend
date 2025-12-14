/**
 * @fileoverview TreeView component for rendering DependencyTree with Primer styling.
 */

goog.module('centrl.treeview');

const Component = goog.require('goog.ui.Component');
const soy = goog.require('goog.soy');
const { dependencyTree } = goog.require('soy.centrl.treeview');
const { DependencyTree } = goog.requireType('centrl.mvs');

/**
 * TreeView component that renders a DependencyTree.
 */
class TreeView extends Component {
    /**
     * @param {!DependencyTree} tree The dependency tree to render
     * @param {?goog.dom.DomHelper=} opt_domHelper
     */
    constructor(tree, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const {!DependencyTree} */
        this.tree_ = tree;
    }

    /** @override */
    createDom() {
        this.setElementInternal(soy.renderAsElement(dependencyTree, {
            tree: this.tree_
        }));
    }
}

exports = { TreeView };
