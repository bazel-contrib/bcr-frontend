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
		const fragmentId = this.makeId(c.getId());
		item.id = fragmentId;

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
		dom.append(this.getNavElement(), item);
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
		a.href = "/#/" + path;
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

		// Find the menu item element corresponding to the child
		const fragmentId = this.makeId(target.getId());
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
