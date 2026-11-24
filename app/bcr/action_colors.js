/**
 * @fileoverview Shared action mnemonic palette for Bazel tools.
 */
goog.module("bcrfrontend.actionColors");

/** Bezel action palette, grouped by color.
 * @const {!Array<!Array<string>>}
 */
const BEZEL_MNEMONIC_COLORS = [
	["#a05f14", "JavaIjar Javac Turbine JavacTurbine JavaSourceJar"],
	["#ed306a", "CppCompile CcStrip SolibSymlink"],
	["#f7ba13", "CppLink"],
	["#159ccf", "GoCompilePkg GoLink GoSourcesData"],
	["#4b3c72", "haskell"],
	["#094eaf", "jsonnet"],
	["#eb7b27", "kotlin"],
	["#3676fe", "objc"],
	["#295e94", "py python"],
	["#1975e1", "r"],
	["#5c0c11", "ruby SoyCompiler"],
	["#d59471", "rust Rustc"],
	["#b21931", "scala Scalac ScalaDeployJar"],
	["#7add40", "sh GZIP Genrule FileWrite TemplateExpand"],
	["#fe9b37", "swift"],
	["#236176", "ts TypeScriptCompile"],
	["#eedc49", "js Closure TestRunner"],
	["#6cae04", "Commands BazelWorkspaceStatusAction SkylarkAction Middleman PackagingSourcesManifest"],
	["#e22b9a", "SymlinkTree SourceSymlinkManifest ExecutableSymlink"],
	["#2b3c42", "docker ImageConfig ImageLayer SHA256"],
	["#8fbc2b", "android"],
	["#187405", "csharp CoreCompile"],
	["#47b2b9", "GenProtoDescriptorSet GoProtocGen ProtoCompile GenProto proto"],
	["#50a6c0", "elm"],
	["#fc4f05", "genmnemonic"],
	["#1a90f4", "filegroup toolchain"],
	["#3b5b3a", "platform"],
	["#e47182", "config"],
	["#a82273", "constraint"],
	["#000000", "alias"],
	["#2db23e", "skylark"],
	["#442b68", "css SassCompiler"],
	["#dd3531", "AngularTemplateCompile"],
];
/** @const {!Map<string,string>} */
const MNEMONIC_COLORS = new Map();
for (const entry of BEZEL_MNEMONIC_COLORS) {
	for (const name of entry[1].split(" ")) MNEMONIC_COLORS.set(name, entry[0]);
}

/**
 * @param {string} mnemonic
 * @return {string}
 */
function mnemonicColor(mnemonic) {
	const known = MNEMONIC_COLORS.get(mnemonic);
	if (known) return known;
	let hash = 0;
	for (let i = 0; i < mnemonic.length; i++) {
		hash = (Math.imul(hash, 31) + mnemonic.charCodeAt(i)) >>> 0;
	}
	return "hsl(" + (hash % 360) + ", 65%, 48%)";
}

exports.mnemonicColor = mnemonicColor;
