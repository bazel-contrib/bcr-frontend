/**
 * @fileoverview SelectNav base class for navigation-based select components.
 */
goog.module("bcrfrontend.SelectNav");

const ComponentEventType = goog.require("goog.ui.Component.EventType");
const arrays = goog.require("goog.array");
const dataset = goog.require("goog.dom.dataset");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { navItem } = goog.require("soy.bcrfrontend.app");

/**
 * @abstract
 */
class SelectNav extends ContentSelect {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);

		/**
		 * Factories for tabs registered via addNavTabLazy. Looked up by
		 * route name in selectFail to recreate the component on demand
		 * after the previous instance was disposed (see
		 * stack.ui.Select.hideCurrent).
		 * @private @const @type {!Object<string, function():!Component>}
		 */
		this.lazyFactories_ = {};
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		this.getHandler().listen(
			this,
			[ComponentEventType.SHOW, ComponentEventType.HIDE],
			this.handleShowHide,
		);
	}

	/**
	 * @abstract
	 * @returns {string}
	 */
	getDefaultTabName() {}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(this.getDefaultTabName(), route.add(this.getDefaultTabName()));
	}

	/**
	 * @return {!HTMLElement}
	 */
	getNavElement() {
		return this.getCssElement(goog.getCssName("nav"));
	}

	/**
	 * @param {string} name
	 * @param {string} label
	 * @param {string} title
	 * @param {number|undefined} count
	 * @param {!Component} c
	 * @returns {!Component}
	 */
	addNavTab(name, label, title, count, c) {
		const rv = super.addTab(name, c);

		const item = this.createMenuItem(name, label, title, count, c.getPathUrl());
		// Key nav-item DOM ids on the route name (stable) rather than the
		// component id (changes after dispose+recreate). Replace any stale
		// item with the same id (e.g. from a prior visit to this route).
		const fragmentId = this.makeId(name);
		item.id = fragmentId;
		const existing = dom.getElement(fragmentId);
		if (existing) {
			dom.removeNode(existing);
		}

		dom.append(this.getNavElement(), item);
		return rv;
	}

	/**
	 * Adds a nav item without the component - component will be added lazily in selectFail.
	 * @param {string} name
	 * @param {string} label
	 * @param {string} title
	 * @param {number|undefined} count
	 * @param {string} path The URL path for this tab
	 */
	addNavTabDeferred(name, label, title, count, path) {
		const item = this.createMenuItem(name, label, title, count, path);
		const fragmentId = this.makeId(name);
		item.id = fragmentId;
		const existing = dom.getElement(fragmentId);
		if (existing) {
			dom.removeNode(existing);
		}
		dom.append(this.getNavElement(), item);
	}

	/**
	 * Adds a nav item AND registers a factory to lazily build the
	 * component on demand. The component is created the first time the
	 * user navigates to this tab, and re-created on each visit after the
	 * previous instance was disposed.
	 *
	 * @param {string} name
	 * @param {string} label
	 * @param {string} title
	 * @param {number|undefined} count
	 * @param {string} path
	 * @param {function():!Component} factory
	 */
	addNavTabLazy(name, label, title, count, path, factory) {
		this.addNavTabDeferred(name, label, title, count, path);
		this.lazyFactories_[name] = factory;
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		const factory = this.lazyFactories_[name];
		if (factory) {
			this.addTab(name, factory());
			this.select(name, route);
			return;
		}
		super.selectFail(name, route);
	}

	/**
	 * @param {string} name
	 * @param {string} label
	 * @param {string} title
	 * @param {number|undefined} count
	 * @param {string} path
	 * @return {!Element}
	 */
	createMenuItem(name, label, title, count, path) {
		const a = soy.renderAsElement(navItem, {
			label,
			title,
			count,
		});
		a.href = "/" + path;
		dataset.set(a, "name", name);
		return a;
	}

	/**
	 * @param {!events.Event} e
	 */
	handleShowHide(e) {
		const target = /** @type {!Component} */ (e.target);

		// Check that the target is a child of us
		const child = this.getChild(target.getId());
		if (!child) {
			return;
		}

		// Find the menu item element by route name (stable across
		// dispose+recreate cycles), not by component id (transient).
		const targetName = target.getName();
		if (!targetName) {
			return;
		}
		const fragmentId = this.makeId(targetName);
		const item = dom.getElement(fragmentId);
		if (!item) {
			return;
		}

		// Get the parent element and find the current active item.
		const menu = dom.getParentElement(item);
		const activeItems = dom.getElementsByClass("UnderlineNav-item", menu);
		if (activeItems && activeItems.length) {
			arrays.forEach(activeItems, (el) => dom.classlist.remove(el, "selected"));
		}

		dom.classlist.add(item, "selected");
	}
}

exports.SelectNav = SelectNav;
