goog.module("centrl.starlark");

const AttributeInfo = goog.require('proto.stardoc_output.AttributeInfo');
const AttributeType = goog.require('proto.stardoc_output.AttributeType');
const FileInfo = goog.require('proto.build.stack.bazel.bzlmod.v1.FileInfo');
const FunctionParamInfo = goog.require('proto.stardoc_output.FunctionParamInfo');
const FunctionParamRole = goog.require('proto.stardoc_output.FunctionParamRole');
const Label = goog.require('proto.build.stack.starlark.v1beta1.Label');
const ModuleVersion = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleVersion');
const ProviderFieldInfo = goog.require('proto.stardoc_output.ProviderFieldInfo');
const SymbolInfo = goog.require('proto.build.stack.bazel.bzlmod.v1.SymbolInfo');


/**
 * Helper class for building Starlark function call examples
 */
class StarlarkCallBuilder {
    /**
     * @param {string} funcName - The function/rule/macro name
     * @param {string=} resultPrefix - Optional prefix (e.g., "result = ")
     */
    constructor(funcName, resultPrefix = '') {
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
        const totalArgs = this.positionalArgs_.length +
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

        // Positional arguments
        this.positionalArgs_.forEach((value) => {
            argLines.push(`    ${value}`);
        });

        // Keyword arguments
        this.keywordArgs_.forEach((arg) => {
            // Suppress "# required" comment for "name" attribute (implicitly required)
            const comment = (arg.required && arg.name !== 'name') ? '  # required' : '';
            argLines.push(`    ${arg.name} = ${arg.value}${comment}`);
        });

        // Varargs
        if (this.varargs_) {
            argLines.push(`    *${this.varargs_}`);
        }

        // Kwargs
        if (this.kwargs_) {
            argLines.push(`    **${this.kwargs_}`);
        }

        // Add commas to all arguments, except no trailing comma after **kwargs-style args
        for (let i = 0; i < argLines.length; i++) {
            const isLast = i === argLines.length - 1;
            const argLine = argLines[i];
            const endsWithKwargs = isLast && argLine.trim().startsWith('**');

            if (endsWithKwargs) {
                // No trailing comma after **kwargs (or any **parameter)
                lines.push(argLine);
            } else {
                // All other arguments get trailing commas
                lines.push(argLine + ',');
            }
        }

        lines.push(')');

        return lines.join('\n');
    }
}

/**
 * Generate a Starlark example for the provider
 * 
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateProviderExample(moduleVersion, file, sym) {
    const provider = sym.getProvider();
    if (!provider) {
        return '';
    }

    const providerName = sym.getName();
    const lines = [generateLoadStatement(moduleVersion, file, providerName), ''];

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
        lines.push(')');
    }

    return lines.join('\n');
}
exports.generateProviderExample = generateProviderExample;


/**
 * Generate a Starlark example for the repository rule
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateRepositoryRuleExample(moduleVersion, file, sym) {
    const repoRule = sym.getRepositoryRule();
    if (!repoRule) {
        return '';
    }

    const ruleName = sym.getName();
    const builder = new StarlarkCallBuilder(ruleName);

    // Add attributes
    const attrs = repoRule.getInfo().getAttributeList();
    attrs.forEach((attr) => {
        const value = getAttributeExampleValue(attr, sym.getName());
        const isRequired = attr.getMandatory() || attr.getName() === 'name';
        builder.addKeyword(attr.getName(), value, isRequired);
    });

    return generateLoadStatement(moduleVersion, file, ruleName) + '\n\n' + builder.build();
}
exports.generateRepositoryRuleExample = generateRepositoryRuleExample;


/**
 * Generate a Starlark example for the aspect
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateAspectExample(moduleVersion, file, sym) {
    const aspect = sym.getAspect();
    if (!aspect) {
        return '';
    }

    const aspectName = sym.getName();
    const lines = [generateLoadStatement(moduleVersion, file, aspectName), ''];

    // Aspect usage (typically used in a rule's aspects parameter)
    lines.push('# Example: Apply aspect to a target');
    lines.push('my_rule(');
    lines.push('    name = "my_target",  # required');
    lines.push(`    aspects = [${aspectName}],`);
    lines.push(')');

    return lines.join('\n');
}
exports.generateAspectExample = generateAspectExample;


/**
 * Generate a load statement for the current symbol
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {string} symbolName - The name of the symbol to load
 * @returns {string}
 */
function generateLoadStatement(moduleVersion, file, symbolName) {
    const label = file.getLabel();
    if (!label) {
        return '';
    }

    // Create a new Label with the module name as repo
    const loadLabel = label.clone();
    loadLabel.setRepo(moduleVersion.getName());

    const loadPath = formatLabel(loadLabel);
    return `load("${loadPath}", "${symbolName}")`;
}


/**
 * Generate a Starlark example for the rule
 * 
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateRuleExample(moduleVersion, file, sym) {
    const rule = sym.getRule();
    if (!rule) {
        return '';
    }

    const ruleName = sym.getName();
    const builder = new StarlarkCallBuilder(ruleName);

    // Add attributes
    const attrs = rule.getInfo().getAttributeList();
    attrs.forEach((attr) => {
        const value = getAttributeExampleValue(attr, sym.getName());
        const isRequired = attr.getMandatory() || attr.getName() === 'name';
        builder.addKeyword(attr.getName(), value, isRequired);
    });

    return generateLoadStatement(moduleVersion, file, ruleName) + '\n\n' + builder.build();
}
exports.generateRuleExample = generateRuleExample;


/**
 * Generate a Starlark example for the function
 * 
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateFunctionExample(moduleVersion, file, sym) {
    const func = sym.getFunc();
    if (!func) {
        return '';
    }

    const funcName = sym.getName();
    const hasReturn = func.getInfo().getReturn() != null;
    const resultPrefix = hasReturn ? 'result = ' : '';

    const builder = new StarlarkCallBuilder(funcName, resultPrefix);
    const params = func.getInfo().getParameterList();

    // Process parameters according to their role
    params.forEach((param, index) => {
        const role = param.getRole();
        const paramName = param.getName();
        const value = getParameterExampleValue(param);
        const isMandatory = param.getMandatory();

        // Special case: first parameter named "ctx" or "repository_ctx" should be positional
        const isContextParam = index === 0 && (paramName === 'ctx' || paramName === 'repository_ctx');

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

    return generateLoadStatement(moduleVersion, file, funcName) + '\n\n' + builder.build();
}
exports.generateFunctionExample = generateFunctionExample;


/**
 * Generate a Starlark example for the macro
 *
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateMacroExample(moduleVersion, file, sym) {
    const macro = sym.getMacro();
    if (!macro) {
        return '';
    }

    const macroName = sym.getName();
    const builder = new StarlarkCallBuilder(macroName);

    // Add attributes
    const attrs = macro.getInfo().getAttributeList();
    attrs.forEach((attr) => {
        const value = getAttributeExampleValue(attr, sym.getName());
        const isRequired = attr.getMandatory() || attr.getName() === 'name';
        builder.addKeyword(attr.getName(), value, isRequired);
    });

    return generateLoadStatement(moduleVersion, file, macroName) + '\n\n' + builder.build();
}
exports.generateMacroExample = generateMacroExample;


/**
 * Generate a Starlark example for the rule macro
 * 
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateRuleMacroExample(moduleVersion, file, sym) {
    const ruleMacro = sym.getRuleMacro();
    if (!ruleMacro) {
        return '';
    }

    const macroName = sym.getName();
    const builder = new StarlarkCallBuilder(macroName);

    // Add attributes from the underlying rule
    const rule = ruleMacro.getRule();
    if (rule && rule.getInfo()) {
        const attrs = rule.getInfo().getAttributeList();
        attrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, sym.getName());
            const isRequired = attr.getMandatory() || attr.getName() === 'name';
            builder.addKeyword(attr.getName(), value, isRequired);
        });
    }

    return generateLoadStatement(moduleVersion, file, macroName) + '\n\n' + builder.build();
}
exports.generateRuleMacroExample = generateRuleMacroExample;


/**
 * Generate a Starlark example for the module extension
 * 
 * @param {!ModuleVersion} moduleVersion
 * @param {!FileInfo} file
 * @param {!SymbolInfo} sym
 * @returns {string}
 */
function generateModuleExtensionExample(moduleVersion, file, sym) {
    const ext = sym.getModuleExtension();
    if (!ext) {
        return '';
    }

    const extName = sym.getName();
    const tagClasses = ext.getInfo().getTagClassList();

    const lines = [generateLoadStatement(moduleVersion, file, extName), ''];

    // Module extension usage in MODULE.bazel
    lines.push('# In MODULE.bazel:');
    lines.push(`${extName} = use_extension("${formatLabel(file.getLabel())}", "${extName}")`);
    lines.push('');

    // Generate example for each tag class
    tagClasses.forEach((tagClass, index) => {
        const tagName = tagClass.getTagName();
        const builder = new StarlarkCallBuilder(`${extName}.${tagName}`);

        if (index > 0) {
            lines.push('');
        }

        // Add attributes for this tag class
        const attrs = tagClass.getAttributeList();
        attrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, sym.getName());
            const isRequired = attr.getMandatory() || attr.getName() === 'name';
            builder.addKeyword(attr.getName(), value, isRequired);
        });

        lines.push(builder.build());
    });

    return lines.join('\n');
}
exports.generateModuleExtensionExample = generateModuleExtensionExample;


/**
* Get an example value for a function parameter based on heuristics.
* @param {!FunctionParamInfo} param The function parameter
* @returns {string} Example value for the parameter
*/
function getParameterExampleValue(param) {
    const defaultValue = param.getDefaultValue();
    if (defaultValue && defaultValue !== '') {
        return defaultValue;
    }

    const name = param.getName().toLowerCase();
    const docString = param.getDocString() ? param.getDocString().toLowerCase() : '';

    // Check for string type indicators in name or docstring
    const likelyString = name.includes('name') ||
        name.includes('label') ||
        name.includes('path') ||
        name.includes('url') ||
        name.includes('msg') ||
        name.includes('message') ||
        name.includes('text') ||
        name.includes('str') ||
        name.includes('tag') ||
        name.includes('version') ||
        name.includes('prefix') ||
        name.includes('suffix') ||
        docString.includes('string') ||
        docString.includes('str');

    // Specific patterns first
    if (name.includes('name')) {
        return '"my_' + param.getName() + '"';
    }
    if (name.includes('label') || name.includes('target')) {
        return '"//path/to:target"';
    }
    if (name.includes('list') || name.includes('files') || name.includes('deps') || name.includes('srcs')) {
        return '[]';
    }
    if (name.includes('dict') || name.includes('map') || name.includes('kwargs')) {
        return '{}';
    }
    if (name.includes('bool') || name.includes('enabled') || name.includes('flag')) {
        return 'True or False';
    }
    if (name.includes('int') || name.includes('count') || name.includes('size')) {
        return '1';
    }

    // If it looks like a string based on heuristics, return empty string
    if (likelyString) {
        return '""';
    }

    // Default placeholder - None is valid Starlark and indicates missing value
    return 'None';
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

    if (name.includes('files') || name.includes('srcs') || name.includes('deps')) {
        return 'depset([])';
    }
    if (name.includes('list') || name.includes('array')) {
        return '[]';
    }
    if (name.includes('dict') || name.includes('map') || name.includes('mapping')) {
        return '{}';
    }
    if (name.includes('bool') || name.includes('enabled') || name.includes('flag')) {
        return 'True';
    }
    if (name.includes('int') || name.includes('count') || name.includes('size')) {
        return '0';
    }
    if (name.includes('path') || name.includes('dir')) {
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
function getAttributeExampleValue(attr, defaultName = 'my_target') {
    const attrName = attr.getName();

    // Special case for "name" attribute - use provided default or attribute name
    if (attrName === 'name' && defaultName) {
        return `"${defaultName}"`;
    }

    const attrType = attr.getType();

    switch (attrType) {
        case AttributeType.NAME:
            return `"${defaultName}"`;
        case AttributeType.INT:
            return '1';
        case AttributeType.LABEL:
            return '"//path/to:target"';
        case AttributeType.STRING:
            return '""';
        case AttributeType.STRING_LIST:
            return '[]';
        case AttributeType.INT_LIST:
            return '[]';
        case AttributeType.LABEL_LIST:
            return '[]';
        case AttributeType.BOOLEAN:
            return 'True';
        case AttributeType.LABEL_STRING_DICT:
            return '{}';
        case AttributeType.STRING_DICT:
            return '{}';
        case AttributeType.STRING_LIST_DICT:
            return '{}';
        case AttributeType.OUTPUT:
            return '"output.txt"';
        case AttributeType.OUTPUT_LIST:
            return '[]';
        case AttributeType.LABEL_DICT_UNARY:
            return '{}';
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
        return '';
    }

    const repo = label.getRepo() || '';
    const pkg = label.getPkg() || '';
    const name = label.getName() || '';

    let result = '';

    // Add repository if present
    if (repo && repo !== '') {
        result += `@${repo}`;
    }

    // Add package path
    if (pkg && pkg !== '') {
        result += `//${pkg}`;
    } else {
        result += '//';
    }

    // Add target name
    if (name && name !== '') {
        result += `:${name}`;
    }

    return result;
}

