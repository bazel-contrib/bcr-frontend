/** @fileoverview Route the experimental Bazel tools. */
goog.module("bcrfrontend.tools");

const ActionQuery = goog.require("bcrfrontend.ActionQuery");
const CommandProfile = goog.require("bcrfrontend.CommandProfile");
const Query = goog.require("bcrfrontend.Query");
const ExecutionLog = goog.require("bcrfrontend.ExecutionLog");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { InvocationGroupsComponent } = goog.require(
	"bcrfrontend.invocationGroups",
);
const { RemoteCacheComponent } = goog.require("bcrfrontend.remoteCache");
const { RemoteExecutionComponent } = goog.require(
	"bcrfrontend.remoteExecution",
);
const { toolsCatalog, toolsSelect } = goog.require("soy.bcrfrontend.tools");

class ToolsSelect extends ContentSelect {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(toolsSelect));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select("catalog", route.add("catalog"));
	}

	/** @override @param {!Route} route */
	goDown(route) {
		if (route.peek() === "invocation") this.select("invocations", route);
		else super.goDown(route);
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === "catalog") {
			this.addTab(name, new ToolsCatalogComponent(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "invocations") {
			this.addTab(name, new InvocationGroupsComponent(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "remote-cache") {
			this.addTab(name, new RemoteCacheComponent(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "remote-execution") {
			this.addTab(name, new RemoteExecutionComponent(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "query") {
			this.addTab(name, new Query(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "action-query") {
			this.addTab(name, new ActionQuery(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "command-profile") {
			this.addTab(name, new CommandProfile(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "execution-log") {
			this.addTab(name, new ExecutionLog(this.dom_));
			this.select(name, route);
			return;
		}
		super.selectFail(name, route);
	}
}

class ToolsCatalogComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(toolsCatalog));
	}
}

exports.ToolsSelect = ToolsSelect;
