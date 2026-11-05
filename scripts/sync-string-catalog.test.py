#!/usr/bin/env python3
"""Permission-catalog regressions; the fast gate needs no Apple toolchain."""
import importlib.util
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("catalog", Path(__file__).with_name("sync-string-catalog.py"))
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


def target(path="Resources/InfoPlist.xcstrings", reason="Camera for meetings.", platform="macOS"):
    return {
        "type": "application", "platform": platform,
        "sources": [{"path": path, "buildPhase": "resources"}],
        "settings": {"base": {"PRODUCT_NAME": "Starlings"}},
        "info": {"properties": {"CFBundleDisplayName": "Starlings", "CFBundleLocalizations": ["en", "pt-BR"],
                                  "NSCameraUsageDescription": reason}},
    }


def translated_catalog(expected):
    result = {"sourceLanguage": "en", "strings": {}, "version": "1.0"}
    catalog.merge_info_catalog(result, expected)
    for entry in result["strings"].values():
        entry["localizations"]["pt-BR"] = {"stringUnit": {"state": "translated", "value": "Câmera para reuniões."}}
    result["strings"]["CFBundleDisplayName"]["localizations"]["pt-BR"]["stringUnit"]["value"] = "Starlings"
    return result


class InfoPlistCatalogTests(unittest.TestCase):
    def setUp(self):
        self.project = {"targets": {"Mac": target(), "iOS": target("Resources/iOS/InfoPlist.xcstrings", "Camera and scans.", "iOS")}}

    def test_platform_specific_reasons_do_not_overwrite_each_other(self):
        expected, bundles = catalog.info_catalog_inventory(self.project, {"en", "pt-BR"})
        self.assertEqual(expected["Resources/InfoPlist.xcstrings"]["NSCameraUsageDescription"], "Camera for meetings.")
        self.assertEqual(expected["Resources/iOS/InfoPlist.xcstrings"]["NSCameraUsageDescription"], "Camera and scans.")
        self.assertEqual(set(bundles), {"Mac", "iOS"})
        self.project["targets"]["iOS"]["sources"] = self.project["targets"]["Mac"]["sources"]
        with self.assertRaisesRegex(ValueError, "different reasons across targets"):
            catalog.info_catalog_inventory(self.project, {"pt-BR"})

    def test_new_permissions_and_build_setting_sources_are_discovered(self):
        self.project["targets"]["Mac"]["info"]["properties"]["NSBluetoothAlwaysUsageDescription"] = "Bluetooth for devices."
        self.project["settings"] = {"base": {"INFOPLIST_KEY_NSContactsUsageDescription": "Contacts for invites."}}
        self.project["targets"]["iOS"]["settings"]["configs"] = {"Release": {"INFOPLIST_KEY_NSContactsUsageDescription": "Different."}}
        with self.assertRaisesRegex(ValueError, "differ by build configuration"):
            catalog.info_catalog_inventory(self.project, {"pt-BR"})
        del self.project["targets"]["iOS"]["settings"]["configs"]
        expected, _ = catalog.info_catalog_inventory(self.project, {"pt-BR"})
        self.assertEqual(expected["Resources/InfoPlist.xcstrings"]["NSBluetoothAlwaysUsageDescription"], "Bluetooth for devices.")
        self.assertEqual(expected["Resources/iOS/InfoPlist.xcstrings"]["NSContactsUsageDescription"], "Contacts for invites.")

    def test_every_app_and_extension_needs_resource_and_language_coverage(self):
        extension = target("Resources/Extensions/InfoPlist.xcstrings")
        extension["type"] = "app-extension"
        self.project["targets"]["NewWidget"] = extension
        extension["sources"] = []
        with self.assertRaisesRegex(ValueError, "NewWidget: needs exactly one"):
            catalog.info_catalog_inventory(self.project, {"pt-BR"})
        extension["sources"] = [{"path": "Resources/Extensions/InfoPlist.xcstrings", "buildPhase": "sources"}]
        with self.assertRaisesRegex(ValueError, "needs exactly one"):
            catalog.info_catalog_inventory(self.project, {"pt-BR"})
        extension["sources"][0]["buildPhase"] = "resources"
        extension["info"]["properties"]["CFBundleLocalizations"] = ["en"]
        with self.assertRaisesRegex(ValueError, "NewWidget: CFBundleLocalizations is missing pt-BR"):
            catalog.info_catalog_inventory(self.project, {"pt-BR"})
        with self.assertRaisesRegex(ValueError, "missing fr"):
            catalog.info_catalog_inventory(self.project, {"fr"})

    def test_non_bundle_targets_are_ignored(self):
        self.project["targets"]["Tests"] = {"type": "bundle.unit-test"}
        self.project["targets"]["CLI"] = {"type": "tool"}
        _, bundles = catalog.info_catalog_inventory(self.project, {"pt-BR"})
        self.assertEqual(len(bundles), 2)

    def test_english_change_preserves_translation_but_requires_review(self):
        expected = self.project["targets"]["Mac"]["info"]["properties"].copy()
        del expected["CFBundleLocalizations"]
        data = translated_catalog(expected)
        expected["NSCameraUsageDescription"] = "Camera for meetings and scans."
        self.assertTrue(any("English source differs" in problem for problem in catalog.info_catalog_problems(data, expected, {"pt-BR"})))
        self.assertEqual(catalog.merge_info_catalog(data, expected), ["NSCameraUsageDescription"])
        portuguese = data["strings"]["NSCameraUsageDescription"]["localizations"]["pt-BR"]["stringUnit"]
        self.assertEqual(portuguese, {"state": "needs_review", "value": "Câmera para reuniões."})
        self.assertTrue(any("no reviewed pt-BR" in problem for problem in catalog.info_catalog_problems(data, expected, {"pt-BR"})))
        self.assertEqual(data["strings"]["CFBundleDisplayName"]["localizations"]["pt-BR"]["stringUnit"]["state"], "translated")

    def test_permission_cannot_bypass_translation_check(self):
        expected, _ = catalog.info_catalog_inventory(self.project, {"pt-BR"})
        values = expected["Resources/InfoPlist.xcstrings"]
        data = translated_catalog(values)
        self.assertEqual(catalog.info_catalog_problems(data, values, {"en", "pt-BR"}), [])
        entry = data["strings"]["NSCameraUsageDescription"]
        entry["shouldTranslate"] = False
        self.assertIn("NSCameraUsageDescription: permission reasons must be translated", catalog.info_catalog_problems(data, values, {"pt-BR"}))
        del entry["shouldTranslate"]
        for value in ("", "   "):
            entry["localizations"]["pt-BR"]["stringUnit"]["value"] = value
            self.assertTrue(catalog.info_catalog_problems(data, values, {"pt-BR"}))
        del entry["localizations"]["pt-BR"]
        self.assertTrue(catalog.info_catalog_problems(data, values, {"pt-BR"}))

    def test_removed_permission_is_stale_and_returning_permission_is_live(self):
        expected, _ = catalog.info_catalog_inventory(self.project, {"pt-BR"})
        values = expected["Resources/InfoPlist.xcstrings"]
        data = translated_catalog(values)
        catalog.merge_info_catalog(data, {"CFBundleDisplayName": "Starlings"})
        self.assertEqual(data["strings"]["NSCameraUsageDescription"]["extractionState"], "stale")
        catalog.merge_info_catalog(data, values)
        self.assertEqual(catalog.info_catalog_problems(data, values, {"pt-BR"}), [])

    def test_compiled_resources_are_checked_for_all_platforms(self):
        expected, bundles = catalog.info_catalog_inventory(self.project, {"pt-BR"})
        for platform, directory, kind, suffix in (("macOS", "Release", "application", ".app"),
                                                 ("iOS", "Release-iphoneos", "application", ".app"),
                                                 ("watchOS", "Release-watchos", "app-extension", ".appex")):
            bundle = dict(bundles["Mac"], platform=platform, type=kind)
            data = translated_catalog(expected[bundle["catalog"]])
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / directory / ("Starlings" + suffix)
                if platform == "macOS":
                    root /= "Contents"
                resources = root / "Resources" if platform == "macOS" else root
                root.mkdir(parents=True)
                with (root / "Info.plist").open("wb") as handle:
                    plistlib.dump(dict(bundle["strings"], CFBundleLocalizations=["en", "pt-BR"]), handle)
                for locale in ("en", "pt-BR"):
                    path = resources / (locale + ".lproj") / "InfoPlist.strings"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("wb") as handle:
                        plistlib.dump({key: entry["localizations"][locale]["stringUnit"]["value"] for key, entry in data["strings"].items()}, handle)
                self.assertEqual(catalog.built_info_problems(bundle, data, temp), [])
                incomplete = dict(data, strings={key: entry for key, entry in data["strings"].items() if key != "NSCameraUsageDescription"})
                self.assertTrue(any("missing or incorrect NSCameraUsageDescription" in p for p in catalog.built_info_problems(bundle, incomplete, temp)))
                path = resources / "pt-BR.lproj" / "InfoPlist.strings"
                path.write_bytes(plistlib.dumps({"NSCameraUsageDescription": "Wrong platform reason."}))
                self.assertTrue(any("missing or incorrect NSCameraUsageDescription" in p for p in catalog.built_info_problems(bundle, data, temp)))
                path.unlink()
                self.assertTrue(any("unavailable" in p for p in catalog.built_info_problems(bundle, data, temp)))

    def test_xcode_utf16_xml_and_binary_strings_files_are_readable(self):
        expected = {"NSCameraUsageDescription": "Câmera para reuniões."}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "InfoPlist.strings"
            xml = plistlib.dumps(expected).decode("utf-8")
            for contents in (xml.encode("utf-16"), xml.encode("utf-16-be"), plistlib.dumps(expected, fmt=plistlib.FMT_BINARY)):
                # UTF-16 BE needs its BOM, as CopyStringsFile supplies.
                if contents.startswith(b"\x00<"):
                    contents = b"\xfe\xff" + contents
                path.write_bytes(contents)
                self.assertEqual(catalog.read_built_plist(path), expected)


if __name__ == "__main__":
    unittest.main()
