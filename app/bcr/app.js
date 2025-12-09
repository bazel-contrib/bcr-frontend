goog.module("centrl.App");

const AspectInfo = goog.require('proto.stardoc_output.AspectInfo');
const AttributeInfo = goog.require('proto.stardoc_output.AttributeInfo');
const AttributeType = goog.require('proto.stardoc_output.AttributeType');
const ComponentEventType = goog.require('goog.ui.Component.EventType');
const DocumentationInfo = goog.require('proto.build.stack.bazel.bzlmod.v1.DocumentationInfo');
const FileInfo = goog.require('proto.build.stack.bazel.bzlmod.v1.FileInfo');
const FunctionParamInfo = goog.require('proto.stardoc_output.FunctionParamInfo');
const FunctionParamRole = goog.require('proto.stardoc_output.FunctionParamRole');
const Label = goog.require('proto.build.stack.bazel.bzlmod.v1.Label');
const Maintainer = goog.require('proto.build.stack.bazel.bzlmod.v1.Maintainer');
const Message = goog.require('jspb.Message');
const Module = goog.require('proto.build.stack.bazel.bzlmod.v1.Module');
const ModuleDependency = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleDependency');
const ModuleExtensionInfo = goog.require('proto.stardoc_output.ModuleExtensionInfo');
const ModuleExtensionTagClassInfo = goog.require('proto.stardoc_output.ModuleExtensionTagClassInfo');
const ModuleInfo = goog.require('proto.stardoc_output.ModuleInfo');
const ModuleMetadata = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleMetadata');
const ModuleVersion = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleVersion');
const ProviderFieldInfo = goog.require('proto.stardoc_output.ProviderFieldInfo');
const ProviderInfo = goog.require('proto.stardoc_output.ProviderInfo');
const Registry = goog.require('proto.build.stack.bazel.bzlmod.v1.Registry');
const RepositoryMetadata = goog.require('proto.build.stack.bazel.bzlmod.v1.RepositoryMetadata');
const RepositoryRuleInfo = goog.require('proto.stardoc_output.RepositoryRuleInfo');
const RuleInfo = goog.require('proto.stardoc_output.RuleInfo');
const Select = goog.require('stack.ui.Select');
const StarlarkFunctionInfo = goog.require('proto.stardoc_output.StarlarkFunctionInfo');
const SymbolInfo = goog.require('proto.build.stack.bazel.bzlmod.v1.SymbolInfo');
const Trie = goog.require('goog.structs.Trie');
const arrays = goog.require('goog.array');
const asserts = goog.require('goog.asserts');
const dataset = goog.require('goog.dom.dataset');
const date = goog.require('goog.date');
const dom = goog.require('goog.dom');
const events = goog.require('goog.events');
const path = goog.require('goog.string.path');
const relative = goog.require('goog.date.relative');
const soy = goog.require('goog.soy');
const strings = goog.require('goog.string');
const style = goog.require('goog.style');
const { App, Component, Route, RouteEvent, RouteEventType } = goog.require('stack.ui');
const { Application, SearchProvider, Searchable, getApplication } = goog.require('centrl.common');
const { DocumentationSearchHandler } = goog.require('centrl.documentation_search');
const { MVS } = goog.require('centrl.mvs');
const { ModuleSearchHandler } = goog.require('centrl.module_search');
const { MvsDependencyTree } = goog.require('centrl.mvs_tree');
const { SearchComponent } = goog.require('centrl.search');
const { aspectInfoComponent, bodySelect, docsMapComponent, docsMapSelectNav, docsSelect, documentationInfoListComponent, documentationInfoSelect, fileErrorBlankslate, fileInfoListComponent, fileInfoSelect, functionInfoComponent, homeOverviewComponent, homeSelect, macroInfoComponent, maintainerComponent, maintainersMapComponent, maintainersMapSelectNav, maintainersSelect, moduleBlankslateComponent, moduleExtensionInfoComponent, moduleSelect, moduleVersionBlankslateComponent, moduleVersionComponent, moduleVersionDependenciesComponent, moduleVersionDependentsComponent, moduleVersionList, moduleVersionSelectNav, moduleVersionsFilterSelect, modulesMapSelect, modulesMapSelectNav, navItem, notFoundComponent, providerInfoComponent, registryApp, repositoryRuleInfoComponent, ruleInfoComponent, settingsAppearanceComponent, settingsSelect, symbolInfoComponent, toastSuccess } = goog.require('soy.centrl.app');
const { moduleDependencyRow, moduleVersionsListComponent } = goog.require('soy.registry');

const HIGHLIGHT_SYNTAX = true;
const FORMAT_MARKDOWN = true;

/**
 * @enum {string}
 */
const LocalStorageKey = {
    COLOR_MODE: "bcr-color-mode",
};


/**
 * @enum {string}
 */
const TabName = {
    ALL: "all",
    APPEARANCE: 'appearance',
    DOCS: "docs",
    HOME: "home",
    LIST: "list",
    MAINTAINERS: "maintainers",
    MODULE_VERSIONS: "moduleversions",
    MODULES: "modules",
    NOT_FOUND: "404",
    OVERVIEW: "overview",
    SETTINGS: "settings",
    TREE: "tree",
};

/**
 * @enum {string}
 */
const ModulesListTabName = {
    ALL: "all",
    DEPRECATED: "deprecated",
    NEW: "new",
    TODAY: "today",
    RECENT: "recent",
    VERIFIED: "verified",
    INCONSISTENT: "inconsistent",
    INCOMPLETE: "incomplete",
    YANKED: "yanked",
};

/**
 * @enum {string}
 */
const MaintainersListTabName = {
    ALL: "all",
};

/**
 * @enum {string}
 */
const DocsListTabName = {
    PUBLISHED: "published",
    AUTOGENERATED: "autogenerated",
};

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

    // Generic example values based on parameter name patterns
    const name = param.getName().toLowerCase();
    if (name.includes('name')) {
        return '"my_target"';
    }
    if (name.includes('label') || name.includes('target')) {
        return '"//path/to:target"';
    }
    if (name.includes('list') || name.includes('files') || name.includes('deps')) {
        return '[]';
    }
    if (name.includes('dict') || name.includes('map')) {
        return '{}';
    }
    if (name.includes('bool') || name.includes('enabled') || name.includes('flag')) {
        return 'True';
    }
    if (name.includes('int') || name.includes('count') || name.includes('size')) {
        return '1';
    }

    return '""';
}

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


/**
 * Base component that has a content element.
 */
class ContentComponent extends Component {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /**
     * @param {string} cssName
     * @return {!HTMLElement}
     */
    getCssElement(cssName) {
        return /** @type {!HTMLElement} */ (
            dom.getRequiredElementByClass(cssName, this.getElementStrict())
        );
    }

    /**
     * @override
     * @return {Element} Element to contain child elements (null if none).
     */
    getContentElement() {
        return this.getCssElement(goog.getCssName("content"));
    }
}


/**
 * Base Select component that shows a not found page for unknown routes.
 * @abstract
 */
class ContentSelect extends Select {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /**
     * @param {string} cssName
     * @return {!HTMLElement}
     */
    getCssElement(cssName) {
        return /** @type {!HTMLElement} */ (
            dom.getRequiredElementByClass(cssName, this.getElementStrict())
        );
    }

    /**
     * @override
     * @return {Element} Element to contain child elements (null if none).
     */
    getContentElement() {
        return this.getCssElement(goog.getCssName("content"));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        let tab = this.getTab(TabName.NOT_FOUND);
        if (tab) {
            this.showTab(TabName.NOT_FOUND);
            tab.go(route);
        } else {
            this.addTab(TabName.NOT_FOUND, new NotFoundComponent(this.dom_));
            this.select(name, route);
        }
    }
}

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
    getDefaultTabName() { }

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

/**
 * Main body of the application.
 */
class BodySelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(bodySelect, {
            registry: this.registry_,
            lastUpdated: formatRelativePast(this.registry_.getCommitDate()),
        }));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(TabName.HOME, new HomeSelect(this.registry_, this.dom_));
        this.addTab(TabName.MODULES, new ModulesMapSelect(this.registry_, this.dom_));
        this.addTab(TabName.SETTINGS, new SettingsSelect(this.dom_));
    }

    /**
     * Modifies behavior to use touch rather than progress to
     * not advance the path pointer.
     * @override
     * @param {!Route} route
     */
    go(route) {
        route.touch(this);
        if (route.atEnd()) {
            this.goHere(route);
        } else {
            this.goDown(route);
        }
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.HOME, route.add(TabName.HOME));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        // install the maintainers tab lazily as it loads quite a few images
        // from github.
        if (name === TabName.DOCS) {
            this.addTab(TabName.DOCS, new DocsSelect(this.registry_, this.dom_));
            this.select(name, route);
            return;
        }
        if (name === TabName.MAINTAINERS) {
            this.addTab(TabName.MAINTAINERS, new MaintainersSelect(this.registry_, this.dom_));
            this.select(name, route);
            return;
        }

        super.selectFail(name, route);
    }
}

class HomeSelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(homeSelect, {
            registry: this.registry_,
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.OVERVIEW, route.add(TabName.OVERVIEW));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.OVERVIEW) {
            this.addTab(
                TabName.OVERVIEW,
                new HomeOverviewComponent(this.registry_, this.dom_),
            );
            this.select(name, route);
            return;
        }

        super.selectFail(name, route);
    }
}


class HomeOverviewComponent extends Component {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;
    }

    /**
     * @override
     */
    createDom() {

        const modules = createModuleMap(this.registry_);
        const maintainers = createMaintainersMap(this.registry_);

        let totalModuleVersions = 0;
        const symbolCounts = {
            rules: 0,
            functions: 0,
            providers: 0,
            aspects: 0,
            moduleExtensions: 0,
            repositoryRules: 0,
            macros: 0,
        };

        for (const module of modules.values()) {
            totalModuleVersions += module.getVersionsList().length;

            // Count symbols from all versions
            for (const version of module.getVersionsList()) {
                const source = version.getSource();
                if (!source) continue;

                const docs = source.getDocumentation();
                if (!docs) continue;

                for (const file of docs.getFileList()) {
                    if (file.getError()) continue;

                    for (const sym of file.getSymbolList()) {
                        const type = sym.getType();
                        switch (type) {
                            case 1: symbolCounts.rules++; break;
                            case 2: symbolCounts.functions++; break;
                            case 3: symbolCounts.providers++; break;
                            case 4: symbolCounts.aspects++; break;
                            case 5: symbolCounts.moduleExtensions++; break;
                            case 6: symbolCounts.repositoryRules++; break;
                            case 7: symbolCounts.macros++; break;
                        }
                    }
                }
            }
        }

        this.setElementInternal(soy.renderAsElement(homeOverviewComponent, {
            registry: this.registry_,
            lastUpdated: formatRelativePast(this.registry_.getCommitDate()),
            totalModules: modules.size,
            totalModuleVersions: totalModuleVersions,
            totalMaintainers: maintainers.size,
            totalRules: symbolCounts.rules,
            totalFunctions: symbolCounts.functions,
            totalProviders: symbolCounts.providers,
            totalAspects: symbolCounts.aspects,
            totalModuleExtensions: symbolCounts.moduleExtensions,
            totalRepositoryRules: symbolCounts.repositoryRules,
            totalMacros: symbolCounts.macros,
        }));
    }
}



class SettingsSelect extends ContentSelect {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(settingsSelect, {
        }, {
            pathUrl: this.getPathUrl(),
        }));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(TabName.APPEARANCE, new SettingsAppearanceComponent(this.dom_));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.APPEARANCE, route.add(TabName.APPEARANCE));
    }
}



class SettingsAppearanceComponent extends Component {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);

        /** @private @type {?HTMLSelectElement} */
        this.themeSelectEl_ = null;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(settingsAppearanceComponent));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterThemeSelect();
    }

    /**
     * @override
     */
    exitDocument() {
        this.themeSelectEl_ = null;
        super.exitDocument();
    }

    enterThemeSelect() {
        this.themeSelectEl_ = /** @type {!HTMLSelectElement} */(this.getCssElement('theme'));

        let colorMode = this.getLocalStorageColorMode();
        if (colorMode) {
            this.setDocumentColorMode(colorMode);
        } else {
            colorMode = this.getDocumentColorMode();
            this.setLocalStorageColorMode(colorMode);
        }
        this.themeSelectEl_.value = colorMode;

        this.getHandler().listen(
            this.themeSelectEl_,
            events.EventType.CHANGE,
            this.handleThemeSelectChange,
        );
    }

    /**
     * @param {!events.BrowserEvent=} e
     */
    handleThemeSelectChange(e) {
        const colorMode = this.themeSelectEl_.value || 'auto';
        this.setDocumentColorMode(colorMode);
        this.setLocalStorageColorMode(colorMode);
    }

    /**
     * @returns {string} 
     */
    getDocumentColorMode() {
        return this.themeSelectEl_.ownerDocument.documentElement.getAttribute('data-color-mode') || 'auto';
    }

    /**
     * @param {string} colorMode 
     */
    setDocumentColorMode(colorMode) {
        this.themeSelectEl_.ownerDocument.documentElement.setAttribute('data-color-mode', colorMode);
    }

    /**
     * @returns {?string} 
     */
    getLocalStorageColorMode() {
        return window.localStorage?.getItem(LocalStorageKey.COLOR_MODE);
    }

    /**
     * @param {string} colorMode 
     */
    setLocalStorageColorMode(colorMode) {
        if (window.localStorage) {
            window.localStorage.setItem(LocalStorageKey.COLOR_MODE, colorMode);
        }
    }

    /**
     * @param {string} cssName
     * @return {!HTMLElement}
     */
    getCssElement(cssName) {
        return /** @type {!HTMLElement} */ (
            dom.getRequiredElementByClass(cssName, this.getElementStrict())
        );
    }

}


class ModuleBlankslateComponent extends Component {
    /**
     * @param {string} moduleName
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleName, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {string} */
        this.moduleName_ = moduleName;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleBlankslateComponent, {
            moduleName: this.moduleName_,
        }));
    }
}


class ModuleVersionBlankslateComponent extends Component {
    /**
     * @param {!Module} module
     * @param {string} version
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(module, version, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {string} */
        this.version_ = version;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionBlankslateComponent, {
            module: this.module_,
            version: this.version_,
        }));
    }
}


class DocsSelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!ModuleVersion>} */
        this.docsMap_ = createDocumentationMap(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(docsSelect));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(
                TabName.LIST,
                new DocsMapSelectNav(this.registry_, this.docsMap_, this.dom_),
            );
            this.select(name, route);
            return;
        }

        super.selectFail(name, route);
    }
}


class MaintainersSelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = createMaintainersMap(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainersSelect));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(
                TabName.LIST,
                new MaintainersMapSelectNav(this.registry_, this.maintainers_, this.dom_),
            );
            this.select(name, route);
            return;
        }

        const maintainer = this.maintainers_.get(name);
        if (maintainer) {
            this.addTab(name, new MaintainerComponent(this.registry_, name, maintainer));
            this.select(name, route);
            return;
        } else {
            console.warn(`failed to get maintainer for ${name}`, this.maintainers_.keys());
        }

        super.selectFail(name, route);
    }
}


class MaintainersMapSelectNav extends SelectNav {
    /**
     * @param {!Registry} registry
     * @param {!Map<string,!Maintainer>} maintainers
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, maintainers, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = maintainers;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainersMapSelectNav));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(MaintainersListTabName.ALL, route.add(MaintainersListTabName.ALL));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterAllTab();
    }

    enterAllTab() {
        this.addNavTab(
            MaintainersListTabName.ALL,
            'All',
            'List of all Maintainers',
            this.maintainers_.size,
            new MaintainersMapComponent(this.maintainers_, this.dom_),
        );
    }

    /**
     * @override
     * @returns {string}
     */
    getDefaultTabName() {
        return MaintainersListTabName.ALL;
    }
}


class DocsMapSelectNav extends SelectNav {
    /**
     * @param {!Registry} registry
     * @param {!Map<string,!ModuleVersion>} docsMap
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, docsMap, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!ModuleVersion>} */
        this.docsMap_ = docsMap;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(docsMapSelectNav));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(DocsListTabName.PUBLISHED, route.add(DocsListTabName.PUBLISHED));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterPublishedTab();
        this.enterAutogeneratedTab();
    }

    enterPublishedTab() {
        const published = this.getPublishedDocs();
        this.addNavTab(
            DocsListTabName.PUBLISHED,
            'Published',
            'Documentation from published latest module versions',
            published.size,
            new DocsMapComponent(published, this.dom_),
        );
    }

    enterAutogeneratedTab() {
        const autogenerated = this.getAutogeneratedDocs();
        this.addNavTab(
            DocsListTabName.AUTOGENERATED,
            'Autogenerated',
            'Documentation generated from all module versions',
            autogenerated.size,
            new DocsMapComponent(autogenerated, this.dom_),
        );
    }

    /**
     * @returns {!Map<string,!DocumentationInfo>}
     */
    getPublishedDocs() {
        const result = new Map();
        this.docsMap_.forEach((moduleVersion, key) => {
            const docs = moduleVersion.getSource()?.getDocumentation();
            // Published = source 1, and only latest versions
            if (docs && docs.getSource() === 1 && moduleVersion.getIsLatestVersion()) {
                result.set(key, docs);
            }
        });
        return result;
    }

    /**
     * @returns {!Map<string,!DocumentationInfo>}
     */
    getAutogeneratedDocs() {
        const result = new Map();
        this.docsMap_.forEach((moduleVersion, key) => {
            const docs = moduleVersion.getSource()?.getDocumentation();
            if (docs && docs.getSource() === 2) { // BEST_EFFORT = 2
                result.set(key, docs);
            }
        });
        return result;
    }

    /**
     * @override
     * @returns {string}
     */
    getDefaultTabName() {
        return DocsListTabName.PUBLISHED;
    }
}

class ModulesMapSelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Module>} */
        this.modules_ = createModuleMap(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(modulesMapSelect));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(name, new ModulesMapSelectNav(this.registry_, this.modules_, this.dom_));
            this.select(name, route);
            return;
        }

        const module = this.modules_.get(name);
        if (module) {
            this.addTab(name, new ModuleSelect(name, this.registry_, module, this.dom_));
            this.select(name, route);
            return;
        }

        this.addTab(name, new ModuleBlankslateComponent(name, this.dom_));
        this.select(name, route);
    }
}


class ModulesMapSelectNav extends SelectNav {
    /**
     * @param {!Registry} registry
     * @param {!Map<string,!Module>} modules
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, modules, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Module>} */
        this.modules_ = modules;

        /** @private @const @type {!Array<!ModuleVersion>} */
        this.all_ = getLatestModuleVersions(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(modulesMapSelectNav));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(ModulesListTabName.ALL, route.add(ModulesListTabName.ALL));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterAllTab();
        this.enterTodayTab();
        this.enterNewTab();
        this.enterRecentTab();
        this.enterVerifiedTab();
        this.enterDeprecatedTab();
        this.enterYankedTab();
        this.enterInconsistentTab();
        this.enterIncompleteTab();
    }

    enterAllTab() {
        this.addNavTab(
            ModulesListTabName.ALL,
            'All',
            'All Modules',
            this.all_.length,
            new ModuleVersionsFilterSelect(this.modules_, this.all_, this.dom_),
        );
    }

    enterTodayTab() {
        const today = this.getNewToday();
        this.addNavTab(
            ModulesListTabName.TODAY,
            'New Today',
            'Modules having a single version added within the last 24 hours',
            today.length,
            new ModuleVersionsFilterSelect(this.modules_, today, this.dom_),
        );
    }

    enterNewTab() {
        const newlyAdded = this.getNew();
        this.addNavTab(
            ModulesListTabName.NEW,
            'New',
            'Modules having a single version added within the last 30 days',
            newlyAdded.length,
            new ModuleVersionsFilterSelect(this.modules_, newlyAdded, this.dom_),
        );
    }

    enterRecentTab() {
        const recent = this.getRecent();
        this.addNavTab(
            ModulesListTabName.RECENT,
            'Recent',
            'Modules having at least two versions updated within the last 30 days',
            recent.length,
            new ModuleVersionsFilterSelect(this.modules_, recent, this.dom_),
        );
    }

    enterVerifiedTab() {
        const verified = this.all_.filter(m => m.getAttestations());
        this.addNavTab(
            ModulesListTabName.VERIFIED,
            'Verified',
            'Modules that contain source attestations for the most recent version',
            verified.length,
            new ModuleVersionsFilterSelect(this.modules_, verified, this.dom_),
        );
    }

    enterDeprecatedTab() {
        const deprecated = this.getDeprecated();
        this.addNavTab(
            ModulesListTabName.DEPRECATED,
            'Deprecated',
            'Modules tagged as deprecated',
            deprecated.length,
            new ModuleVersionsFilterSelect(this.modules_, deprecated, this.dom_),
        );
    }

    enterYankedTab() {
        const yanked = this.getYankedVersions();
        this.addNavTab(
            ModulesListTabName.YANKED,
            'Yanked',
            'Module Versions tagged as yanked',
            yanked.length,
            new ModuleVersionsFilterSelect(this.modules_, yanked, this.dom_),
        );
    }

    enterInconsistentTab() {
        const inconsistent = this.getInconsistentVersions();
        this.addNavTab(
            ModulesListTabName.INCONSISTENT,
            'Inconsistent',
            'Modules Versions that reference non-existent modules or module versions',
            inconsistent.length,
            new ModuleVersionsFilterSelect(this.modules_, inconsistent, this.dom_),
        );
    }

    /**
     * Incomplete tab is internal easter egg.
     */
    enterIncompleteTab() {
        const incomplete = this.all_.filter(m => !m.getRepositoryMetadata()?.getLanguagesMap()?.getLength());
        this.addTab(
            ModulesListTabName.INCOMPLETE,
            new ModuleVersionsFilterSelect(this.modules_, incomplete, this.dom_),
        );
    }

    /**
     * @override
     * @returns {string}
     */
    getDefaultTabName() {
        return ModulesListTabName.ALL;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getNewToday() {
        const oneDayAgo = new Date(Date.now() - (1 * 24 * 60 * 60 * 1000));

        const result = [];
        for (const mv of this.all_) {
            const module = this.modules_.get(mv.getName());
            const versions = module.getVersionsList();
            if (versions.length > 1) {
                continue;
            }
            const then = new Date(versions[0].getCommit().getDate());
            if (then < oneDayAgo) {
                continue;
            }
            result.push(mv);
        }

        return result;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getNew() {
        const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));

        const result = [];
        for (const mv of this.all_) {
            const module = this.modules_.get(mv.getName());
            const versions = module.getVersionsList();
            if (versions.length > 1) {
                continue;
            }
            const then = new Date(versions[0].getCommit().getDate());
            if (then < thirtyDaysAgo) {
                continue;
            }
            result.push(mv);
        }

        return result;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getRecent() {
        const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));

        const result = [];
        for (const mv of this.all_) {
            const module = this.modules_.get(mv.getName());
            const versions = module.getVersionsList();
            if (versions.length === 1) { // use for newly added
                continue;
            }
            const then = new Date(versions[0].getCommit().getDate());
            if (then < thirtyDaysAgo) {
                continue;
            }
            result.push(mv);
        }

        return result;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getDeprecated() {
        const result = [];
        for (const mv of this.all_) {
            const module = this.modules_.get(mv.getName());
            if (module.getMetadata().getDeprecated()) {
                result.push(mv);
            }
        }
        return result;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getYankedVersions() {
        const result = [];
        for (const module of this.registry_.getModulesList()) {
            const metadata = module.getMetadata();
            if (metadata.getYankedVersionsMap()) {
                const yankedVersions = metadata.getYankedVersionsMap();
                for (const version of yankedVersions.keys()) {
                    // const message = yankedVersions.get(version);
                    const moduleVersion = module.getVersionsList().find(mv => mv.getVersion() === version);
                    if (moduleVersion) {
                        result.push(moduleVersion);
                    }
                }
            }
        }
        return result;
    }

    /**
     * @returns {!Array<!ModuleVersion>}
     */
    getInconsistentVersions() {
        const result = [];
        for (const module of this.registry_.getModulesList()) {
            for (const version of module.getVersionsList()) {
                for (const dep of version.getDepsList()) {
                    if (dep.getUnresolved()) {
                        result.push(version);
                        break;
                    }
                }
            }
        }
        return result;
    }
}


class ModuleVersionsFilterSelect extends ContentSelect {
    /**
     * @param {!Map<string,!Module>} modules
     * @param {!Array<!ModuleVersion>} moduleVersions
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(modules, moduleVersions, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Map<string,!Module>} */
        this.modules_ = modules;

        /** @private @const @type {!Array<!ModuleVersion>} */
        this.moduleVersions_ = moduleVersions;

        /** @private @const @type {!Array<!Language>} */
        this.languages_ = this.getModulesPrimaryLanguages();
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionsFilterSelect, {
            languages: this.languages_,
        }, {
            pathUrl: this.getPathUrl(),
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(name, new ModuleVersionsListComponent(this.moduleVersions_, this.dom_));
            this.select(name, route);
            return;
        }
        // Check if name matches any language filter
        const langFilter = this.languages_.find(filter => filter.sanitizedName === name);
        if (langFilter) {
            this.addTab(name, new ModuleVersionsListComponent(this.getLanguageModuleVersions(unsanitizeLanguageName(name)), this.dom_));
            this.select(name, route);
            return;
        }
        super.selectFail(name, route);
    }

    /**
     * @returns {!Array<string>}
     */
    getAllLanguages() {
        const set = new Set();

        for (const mv of this.moduleVersions_) {
            const module = this.modules_.get(mv.getName());
            const md = module.getRepositoryMetadata();
            if (md && md.getLanguagesMap()) {
                for (const value of md.getLanguagesMap().keys()) {
                    set.add(value);
                }
            }
        }

        const list = Array.from(set);
        list.sort();
        return list;
    }

    /**
     * @returns {!Array<!Language>}
     */
    getModulesPrimaryLanguages() {
        /** @type {!Set<string>} */
        const set = new Set();

        for (const mv of this.moduleVersions_) {
            const module = this.modules_.get(mv.getName());
            const md = module.getRepositoryMetadata();
            if (md && md.getPrimaryLanguage()) {
                set.add(md.getPrimaryLanguage());
            }
        }

        /** @type {!Array<string>} **/
        const names = Array.from(set);
        names.sort();

        return names.map(name => /** @type {!Language} */({
            name,
            sanitizedName: sanitizeLanguageName(name)
        }));
    }

    /**
     * 
     * @param {string} lang
     * @return {!Array<!ModuleVersion>}
     */
    getLanguageModuleVersions(lang) {
        const result = [];
        for (const mv of this.moduleVersions_) {
            const module = this.modules_.get(mv.getName());
            const md = module.getRepositoryMetadata();
            if (md && md.getLanguagesMap()) {
                if (md.getLanguagesMap().has(lang)) {
                    result.push(mv);
                }
            }
        }
        return result;
    }
}

class ModuleVersionsListComponent extends Component {
    /**
     * @param {!Array<!ModuleVersion>} moduleVersions
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersions, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.moduleVersions_ = moduleVersions;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionsListComponent, {
            moduleVersions: this.moduleVersions_,
        }));
    }
}

class MaintainersMapComponent extends Component {
    /**
     * @param {!Map<string,!Maintainer>} maintainers
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(maintainers, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = maintainers;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainersMapComponent, {
            maintainers: this.maintainers_,
        }));
    }
}

class MaintainerComponent extends Component {
    /**
     * @param {!Registry} registry
     * @param {string} name
     * @param {!Maintainer} maintainer
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, name, maintainer, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {string} */
        this.maintainerName_ = name;

        /** @private @const @type {!Maintainer} */
        this.maintainer_ = maintainer;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainerComponent, {
            name: this.maintainerName_,
            maintainer: this.maintainer_,
            moduleVersions: maintainerModuleVersions(this.registry_, this.maintainer_),
        }));
    }
}


class DocsMapComponent extends Component {
    /**
     * @param {!Map<string,!DocumentationInfo>} docsMap
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(docsMap, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Map<string,!DocumentationInfo>} */
        this.docsMap_ = docsMap;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(docsMapComponent, {
            docsMap: this.docsMap_,
        }));
    }
}


class ModuleSelect extends ContentSelect {
    /**
     * @param {string} name
     * @param {!Registry} registry
     * @param {!Module} module
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(name, registry, module, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {string} */
        this.moduleName_ = name;

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.latest_ = getLatestModuleVersion(module);

        /** @private @const @type {!Map<string,!ModuleVersion>} */
        this.moduleVersions_ = createModuleVersionMap(module);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleSelect, {
            name: this.moduleName_,
            module: this.module_,
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(this.latest_.getVersion(), route.add(this.latest_.getVersion()));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        const moduleVersion = this.moduleVersions_.get(name);

        if (moduleVersion) {
            this.addTab(name, new ModuleVersionSelectNav(this.registry_, this.module_, moduleVersion));
            this.select(name, route);
            return;
        }

        this.addTab(name, new ModuleVersionBlankslateComponent(this.module_, name));
        this.select(name, route);
    }
}


class ModuleVersionSelectNav extends SelectNav {
    /**
     * @param {!Registry} registry
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, module, moduleVersion, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;

        /** @private @const @type {{versionData: !Array<!VersionData>, totalDeps: number}} */
        this.versionData_ = this.computeVersionData();
    }

    /**
     * @override
     */
    createDom() {
        const { versionData, totalDeps } = this.versionData_;

        this.setElementInternal(soy.renderAsElement(moduleVersionSelectNav, {
            moduleVersion: this.moduleVersion_,
            metadata: asserts.assertObject(this.module_.getMetadata()),
            versionData,
            totalDeps,
        }));
    }

    /**
     * @override
     * @returns {string}
     */
    getDefaultTabName() {
        return TabName.OVERVIEW;
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.addNavTab(
            TabName.OVERVIEW,
            'Overview',
            'Module Version Overview',
            undefined,
            new ModuleVersionComponent(this.registry_, this.module_, this.moduleVersion_, this.versionData_),
        );

        const docs = this.moduleVersion_.getSource().getDocumentation();
        if (docs) {
            this.addNavTab(
                'docs',
                'Documentation',
                'Generated Stardoc Documentation',
                undefined,
                new DocumentationInfoSelect(this.moduleVersion_, docs),
            );

        }
    }

    /**
     * Compute version data with dependency counts and total dependents
     * @return {{versionData: !Array<!VersionData>, totalDeps: number}}
     */
    computeVersionData() {
        /** @type {!Array<!VersionData>} */
        const versionData = [];
        let totalDeps = 0;
        const versions = this.module_.getVersionsList();

        for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const directDeps = getModuleDirectDeps(this.registry_, this.module_, v.getVersion());
            totalDeps += directDeps.length;

            // Calculate age summary from previous version
            let ageSummary = null;
            if (i < versions.length - 1) {
                const currentCommit = v.getCommit();
                const prevCommit = versions[i + 1].getCommit();
                if (!currentCommit || !prevCommit) {
                    ageSummary = '(no commit)';
                } else {
                    const currentDate = new Date(currentCommit.getDate());
                    const prevDate = new Date(prevCommit.getDate());
                    const diffMs = currentDate - prevDate;
                    const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    if (totalDays > 0) {
                        ageSummary = calculateAgeSummary(totalDays);
                    } else if (totalDays === 0) {
                        // Same day release - calculate hours
                        const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
                        if (totalHours > 0) {
                            ageSummary = `${totalHours}h`;
                        } else {
                            ageSummary = '<1h';
                        }
                    } else {
                        ageSummary = '(non-positive date)';
                    }
                }
            }

            versionData.push(/** @type{!VersionData} **/({
                version: v.getVersion(),
                compat: v.getCompatibilityLevel(),
                commitDate: formatDate(v.getCommit().getDate()),
                directDeps,
                ageSummary,
            }));
        }

        return { versionData, totalDeps };
    }

}

class ModuleVersionComponent extends Component {
    /**
     * @param {!Registry} registry
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {{versionData: !Array<!VersionData>, totalDeps: number}} versionData
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, module, moduleVersion, versionData, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;

        /** @private @const @type {{versionData: !Array<!VersionData>, totalDeps: number}} */
        this.versionData_ = versionData;
    }

    /**
     * @override
     */
    createDom() {
        const { versionData, totalDeps } = this.versionData_;

        // Calculate time since latest release
        let timeSinceLatest = '';
        if (versionData.length > 0) {
            const latestVersion = this.module_.getVersionsList()[0];
            const latestCommit = latestVersion.getCommit();
            if (latestCommit) {
                const latestDate = new Date(latestCommit.getDate());
                const now = new Date();
                const diffMs = now - latestDate;
                const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                if (totalDays > 0) {
                    timeSinceLatest = calculateAgeSummary(totalDays);
                } else if (totalDays === 0) {
                    const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
                    timeSinceLatest = totalHours > 0 ? `${totalHours}h` : '<1h';
                }
            }
        }

        this.setElementInternal(soy.renderAsElement(moduleVersionComponent, {
            module: this.module_,
            metadata: asserts.assertObject(this.module_.getMetadata()),
            deps: this.moduleVersion_.getDepsList().filter(d => !d.getDev()),
            devDeps: this.moduleVersion_.getDepsList().filter(d => d.getDev()),
            moduleVersion: this.moduleVersion_,
            yanked: getYankedMap(this.module_.getMetadata()),
            commitDate: formatRelativePast(this.moduleVersion_.getCommit().getDate()),
            languageData: computeLanguageData(this.module_.getRepositoryMetadata()),
            versionData,
            totalDeps,
            timeSinceLatest,
        }, {
            repositoryUrl: this.registry_.getRepositoryUrl(),
            repositoryCommit: this.registry_.getCommitSha(),
            latestVersions: getLatestModuleVersionsByName(this.registry_),
            versionDistances: getVersionDistances(this.registry_),
        }));
    }


    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterSyntaxHighlighting();
        this.enterDependencies();
        this.enterDevDependencies();
        this.enterDependents();
        this.enterNextVersion();
    }

    enterDependencies() {
        const deps = this.moduleVersion_.getDepsList().filter(d => !d.getDev());
        if (deps.length > 0) {
            const depsEl = dom.getRequiredElementByClass(goog.getCssName('deps'), this.getElementStrict());
            const depsComponent = new ModuleVersionDependenciesComponent(this.registry_, this.module_, this.moduleVersion_, false, 'Dependencies');
            this.addChild(depsComponent, false);
            depsComponent.render(depsEl);
        }
    }

    enterDevDependencies() {
        const deps = this.moduleVersion_.getDepsList().filter(d => d.getDev());
        if (deps.length > 0) {
            const depsEl = dom.getRequiredElementByClass(goog.getCssName('dev-deps'), this.getElementStrict());
            const depsComponent = new ModuleVersionDependenciesComponent(this.registry_, this.module_, this.moduleVersion_, true, 'Dev Dependencies');
            this.addChild(depsComponent, false);
            depsComponent.render(depsEl);
        }
    }

    enterDependents() {
        const deps = getModuleDirectDeps(this.registry_, this.module_, this.moduleVersion_.getVersion());
        if (deps.length > 0) {
            const depsEl = dom.getRequiredElementByClass(goog.getCssName('dependents'), this.getElementStrict());
            const depsComponent = new ModuleVersionDependentsComponent(this.registry_, this.module_, this.moduleVersion_, deps, 'Used By');
            this.addChild(depsComponent, false);
            depsComponent.render(depsEl);
        }
    }

    enterNextVersion() {
        const rootEl = this.getElementStrict();

        // Find the next-version placeholder element
        const placeholderEl = dom.getElementByClass(goog.getCssName('next-version'), rootEl);
        if (!placeholderEl) {
            return;
        }

        // Get the latest version from versionData
        const { versionData } = this.versionData_;
        if (!versionData || versionData.length === 0) {
            return;
        }

        const latestVersion = versionData[0].version;

        // Find the element with data-version matching the latest version
        const versionEls = dom.findElements(rootEl, el => el.getAttribute('data-version') === latestVersion);
        if (versionEls.length === 0) {
            return;
        }

        const versionContainerEl = versionEls[0];

        // Get the first child element (the actual text span or link, not the container with padding)
        const textEl = dom.getFirstElementChild(versionContainerEl);
        if (!textEl) {
            return;
        }

        // Measure the width of the text element and set it on the placeholder
        // Add a few pixels for visual comfort
        const size = style.getSize(textEl);
        style.setStyle(placeholderEl, 'width', `${size.width + 2}px`);
    }

    enterSyntaxHighlighting() {
        if (HIGHLIGHT_SYNTAX) {
            const rootEl = this.getElementStrict();
            const className = goog.getCssName('shiki');
            const preEls = dom.findElements(rootEl, el => el.classList.contains(className));
            arrays.forEach(preEls, preEl => syntaxHighlight(this.dom_.getWindow(), preEl));
        }
    }

}

class ModuleVersionDependenciesComponent extends ContentComponent {
    /**
     * @param {!Registry} registry
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {boolean} dev
     * @param {string} title
     * @param {!Array<!ModuleDependency>=} opt_deps
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, module, moduleVersion, dev, title, opt_deps, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;

        /** @private @const @type {boolean} */
        this.dev_ = dev;

        /** @private @const @type {string} */
        this.title_ = title;

        /** @private @const @type {!Array<!ModuleDependency>} */
        this.deps_ = opt_deps || [];

        /** @private @type {?MvsDependencyTree} */
        this.treeComponent_ = null;
    }

    /**
     * @override
     */
    createDom() {
        const deps = this.deps_.length > 0
            ? this.deps_
            : this.moduleVersion_.getDepsList().filter(d => d.getDev() === this.dev_);

        // Get the set of module names in this dependency list
        const depModuleNames = new Set(deps.map(d => d.getName()));

        // Filter overrides to only include those for modules in this dependency list
        const overrides = this.moduleVersion_.getOverrideList().filter(
            override => depModuleNames.has(override.getModuleName())
        );

        this.setElementInternal(soy.renderAsElement(moduleVersionDependenciesComponent, {
            title: this.title_,
            deps: deps,
            overrides: overrides,
        }, {
            latestVersions: getLatestModuleVersionsByName(this.registry_),
            versionDistances: getVersionDistances(this.registry_),
        }));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterListButton();
        this.enterTreeButton();

        this.enterSyntaxHighlighting();
    }

    enterSyntaxHighlighting() {
        if (HIGHLIGHT_SYNTAX) {
            const rootEl = this.getElementStrict();
            const className = goog.getCssName('shiki');
            const preEls = dom.findElements(rootEl, el => el.classList.contains(className));
            arrays.forEach(preEls, preEl => syntaxHighlight(this.dom_.getWindow(), preEl));
        }
    }

    enterListButton() {
        this.getHandler().listen(
            this.getCssElement(goog.getCssName('btn-list')),
            events.EventType.CLICK,
            this.handleListButtonElementClick,
        );
    }

    enterTreeButton() {
        this.getHandler().listen(
            this.getCssElement(goog.getCssName('btn-tree')),
            events.EventType.CLICK,
            this.handleTreeButtonElementClick,
        );
    }

    /**
     * @param {!events.Event} e
     */
    handleListButtonElementClick(e) {
        this.toggleContentElements(false);
    }

    /**
     * @param {!events.Event} e
     */
    handleTreeButtonElementClick(e) {
        this.toggleContentElements(true);
    }

    /**
     * @param {boolean} displayTree 
     */
    toggleContentElements(displayTree) {
        const contentEl = this.getContentElement();
        const treeContentEl = this.getTreeContentElement();
        const btnListEl = this.getListButtonElement();
        const btnTreeEl = this.getTreeButtonElement();

        if (displayTree && !this.treeComponent_) {
            this.enterTreeComponent(treeContentEl);
        }

        const displayContentEl = displayTree ? treeContentEl : contentEl;
        const hideContentEl = displayTree ? contentEl : treeContentEl;
        const selectButtonEl = displayTree ? btnTreeEl : btnListEl;
        const unselectButtonEl = displayTree ? btnListEl : btnTreeEl;

        style.setElementShown(displayContentEl, true);
        style.setElementShown(hideContentEl, false);

        dom.classlist.add(selectButtonEl, 'selected');
        dom.classlist.remove(unselectButtonEl, 'selected');
    }

    /**
     * @param {!Element} treeContentEl The elenent to render the tree into.
     * @returns 
     */
    enterTreeComponent(treeContentEl) {
        const app = /** @type {!RegistryApp} */(getApplication(this));
        const mvs = app.getMvs();
        const moduleName = this.moduleVersion_.getName();
        const version = this.moduleVersion_.getVersion();

        /** @type {string|boolean} */
        const modifier = this.dev_ ? "only" : false;

        const treeComponent = this.treeComponent_ = new MvsDependencyTree(moduleName, version, mvs, modifier, this.dom_);
        this.addChild(treeComponent, false);
        treeComponent.render(treeContentEl);
    }

    /**
     * @return {!Element} Element to contain the mvs tree.
     */
    getTreeContentElement() {
        return this.getCssElement(goog.getCssName("tree-content"));
    }

    /**
     * @return {!Element}.
     */
    getListButtonElement() {
        return this.getCssElement(goog.getCssName("btn-list"));
    }

    /**
     * @return {!Element}.
     */
    getTreeButtonElement() {
        return this.getCssElement(goog.getCssName("btn-tree"));
    }
}


class ModuleVersionDependentsComponent extends ContentComponent {
    /**
     * @param {!Registry} registry
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {!Array<!ModuleDependency>} directDeps
     * @param {string} title
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, module, moduleVersion, directDeps, title, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;

        /** @private @const @type {!Array<!ModuleDependency>} */
        this.directDeps_ = directDeps;

        /** @private @const @type {string} */
        this.title_ = title;

        /** @private @type {?Object} */
        this.matrixData_ = null;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionDependentsComponent, {
            title: this.title_,
            deps: this.directDeps_,
        }));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterListButton();
        this.enterTableButton();
    }

    enterListButton() {
        this.getHandler().listen(
            this.getCssElement(goog.getCssName('btn-list')),
            events.EventType.CLICK,
            this.handleListButtonElementClick,
        );
    }

    enterTableButton() {
        this.getHandler().listen(
            this.getCssElement(goog.getCssName('btn-table')),
            events.EventType.CLICK,
            this.handleTableButtonElementClick,
        );
    }

    /**
     * @param {!events.Event} e
     */
    handleListButtonElementClick(e) {
        this.toggleContentElements(false);
    }

    /**
     * @param {!events.Event} e
     */
    handleTableButtonElementClick(e) {
        this.toggleContentElements(true);
    }

    /**
     * @param {boolean} displayTable
     */
    toggleContentElements(displayTable) {
        const listContentEl = this.getListContentElement();
        const tableContentEl = this.getTableContentElement();
        const btnListEl = this.getListButtonElement();
        const btnTableEl = this.getTableButtonElement();

        if (displayTable && !this.matrixData_) {
            this.enterTableContent(tableContentEl);
        }

        const displayContentEl = displayTable ? tableContentEl : listContentEl;
        const hideContentEl = displayTable ? listContentEl : tableContentEl;
        const selectButtonEl = displayTable ? btnTableEl : btnListEl;
        const unselectButtonEl = displayTable ? btnListEl : btnTableEl;

        style.setElementShown(displayContentEl, true);
        style.setElementShown(hideContentEl, false);

        dom.classlist.add(selectButtonEl, 'selected');
        dom.classlist.remove(unselectButtonEl, 'selected');
    }

    /**
     * @param {!Element} tableContentEl The element to render the table into.
     */
    enterTableContent(tableContentEl) {
        // Calculate matrix data
        this.matrixData_ = this.getDependentsByVersion();

        // Render the table
        this.renderDependentsMatrix(tableContentEl, this.matrixData_);
    }

    /**
     * Get dependents organized by module and version.
     * Returns a structure showing which modules depend on each version of the current module.
     * Only shows versions from the current version backwards, and each dependent appears only once
     * at the newest version it depends on (the "front").
     * @return {{modules: !Array<string>, versions: !Array<string>, matrix: !Map<string, string>}}
     */
    getDependentsByVersion() {
        const moduleName = this.moduleVersion_.getName();
        const module = this.module_;
        const currentVersion = this.moduleVersion_.getVersion();

        // Get all versions in order (newest to oldest)
        const allVersions = module.getVersionsList().map(v => v.getVersion());

        // Find index of current version
        const currentIndex = allVersions.indexOf(currentVersion);
        if (currentIndex === -1) {
            return { modules: [], versions: [], matrix: new Map() };
        }

        // Only show versions from current backwards (current version and older)
        const versions = allVersions.slice(currentIndex);

        // Map to track the newest version each module depends on
        // Structure: moduleDepName -> version (the newest/front version)
        /** @type {!Map<string, string>} */
        const dependentsMap = new Map();

        // Iterate through all modules in the registry
        for (const depModule of this.registry_.getModulesList()) {
            if (depModule.getName() === moduleName) {
                continue;
            }

            const depModuleName = depModule.getName();

            // Check all versions of this dependent module
            for (const depModuleVersion of depModule.getVersionsList()) {
                for (const dep of depModuleVersion.getDepsList()) {
                    if (dep.getName() === moduleName) {
                        const version = dep.getVersion();

                        // Only consider versions in our range (current and older)
                        if (!versions.includes(version)) {
                            continue;
                        }

                        // If we haven't seen this dependent yet, or if this version is newer
                        // than what we've seen, update it
                        const existingVersion = dependentsMap.get(depModuleName);
                        if (!existingVersion) {
                            dependentsMap.set(depModuleName, version);
                        } else {
                            // Check if this version is newer (earlier in the versions array)
                            const existingIndex = versions.indexOf(existingVersion);
                            const newIndex = versions.indexOf(version);
                            if (newIndex < existingIndex) {
                                dependentsMap.set(depModuleName, version);
                            }
                        }
                    }
                }
            }
        }

        // Get unique versions that actually have dependents
        /** @type {!Set<string>} */
        const usedVersions = new Set(dependentsMap.values());
        /** @type {function(string): boolean} */
        const hasVersion = (v) => usedVersions.has(v);
        const filteredVersions = versions.filter(hasVersion);

        // Sort modules by their front version (newest first)
        // This makes checkmarks appear more to the left at the top, moving right as you scroll down
        const moduleNames = Array.from(dependentsMap.keys()).sort(
            /**
             * @param {string} a
             * @param {string} b
             * @returns {number}
             */
            (a, b) => {
                const versionA = dependentsMap.get(a);
                const versionB = dependentsMap.get(b);

                if (!versionA || !versionB) {
                    return 0;
                }

                const indexA = filteredVersions.indexOf(versionA);
                const indexB = filteredVersions.indexOf(versionB);

                // Sort by version index (earlier index = newer version = top of list)
                return indexA - indexB;
            });

        return {
            modules: moduleNames,
            versions: filteredVersions,
            matrix: dependentsMap
        };
    }

    /**
     * Render the dependents matrix as a table.
     * @param {!Element} container
     * @param {{modules: !Array<string>, versions: !Array<string>, matrix: !Map<string, string>}} data
     */
    renderDependentsMatrix(container, data) {
        // Wrapper for horizontal scroll with grab cursor
        const wrapper = dom.createDom('div', {
            'class': 'm-1',
            'style': 'overflow-x: scroll; cursor: grab;',
            'onmousedown': /** @this {!HTMLElement} */ function () { this.style.cursor = 'grabbing'; },
            'onmouseup': /** @this {!HTMLElement} */ function () { this.style.cursor = 'grab'; },
            'onmouseleave': /** @this {!HTMLElement} */ function () { this.style.cursor = 'grab'; }
        });

        const table = dom.createDom('table', {
            'class': 'width-full p-0',
            'style': 'border-collapse: collapse;'
        });

        // Header row
        const thead = dom.createDom('thead');
        const headerRow = dom.createDom('tr');

        const moduleHeader = dom.createDom('th', {
            'class': 'text-left p-1 pr-2 position-sticky',
            'style': 'z-index: 2;'
        });
        dom.appendChild(headerRow, moduleHeader);

        for (const version of data.versions) {
            const headerContent = dom.createDom('div', {
                'style': 'writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; min-height: 100px; display: flex; align-items: left; justify-content: left;'
            }, version);

            const th = dom.createDom('th', {
                'class': 'text-left text-small p-1 pl-2'
            }, headerContent);
            dom.appendChild(headerRow, th);
        }
        dom.appendChild(thead, headerRow);
        dom.appendChild(table, thead);

        // Body rows
        const tbody = dom.createDom('tbody');
        for (const moduleName of data.modules) {
            const frontVersion = data.matrix.get(moduleName);

            // Skip if no version (shouldn't happen, but be safe)
            if (!frontVersion) {
                continue;
            }

            const row = dom.createDom('tr');

            // Get the latest version of the dependent module
            const depModule = this.registry_.getModulesList().find(m => m.getName() === moduleName);
            const latestVersion = depModule ? depModule.getVersionsList()[0].getVersion() : '';

            // Create link to module version with version displayed
            const moduleNameText = dom.createDom('span', {}, moduleName);
            const versionText = dom.createDom('span', {
                'class': 'mr-1 text-light text-small'
            }, latestVersion);
            const moduleLink = dom.createDom('a', {
                'href': `/#/modules/${moduleName}/${latestVersion}`,
                'class': 'Box-row-link'
            }, [versionText, moduleNameText]);

            const moduleCell = dom.createDom('td', {
                'class': 'p-1 pr-2 position-sticky text-right',
                'style': 'left: 0;'
            }, moduleLink);
            dom.appendChild(row, moduleCell);

            // Render cells - only mark the front version
            for (const version of data.versions) {
                const isAtFront = version === frontVersion;
                const cellClasses = isAtFront
                    ? 'text-center p-1 border color-bg-success'
                    : 'text-center p-1 border color-bg-subtle';
                const cell = dom.createDom('td', {
                    'class': cellClasses,
                    'style': 'max-width: 2em; width: 2em;'
                }, isAtFront ? '•' : '');
                dom.appendChild(row, cell);
            }
            dom.appendChild(tbody, row);
        }
        dom.appendChild(table, tbody);

        dom.appendChild(wrapper, table);
        dom.appendChild(container, wrapper);
    }

    /**
     * @return {!Element}
     */
    getListContentElement() {
        return this.getCssElement(goog.getCssName("list-content"));
    }

    /**
     * @return {!Element}
     */
    getTableContentElement() {
        return this.getCssElement(goog.getCssName("table-content"));
    }

    /**
     * @return {!Element}
     */
    getListButtonElement() {
        return this.getCssElement(goog.getCssName("btn-list"));
    }

    /**
     * @return {!Element}
     */
    getTableButtonElement() {
        return this.getCssElement(goog.getCssName("btn-table"));
    }
}

/**
 * @abstract
 * TODO: convert to template / generics
 */
class NavigableSelect extends ContentSelect {
    /**
     * @param {!Array<!Object>} items
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(items, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const  */
        this.items_ = items;
    }

    /**
     * @abstract
     * @returns {?Object}
     */
    getCurrentItem() { }

    /**
     * @abstract
     * @param {!Object} item
     * @returns {!Array<string>}
     */
    getItemPath(item) { }

    /** @override */
    enterDocument() {
        super.enterDocument();
        this.enterKeys();
    }

    /**
     * Setup keyboard shorcuts.
     */
    enterKeys() {
        this.getHandler().listen(this, ["keydown", "keyup"], this.handleKey);
    }

    /**
     * Key down handler for the menu.
     * @param {events.KeyEvent} e The event object.
     */
    handleKey(e) {
        let handled = false;
        switch (e.keyCode) {
            case events.KeyCodes.RIGHT:
                handled = this.onKeyRight();
                break;
            case events.KeyCodes.LEFT:
                handled = this.onKeyLeft();
                break;
            case events.KeyCodes.UP:
                handled = this.onKeyUp();
                break;
        }
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    /**
     * @returns {boolean} true if event was handled.
     */
    onKeyRight() {
        this.setSelectedItem(this.getNextPrevItem(false));
        return true;
    }

    /**
     * @returns {boolean} true if event was handled.
     */
    onKeyLeft() {
        this.setSelectedItem(this.getNextPrevItem(true));
        return true;
    }

    /**
     * @returns {boolean} true if event was handled.
     */
    onKeyUp() {
        const app = /** @type {!Application} */ (this.getApp());
        app.setLocation(this.parent().getPath());
        return true;
    }

    /**
     * 
     * @param {!Object} item
     */
    setSelectedItem(item) {
        const app = /** @type {!Application} */ (this.getApp());
        app.setLocation(this.getPath().concat(this.getItemPath(item)));
    }

    /**
     * Returns the next or previous item. Used for up/down arrows.
     * @param {boolean} prev True to go to the previous element instead of next.
     * @return {!Object} The next or previous symbol.
     */
    getNextPrevItem(prev) {
        const items = this.items_;
        const count = items.length;

        const currentItem = this.getCurrentItem();
        if (!currentItem) {
            const nextIndex = prev ? count - 1 : 0;
            return items[nextIndex];
        }

        const currentIndex = items.indexOf(currentItem);
        let nextIndex = currentIndex + (prev ? -1 : 1);

        // if overflowed/underflowed, wrap around
        if (nextIndex < 0) {
            nextIndex += count;
        } else if (nextIndex >= count) {
            nextIndex -= count;
        }

        return items[nextIndex];
    }
}

/**
 * Sorts file-symbol pairs by symbol name alphabetically.
 * @param {!FileSymbol} a
 * @param {!FileSymbol} b
 * @return {number}
 */
function bySymbolName(a, b) {
    return a.sym.getName().localeCompare(b.sym.getName());
}

/**
 * Returns true if the file should be included in public documentation.
 * Filters out files in /private/ or /internal/ directories.
 * @param {!FileInfo} file
 * @return {boolean}
 */
function isPublicFile(file) {
    const label = file.getLabel();
    if (!label) {
        return true;
    }
    const pkg = label.getPkg() || '';
    const name = label.getName() || '';
    const path = pkg ? `${pkg}/${name}` : name;
    return !path.includes('/private/') && !path.includes('/internal/');
}

class DocumentationInfoSelect extends ContentSelect {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!DocumentationInfo} docs
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, docs, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.moduleVersion_ = moduleVersion;

        /** @private @const */
        this.docs_ = docs;

        /** @const @private @type {!Trie<!FileInfo>}*/
        this.fileTrie_ = new Trie();

        for (const file of docs.getFileList()) {
            this.addFile(file);
        }
    }

    /**
     * @param {!FileInfo} file
     */
    addFile(file) {
        this.fileTrie_.add(this.getFilePrefix(file), file);
    }

    /**
     * @param {!FileInfo} file
     * @returns {string}
     */
    getFilePrefix(file) {
        return `${file.getLabel().getPkg() ? file.getLabel().getPkg() + '/' : ''}${file.getLabel().getName()}`;
    }

    /**
     * @override
     */
    createDom() {
        /** @type {!Array<!FileSymbol>} */
        const rules = [];
        /** @type {!Array<!FileSymbol>} */
        const funcs = [];
        /** @type {!Array<!FileSymbol>} */
        const providers = [];
        /** @type {!Array<!FileSymbol>} */
        const aspects = [];
        /** @type {!Array<!FileSymbol>} */
        const moduleExtensions = [];
        /** @type {!Array<!FileSymbol>} */
        const repositoryRules = [];
        /** @type {!Array<!FileSymbol>} */
        const macros = [];

        for (const file of this.docs_.getFileList()) {
            // Skip files in /private/ or /internal/ directories
            if (!isPublicFile(file)) {
                continue;
            }

            for (const sym of file.getSymbolList()) {
                switch (sym.getType()) {
                    case 1: // SYMBOL_TYPE_RULE
                        rules.push({ file, sym });
                        break;
                    case 2: // SYMBOL_TYPE_FUNCTION
                        funcs.push({ file, sym });
                        break;
                    case 3: // SYMBOL_TYPE_PROVIDER
                        providers.push({ file, sym });
                        break;
                    case 4: // SYMBOL_TYPE_ASPECT
                        aspects.push({ file, sym });
                        break;
                    case 5: // SYMBOL_TYPE_MODULE_EXTENSION
                        moduleExtensions.push({ file, sym });
                        break;
                    case 6: // SYMBOL_TYPE_REPOSITORY_RULE
                        repositoryRules.push({ file, sym });
                        break;
                    case 7: // SYMBOL_TYPE_MACRO
                        macros.push({ file, sym });
                        break;
                }
            }
        }

        rules.sort(bySymbolName);
        funcs.sort(bySymbolName);
        providers.sort(bySymbolName);
        aspects.sort(bySymbolName);
        moduleExtensions.sort(bySymbolName);
        repositoryRules.sort(bySymbolName);
        macros.sort(bySymbolName);

        this.setElementInternal(soy.renderAsElement(documentationInfoSelect, {
            info: this.docs_,
            aspects,
            funcs,
            macros,
            moduleExtensions,
            providers,
            repositoryRules,
            rules,
        }, {
            baseUrl: this.getPathUrl(),
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(name, new DocumentationInfoListComponent(this.moduleVersion_, this.docs_, this.dom_));
            this.select(name, route);
            return;
        }

        // try to find the longest matching prefix by popping path elements off
        // the remaining part of the route URL.
        const unmatched = route.unmatchedPath();
        while (unmatched.length) {
            const prefix = unmatched.join("/");
            const file = this.fileTrie_.get(prefix);
            if (file) {
                let tab = this.getTab(prefix);
                if (!tab) {
                    tab = this.addTab(prefix, new FileInfoSelect(this.moduleVersion_, file, this.dom_));
                }
                this.showTab(prefix);
                tab.go(route.advance(unmatched.length - 1));
                return;
            }
            unmatched.pop();
        }

        super.selectFail(name, route);
    }

}


class FileInfoSelect extends NavigableSelect {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, opt_domHelper) {
        super(file.getSymbolList(), opt_domHelper);

        /** @private @const */
        this.moduleVersion_ = moduleVersion;

        /** @private @const */
        this.file_ = file;
    }

    /**
     * @override
     * @returns {?Object}
     */
    getCurrentItem() {
        const currentTab = this.getCurrent();
        if (currentTab && (currentTab instanceof SymbolInfoComponent)) {
            return /** @type {!SymbolInfoComponent} */(currentTab).getSymbol();
        }
        return null;
    }

    /**
     * @override
     * @param {!Object} item
     * @returns {!Array<string>}
     */
    getItemPath(item) {
        return [/** @type {!SymbolInfo} */(item).getName()];
    }

    /**
     * @returns {!FileInfo}
     */
    getFile() {
        return this.file_;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(fileInfoSelect, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
        }, {
            baseUrl: this.getPathUrl(),
        }));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        formatMarkdownAll(this.getElementStrict());
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(name, new FileInfoListComponent(this.moduleVersion_, this.file_, this.dom_));
            this.select(name, route);
            return;
        }

        for (const sym of this.file_.getSymbolList()) {
            if (name !== sym.getName()) {
                continue;
            }
            this.addTab(name, this.createSymbolComponent(sym));
            this.select(name, route);
            return;
        }

        super.selectFail(name, route);
    }

    /**
     * @param {!SymbolInfo} sym
     * @returns {!SymbolInfoComponent}
     */
    createSymbolComponent(sym) {
        switch (sym.getType()) {
            case 1: // SYMBOL_TYPE_RULE
                return new RuleInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 2: // SYMBOL_TYPE_FUNCTION
                return new FunctionInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 3: // SYMBOL_TYPE_PROVIDER
                return new ProviderInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 4: // SYMBOL_TYPE_ASPECT
                return new AspectInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 5: // SYMBOL_TYPE_MODULE_EXTENSION
                return new ModuleExtensionInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 6: // SYMBOL_TYPE_REPOSITORY_RULE
                return new RepositoryRuleInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            case 7: // SYMBOL_TYPE_MACRO
                return new MacroInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
            default:
                return new SymbolInfoComponent(this.moduleVersion_, this.file_, sym, this.dom_);
        }
    }
}


class MarkdownComponent extends Component {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        formatMarkdownAll(this.getElementStrict());
    }
}

class SymbolInfoComponent extends MarkdownComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(opt_domHelper);

        /** @protected @const */
        this.moduleVersion_ = moduleVersion;

        /** @protected @const */
        this.file_ = file;

        /** @protected @const */
        this.sym_ = sym;
    }

    /**
     * @returns {!SymbolInfo}
     */
    getSymbol() {
        return this.sym_;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(symbolInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * @returns {string}
     */
    getDocsBaseUrl() {
        return path.join('modules', this.moduleVersion_.getName(), this.moduleVersion_.getVersion(), 'docs');
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        this.enterSyntaxHighlighting();
    }

    enterSyntaxHighlighting() {
        if (HIGHLIGHT_SYNTAX) {
            const rootEl = this.getElementStrict();
            const className = goog.getCssName('shiki');
            const preEls = dom.findElements(rootEl, el => el.classList.contains(className));
            arrays.forEach(preEls, preEl => syntaxHighlight(this.dom_.getWindow(), preEl));
        }
    }

    /**
     * Generate a load statement for the current symbol
     * @param {string} symbolName - The name of the symbol to load
     * @returns {string}
     */
    generateLoadStatement(symbolName) {
        const label = this.file_.getLabel();
        if (!label) {
            return '';
        }

        // Create a new Label with the module name as repo
        const loadLabel = label.clone();
        loadLabel.setRepo(this.moduleVersion_.getName());

        const loadPath = formatLabel(loadLabel);
        return `load("${loadPath}", "${symbolName}")`;
    }
}

class RuleInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateRuleExample();

        this.setElementInternal(soy.renderAsElement(ruleInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the rule
     * @returns {string}
     */
    generateRuleExample() {
        const rule = this.sym_.getRule();
        if (!rule) {
            return '';
        }

        const ruleName = this.sym_.getName();
        const lines = [this.generateLoadStatement(ruleName), ''];

        // Rule invocation
        lines.push(`${ruleName}(`);

        // Add attributes
        const attrs = rule.getInfo().getAttributeList();
        const requiredAttrs = attrs.filter(attr => attr.getMandatory() || attr.getName() === 'name');
        const optionalAttrs = attrs.filter(attr => !attr.getMandatory() && attr.getName() !== 'name');

        // Required attributes first (including 'name')
        requiredAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    ${attr.getName()} = ${value},`);
        });
        optionalAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    # ${attr.getName()} = ${value},`);
        });

        lines.push(')');

        return lines.join('\n');
    }
}

class FunctionInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateFunctionExample();

        this.setElementInternal(soy.renderAsElement(functionInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the function
     * @returns {string}
     */
    generateFunctionExample() {
        const func = this.sym_.getFunc();
        if (!func) {
            return '';
        }

        const funcName = this.sym_.getName();
        const lines = [this.generateLoadStatement(funcName), ''];

        // Function invocation with role-aware parameter formatting
        const params = func.getInfo().getParameterList();
        const hasReturn = func.getInfo().getReturn() != null;
        const resultPrefix = hasReturn ? 'result = ' : '';

        // Separate parameters by role
        const positionalParams = params.filter(p => {
            const role = p.getRole();
            return (role === FunctionParamRole.PARAM_ROLE_UNSPECIFIED ||
                role === FunctionParamRole.PARAM_ROLE_ORDINARY ||
                role === FunctionParamRole.PARAM_ROLE_POSITIONAL_ONLY) && p.getMandatory();
        });
        const keywordOnlyParams = params.filter(p => {
            const role = p.getRole();
            return role === FunctionParamRole.PARAM_ROLE_KEYWORD_ONLY && p.getMandatory();
        });
        const varargsParam = params.find(p => p.getRole() === FunctionParamRole.PARAM_ROLE_VARARGS);
        const kwargsParam = params.find(p => p.getRole() === FunctionParamRole.PARAM_ROLE_KWARGS);

        const hasParams = positionalParams.length > 0 || keywordOnlyParams.length > 0 || varargsParam || kwargsParam;

        if (!hasParams) {
            lines.push(`${resultPrefix}${funcName}()`);
        } else {
            lines.push(`${resultPrefix}${funcName}(`);

            // Positional/ordinary parameters (can be passed by position or keyword)
            positionalParams.forEach((param) => {
                const value = getParameterExampleValue(param);
                lines.push(`    ${param.getName()} = ${value},`);
            });

            // Keyword-only parameters
            keywordOnlyParams.forEach((param) => {
                const value = getParameterExampleValue(param);
                lines.push(`    ${param.getName()} = ${value},`);
            });

            // Varargs (*args) - show as comment since it's optional
            if (varargsParam) {
                lines.push(`    # *${varargsParam.getName()},`);
            }

            // Kwargs (**kwargs) - show as comment since it's optional
            if (kwargsParam) {
                lines.push(`    # **${kwargsParam.getName()},`);
            }

            lines.push(')');
        }

        return lines.join('\n');
    }
}

class ProviderInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateProviderExample();

        this.setElementInternal(soy.renderAsElement(providerInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the provider
     * @returns {string}
     */
    generateProviderExample() {
        const provider = this.sym_.getProvider();
        if (!provider) {
            return '';
        }

        const providerName = this.sym_.getName();
        const lines = [this.generateLoadStatement(providerName), ''];

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
}

class RepositoryRuleInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateRepositoryRuleExample();

        this.setElementInternal(soy.renderAsElement(repositoryRuleInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the repository rule
     * @returns {string}
     */
    generateRepositoryRuleExample() {
        const repoRule = this.sym_.getRepositoryRule();
        if (!repoRule) {
            return '';
        }

        const ruleName = this.sym_.getName();
        const lines = [this.generateLoadStatement(ruleName), ''];

        // Repository rule invocation
        lines.push(`${ruleName}(`);

        // Add attributes
        const attrs = repoRule.getInfo().getAttributeList();
        const requiredAttrs = attrs.filter(attr => attr.getMandatory() || attr.getName() === 'name');
        const optionalAttrs = attrs.filter(attr => !attr.getMandatory() && attr.getName() !== 'name');

        // Required attributes first (including 'name')
        requiredAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    ${attr.getName()} = ${value},`);
        });
        optionalAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    # ${attr.getName()} = ${value},`);
        });

        lines.push(')');

        return lines.join('\n');
    }
}

class AspectInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateAspectExample();

        this.setElementInternal(soy.renderAsElement(aspectInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the aspect
     * @returns {string}
     */
    generateAspectExample() {
        const aspect = this.sym_.getAspect();
        if (!aspect) {
            return '';
        }

        const aspectName = this.sym_.getName();
        const lines = [this.generateLoadStatement(aspectName), ''];

        // Aspect usage (typically used in a rule's aspects parameter)
        lines.push('# Example: Apply aspect to a target');
        lines.push('my_rule(');
        lines.push('    name = "my_target",');
        lines.push(`    aspects = [${aspectName}],`);
        lines.push(')');

        return lines.join('\n');
    }
}

class MacroInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateMacroExample();

        this.setElementInternal(soy.renderAsElement(macroInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the macro
     * @returns {string}
     */
    generateMacroExample() {
        const macro = this.sym_.getMacro();
        if (!macro) {
            return '';
        }

        const macroName = this.sym_.getName();
        const lines = [this.generateLoadStatement(macroName), ''];

        // Macro invocation
        lines.push(`${macroName}(`);

        // Add attributes
        const attrs = macro.getInfo().getAttributeList();
        const requiredAttrs = attrs.filter(attr => attr.getMandatory() || attr.getName() === 'name');
        const optionalAttrs = attrs.filter(attr => !attr.getMandatory() && attr.getName() !== 'name');

        // Required attributes first (including 'name')
        requiredAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    ${attr.getName()} = ${value},`);
        });
        optionalAttrs.forEach((attr) => {
            const value = getAttributeExampleValue(attr, this.sym_.getName());
            lines.push(`    # ${attr.getName()} = ${value},`);
        });

        lines.push(')');

        return lines.join('\n');
    }
}

class ModuleExtensionInfoComponent extends SymbolInfoComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {!SymbolInfo} sym
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, sym, opt_domHelper) {
        super(moduleVersion, file, sym, opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        const exampleCode = this.generateModuleExtensionExample();

        this.setElementInternal(soy.renderAsElement(moduleExtensionInfoComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            sym: this.sym_,
            exampleCode: exampleCode,
        }, {
            baseUrl: this.getDocsBaseUrl(),
        }));
    }

    /**
     * Generate a Starlark example for the module extension
     * @returns {string}
     */
    generateModuleExtensionExample() {
        const ext = this.sym_.getModuleExtension();
        if (!ext) {
            return '';
        }

        const extName = this.sym_.getName();
        const tagClasses = ext.getInfo().getTagClassList();

        const lines = [this.generateLoadStatement(extName), ''];

        // Module extension usage in MODULE.bazel
        lines.push('# In MODULE.bazel:');
        lines.push(`${extName} = use_extension("${formatLabel(this.file_.getLabel())}", "${extName}")`);
        lines.push('');

        // Generate example for each tag class
        tagClasses.forEach((tagClass, index) => {
            const tagName = tagClass.getTagName();
            const attrs = tagClass.getAttributeList();
            const requiredAttrs = attrs.filter(attr => attr.getMandatory() || attr.getName() === 'name');
            const optionalAttrs = attrs.filter(attr => !attr.getMandatory() && attr.getName() !== 'name');

            if (index > 0) {
                lines.push('');
            }

            if (requiredAttrs.length === 0 && optionalAttrs.length === 0) {
                lines.push(`${extName}.${tagName}()`);
            } else {
                lines.push(`${extName}.${tagName}(`);

                // Required attributes (including 'name')
                requiredAttrs.forEach((attr) => {
                    const value = getAttributeExampleValue(attr, this.sym_.getName());
                    lines.push(`    ${attr.getName()} = ${value},`);
                });

                // Optional attributes (commented out)
                optionalAttrs.forEach((attr) => {
                    const value = getAttributeExampleValue(attr, this.sym_.getName());
                    lines.push(`    # ${attr.getName()} = ${value},`);
                });

                lines.push(')');
            }
        });

        return lines.join('\n');
    }
}


class DocumentationInfoListComponent extends MarkdownComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!DocumentationInfo} docs
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, docs, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.moduleVersion_ = moduleVersion;

        /** @private @const */
        this.docs_ = docs;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(documentationInfoListComponent, {
            moduleVersion: this.moduleVersion_,
            docs: this.docs_,
        }, {
            baseUrl: path.dirname(this.getPathUrl()),
        }));
    }
}



class FileInfoListComponent extends MarkdownComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!FileInfo} file
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, file, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.moduleVersion_ = moduleVersion;

        /** @private @const */
        this.file_ = file;
    }

    /**
     * @override
     */
    createDom() {
        // Construct symbol lists by type
        const rules = [];
        const funcs = [];
        const providers = [];
        const aspects = [];
        const moduleExtensions = [];
        const repositoryRules = [];

        for (const sym of this.file_.getSymbolList()) {
            switch (sym.getType()) {
                case 1: // SYMBOL_TYPE_RULE
                    rules.push(sym);
                    break;
                case 2: // SYMBOL_TYPE_FUNCTION
                    funcs.push(sym);
                    break;
                case 3: // SYMBOL_TYPE_PROVIDER
                    providers.push(sym);
                    break;
                case 4: // SYMBOL_TYPE_ASPECT
                    aspects.push(sym);
                    break;
                case 5: // SYMBOL_TYPE_MODULE_EXTENSION
                    moduleExtensions.push(sym);
                    break;
                case 6: // SYMBOL_TYPE_REPOSITORY_RULE
                    repositoryRules.push(sym);
                    break;
            }
        }

        this.setElementInternal(soy.renderAsElement(fileInfoListComponent, {
            moduleVersion: this.moduleVersion_,
            file: this.file_,
            rules: rules,
            funcs: funcs,
            providers: providers,
            aspects: aspects,
            moduleExtensions: moduleExtensions,
            repositoryRules: repositoryRules,
        }, {
            baseUrl: path.join('modules', this.moduleVersion_.getName(), this.moduleVersion_.getVersion(), 'docs'),
        }));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        this.enterSyntaxHighlighting();
    }

    enterSyntaxHighlighting() {
        if (HIGHLIGHT_SYNTAX) {
            const rootEl = this.getElementStrict();
            const className = goog.getCssName('shiki');
            const preEls = dom.findElements(rootEl, el => el.classList.contains(className));
            arrays.forEach(preEls, preEl => syntaxHighlight(this.dom_.getWindow(), preEl));
        }
    }
}

class NotFoundComponent extends Component {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(notFoundComponent));
    }
}

/**
 * Builds a mapping of modules from the registry.
 * 
 * @param {!Registry} registry
 * @returns {!Map<string,!Module>} set of modules by name
 */
function createModuleMap(registry) {
    const result = new Map();
    registry.getModulesList().forEach(m => {
        const latest = getLatestModuleVersion(m);
        result.set(latest.getName(), m);
    });
    return result;
}

/**
 * Builds a mapping of maintainers from the registry.
 *
 * @param {!Registry} registry
 * @returns {!Map<string,!Maintainer>} set of modules by name
 */
function createMaintainersMap(registry) {
    const result = new Map();
    registry.getModulesList().forEach(module => {
        module.getMetadata().getMaintainersList().forEach(maintainer => {
            if (maintainer.getGithub()) {
                result.set("@" + maintainer.getGithub(), maintainer);
            } else if (maintainer.getEmail()) {
                result.set(maintainer.getEmail(), maintainer);
            }
        });
    });
    return result;
}

/**
 * Builds a mapping of module versions that have documentation.
 *
 * @param {!Registry} registry
 * @returns {!Map<string,!ModuleVersion>} map of module versions by "module@version" key
 */
function createDocumentationMap(registry) {
    const result = new Map();
    registry.getModulesList().forEach(module => {
        module.getVersionsList().forEach(version => {
            const docs = version.getSource()?.getDocumentation();
            if (docs) {
                const key = `${module.getName()}@${version.getVersion()}`;
                result.set(key, version);
            }
        });
    });
    return result;
}

/**
 * @param {!Registry} registry
 * @param {!Maintainer} maintainer
 * @returns {!Array<!ModuleVersion>} set of (latest) module versions that this maintainer maintains
 */
function maintainerModuleVersions(registry, maintainer) {
    const result = new Set();
    registry.getModulesList().forEach(module => {
        const metadata = module.getMetadata();
        metadata.getMaintainersList().forEach(m => {
            if (maintainer.getGithub() === m.getGithub() || maintainer.getEmail() === m.getEmail()) {
                result.add(module.getVersionsList()[0]);
            }
        });
    });
    return Array.from(result);
}

/**
 * Builds a mapping of module versions from a module.
 *
 * @param {!Window} window
 * @param {!Element} preEl The element to highlight
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
async function syntaxHighlight(window, preEl) {
    const codeEl = preEl.firstElementChild;
    const lang = codeEl.getAttribute('lang');
    const text = codeEl.textContent;
    const theme = 'github-' + getEffectiveColorMode(asserts.assertObject(preEl.ownerDocument));
    const html = await window['codeToHtml'](text, {
        'lang': lang,
        'theme': theme,
    });
    preEl.outerHTML = html;
}

/**
 * 
 * @param {!Element} rootEl The root element to search from 
 */
function formatMarkdownAll(rootEl) {
    if (FORMAT_MARKDOWN) {
        const divEls = dom.findElements(rootEl, el => dom.classlist.contains(el, 'marked'));
        arrays.forEach(divEls, formatMarkdown);
    }
}

/**
 * formats the innner text of an element as markdown using 'marked'.
 *
 * @param {!Element} el The element to convert
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
function formatMarkdown(el) {
    const text = el.textContent;
    const html = window['marked']['parse'](text);
    el.innerHTML = html;
    dom.dataset.set(el, "formatted", "markdown");
}

/**
 * @param {!Document} ownerDocument 
 * @returns {string}
 */
function getEffectiveColorMode(ownerDocument) {
    const colorMode = ownerDocument.documentElement.getAttribute('data-color-mode');

    if (colorMode === 'auto') {
        // Check system preference
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    return colorMode; // 'light' or 'dark'
}


/**
 * @param {!Registry} registry
 * @param {!Module} module
 * @param {string} version
 * @returns {!Array<!ModuleDependency>}
 */
function getModuleDirectDeps(registry, module, version) {
    const result = [];
    for (const m of registry.getModulesList()) {
        if (m.getName() === module.getName()) {
            continue;
        }
        versionLoop: for (const moduleVersion of module.getVersionsList()) {
            for (const dep of moduleVersion.getDepsList()) {
                if (dep.getName() === moduleVersion.getName() && dep.getVersion() === version) {
                    const direct = new ModuleDependency();
                    direct.setName(moduleVersion.getName());
                    direct.setVersion(moduleVersion.getVersion());
                    result.push(direct);
                    break versionLoop;
                }
            }
        }
    }
    return result;
}

/**
 * Builds a mapping of module versions from a module.
 * 
 * @param {!Module} module
 * @returns {!Map<string,!ModuleVersion>} set of module versions by ID
 */
function createModuleVersionMap(module) {
    const result = new Map();
    module.getVersionsList().forEach(mv => {
        result.set(mv.getVersion(), mv);
    });
    return result;
}

/**
 * @param {!Registry} registry 
 * @returns {!Array<!ModuleVersion>}
 */
function getLatestModuleVersions(registry) {
    return registry.getModulesList().map(module => {
        return module.getVersionsList()[0];
    });
}

/**
 * @param {!Registry} registry
 * @returns {!Map<string,!ModuleVersion>}
 */
function getLatestModuleVersionsByName(registry) {
    const result = new Map();
    for (const module of registry.getModulesList()) {
        for (const moduleVersion of module.getVersionsList()) {
            result.set(module.getName(), moduleVersion);
            break;
        }
    }
    return result;
}

/**
 * @param {!Registry} registry
 * @returns {!Map<string, !ModuleMetadata>}
 */
function getModuleMetadataByName(registry) {
    const result = new Map();
    for (const module of registry.getModulesList()) {
        const metadata = module.getMetadata();
        if (metadata) {
            result.set(module.getName(), metadata);
        }
    }
    return result;
}

/**
 * Calculate a human-readable age summary from a number of days.
 * @param {number} totalDays
 * @returns {string} Age string like "1y 6m" or "6m 23d"
 */
function calculateAgeSummary(totalDays) {
    // If years, show as decimal years (e.g., "1.2y")
    if (totalDays >= 365) {
        const years = (totalDays / 365).toFixed(1);
        return `${years}y`;
    }

    // If months, show as decimal months (e.g., "2.5m")
    if (totalDays >= 30) {
        const months = (totalDays / 30).toFixed(1);
        return `${months}m`;
    }

    // Otherwise just show days
    return `${totalDays}d`;
}

/**
 * Calculate version distances and age summary for each module.
 * @param {!Registry} registry
 * @returns {!Map<string, !Map<string, {versionsBehind: number, ageSummary: ?string}>>} Map of moduleName -> (version -> {versionsBehind, ageSummary})
 */
function getVersionDistances(registry) {
    const result = new Map();
    for (const module of registry.getModulesList()) {
        const metadata = module.getMetadata();
        if (!metadata) continue;

        const versions = metadata.getVersionsList();
        const moduleVersions = module.getVersionsList();
        const versionDistanceMap = new Map();

        // Get the latest version's commit date for comparison
        let latestDate = null;
        if (moduleVersions.length > 0 && moduleVersions[0].getCommit()) {
            const dateStr = moduleVersions[0].getCommit().getDate();
            if (dateStr) {
                latestDate = new Date(dateStr);
            }
        }

        for (let i = 0; i < versions.length; i++) {
            const versionStr = versions[i];
            let ageSummary = null;

            // Find the corresponding ModuleVersion to get commit date
            const moduleVersion = moduleVersions.find(mv => mv.getVersion() === versionStr);
            if (moduleVersion && moduleVersion.getCommit() && latestDate) {
                const versionDateStr = moduleVersion.getCommit().getDate();
                if (versionDateStr) {
                    const versionDate = new Date(versionDateStr);
                    const diffMs = latestDate - versionDate;
                    const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    ageSummary = calculateAgeSummary(totalDays);
                }
            }

            versionDistanceMap.set(versionStr, {
                versionsBehind: i,
                ageSummary: ageSummary
            });
        }

        result.set(module.getName(), versionDistanceMap);
    }
    return result;
}

/**
 * @param {!Module} module
 * @returns {!ModuleVersion}
 */
function getLatestModuleVersion(module) {
    const versions = module.getVersionsList();
    return versions[0];
}

/**
 * Create a map from the yanked versions.  Regular map seems to play nicer with
 * soy templates than jspb.Map.
 * @param {?ModuleMetadata} metadata
 * @returns {!Map<string,string>}
 */
function getYankedMap(metadata) {
    const result = new Map();
    if (metadata && metadata.getYankedVersionsMap()) {
        for (const k of metadata.getYankedVersionsMap().keys()) {
            const v = metadata.getYankedVersionsMap().get(k);
            result.set(k, v);
        }
    }
    return result;
}

/**
 * @param {string} text
 */
function copyToClipboard(text) {
    const el = dom.createDom(dom.TagName.TEXTAREA);
    el.value = text; // Set its value to the string that you want copied
    el.setAttribute("readonly", ""); // Make it readonly to be tamper-proof
    el.style.position = "absolute";
    el.style.left = "-9999px"; // Move outside the screen to make it invisible
    document.body.appendChild(el); // Append the <textarea> element to the HTML document
    const selected =
        document.getSelection().rangeCount > 0 // Check if there is any content selected previously
            ? document.getSelection().getRangeAt(0) // Store selection if found
            : null; // Mark as false to know no selection existed before
    el.select(); // Select the <textarea> content
    document.execCommand("copy"); // Copy - only works as a result of a user action (e.g. click events)
    document.body.removeChild(el); // Remove the <textarea> element
    if (selected) {
        // If a selection existed before copying
        document.getSelection().removeAllRanges(); // Unselect everything on the HTML document
        document.getSelection().addRange(selected); // Restore the original selection
    }
}

/**
 * @typedef {{
 *   name: string,
 *   sanitizedName: string,
 *   percentage: number,
 *   isPrimary: boolean
 * }}
 */
let LanguageData;

/**
 * @typedef {{
 *   version: string,
 *   compat: number,
 *   commitDate: string,
 *   directDeps: !Array<!ModuleDependency>
 * }}
 */
let VersionData;

/**
 * @typedef {{
 *   name: string,
 *   sanitizedName: string
 * }}
 */
let Language;

/**
 * @typedef {{
 *   file: FileInfo,
 *   sym: SymbolInfo,
 * }}
 */
let FileSymbol;

/**
 * Sanitize a language name for use as a CSS identifier
 * Matches the logic in pkg/css/identifier.go SanitizeIdentifier
 * @param {string} name
 * @return {string}
 */
function sanitizeLanguageName(name) {
    // Replace spaces and special characters
    let sanitized = name
        .replace(/ /g, '-')
        .replace(/\+/g, 'plus')
        .replace(/#/g, 'sharp');

    // Remove any remaining invalid characters (keep only alphanumeric, hyphen, underscore)
    sanitized = sanitized.replace(/[^a-zA-Z0-9\-_]/g, '');

    return sanitized;
}

/**
 * Unsanitize a language name from CSS identifier back to original form
 * Reverses the logic in sanitizeLanguageName
 * @param {string} sanitizedName
 * @return {string}
 */
function unsanitizeLanguageName(sanitizedName) {
    // Reverse the replacements
    let unsanitized = sanitizedName
        .replace(/sharp/g, '#')
        .replace(/plus/g, '+')
        .replace(/-/g, ' ');

    return unsanitized;
}

/**
 * Compute language breakdown data from repository metadata
 * @param {?RepositoryMetadata} repoMetadata
 * @return {!Array<!LanguageData>}
 */
function computeLanguageData(repoMetadata) {
    const languageData = /** @type {!Array<!LanguageData>} */([]);
    if (!repoMetadata) {
        return languageData;
    }

    const languagesMap = repoMetadata.getLanguagesMap();
    let total = 0;
    for (const lang of languagesMap.keys()) {
        total += languagesMap.get(lang);
    }

    if (total > 0) {
        for (const lang of languagesMap.keys()) {
            const count = languagesMap.get(lang);
            const percentage = Math.round((count * 1000) / total) / 10;
            languageData.push({
                name: lang,
                sanitizedName: sanitizeLanguageName(lang),
                percentage: percentage,
                isPrimary: lang === repoMetadata.getPrimaryLanguage()
            });
        }
        // Sort by percentage descending, primary first
        languageData.sort((a, b) => {
            if (a.isPrimary) return -1;
            if (b.isPrimary) return 1;
            return b.percentage - a.percentage;
        });
    }

    return languageData;
}

/**
 * Format a duration in human-readable relative format ("2 hours ago")
 *
 * @param {string|undefined} value The datetime string
 * @returns {string}
 */
function formatRelativePast(value) {
    if (!value) {
        return "";
    }
    return relative.getPastDateString(new Date(value));
}

/**
 * Format date as YYYY-MM-DD
 * @param {string|number} value
 * @return {string}
 */
function formatDate(value) {
    if (!value) {
        return "";
    }
    const d = new Date(value);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


/**
 * Top-level app component.
 *
 * @implements {Application}
 */
class RegistryApp extends App {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.registry_ = registry;

        /** @private @type {!Map<string,string>} */
        this.options_ = new Map();

        /** @private @type {?Component} */
        this.activeComponent_ = null;

        /** @private @type {!BodySelect} */
        this.body_ = new BodySelect(registry, opt_domHelper);

        /** @const @private @type {!ModuleSearchHandler} */
        this.moduleSearchHandler_ = new ModuleSearchHandler(registry);

        /** @const @private @type {!DocumentationSearchHandler} */
        this.documentationSearchHandler_ = new DocumentationSearchHandler(registry);

        /** @private @type {?SearchComponent} */
        this.search_ = null;

        // Build MVS maps from registry
        const { moduleVersionMap, moduleMetadataMap } = MVS.buildMaps(registry);

        /** @private @const @type {!MVS} */
        this.mvs_ = new MVS(moduleVersionMap, moduleMetadataMap);
    }

    /**
     * Returns a set of named flags.  This is a way to pass in compile-time global
     * constants into goog.modules.
     * @override
     * @returns {!Map<string,string>}
     */
    getOptions() {
        return this.options_;
    }

    /**
     * Returns the MVS instance.
     * @return {!MVS}
     */
    getMvs() {
        return this.mvs_;
    }

    /** @override */
    createDom() {
        this.setElementInternal(soy.renderAsElement(registryApp));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        this.addChild(this.body_, true);

        this.enterRouter();
        this.enterSearch();
        this.enterKeys();
        this.enterTopLevelClickEvents();
    }

    /**
     * Setup event listeners that bubble up to the app.
     */
    enterTopLevelClickEvents() {
        this.getHandler().listen(
            this.getElementStrict(),
            events.EventType.CLICK,
            this.handleElementClick,
        );
    }

    /**
     * Register for router events.
     */
    enterRouter() {
        const handler = this.getHandler();
        const router = this.getRouter();

        handler.listen(router, ComponentEventType.ACTION, this.handleRouteBegin);
        handler.listen(router, RouteEventType.DONE, this.handleRouteDone);
        handler.listen(router, RouteEventType.PROGRESS, this.handleRouteProgress);
        handler.listen(router, RouteEventType.FAIL, this.handleRouteFail);
    }

    /**
     * Setup the search component.
     */
    enterSearch() {
        const formEl = asserts.assertElement(
            this.getElementStrict().querySelector("form"),
        );

        this.search_ = new SearchComponent(this, formEl);

        events.listen(this.search_, events.EventType.FOCUS, () =>
            this.getKbd().setEnabled(false),
        );
        events.listen(this.search_, events.EventType.BLUR, () =>
            this.getKbd().setEnabled(true),
        );

        this.moduleSearchHandler_.addModules(this.registry_.getModulesList());
        this.documentationSearchHandler_.addAllSymbols();

        this.search_.addSearchProvider(
            this.moduleSearchHandler_.getSearchProvider(),
        );
        this.search_.addSearchProvider(
            this.documentationSearchHandler_.getSearchProvider(),
        );

        this.search_.setCurrentSearchProviderByName('modules');
    }


    /**
     * Setup keyboard shorcuts.
     */
    enterKeys() {
        this.getHandler().listen(
            window.document.documentElement,
            "keydown",
            this.onKeyDown,
        );
        this.getKbd().setEnabled(true);
    }


    /**
     * @param {!events.BrowserEvent=} e
     * suppress {checkTypes}
     */
    onKeyDown(e) {
        if (this.search_.isActive()) {
            switch (e.keyCode) {
                case events.KeyCodes.ESC:
                    this.blurSearchBox(e);
                    break;
            }
            return;
        }

        // CMD-P (Mac) or CTRL-P (Windows/Linux) to focus documentation search
        if (e.keyCode === events.KeyCodes.P && (e.metaKey || e.ctrlKey)) {
            if (this.getKbd().isEnabled()) {
                this.focusSearchBox(e, this.documentationSearchHandler_.getSearchProvider());
            }
            return;
        }

        switch (e.keyCode) {
            case events.KeyCodes.SLASH:
                if (this.getKbd().isEnabled()) {
                    this.focusSearchBox(e, this.moduleSearchHandler_.getSearchProvider());
                }
                break;
            case events.KeyCodes.PERIOD:
                if (this.getKbd().isEnabled()) {
                    this.focusSearchBox(e, this.documentationSearchHandler_.getSearchProvider());
                }
                break;
        }

        if (this.activeComponent_) {
            this.activeComponent_.dispatchEvent(e);
        }
    }

    /**
     * Focuses the search box.
     *
     * @param {!events.BrowserEvent=} opt_e The browser event this action is
     *     in response to. If provided, the event's propagation will be cancelled.
     * @param {?SearchProvider=} opt_searchProvider If a provider is given, set to the active one.
     */
    focusSearchBox(opt_e, opt_searchProvider) {
        if (opt_searchProvider) {
            this.search_.setCurrentProvider(opt_searchProvider);
        }
        this.search_.focus();
        if (opt_e) {
            opt_e.preventDefault();
            opt_e.stopPropagation();
        }
    }

    /**
     * UnFocuses the search box.
     *
     * @param {!events.BrowserEvent=} opt_e The browser event this action is
     *     in response to. If provided, the event's propagation will be cancelled.
     */
    blurSearchBox(opt_e) {
        this.search_.blur();
        if (opt_e) {
            opt_e.preventDefault();
            opt_e.stopPropagation();
        }
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteBegin(e) { }

    /**
     * @param {!events.Event} e
     */
    handleRouteDone(e) {
        const routeEvent = /** @type {!RouteEvent} */ (e);
        this.activeComponent_ = routeEvent.component || null;
        const route = /** @type {!Route} */ (e.target);
        console.log('done:', route.getPath());
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteProgress(e) {
        const routeEvent = /** @type {!RouteEvent} */ (e);
        // console.info(`progress: ${routeEvent.route.unmatchedPath()}`, routeEvent);
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteFail(e) {
        const route = /** @type {!Route} */ (e.target);
        this.getRouter().unlistenRoute();
        this.activeComponent_ = null;
        console.error('not found:', route.getPath());
        // this.route("/" + TabName.NOT_FOUND + route.getPath());
    }

    /** 
     * @override
     * @param {!Route} route the route object
     */
    go(route) {
        route.touch(this);
        route.progress(this);
        this.body_.go(route);
    }

    /**
     * Handle element click event and search for an el with a 'data-route'
     * or data-clippy element.  If found, send it.
     *
     * @param {!events.Event} e
     */
    handleElementClick(e) {
        const target = /** @type {?Node} */ (e.target);
        if (!target) {
            return;
        }

        dom.getAncestor(
            target,
            (node) => {
                if (!(node instanceof Element)) {
                    return false;
                }
                const route = dataset.get(node, "route");
                if (route) {
                    this.setLocation(route.split("/"));
                    return true;
                }
                const clippy = dataset.get(node, "clippy");
                if (clippy) {
                    copyToClipboard(clippy);
                    this.toastSuccess(`copied: ${clippy}`);
                    return true;
                }
                return false;
            },
            true,
        );
    }

    /**
     * Place an info toast on the page
     * @param {string} message
     * @param {number=} opt_dismiss
     */
    toastSuccess(message, opt_dismiss) {
        const toast = soy.renderAsElement(toastSuccess, { message });
        dom.append(document.body, toast);
        setTimeout(() => dom.removeNode(toast), opt_dismiss || 3000);
    }
}
exports = RegistryApp;
