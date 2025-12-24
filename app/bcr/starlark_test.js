goog.module("bcrfrontend.starlarkTest");
goog.setTestOnly();

const Aspect = goog.require("proto.build.stack.starlark.v1beta1.Aspect");
const AspectInfo = goog.require("proto.stardoc_output.AspectInfo");
const AttributeInfo = goog.require("proto.stardoc_output.AttributeInfo");
const AttributeType = goog.require("proto.stardoc_output.AttributeType");
const File = goog.require("proto.build.stack.bazel.symbol.v1.File");
const Function = goog.require("proto.build.stack.starlark.v1beta1.Function");
const FunctionParamInfo = goog.require(
	"proto.stardoc_output.FunctionParamInfo",
);
const FunctionParamRole = goog.require(
	"proto.stardoc_output.FunctionParamRole",
);
const FunctionReturnInfo = goog.require(
	"proto.stardoc_output.FunctionReturnInfo",
);
const Label = goog.require("proto.build.stack.starlark.v1beta1.Label");
const Macro = goog.require("proto.build.stack.starlark.v1beta1.Macro");
const MacroInfo = goog.require("proto.stardoc_output.MacroInfo");
const ModuleExtension = goog.require(
	"proto.build.stack.starlark.v1beta1.ModuleExtension",
);
const ModuleExtensionInfo = goog.require(
	"proto.stardoc_output.ModuleExtensionInfo",
);
const ModuleExtensionTagClassInfo = goog.require(
	"proto.stardoc_output.ModuleExtensionTagClassInfo",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Provider = goog.require("proto.build.stack.starlark.v1beta1.Provider");
const ProviderFieldInfo = goog.require(
	"proto.stardoc_output.ProviderFieldInfo",
);
const ProviderInfo = goog.require("proto.stardoc_output.ProviderInfo");
const RepositoryRule = goog.require(
	"proto.build.stack.starlark.v1beta1.RepositoryRule",
);
const RepositoryRuleInfo = goog.require(
	"proto.stardoc_output.RepositoryRuleInfo",
);
const Rule = goog.require("proto.build.stack.starlark.v1beta1.Rule");
const RuleInfo = goog.require("proto.stardoc_output.RuleInfo");
const StarlarkFunctionInfo = goog.require(
	"proto.stardoc_output.StarlarkFunctionInfo",
);
const Symbol = goog.require("proto.build.stack.bazel.symbol.v1.Symbol");
const jsunit = goog.require("goog.testing.jsunit");
const starlark = goog.require("bcrfrontend.starlark");
const testSuite = goog.require("goog.testing.testSuite");
const {
	generateAspectExample,
	generateFunctionExample,
	generateMacroExample,
	generateModuleExtensionExample,
	generateProviderExample,
	generateRepositoryRuleExample,
	generateRuleExample,
	getAttributeExampleValue,
	getFieldExampleValue,
	getParameterExampleValue,
} = goog.require("bcrfrontend.starlark");

testSuite({
	teardown: () => {},

	// ========== StarlarkCallBuilder Tests ==========

	testStarlarkCallBuilder_noArguments: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		const result = builder.build();
		assertEquals("my_rule()", result);
	},

	testStarlarkCallBuilder_singlePositionalArg: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		builder.addPositional('"arg1"');
		const result = builder.build();
		assertEquals('my_rule("arg1")', result);
	},

	testStarlarkCallBuilder_singleKeywordArg: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		builder.addKeyword("name", '"my_target"');
		const result = builder.build();
		assertEquals('my_rule(name = "my_target")', result);
	},

	testStarlarkCallBuilder_singleVarargs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.setVarargs("args");
		const result = builder.build();
		assertEquals("my_func(*args)", result);
	},

	testStarlarkCallBuilder_singleKwargs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.setKwargs("kwargs");
		const result = builder.build();
		assertEquals("my_func(**kwargs)", result);
	},

	testStarlarkCallBuilder_multiplePositionalArgs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.addPositional("arg1");
		builder.addPositional("arg2");
		const result = builder.build();
		const expected = "my_func(\n    arg1,\n    arg2,\n)";
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_multipleKeywordArgs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		builder.addKeyword("name", '"my_target"');
		builder.addKeyword("srcs", "[]");
		const result = builder.build();
		const expected = 'my_rule(\n    name = "my_target",\n    srcs = [],\n)';
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_requiredAttr: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		builder.addKeyword("name", '"my_target"', true);
		builder.addKeyword("url", '""', true);
		builder.addKeyword("sha256", '""', false);
		const result = builder.build();

		// BUG: The current implementation produces:
		// my_rule(
		//     name = "my_target",
		//     url = ""  # required,
		//     sha256 = "",
		// )
		// Note the misplaced comma after "# required"

		// This test should FAIL with the current implementation
		const expected =
			'my_rule(\n    name = "my_target",\n    url = "",  # required\n    sha256 = "",\n)';
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_requiredAttrSuppressedForName: () => {
		const builder = new starlark.StarlarkCallBuilder("my_rule");
		builder.addKeyword("name", '"my_target"', true);
		builder.addKeyword("version", '""', true);
		const result = builder.build();

		// "name" should not show "# required" comment (implicitly required)
		// but "version" should show it
		const expected =
			'my_rule(\n    name = "my_target",\n    version = "",  # required\n)';
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_mixedArgs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.addPositional("ctx");
		builder.addKeyword("name", '"my_name"');
		builder.addKeyword("required_arg", '""', true);
		builder.addKeyword("optional_arg", "[]", false);
		const result = builder.build();

		const expected =
			'my_func(\n    ctx,\n    name = "my_name",\n    required_arg = "",  # required\n    optional_arg = [],\n)';
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_withResultPrefix: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func", "result = ");
		builder.addKeyword("name", '"value"');
		const result = builder.build();
		assertEquals('result = my_func(name = "value")', result);
	},

	testStarlarkCallBuilder_withVarargsAndKwargs: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.addPositional("arg1");
		builder.addKeyword("name", '"value"');
		builder.setVarargs("args");
		builder.setKwargs("kwargs");
		const result = builder.build();

		// **kwargs should NOT have trailing comma
		const expected =
			'my_func(\n    arg1,\n    name = "value",\n    *args,\n    **kwargs\n)';
		assertEquals(expected, result);
	},

	testStarlarkCallBuilder_kwargsNoTrailingComma: () => {
		const builder = new starlark.StarlarkCallBuilder("my_func");
		builder.setKwargs("kwargs");
		builder.addKeyword("name", '"value"');
		const result = builder.build();

		// **kwargs should be last and have no trailing comma
		const expected = 'my_func(\n    name = "value",\n    **kwargs\n)';
		assertEquals(expected, result);
	},

	// ========== Helper Function Tests ==========

	testGetAttributeExampleValue_name: () => {
		const attr = new AttributeInfo();
		attr.setName("name");
		attr.setType(AttributeType.NAME);

		const result = getAttributeExampleValue(attr, "my_target");
		assertEquals('"my_target"', result);
	},

	testGetAttributeExampleValue_string: () => {
		const attr = new AttributeInfo();
		attr.setName("url");
		attr.setType(AttributeType.STRING);

		const result = getAttributeExampleValue(attr);
		assertEquals('""', result);
	},

	testGetAttributeExampleValue_int: () => {
		const attr = new AttributeInfo();
		attr.setName("count");
		attr.setType(AttributeType.INT);

		const result = getAttributeExampleValue(attr);
		assertEquals("1", result);
	},

	testGetAttributeExampleValue_boolean: () => {
		const attr = new AttributeInfo();
		attr.setName("enabled");
		attr.setType(AttributeType.BOOLEAN);

		const result = getAttributeExampleValue(attr);
		assertEquals("True", result);
	},

	testGetAttributeExampleValue_label: () => {
		const attr = new AttributeInfo();
		attr.setName("target");
		attr.setType(AttributeType.LABEL);

		const result = getAttributeExampleValue(attr);
		assertEquals('"//path/to:target"', result);
	},

	testGetAttributeExampleValue_stringList: () => {
		const attr = new AttributeInfo();
		attr.setName("srcs");
		attr.setType(AttributeType.STRING_LIST);

		const result = getAttributeExampleValue(attr);
		assertEquals("[]", result);
	},

	testGetAttributeExampleValue_labelList: () => {
		const attr = new AttributeInfo();
		attr.setName("deps");
		attr.setType(AttributeType.LABEL_LIST);

		const result = getAttributeExampleValue(attr);
		assertEquals("[]", result);
	},

	testGetAttributeExampleValue_stringDict: () => {
		const attr = new AttributeInfo();
		attr.setName("env");
		attr.setType(AttributeType.STRING_DICT);

		const result = getAttributeExampleValue(attr);
		assertEquals("{}", result);
	},

	testGetAttributeExampleValue_output: () => {
		const attr = new AttributeInfo();
		attr.setName("out");
		attr.setType(AttributeType.OUTPUT);

		const result = getAttributeExampleValue(attr);
		assertEquals('"output.txt"', result);
	},

	testGetParameterExampleValue_withDefault: () => {
		const param = new FunctionParamInfo();
		param.setName("count");
		param.setDefaultValue("5");

		const result = getParameterExampleValue(param);
		assertEquals("5", result);
	},

	testGetParameterExampleValue_namePattern: () => {
		const param = new FunctionParamInfo();
		param.setName("module_name");

		const result = getParameterExampleValue(param);
		assertEquals('"my_module_name"', result);
	},

	testGetParameterExampleValue_labelPattern: () => {
		const param = new FunctionParamInfo();
		param.setName("target_label");

		const result = getParameterExampleValue(param);
		assertEquals('"//path/to:target"', result);
	},

	testGetParameterExampleValue_listPattern: () => {
		const param = new FunctionParamInfo();
		param.setName("file_list");

		const result = getParameterExampleValue(param);
		assertEquals("[]", result);
	},

	testGetParameterExampleValue_boolPattern: () => {
		const param = new FunctionParamInfo();
		param.setName("enabled");

		const result = getParameterExampleValue(param);
		assertEquals("True or False", result);
	},

	testGetFieldExampleValue_files: () => {
		const field = new ProviderFieldInfo();
		field.setName("output_files");

		const result = getFieldExampleValue(field);
		assertEquals("depset([])", result);
	},

	testGetFieldExampleValue_list: () => {
		const field = new ProviderFieldInfo();
		field.setName("items_list");

		const result = getFieldExampleValue(field);
		assertEquals("[]", result);
	},

	testGetFieldExampleValue_bool: () => {
		const field = new ProviderFieldInfo();
		field.setName("is_enabled");

		const result = getFieldExampleValue(field);
		assertEquals("True", result);
	},

	testGetFieldExampleValue_path: () => {
		const field = new ProviderFieldInfo();
		field.setName("install_path");

		const result = getFieldExampleValue(field);
		assertEquals('"path/to/file"', result);
	},

	testGetFieldExampleValue_default: () => {
		const field = new ProviderFieldInfo();
		field.setName("unknown_field");

		const result = getFieldExampleValue(field);
		assertEquals('""', result);
	},

	// ========== Generate Function Tests ==========

	testGenerateProviderExample_noFields: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("providers");
		label.setName("providers.bzl");

		const file = new File();
		file.setLabel(label);

		const providerInfo = new ProviderInfo();
		providerInfo.setFieldInfoList([]);

		const provider = new Provider();
		provider.setInfo(providerInfo);

		const symbol = new Symbol();
		symbol.setName("GoInfo");
		symbol.setProvider(provider);

		const result = generateProviderExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//providers:providers.bzl", "GoInfo")\n\ninfo = GoInfo()';
		assertEquals(expected, result);
	},

	testGenerateProviderExample_withFields: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("providers");
		label.setName("providers.bzl");

		const file = new File();
		file.setLabel(label);

		const field1 = new ProviderFieldInfo();
		field1.setName("output_files");

		const field2 = new ProviderFieldInfo();
		field2.setName("is_enabled");

		const providerInfo = new ProviderInfo();
		providerInfo.setFieldInfoList([field1, field2]);

		const provider = new Provider();
		provider.setInfo(providerInfo);

		const symbol = new Symbol();
		symbol.setName("MyInfo");
		symbol.setProvider(provider);

		const result = generateProviderExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//providers:providers.bzl", "MyInfo")\n\n' +
			"info = MyInfo(\n" +
			"    output_files = depset([]),\n" +
			"    is_enabled = True,\n" +
			")";
		assertEquals(expected, result);
	},

	testGenerateRuleExample_simpleRule: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("rules");
		label.setName("rules.bzl");

		const file = new File();
		file.setLabel(label);

		const nameAttr = new AttributeInfo();
		nameAttr.setName("name");
		nameAttr.setType(AttributeType.NAME);

		const srcsAttr = new AttributeInfo();
		srcsAttr.setName("srcs");
		srcsAttr.setType(AttributeType.STRING_LIST);
		srcsAttr.setMandatory(true);

		const ruleInfo = new RuleInfo();
		ruleInfo.setAttributeList([nameAttr, srcsAttr]);

		const rule = new Rule();
		rule.setInfo(ruleInfo);

		const symbol = new Symbol();
		symbol.setName("go_library");
		symbol.setRule(rule);

		const result = generateRuleExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//rules:rules.bzl", "go_library")\n\n' +
			"go_library(\n" +
			'    name = "go_library",\n' +
			"    srcs = [],  # required\n" +
			")";
		assertEquals(expected, result);
	},

	testGenerateRepositoryRuleExample: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("repo");
		label.setName("repo.bzl");

		const file = new File();
		file.setLabel(label);

		const nameAttr = new AttributeInfo();
		nameAttr.setName("name");
		nameAttr.setType(AttributeType.NAME);

		const urlAttr = new AttributeInfo();
		urlAttr.setName("url");
		urlAttr.setType(AttributeType.STRING);
		urlAttr.setMandatory(true);

		const repoRuleInfo = new RepositoryRuleInfo();
		repoRuleInfo.setAttributeList([nameAttr, urlAttr]);

		const repoRule = new RepositoryRule();
		repoRule.setInfo(repoRuleInfo);

		const symbol = new Symbol();
		symbol.setName("go_repository");
		symbol.setRepositoryRule(repoRule);

		const result = generateRepositoryRuleExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//repo:repo.bzl", "go_repository")\n\n' +
			"go_repository(\n" +
			'    name = "go_repository",\n' +
			'    url = "",  # required\n' +
			")";
		assertEquals(expected, result);
	},

	testGenerateFunctionExample_noParams: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_python");

		const label = new Label();
		label.setPkg("utils");
		label.setName("utils.bzl");

		const file = new File();
		file.setLabel(label);

		const funcInfo = new StarlarkFunctionInfo();
		funcInfo.setParameterList([]);

		const func = new Function();
		func.setInfo(funcInfo);

		const symbol = new Symbol();
		symbol.setName("get_version");
		symbol.setFunc(func);

		const result = generateFunctionExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_python//utils:utils.bzl", "get_version")\n\nget_version()';
		assertEquals(expected, result);
	},

	testGenerateFunctionExample_withReturn: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_python");

		const label = new Label();
		label.setPkg("utils");
		label.setName("utils.bzl");

		const file = new File();
		file.setLabel(label);

		const returnInfo = new FunctionReturnInfo();
		returnInfo.setDocString("Returns a string");

		const funcInfo = new StarlarkFunctionInfo();
		funcInfo.setParameterList([]);
		funcInfo.setReturn(returnInfo);

		const func = new Function();
		func.setInfo(funcInfo);

		const symbol = new Symbol();
		symbol.setName("get_version");
		symbol.setFunc(func);

		const result = generateFunctionExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_python//utils:utils.bzl", "get_version")\n\nresult = get_version()';
		assertEquals(expected, result);
	},

	testGenerateFunctionExample_withParams: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_python");

		const label = new Label();
		label.setPkg("utils");
		label.setName("utils.bzl");

		const file = new File();
		file.setLabel(label);

		const ctxParam = new FunctionParamInfo();
		ctxParam.setName("ctx");
		ctxParam.setRole(FunctionParamRole.PARAM_ROLE_ORDINARY);

		const nameParam = new FunctionParamInfo();
		nameParam.setName("module_name");
		nameParam.setRole(FunctionParamRole.PARAM_ROLE_KEYWORD_ONLY);
		nameParam.setMandatory(true);

		const funcInfo = new StarlarkFunctionInfo();
		funcInfo.setParameterList([ctxParam, nameParam]);

		const func = new Function();
		func.setInfo(funcInfo);

		const symbol = new Symbol();
		symbol.setName("process_module");
		symbol.setFunc(func);

		const result = generateFunctionExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_python//utils:utils.bzl", "process_module")\n\n' +
			"process_module(\n" +
			"    ctx,\n" +
			'    module_name = "my_module_name",  # required\n' +
			")";
		assertEquals(expected, result);
	},

	testGenerateMacroExample: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_pkg");

		const label = new Label();
		label.setPkg("macros");
		label.setName("macros.bzl");

		const file = new File();
		file.setLabel(label);

		const nameAttr = new AttributeInfo();
		nameAttr.setName("name");
		nameAttr.setType(AttributeType.NAME);

		const srcsAttr = new AttributeInfo();
		srcsAttr.setName("srcs");
		srcsAttr.setType(AttributeType.LABEL_LIST);
		srcsAttr.setMandatory(true);

		const macroInfo = new MacroInfo();
		macroInfo.setAttributeList([nameAttr, srcsAttr]);

		const macro = new Macro();
		macro.setInfo(macroInfo);

		const symbol = new Symbol();
		symbol.setName("pkg_tar");
		symbol.setMacro(macro);

		const result = generateMacroExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_pkg//macros:macros.bzl", "pkg_tar")\n\n' +
			"pkg_tar(\n" +
			'    name = "pkg_tar",\n' +
			"    srcs = [],  # required\n" +
			")";
		assertEquals(expected, result);
	},

	testGenerateAspectExample: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("aspects");
		label.setName("aspects.bzl");

		const file = new File();
		file.setLabel(label);

		const aspectInfo = new AspectInfo();

		const aspect = new Aspect();
		aspect.setInfo(aspectInfo);

		const symbol = new Symbol();
		symbol.setName("go_proto_aspect");
		symbol.setAspect(aspect);

		const result = generateAspectExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//aspects:aspects.bzl", "go_proto_aspect")\n\n' +
			"# Example: Apply aspect to a target\n" +
			"my_rule(\n" +
			'    name = "my_target",  # required\n' +
			"    aspects = [go_proto_aspect],\n" +
			")";
		assertEquals(expected, result);
	},

	testGenerateModuleExtensionExample_noTags: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("extensions");
		label.setName("extensions.bzl");

		const file = new File();
		file.setLabel(label);

		const extInfo = new ModuleExtensionInfo();
		extInfo.setTagClassList([]);

		const ext = new ModuleExtension();
		ext.setInfo(extInfo);

		const symbol = new Symbol();
		symbol.setName("go_sdk");
		symbol.setModuleExtension(ext);

		const result = generateModuleExtensionExample(moduleVersion, file, symbol);

		const expected =
			'load("@rules_go//extensions:extensions.bzl", "go_sdk")\n\n' +
			"# In MODULE.bazel:\n" +
			'go_sdk = use_extension("@rules_go//extensions:extensions.bzl", "go_sdk")\n';
		assertEquals(expected, result);
	},

	testGenerateModuleExtensionExample_withTags: () => {
		const moduleVersion = new ModuleVersion();
		moduleVersion.setName("rules_go");

		const label = new Label();
		label.setPkg("extensions");
		label.setName("extensions.bzl");

		const file = new File();
		file.setLabel(label);

		const versionAttr = new AttributeInfo();
		versionAttr.setName("version");
		versionAttr.setType(AttributeType.STRING);
		versionAttr.setMandatory(true);

		const tagClass = new ModuleExtensionTagClassInfo();
		tagClass.setTagName("download");
		tagClass.setAttributeList([versionAttr]);

		const extInfo = new ModuleExtensionInfo();
		extInfo.setTagClassList([tagClass]);

		const ext = new ModuleExtension();
		ext.setInfo(extInfo);

		const symbol = new Symbol();
		symbol.setName("go_sdk");
		symbol.setModuleExtension(ext);

		const result = generateModuleExtensionExample(moduleVersion, file, symbol);

		// Note: Single attribute renders as single line without "# required" comment
		const expected =
			'load("@rules_go//extensions:extensions.bzl", "go_sdk")\n\n' +
			"# In MODULE.bazel:\n" +
			'go_sdk = use_extension("@rules_go//extensions:extensions.bzl", "go_sdk")\n' +
			"\n" +
			'go_sdk.download(version = "")';
		assertEquals(expected, result);
	},
});

goog.exportSymbol("bcrfrontend.starlarkTest", testSuite);
