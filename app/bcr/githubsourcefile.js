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

		/** @protected @const @type {!Module} */
		this.module_ = module;

		/** @protected @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @protected @const @type {string} */
		this.filePath_ = filePath;

		/** @private @const @type {!Function} */
		this.templateFn_ = templateFn;

		/** @protected @type {?Object} */
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
	 * Fetch source file from GitHub for the specific commit. Subclasses may
	 * override to substitute a different fetch URL (e.g. a BCR overlay file).
	 * @protected
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

		this.fetchAndRender_(sourceUrl);
	}

	/**
	 * Fetch the file at `url` (with a 10s timeout) and update the source view.
	 * Subclasses use this when the upstream-repo path doesn't apply (e.g.
	 * overlay files served from the BCR archive on GitHub).
	 * @param {string} url
	 * @protected
	 */
	fetchAndRender_(url) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);

		fetch(url, { signal: controller.signal })
			.then((response) => {
				clearTimeout(timeoutId);
				if (!response.ok) {
					throw new Error(`Source file not found (${response.status})`);
				}
				return response.text();
			})
			.then(
				/**
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

/**
 * Extracts {owner, repo} from a github.com URL of the forms
 * `https://github.com/<owner>/<repo>(.git)?` or `git@github.com:<owner>/<repo>.git`.
 * Returns null if the URL doesn't match GitHub's pattern.
 * @param {string} url
 * @return {?{owner: string, repo: string}}
 */
function parseGitHubRepoUrl(url) {
	const m = url.match(
		/^(?:https:\/\/github\.com\/|git@github\.com:)([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
	);
	if (!m) return null;
	return { owner: m[1], repo: m[2] };
}

exports = { GitHubSourceFileComponent, parseGitHubRepoUrl };
