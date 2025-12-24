goog.module("bcrfrontend.githubsourcefile");

const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const RepositoryType = goog.require(
	"proto.build.stack.bazel.registry.v1.RepositoryType",
);
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { getLatestModuleVersion } = goog.require("bcrfrontend.registry");
const { highlightAll } = goog.require("bcrfrontend.syntax");

/**
 * Component for displaying source files from GitHub repositories.
 * Fetches and displays file content from a specific commit with syntax highlighting.
 */
class GitHubSourceFileComponent extends Component {
	/**
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {string} filePath - Relative file path from repository root
	 * @param {!Function} templateFn - Soy template function for rendering
	 * @param {?Object=} opt_templateData - Optional additional data to pass to template
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(
		module,
		moduleVersion,
		filePath,
		templateFn,
		opt_templateData,
		opt_domHelper,
	) {
		super(opt_domHelper);

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {string} */
		this.filePath_ = filePath;

		/** @private @const @type {!Function} */
		this.templateFn_ = templateFn;

		/** @private @const @type {?Object} */
		this.templateData_ = opt_templateData || null;

		/** @private @type {boolean} */
		this.loading_ = true;

		/** @private @type {?string} */
		this.sourceContent_ = null;

		/** @private @type {?string} */
		this.error_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		const templateData = {
			moduleVersion: this.moduleVersion_,
			filePath: this.filePath_,
			loading: this.loading_,
			error: this.error_ || undefined,
			content: this.sourceContent_ || undefined,
			...(this.templateData_ || {}),
		};

		this.setElementInternal(
			soy.renderAsElement(this.templateFn_, templateData),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.fetchSource_();
	}

	/**
	 * Fetch source file from GitHub for the specific commit
	 * @private
	 */
	fetchSource_() {
		const metadata = this.moduleVersion_.getRepositoryMetadata();

		// Only fetch if it's a GitHub repo
		if (!metadata || metadata.getType() !== RepositoryType.GITHUB) {
			this.error_ = "Source is only available for GitHub repositories";
			this.loading_ = false;
			this.updateDom_();
			return;
		}

		// Get commit SHA from current version, or fall back to latest version, or use HEAD
		let commitSha = this.moduleVersion_.getSource()?.getCommitSha();
		if (!commitSha) {
			// Use the latest version's commit SHA
			const latestVersion = getLatestModuleVersion(this.module_);
			commitSha = latestVersion?.getSource()?.getCommitSha();
			if (!commitSha) {
				// Fall back to HEAD which resolves to the default branch
				commitSha = "HEAD";
			}
		}

		const org = metadata.getOrganization();
		const repo = metadata.getName();
		const sourceUrl = `https://raw.githubusercontent.com/${org}/${repo}/${commitSha}/${this.filePath_}`;

		// Create an AbortController for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);

		fetch(sourceUrl, { signal: controller.signal })
			.then((response) => {
				clearTimeout(timeoutId);
				if (!response.ok) {
					throw new Error(`Source file not found (${response.status})`);
				}
				return response.text();
			})
			.then(
				/**
				 * Success callback
				 * @param {string} content
				 */
				(content) => {
					this.sourceContent_ = content;
					this.loading_ = false;
					this.updateDom_();
				},
			)
			.catch((err) => {
				clearTimeout(timeoutId);
				if (err instanceof Error) {
					if (err.name === "AbortError") {
						this.error_ = "Source file fetch timed out after 10 seconds";
					} else {
						this.error_ = err.message;
					}
				}
				this.loading_ = false;
				this.updateDom_();
			});
	}

	/**
	 * Update the DOM with new content
	 * @private
	 */
	updateDom_() {
		const templateData = {
			moduleVersion: this.moduleVersion_,
			filePath: this.filePath_,
			loading: this.loading_,
			error: this.error_ || undefined,
			content: this.sourceContent_ || undefined,
			...(this.templateData_ || {}),
		};

		const newElement = soy.renderAsElement(this.templateFn_, templateData);

		if (this.getElement()) {
			dom.replaceNode(newElement, this.getElement());
			this.setElementInternal(newElement);
			// Apply syntax highlighting after update
			highlightAll(this.getElementStrict());
		}
	}
}

exports = { GitHubSourceFileComponent };
