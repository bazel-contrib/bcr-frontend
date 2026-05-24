goog.module("bcrfrontend.starlark");

const AttributeInfo = goog.require("proto.stardoc_output.AttributeInfo");
const AttributeType = goog.require("proto.stardoc_output.AttributeType");
const File = goog.require("proto.build.stack.bazel.symbol.v1.File");
const FunctionParamInfo = goog.require(
	"proto.stardoc_output.FunctionParamInfo",
);
const FunctionParamRole = goog.require(
	"proto.stardoc_output.FunctionParamRole",
);
const Label = goog.require("proto.build.stack.starlark.v1beta1.Label");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Package = goog.require("proto.build.stack.starlark.v1beta1.Package");
const ProviderFieldInfo = goog.require(
	"proto.stardoc_output.ProviderFieldInfo",
);
const Symbol = goog.require("proto.build.stack.bazel.symbol.v1.Symbol");
const SymbolType = goog.require("proto.build.stack.bazel.symbol.v1.SymbolType");
const Target = goog.require("proto.build.stack.starlark.v1beta1.Target");
const Value = goog.require("proto.build.stack.starlark.v1beta1.Value");

/**
 * Helper class for building Starlark function call examples
 */
class StarlarkCallBuilder {
	/**
	 * @param {string} funcName - The function/rule/macro name
	 * @param {string=} resultPrefix - Optional prefix (e.g., "result = ")
	 */
	constructor(funcName, resultPrefix = "") {
		/** @private @const {string} */
		this.funcName_ = funcName;

		/** @private @const {string} */
		this.resultPrefix_ = resultPrefix;

		/** @private @const {!Array<string>} */
		this.positionalArgs_ = [];

		/** @private @const {!Array<{name: string, value: string, required: boolean}>} */
		this.keywordArgs_ = [];

		/** @private {?string} */
		this.varargs_ = null;

		/** @private {?string} */
		this.kwargs_ = null;
	}

	/**
	 * Add a positional argument
	 * @param {string} value
	 * @return {!StarlarkCallBuilder}
	 */
	addPositional(value) {
		this.positionalArgs_.push(value);
		return this;
	}

	/**
	 * Add a keyword argument
	 * @param {string} name
	 * @param {string} value
	 * @param {boolean=} required
	 * @return {!StarlarkCallBuilder}
	 */
	addKeyword(name, value, required = false) {
		this.keywordArgs_.push({ name, value, required });
		return this;
	}

	/**
	 * Set varargs (*args)
	 * @param {string} name
	 * @return {!StarlarkCallBuilder}
	 */
	setVarargs(name) {
		this.varargs_ = name;
		return this;
	}

	/**
	 * Set kwargs (**kwargs)
	 * @param {string} name
	 * @return {!StarlarkCallBuilder}
	 */
	setKwargs(name) {
		this.kwargs_ = name;
		return this;
	}

	/**
	 * Build the function call string
	 * @return {string}
	 */
	build() {
		const lines = [];

		// Count total arguments
		const totalArgs =
			this.positionalArgs_.length +
			this.keywordArgs_.length +
			(this.varargs_ ? 1 : 0) +
			(this.kwargs_ ? 1 : 0);

		// No arguments - single line
		if (totalArgs === 0) {
			return `${this.resultPrefix_}${this.funcName_}()`;
		}

		// Single argument - format on one line without "required" comment
		if (totalArgs === 1) {
			if (this.positionalArgs_.length === 1) {
				return `${this.resultPrefix_}${this.funcName_}(${this.positionalArgs_[0]})`;
			}
			if (this.keywordArgs_.length === 1) {
				const arg = this.keywordArgs_[0];
				return `${this.resultPrefix_}${this.funcName_}(${arg.name} = ${arg.value})`;
			}
			if (this.varargs_) {
				return `${this.resultPrefix_}${this.funcName_}(*${this.varargs_})`;
			}
			if (this.kwargs_) {
				return `${this.resultPrefix_}${this.funcName_}(**${this.kwargs_})`;
			}
		}

		// Multiple arguments - format multi-line with comments
		lines.push(`${this.resultPrefix_}${this.funcName_}(`);

		// Collect all argument lines first
		/** @type {!Array<string>} */
		const argLines = [];

		// Count total arguments to determine trailing commas
		const totalArgCount =
			this.positionalArgs_.length +
			this.keywordArgs_.length +
			(this.varargs_ ? 1 : 0) +
			(this.kwargs_ ? 1 : 0);

		let argIndex = 0;

		// Positional arguments
		this.positionalArgs_.forEach((value) => {
			argIndex++;
			const isLast = argIndex === totalArgCount;
			const comma = isLast ? "," : ","; // All args get trailing comma except **kwargs
			argLines.push(`    ${value}${comma}`);
		});

		// Keyword arguments - need to add commas before comments
		this.keywordArgs_.forEach((arg) => {
			argIndex++;
			const isLast = argIndex === totalArgCount;
			const comma = isLast ? "," : ","; // All args get trailing comma except **kwargs
			// Suppress "# required" comment for "name" attribute (implicitly required)
			const comment = arg.required && arg.name !== "name" ? "  # required" : "";
			argLines.push(`    ${arg.name} = ${arg.value}${comma}${comment}`);
		});

		// Varargs
		if (this.varargs_) {
			argIndex++;
			const isLast = argIndex === totalArgCount;
			const comma = isLast ? "," : ",";
			argLines.push(`    *${this.varargs_}${comma}`);
		}

		// Kwargs - never gets trailing comma
		if (this.kwargs_) {
			argLines.push(`    **${this.kwargs_}`);
		}

		// Add all argument lines
		argLines.forEach((line) => {
			lines.push(line);
		});

		lines.push(")");

		return lines.join("\n");
	}
}

/**
 * Generate a Starlark example for the provider
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateProviderExample(moduleVersion, file, sym) {
	const provider = sym.getProvider();
	if (!provider) {
		return "";
	}

	const providerName = sym.getName();
	const loadStmt = generateLoadStatement(moduleVersion, file, providerName);
	const lines = loadStmt ? [loadStmt, ""] : [];

	// Provider instantiation
	const fields = provider.getInfo().getFieldInfoList();

	if (fields.length === 0) {
		lines.push(`info = ${providerName}()`);
	} else {
		lines.push(`info = ${providerName}(`);
		fields.forEach((field) => {
			const value = getFieldExampleValue(field);
			lines.push(`    ${field.getName()} = ${value},`);
		});
		lines.push(")");
	}

	return lines.join("\n");
}
exports.generateProviderExample = generateProviderExample;

/**
 * Generate a Starlark example for the repository rule
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateRepositoryRuleExample(moduleVersion, file, sym) {
	const repoRule = sym.getRepositoryRule();
	if (!repoRule) {
		return "";
	}

	const ruleName = sym.getName();
	const builder = new StarlarkCallBuilder(ruleName);

	// Add attributes
	const attrs = repoRule.getInfo().getAttributeList();
	attrs.forEach((attr) => {
		const value = getAttributeExampleValue(attr, sym.getName());
		const isRequired = attr.getMandatory() || attr.getName() === "name";
		builder.addKeyword(attr.getName(), value, isRequired);
	});

	return joinExampleWithLoad(
		generateLoadStatement(moduleVersion, file, ruleName),
		builder.build(),
	);
}
exports.generateRepositoryRuleExample = generateRepositoryRuleExample;

/**
 * Generate a Starlark example for the aspect
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateAspectExample(moduleVersion, file, sym) {
	const aspect = sym.getAspect();
	if (!aspect) {
		return "";
	}

	const aspectName = sym.getName();
	const loadStmt = generateLoadStatement(moduleVersion, file, aspectName);
	const lines = loadStmt ? [loadStmt, ""] : [];

	// Aspect usage (typically used in a rule's aspects parameter)
	lines.push("# Example: Apply aspect to a target");
	lines.push("my_rule(");
	lines.push('    name = "my_target",  # required');
	lines.push(`    aspects = [${aspectName}],`);
	lines.push(")");

	return lines.join("\n");
}
exports.generateAspectExample = generateAspectExample;

/**
 * If symbolName is a qualified struct-field name (e.g. "types.is_bool"),
 * locate the parent struct symbol in the same file and return its name
 * (e.g. "types"). Returns null for ordinary top-level names.
 *
 * @param {!File} file
 * @param {string} symbolName
 * @returns {?string}
 */
function findParentStructName(file, symbolName) {
	if (symbolName.indexOf(".") < 0) {
		return null;
	}
	for (const sym of file.getSymbolList()) {
		if (sym.getType() !== SymbolType.SYMBOL_TYPE_STRUCT) {
			continue;
		}
		const struct = sym.getStruct();
		if (!struct) {
			continue;
		}
		for (const field of struct.getFieldList()) {
			if (field.getQualifiedName() === symbolName) {
				return sym.getName();
			}
		}
	}
	return null;
}

/**
 * Generate a load statement for the current symbol
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {string} symbolName - The name of the symbol to load
 * @returns {string}
 */
function generateLoadStatement(moduleVersion, file, symbolName) {
	const label = file.getLabel();
	if (!label) {
		return "";
	}
	// Synthetic pseudo-module files (e.g. @_builtins's "globals", "cpp",
	// "java") aren't real .bzl files and shouldn't pretend to be loadable.
	// The builtinscompiler reshape deliberately omits the .bzl suffix on
	// those labels — gate the load snippet on the suffix.
	if (!label.getName().endsWith(".bzl")) {
		return "";
	}

	const parent = findParentStructName(file, symbolName);
	const loadName = parent || symbolName;

	// Create a new Label with the module name as repo
	const loadLabel = label.clone();
	loadLabel.setRepo(moduleVersion.getName());

	const loadPath = formatLabel(loadLabel);
	return `load("${loadPath}", "${loadName}")`;
}

/**
 * Concatenate a load statement with the example body. If the load statement
 * is empty (e.g. for synthetic pseudo-module files where load() doesn't
 * apply), returns just the body — avoids a misleading blank-line prefix.
 *
 * @param {string} loadStatement
 * @param {string} body
 * @returns {string}
 */
function joinExampleWithLoad(loadStatement, body) {
	return loadStatement ? `${loadStatement}\n\n${body}` : body;
}

/**
 * Generate a Starlark example for the rule
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateRuleExample(moduleVersion, file, sym) {
	const rule = sym.getRule();
	if (!rule) {
		return "";
	}

	const ruleName = sym.getName();
	const builder = new StarlarkCallBuilder(ruleName);

	// Add attributes
	const attrs = rule.getInfo().getAttributeList();
	attrs.forEach((attr) => {
		const value = getAttributeExampleValue(attr, sym.getName());
		const isRequired = attr.getMandatory() || attr.getName() === "name";
		builder.addKeyword(attr.getName(), value, isRequired);
	});

	return joinExampleWithLoad(
		generateLoadStatement(moduleVersion, file, ruleName),
		builder.build(),
	);
}
exports.generateRuleExample = generateRuleExample;

/**
 * Generate a Starlark example for the function
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateFunctionExample(moduleVersion, file, sym) {
	const func = sym.getFunc();
	if (!func) {
		return "";
	}

	const funcName = sym.getName();
	const hasReturn = func.getInfo().getReturn() != null;
	const resultPrefix = hasReturn ? "result = " : "";

	const builder = new StarlarkCallBuilder(funcName, resultPrefix);
	const params = func.getInfo().getParameterList();

	// Process parameters according to their role
	params.forEach((param, index) => {
		const role = param.getRole();
		const paramName = param.getName();
		const value = getParameterExampleValue(param);
		const isMandatory = param.getMandatory();

		// Special case: first parameter named "ctx" or "repository_ctx" should be positional
		const isContextParam =
			index === 0 && (paramName === "ctx" || paramName === "repository_ctx");

		switch (role) {
			case FunctionParamRole.PARAM_ROLE_POSITIONAL_ONLY:
				// Positional-only: show as positional argument (rare in Starlark)
				if (isMandatory) {
					builder.addPositional(value);
				}
				break;

			case FunctionParamRole.PARAM_ROLE_ORDINARY:
			case FunctionParamRole.PARAM_ROLE_UNSPECIFIED:
				// Ordinary parameters can be positional or keyword
				// Show ctx/repository_ctx as positional (use param name), others as keyword
				if (isContextParam) {
					builder.addPositional(paramName);
				} else {
					builder.addKeyword(paramName, value, isMandatory);
				}
				break;

			case FunctionParamRole.PARAM_ROLE_KEYWORD_ONLY:
				// Keyword-only: must use keyword syntax
				builder.addKeyword(paramName, value, isMandatory);
				break;

			case FunctionParamRole.PARAM_ROLE_VARARGS:
				// *args
				builder.setVarargs(paramName);
				break;

			case FunctionParamRole.PARAM_ROLE_KWARGS:
				// **kwargs
				builder.setKwargs(paramName);
				break;
		}
	});

	return joinExampleWithLoad(
		generateLoadStatement(moduleVersion, file, funcName),
		builder.build(),
	);
}
exports.generateFunctionExample = generateFunctionExample;

/**
 * Generate a Starlark example for the macro
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateMacroExample(moduleVersion, file, sym) {
	const macro = sym.getMacro();
	if (!macro) {
		return "";
	}

	const macroName = sym.getName();
	const builder = new StarlarkCallBuilder(macroName);

	// Add attributes
	const attrs = macro.getInfo().getAttributeList();
	attrs.forEach((attr) => {
		const value = getAttributeExampleValue(attr, sym.getName());
		const isRequired = attr.getMandatory() || attr.getName() === "name";
		builder.addKeyword(attr.getName(), value, isRequired);
	});

	return joinExampleWithLoad(
		generateLoadStatement(moduleVersion, file, macroName),
		builder.build(),
	);
}
exports.generateMacroExample = generateMacroExample;

/**
 * Generate a Starlark example for the rule macro
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateRuleMacroExample(moduleVersion, file, sym) {
	const ruleMacro = sym.getRuleMacro();
	if (!ruleMacro) {
		return "";
	}

	const macroName = sym.getName();
	const builder = new StarlarkCallBuilder(macroName);

	// Add attributes from the underlying rule
	const rule = ruleMacro.getRule();
	if (rule && rule.getInfo()) {
		const attrs = rule.getInfo().getAttributeList();
		attrs.forEach((attr) => {
			const value = getAttributeExampleValue(attr, sym.getName());
			const isRequired = attr.getMandatory() || attr.getName() === "name";
			builder.addKeyword(attr.getName(), value, isRequired);
		});
	}

	return joinExampleWithLoad(
		generateLoadStatement(moduleVersion, file, macroName),
		builder.build(),
	);
}
exports.generateRuleMacroExample = generateRuleMacroExample;

/**
 * Generate a Starlark example for the module extension
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!File} file
 * @param {!Symbol} sym
 * @returns {string}
 */
function generateModuleExtensionExample(moduleVersion, file, sym) {
	const ext = sym.getModuleExtension();
	if (!ext) {
		return "";
	}

	const extName = sym.getName();
	const tagClasses = ext.getInfo().getTagClassList();

	const loadStmt = generateLoadStatement(moduleVersion, file, extName);
	const lines = loadStmt ? [loadStmt, ""] : [];

	// Module extension usage in MODULE.bazel
	lines.push("# In MODULE.bazel:");
	const label = file.getLabel();
	const extLabel = label ? label.clone() : new Label();
	extLabel.setRepo(moduleVersion.getName());
	lines.push(
		`${extName} = use_extension("${formatLabel(extLabel)}", "${extName}")`,
	);
	lines.push("");

	// Generate example for each tag class
	tagClasses.forEach((tagClass, index) => {
		const tagName = tagClass.getTagName();
		const builder = new StarlarkCallBuilder(`${extName}.${tagName}`);

		if (index > 0) {
			lines.push("");
		}

		// Add attributes for this tag class
		const attrs = tagClass.getAttributeList();
		attrs.forEach((attr) => {
			const value = getAttributeExampleValue(attr, sym.getName());
			const isRequired = attr.getMandatory() || attr.getName() === "name";
			builder.addKeyword(attr.getName(), value, isRequired);
		});

		lines.push(builder.build());
	});

	return lines.join("\n");
}
exports.generateModuleExtensionExample = generateModuleExtensionExample;

/**
 * Get an example value for a function parameter based on heuristics.
 * @param {!FunctionParamInfo} param The function parameter
 * @returns {string} Example value for the parameter
 */
function getParameterExampleValue(param) {
	const defaultValue = param.getDefaultValue();
	if (defaultValue && defaultValue !== "") {
		return defaultValue;
	}

	const name = param.getName().toLowerCase();
	const docString = param.getDocString()
		? param.getDocString().toLowerCase()
		: "";

	// Check for string type indicators in name or docstring
	const likelyString =
		name.includes("name") ||
		name.includes("label") ||
		name.includes("path") ||
		name.includes("url") ||
		name.includes("msg") ||
		name.includes("message") ||
		name.includes("text") ||
		name.includes("str") ||
		name.includes("tag") ||
		name.includes("version") ||
		name.includes("prefix") ||
		name.includes("suffix") ||
		docString.includes("string") ||
		docString.includes("str");

	// Specific patterns first
	if (name.includes("name")) {
		return '"my_' + param.getName() + '"';
	}
	if (name.includes("label") || name.includes("target")) {
		return '"//path/to:target"';
	}
	if (
		name.includes("list") ||
		name.includes("files") ||
		name.includes("deps") ||
		name.includes("srcs")
	) {
		return "[]";
	}
	if (
		name.includes("dict") ||
		name.includes("map") ||
		name.includes("kwargs")
	) {
		return "{}";
	}
	if (
		name.includes("bool") ||
		name.includes("enabled") ||
		name.includes("flag")
	) {
		return "True or False";
	}
	if (name.includes("int") || name.includes("count") || name.includes("size")) {
		return "1";
	}

	// If it looks like a string based on heuristics, return empty string
	if (likelyString) {
		return '""';
	}

	// Default placeholder - None is valid Starlark and indicates missing value
	return "None";
}
exports.getParameterExampleValue = getParameterExampleValue;

/**
 * Get an example value for a provider field based on heuristics.
 * @param {!ProviderFieldInfo} field The provider field
 * @returns {string} Example value for the field
 */
function getFieldExampleValue(field) {
	// Generic example values based on field name patterns
	const name = field.getName().toLowerCase();

	if (
		name.includes("files") ||
		name.includes("srcs") ||
		name.includes("deps")
	) {
		return "depset([])";
	}
	if (name.includes("list") || name.includes("array")) {
		return "[]";
	}
	if (
		name.includes("dict") ||
		name.includes("map") ||
		name.includes("mapping")
	) {
		return "{}";
	}
	if (
		name.includes("bool") ||
		name.includes("enabled") ||
		name.includes("flag")
	) {
		return "True";
	}
	if (name.includes("int") || name.includes("count") || name.includes("size")) {
		return "0";
	}
	if (name.includes("path") || name.includes("dir")) {
		return '"path/to/file"';
	}

	return '""';
}
exports.getFieldExampleValue = getFieldExampleValue;

/**
 * Get an example value for an attribute based on its type.
 * @param {!AttributeInfo} attr The attribute info
 * @param {string=} defaultName Optional default name to use for NAME type attributes
 * @returns {string} Example value for the attribute
 */
function getAttributeExampleValue(attr, defaultName = "my_target") {
	const attrName = attr.getName();

	// Special case for "name" attribute - use provided default or attribute name
	if (attrName === "name" && defaultName) {
		return `"${defaultName}"`;
	}

	const attrType = attr.getType();

	switch (attrType) {
		case AttributeType.NAME:
			return `"${defaultName}"`;
		case AttributeType.INT:
			return "1";
		case AttributeType.LABEL:
			return '"//path/to:target"';
		case AttributeType.STRING:
			return '""';
		case AttributeType.STRING_LIST:
			return "[]";
		case AttributeType.INT_LIST:
			return "[]";
		case AttributeType.LABEL_LIST:
			return "[]";
		case AttributeType.BOOLEAN:
			return "True";
		case AttributeType.LABEL_STRING_DICT:
			return "{}";
		case AttributeType.STRING_DICT:
			return "{}";
		case AttributeType.STRING_LIST_DICT:
			return "{}";
		case AttributeType.OUTPUT:
			return '"output.txt"';
		case AttributeType.OUTPUT_LIST:
			return "[]";
		case AttributeType.LABEL_DICT_UNARY:
			return "{}";
		default:
			return '""';
	}
}
exports.getAttributeExampleValue = getAttributeExampleValue;

/**
 * Format a Bazel label into string format.
 * @param {?Label} label The label to format
 * @returns {string} Formatted label string (e.g., "@repo//pkg:name")
 */
function formatLabel(label) {
	if (!label) {
		return "";
	}

	const repo = label.getRepo() || "";
	const pkg = label.getPkg() || "";
	const name = label.getName() || "";

	let result = "";

	// Add repository if present
	if (repo && repo !== "") {
		result += `@${repo}`;
	}

	// Add package path
	if (pkg && pkg !== "") {
		result += `//${pkg}`;
	} else {
		result += "//";
	}

	// Add target name
	if (name && name !== "") {
		result += `:${name}`;
	}

	return result;
}

exports.formatLabel = formatLabel;

/**
 * Encode a load-symbol coordinate into the URL form used by the /targets
 * view's Trie router. Empty `pkg` collapses (no intermediate segments) so
 * `@swig//:swig.bzl%swig_library` becomes `@swig/swig.bzl/swig_library`.
 *
 * @param {!Label} label  the loaded .bzl file's label
 * @param {string} symbol the symbol name (the rule/function being loaded)
 * @returns {string}
 */
function loadLabelToUrlKey(label, symbol) {
	const repo = `@${label.getRepo() || ""}`;
	const pkg = label.getPkg() || "";
	const file = label.getName() || "";
	return pkg ? `${repo}/${pkg}/${file}/${symbol}` : `${repo}/${file}/${symbol}`;
}
exports.loadLabelToUrlKey = loadLabelToUrlKey;

/**
 * Inverse of loadLabelToUrlKey: parse a `/targets/<urlKey>` path into the
 * underlying load coordinate so the detail view can render the user-friendly
 * `@<repo>//<pkg>:<file>%<symbol>` form. Returns null when the urlKey has no
 * `.bzl` segment to anchor on.
 *
 * @param {string} urlKey
 * @returns {?{repo: string, pkg: string, file: string, symbol: string}}
 */
function parseLoadUrlKey(urlKey) {
	const parts = urlKey.split("/");
	if (parts.length < 3) return null;
	if (!parts[0].startsWith("@")) return null;
	// Find the segment ending in .bzl — everything before it (after the @repo)
	// is the package path, the .bzl segment is the file, everything after is
	// the symbol.
	let bzlIdx = -1;
	for (let i = 1; i < parts.length; i++) {
		if (parts[i].endsWith(".bzl")) {
			bzlIdx = i;
			break;
		}
	}
	if (bzlIdx === -1 || bzlIdx === parts.length - 1) return null;
	return {
		repo: parts[0].slice(1),
		pkg: parts.slice(1, bzlIdx).join("/"),
		file: parts[bzlIdx],
		symbol: parts.slice(bzlIdx + 1).join("/"),
	};
}
exports.parseLoadUrlKey = parseLoadUrlKey;

// Export StarlarkCallBuilder for testing
exports.StarlarkCallBuilder = StarlarkCallBuilder;

/**
 * Render a captured Value proto as a Starlark literal. Mirrors the Value
 * oneof: string -> quoted, int/bool -> bare, list -> recursive render, macro
 * or anything else unrepresentable -> a `# <complex expr>` placeholder
 * comment so the rendered call stays syntactically valid.
 *
 * @param {?Value} value
 * @param {string=} indent leading whitespace for nested list lines
 * @returns {string}
 */
function valueToStarlark(value, indent = "    ") {
	if (!value) return "None";

	const oneofCase = value.getValueCase();
	switch (oneofCase) {
		case Value.ValueCase.STRING:
			return JSON.stringify(value.getString());
		case Value.ValueCase.INT:
			return String(value.getInt());
		case Value.ValueCase.BOOL:
			return value.getBool() ? "True" : "False";
		case Value.ValueCase.LIST: {
			const list = value.getList();
			if (!list) return "[]";
			const entries = list.getValueList();
			if (entries.length === 0) {
				return "[]";
			}
			if (entries.length === 1) {
				return `[${valueToStarlark(entries[0], indent)}]`;
			}
			const inner = indent + "    ";
			const items = entries.map(
				/** @param {!Value} v */
				(v) => `${inner}${valueToStarlark(v, inner)}`,
			);
			return `[\n${items.join(",\n")},\n${indent}]`;
		}
		case Value.ValueCase.MACRO:
			return "# <macro>";
		default:
			return "# <complex expr>";
	}
}
exports.valueToStarlark = valueToStarlark;

/**
 * Reproduce the BUILD-file invocation for a captured Target. If the target's
 * rule was loaded from a .bzl, prepend the matching load() statement (from
 * the Package's load list). Native rules render bare.
 *
 * @param {!Package} pkg
 * @param {!Target} target
 * @returns {string}
 */
function generateTargetCall(pkg, target) {
	const ruleName = target.getRule();
	const builder = new StarlarkCallBuilder(ruleName);

	for (const attr of target.getAttributeList()) {
		const literal = valueToStarlark(attr.getValue(), "    ");
		builder.addKeyword(attr.getName(), literal, attr.getName() === "name");
	}

	let load = "";
	if (target.getIsMacro()) {
		for (const stmt of pkg.getLoadList()) {
			for (const sym of stmt.getSymbolList()) {
				const exported = sym.getTo() || sym.getFrom();
				if (exported === ruleName) {
					const label = stmt.getLabel();
					if (label) {
						load = `load(${JSON.stringify(formatLabel(label))}, ${JSON.stringify(ruleName)})\n\n`;
					}
					break;
				}
			}
			if (load) break;
		}
	}

	return load + builder.build();
}
exports.generateTargetCall = generateTargetCall;
