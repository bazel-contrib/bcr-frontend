/**
 * @fileoverview TreeView component for rendering DependencyTree with Primer styling.
 */

goog.module('centrl.treeview');

const Component = goog.require('goog.ui.Component');
const EventType = goog.require('goog.events.EventType');
const soy = goog.require('goog.soy');
const { dependencyTree } = goog.require('soy.centrl.treeview');
const { DependencyTree } = goog.requireType('centrl.mvs');

/**
 * TreeView component that renders a DependencyTree.
 */
class TreeView extends Component {
    /**
     * @param {!DependencyTree} tree The dependency tree to render
     * @param {boolean=} expanded Whether items start expanded (default: false)
     * @param {?goog.dom.DomHelper=} opt_domHelper
     */
    constructor(tree, expanded = false, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const {!DependencyTree} */
        this.tree_ = tree;

        /** @private @const {boolean} */
        this.expanded_ = expanded;
    }

    /** @override */
    createDom() {
        this.setElementInternal(soy.renderAsElement(dependencyTree, {
            tree: this.tree_,
            expanded: this.expanded_
        }));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        // Add click handlers for expand/collapse buttons
        const buttons = this.getElement().querySelectorAll('.treeview-expand-button');
        buttons.forEach(button => {
            this.getHandler().listen(
                button,
                EventType.CLICK,
                this.handleExpandClick_,
            );
        });
    }

    /**
     * Handles clicks on expand/collapse buttons.
     * @param {!goog.events.BrowserEvent} e The click event
     * @private
     */
    handleExpandClick_(e) {
        e.preventDefault();
        e.stopPropagation();

        const button = /** @type {!Element} */ (e.target);
        const item = button.closest('.treeview-item');
        if (!item) return;

        const chevron = button.querySelector('.treeview-chevron');
        const children = item.querySelector('.treeview-children');
        const isExpanded = item.getAttribute('aria-expanded') === 'true';

        // Toggle state
        const newState = !isExpanded;
        item.setAttribute('aria-expanded', newState.toString());
        button.setAttribute('aria-label', newState ? 'Collapse' : 'Expand');

        if (chevron) {
            chevron.classList.toggle('treeview-chevron-expanded', newState);
        }

        if (children) {
            children.classList.toggle('treeview-children-expanded', newState);
            children.classList.toggle('treeview-children-collapsed', !newState);
        }
    }

    /**
     * Expands all items in the tree.
     */
    expandAll() {
        const items = this.getElement().querySelectorAll('.treeview-item[aria-expanded]');
        items.forEach(item => {
            item.setAttribute('aria-expanded', 'true');
            const button = item.querySelector('.treeview-expand-button');
            if (button) {
                button.setAttribute('aria-label', 'Collapse');
            }
            const chevron = item.querySelector('.treeview-chevron');
            if (chevron) {
                chevron.classList.add('treeview-chevron-expanded');
            }
            const children = item.querySelector('.treeview-children');
            if (children) {
                children.classList.add('treeview-children-expanded');
                children.classList.remove('treeview-children-collapsed');
            }
        });
    }

    /**
     * Collapses all items in the tree.
     */
    collapseAll() {
        const items = this.getElement().querySelectorAll('.treeview-item[aria-expanded]');
        items.forEach(item => {
            item.setAttribute('aria-expanded', 'false');
            const button = item.querySelector('.treeview-expand-button');
            if (button) {
                button.setAttribute('aria-label', 'Expand');
            }
            const chevron = item.querySelector('.treeview-chevron');
            if (chevron) {
                chevron.classList.remove('treeview-chevron-expanded');
            }
            const children = item.querySelector('.treeview-children');
            if (children) {
                children.classList.remove('treeview-children-expanded');
                children.classList.add('treeview-children-collapsed');
            }
        });
    }
}

exports = { TreeView };
