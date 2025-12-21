goog.module('centrl.registryTest');
goog.setTestOnly();

const Module = goog.require('proto.build.stack.bazel.registry.v1.Module');
const ModuleCommit = goog.require('proto.build.stack.bazel.registry.v1.ModuleCommit');
const ModuleMetadata = goog.require('proto.build.stack.bazel.registry.v1.ModuleMetadata');
const ModuleVersion = goog.require('proto.build.stack.bazel.registry.v1.ModuleVersion');
const Registry = goog.require('proto.build.stack.bazel.registry.v1.Registry');
const jsunit = goog.require('goog.testing.jsunit');
const testSuite = goog.require('goog.testing.testSuite');
const { calculateAgeSummary, getVersionDistances } = goog.require('centrl.registry');

testSuite({
    teardown: function () { },

    testCalculateAgeSummary: function () {
        // Test edge cases
        assertEquals("0d", calculateAgeSummary(0));

        // Test days (0-29)
        assertEquals("1d", calculateAgeSummary(1));
        assertEquals("7d", calculateAgeSummary(7));
        assertEquals("29d", calculateAgeSummary(29));

        // Test months boundary (30-364)
        assertEquals("1.0m", calculateAgeSummary(30));
        assertEquals("1.5m", calculateAgeSummary(45));
        assertEquals("2.5m", calculateAgeSummary(75));
        assertEquals("6.0m", calculateAgeSummary(180));
        assertEquals("11.0m", calculateAgeSummary(330));
        assertEquals("12.1m", calculateAgeSummary(364));

        // Test years boundary (365+)
        assertEquals("1.0y", calculateAgeSummary(365));
        assertEquals("1.5y", calculateAgeSummary(548));  // ~1.5 years
        assertEquals("2.0y", calculateAgeSummary(730));
        assertEquals("5.5y", calculateAgeSummary(2008)); // ~5.5 years
        assertEquals("10.0y", calculateAgeSummary(3650));
    },

    testGetVersionDistances_emptyRegistry: function () {
        const registry = new Registry();
        const result = getVersionDistances(registry);
        assertEquals(0, result.size);
    },

    testGetVersionDistances_moduleWithoutMetadata: function () {
        const registry = new Registry();
        const module = new Module();
        module.setName('test-module');
        // No metadata set
        registry.setModulesList([module]);

        const result = getVersionDistances(registry);
        assertEquals(0, result.size);
    },

    testGetVersionDistances_singleVersion: function () {
        const registry = new Registry();

        // Create module with metadata
        const module = new Module();
        module.setName('rules_go');

        const metadata = new ModuleMetadata();
        metadata.setVersionsList(['1.0.0']);
        module.setMetadata(metadata);

        // Create module version with commit
        const commit = new ModuleCommit();
        commit.setDate('2024-01-01T00:00:00Z');

        const moduleVersion = new ModuleVersion();
        moduleVersion.setVersion('1.0.0');
        moduleVersion.setCommit(commit);

        module.setVersionsList([moduleVersion]);
        registry.setModulesList([module]);

        const result = getVersionDistances(registry);

        assertEquals(1, result.size);
        assertTrue(result.has('rules_go'));

        const versionMap = result.get('rules_go');
        assertEquals(1, versionMap.size);
        assertTrue(versionMap.has('1.0.0'));

        const versionInfo = versionMap.get('1.0.0');
        assertEquals(0, versionInfo.versionsBehind);
        assertEquals('0d', versionInfo.ageSummary);
    },

    testGetVersionDistances_multipleVersions: function () {
        const registry = new Registry();

        const module = new Module();
        module.setName('rules_rust');

        const metadata = new ModuleMetadata();
        metadata.setVersionsList(['3.0.0', '2.0.0', '1.0.0']);
        module.setMetadata(metadata);

        // Latest version (3.0.0) - today
        const commit3 = new ModuleCommit();
        commit3.setDate('2024-12-18T00:00:00Z');
        const moduleVersion3 = new ModuleVersion();
        moduleVersion3.setVersion('3.0.0');
        moduleVersion3.setCommit(commit3);

        // Version 2.0.0 - 60 days ago (should show ~2.0m)
        const commit2 = new ModuleCommit();
        commit2.setDate('2024-10-19T00:00:00Z');
        const moduleVersion2 = new ModuleVersion();
        moduleVersion2.setVersion('2.0.0');
        moduleVersion2.setCommit(commit2);

        // Version 1.0.0 - 400 days ago (should show ~1.1y)
        const commit1 = new ModuleCommit();
        commit1.setDate('2023-11-13T00:00:00Z');
        const moduleVersion1 = new ModuleVersion();
        moduleVersion1.setVersion('1.0.0');
        moduleVersion1.setCommit(commit1);

        module.setVersionsList([moduleVersion3, moduleVersion2, moduleVersion1]);
        registry.setModulesList([module]);

        const result = getVersionDistances(registry);

        assertEquals(1, result.size);
        const versionMap = result.get('rules_rust');
        assertEquals(3, versionMap.size);

        // Latest version: 0 versions behind, 0 days old
        const v3Info = versionMap.get('3.0.0');
        assertEquals(0, v3Info.versionsBehind);
        assertEquals('0d', v3Info.ageSummary);

        // Version 2.0.0: 1 version behind, ~60 days old
        const v2Info = versionMap.get('2.0.0');
        assertEquals(1, v2Info.versionsBehind);
        assertEquals('2.0m', v2Info.ageSummary);

        // Version 1.0.0: 2 versions behind, ~400 days old
        const v1Info = versionMap.get('1.0.0');
        assertEquals(2, v1Info.versionsBehind);
        assertEquals('1.1y', v1Info.ageSummary);
    },

    testGetVersionDistances_versionWithoutCommit: function () {
        const registry = new Registry();

        const module = new Module();
        module.setName('test-module');

        const metadata = new ModuleMetadata();
        metadata.setVersionsList(['2.0.0', '1.0.0']);
        module.setMetadata(metadata);

        const moduleVersion1 = new ModuleVersion();
        moduleVersion1.setVersion('1.0.0');
        // No commit set

        const moduleVersion2 = new ModuleVersion();
        moduleVersion2.setVersion('2.0.0');
        // No commit set

        module.setVersionsList([moduleVersion2, moduleVersion1]);
        registry.setModulesList([module]);

        const result = getVersionDistances(registry);

        const versionMap = result.get('test-module');

        // Should still track versions behind, but no age summary
        const v2Info = versionMap.get('2.0.0');
        assertEquals(0, v2Info.versionsBehind);
        assertNull(v2Info.ageSummary);

        const v1Info = versionMap.get('1.0.0');
        assertEquals(1, v1Info.versionsBehind);
        assertNull(v1Info.ageSummary);
    },

    testGetVersionDistances_protobufBug: function () {
        // Reproduces bug where protobuf 33.1 shows as 52 versions behind 33.2
        // This happens when metadata.versionsList contains ALL versions (33.2, 33.1, 33.0, ... 27.0)
        // but module.versionsList only contains the versions present in BCR (33.2, 33.1)
        const registry = new Registry();

        const module = new Module();
        module.setName('protobuf');

        // Metadata contains ALL published versions (from upstream source)
        const metadata = new ModuleMetadata();
        const allVersions = [];
        // Simulate protobuf versions 33.2 down to 27.0 (52 versions total)
        for (let major = 33; major >= 27; major--) {
            for (let minor = 2; minor >= 0; minor--) {
                allVersions.push(`${major}.${minor}`);
                if (allVersions.length >= 52) break;
            }
            if (allVersions.length >= 52) break;
        }
        metadata.setVersionsList(allVersions);
        module.setMetadata(metadata);

        // BUT: module.versionsList only contains versions in BCR (33.2 and 33.1)
        const commit332 = new ModuleCommit();
        commit332.setDate('2024-12-18T00:00:00Z');
        const moduleVersion332 = new ModuleVersion();
        moduleVersion332.setVersion('33.2');
        moduleVersion332.setCommit(commit332);

        const commit331 = new ModuleCommit();
        commit331.setDate('2024-10-19T00:00:00Z');
        const moduleVersion331 = new ModuleVersion();
        moduleVersion331.setVersion('33.1');
        moduleVersion331.setCommit(commit331);

        module.setVersionsList([moduleVersion332, moduleVersion331]);
        registry.setModulesList([module]);

        const result = getVersionDistances(registry);
        const versionMap = result.get('protobuf');

        // The bug: version 33.1 shows as 52 versions behind because it's at index 1
        // in metadata.versionsList, but should only be 1 version behind
        const v331Info = versionMap.get('33.1');

        // Current buggy behavior: versionsBehind = 1 (index in metadata list)
        // This is WRONG - should only count versions that actually exist in BCR
        assertEquals(1, v331Info.versionsBehind); // This will FAIL showing the bug

        // Expected correct behavior:
        // v331Info.versionsBehind should be 1 (only 33.2 is newer in BCR)
        // NOT 52 (which would be the index if counting all metadata versions)
    },
});

goog.exportSymbol('centrl.registryTest', testSuite);
