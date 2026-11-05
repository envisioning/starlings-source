#!/usr/bin/env python3
"""Keep Apple string catalogs in step with Swift and project.yml.

Xcode the app writes extracted strings back into a String Catalog on every
build; `xcodebuild` does not. It still emits one `.stringsdata` file per
Swift source (SWIFT_EMIT_LOC_STRINGS, project.yml) into DerivedData, and
that is what this script reads. So the flow for an agent or CI is: build,
then run this.

InfoPlist catalogs take their English values and target membership from
XcodeGen's resolved project.yml. Each bundle gets the reasons it actually
declares; a shared catalog cannot overwrite a platform-specific reason.

    scripts/sync-string-catalog.py            # merge, rewrite the catalog
    scripts/sync-string-catalog.py --check    # fail when the code has a key the catalog lacks
    scripts/sync-string-catalog.py --check --translated pt-BR
                                              # ...or when a key has no pt-BR
    scripts/sync-string-catalog.py --info-plist-only --check --translated pt-BR
                                              # permission tables, no Swift build
    scripts/sync-string-catalog.py --prune    # merge, then drop every stale key; only
                                              # after Debug and Release builds of every
                                              # target, or DEBUG-only keys go too

Localizable merge rules, the same ones Xcode applies:
- a key the compiler saw is in the catalog; a new one is added bare;
- a key the compiler no longer sees is kept, marked `extractionState:
  stale`, so a translation survives a refactor that moves a string;
- a key marked `manual` is never touched;
- translations already in the catalog are never rewritten here.

Keys the compiler emits but nobody translates are skipped: the empty
string, bare format specifiers such as `%lld`, and separators such as ` · `.
"""

import argparse
import glob
import json
import os
import plistlib
import re
import subprocess
import sys
from xml.parsers.expat import ExpatError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "Resources", "Localizable.xcstrings")
DERIVED = os.path.join(ROOT, "DerivedData")
TARGETS = ("Starlings", "Starlings-iOS", "Starlings-Activities", "Starlings-Share", "Starlings-Watch", "Starlings-WatchWidgets")
TABLE = "Localizable"

# `%lld`, `#%lld · %@`, ` · `: nothing a translator can act on. A key with
# no letter in it is a layout, not a sentence.
UNTRANSLATABLE = re.compile(r"^[^A-Za-z]*$")


def stringsdata_files(derived: str) -> list[str]:
    found: list[str] = []
    for target in TARGETS:
        pattern = os.path.join(
            derived, "Build", "Intermediates.noindex", "Starlings.build", "*",
            f"{target}.build", "Objects-normal", "*", "*.stringsdata",
        )
        found.extend(glob.glob(pattern))
    return sorted(set(found))


def extracted_keys(files: list[str]) -> dict[str, str]:
    """key -> comment, from every file; the first non-empty comment wins."""
    keys: dict[str, str] = {}
    for path in files:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        for entry in data.get("tables", {}).get(TABLE, []):
            key = entry.get("key", "")
            if UNTRANSLATABLE.match(key):
                continue
            comment = entry.get("comment", "") or ""
            if key not in keys or (comment and not keys[key]):
                keys[key] = comment
    return keys


def load_catalog(path: str = CATALOG) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save_catalog(catalog: dict, path: str = CATALOG) -> None:
    # Xcode's own serialisation: two-space indent, sorted keys, a space
    # before each colon, so a diff against an Xcode-written file is quiet.
    text = json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=True)
    text = re.sub(r'^(\s*)"((?:[^"\\]|\\.)*)":', r'\1"\2" :', text, flags=re.M)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text + "\n")


def project_spec() -> dict:
    # XcodeGen resolves YAML includes/settings for us. Do not keep a second
    # YAML parser or a hand-copied list of permission keys/target membership.
    result = subprocess.run(
        ["xcodegen", "dump", "--type", "json", "--no-env"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"XcodeGen could not read project.yml: {(result.stderr or result.stdout).strip()}") from error


def info_catalog_inventory(spec: dict, languages: set[str]) -> tuple[dict, dict]:
    """Catalog -> English plist strings, and target -> bundle metadata."""
    catalogs: dict[str, dict[str, str]] = {}
    bundles: dict[str, dict] = {}
    for name, target in spec["targets"].items():
        if target["type"] not in ("application", "app-extension"):
            continue
        paths = [source["path"] for source in target.get("sources", [])
                 if os.path.basename(source["path"]) == "InfoPlist.xcstrings"
                 and source.get("buildPhase") == "resources"]
        if len(paths) != 1:
            raise ValueError(f"{name}: needs exactly one InfoPlist.xcstrings resource in project.yml")
        properties = dict(target.get("info", {}).get("properties", {}))
        # Generated plists may instead receive INFOPLIST_KEY_* build settings.
        settings = spec.get("settings", {})
        local_settings = target.get("settings", {})
        configurations = spec.get("configs", {"Debug": {}, "Release": {}})
        variants = []
        for config in configurations:
            values = dict(properties)
            for layer in (settings.get("base", {}), settings.get("configs", {}).get(config, {}),
                          local_settings.get("base", {}), local_settings.get("configs", {}).get(config, {})):
                values.update({key.removeprefix("INFOPLIST_KEY_"): value for key, value in layer.items()
                               if key.startswith("INFOPLIST_KEY_")})
            variants.append({key: value for key, value in values.items()
                             if key.endswith("UsageDescription") or key == "CFBundleDisplayName"})
        if any(values != variants[0] for values in variants[1:]):
            raise ValueError(f"{name}: localized Info.plist strings differ by build configuration")
        strings = variants[0]
        declared = set(properties.get("CFBundleLocalizations", []))
        if not languages <= declared:
            raise ValueError(f"{name}: CFBundleLocalizations is missing {', '.join(sorted(languages - declared))}")
        path = paths[0]
        expected = catalogs.setdefault(path, {})
        for key, value in strings.items():
            if not isinstance(value, str) or not value.strip() or "$(" in value:
                raise ValueError(f"{name}: {key} needs a literal English source in project.yml")
            if key in expected and expected[key] != value:
                raise ValueError(f"{path}: {key} has different reasons across targets; use separate catalogs")
            expected[key] = value
        bundles[name] = {"catalog": path, "strings": strings, "languages": declared,
                         "platform": target["platform"], "type": target["type"],
                         "product": local_settings.get("base", {}).get("PRODUCT_NAME", name)}
    return catalogs, bundles


def merge_info_catalog(catalog: dict, expected: dict[str, str]) -> list[str]:
    """Sync English key/value pairs; a changed reason needs translation review."""
    strings = catalog.setdefault("strings", {})
    language = catalog["sourceLanguage"]
    changed: list[str] = []
    for key, value in expected.items():
        entry = strings.setdefault(key, {})
        localizations = entry.setdefault("localizations", {})
        if localizations.get(language, {}).get("stringUnit", {}).get("value") != value:
            localizations[language] = {"stringUnit": {"state": "translated", "value": value}}
            for locale, localization in localizations.items():
                if locale != language and "stringUnit" in localization:
                    localization["stringUnit"]["state"] = "needs_review"
            changed.append(key)
        # xcodebuild does not sync this table either. project.yml owns its
        # key set even though Xcode represents entries as manually managed.
        entry["extractionState"] = "manual"
        if key == "CFBundleDisplayName":
            entry["shouldTranslate"] = False
    for key, entry in strings.items():
        if key not in expected:
            entry["extractionState"] = "stale"
    return changed


def info_catalog_problems(catalog: dict, expected: dict, languages: set[str]) -> list[str]:
    problems = []
    if catalog.get("sourceLanguage") != "en":
        problems.append("sourceLanguage must be en, matching project.yml")
    for key, english in expected.items():
        entry = catalog.get("strings", {}).get(key, {})
        localizations = entry.get("localizations", {})
        if localizations.get("en", {}).get("stringUnit", {}).get("value") != english:
            problems.append(f"{key}: English source differs from project.yml; sync and review its translations")
        if entry.get("extractionState") == "stale":
            problems.append(f"{key}: current Info.plist key is marked stale")
        if key.endswith("UsageDescription") and entry.get("shouldTranslate") is False:
            problems.append(f"{key}: permission reasons must be translated")
        for language in sorted(languages):
            if not translated(localizations.get(language, {})):
                problems.append(f"{key}: no reviewed {language} translation")
    return problems


def read_built_plist(path: str) -> dict:
    with open(path, "rb") as handle:
        data = handle.read()
    # CopyStringsFile on Mac encodes the catalog's XML as UTF-16 while
    # retaining its UTF-8 declaration; iOS produces a binary plist instead.
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = re.sub(r'encoding="[^"]+"', 'encoding="UTF-8"', data.decode("utf-16"), count=1)
        data = text.encode("utf-8")
    return plistlib.loads(data)


def built_info_problems(bundle: dict, catalog: dict, products: str) -> list[str]:
    """Check the OS-facing compiled resources, not only catalog membership."""
    directory = {"macOS": "Release", "iOS": "Release-iphoneos", "watchOS": "Release-watchos"}[bundle["platform"]]
    suffix = ".app" if bundle["type"] == "application" else ".appex"
    path = os.path.join(products, directory, bundle["product"] + suffix)
    if bundle["platform"] == "macOS":
        path = os.path.join(path, "Contents")
    problems = []
    try:
        plist = read_built_plist(os.path.join(path, "Info.plist"))
        if not bundle["languages"] <= set(plist.get("CFBundleLocalizations", [])):
            problems.append("built Info.plist is missing declared languages")
        for key, value in bundle["strings"].items():
            if plist.get(key) != value:
                problems.append(f"built Info.plist differs from project.yml: {key}")
        resources = os.path.join(path, "Resources") if bundle["platform"] == "macOS" else path
        for language in sorted(bundle["languages"]):
            values = read_built_plist(os.path.join(resources, language + ".lproj", "InfoPlist.strings"))
            for key in bundle["strings"]:
                expected = catalog.get("strings", {}).get(key, {}).get("localizations", {}).get(language, {}).get("stringUnit", {}).get("value")
                if not expected or values.get(key) != expected:
                    problems.append(f"{language}/InfoPlist.strings: missing or incorrect {key}")
    except (OSError, ValueError, plistlib.InvalidFileException, ExpatError) as error:
        problems.append(f"built localization unavailable: {error}")
    return problems


def sync_info_catalogs(args) -> int:
    languages = {"en"}
    if args.translated:
        languages.add(args.translated)
    expected, bundles = info_catalog_inventory(project_spec(), languages)
    catalogs = {}
    problems = []
    for path, strings in sorted(expected.items()):
        absolute = os.path.join(ROOT, path)
        catalog = load_catalog(absolute) if os.path.exists(absolute) else {"sourceLanguage": "en", "strings": {}, "version": "1.0"}
        catalogs[path] = catalog
        if args.check:
            problems.extend(f"{path}: {problem}" for problem in info_catalog_problems(catalog, strings, languages))
        else:
            merge_info_catalog(catalog, strings)
            if args.prune:
                catalog["strings"] = {key: entry for key, entry in catalog["strings"].items() if entry.get("extractionState") != "stale"}
            save_catalog(catalog, absolute)
    if args.built_products:
        for name, bundle in bundles.items():
            problems.extend(f"{name}: {problem}" for problem in built_info_problems(bundle, catalogs[bundle["catalog"]], args.built_products))
    for problem in problems:
        print(f"sync-string-catalog: {problem}", file=sys.stderr)
    if not problems:
        print(f"sync-string-catalog: InfoPlist, {len(bundles)} bundles, {len(expected)} catalogs, {sum(map(len, expected.values()))} strings")
    return 1 if problems else 0


def merge(catalog: dict, keys: dict[str, str]) -> tuple[list[str], list[str]]:
    strings: dict = catalog.setdefault("strings", {})
    added: list[str] = []
    staled: list[str] = []
    for key, comment in keys.items():
        entry = strings.get(key)
        if entry is None:
            entry = {}
            if comment:
                entry["comment"] = comment
            strings[key] = entry
            added.append(key)
            continue
        if entry.get("extractionState") == "manual":
            continue
        if entry.get("extractionState") == "stale":
            del entry["extractionState"]
        if comment and not entry.get("comment"):
            entry["comment"] = comment
    for key, entry in strings.items():
        if key in keys or entry.get("extractionState") in ("manual", "stale"):
            continue
        entry["extractionState"] = "stale"
        staled.append(key)
    return added, staled


def translated(localization: dict) -> bool:
    """A plain value, or plural forms that are all translated (meet#805)."""
    unit = localization.get("stringUnit")
    if unit is not None:
        return unit.get("state") == "translated" and bool(unit.get("value", "").strip())
    plural = localization.get("variations", {}).get("plural", {})
    forms = [form.get("stringUnit", {}) for form in plural.values()]
    return {"one", "other"} <= set(plural) and all(form.get("state") == "translated" and form.get("value") for form in forms)


def untranslated(catalog: dict, language: str) -> list[str]:
    missing: list[str] = []
    for key, entry in catalog.get("strings", {}).items():
        if entry.get("extractionState") == "stale" or entry.get("shouldTranslate") is False:
            continue
        if not translated(entry.get("localizations", {}).get(language, {})):
            missing.append(key)
    return missing


def export(catalog: dict, path: str, language: str = "pt-BR") -> int:
    """One row per live key, for a reader: key, the translation, the comment."""
    import csv
    rows = 0
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, quoting=csv.QUOTE_ALL)
        writer.writerow(["key", language, "comment"])
        for key, entry in sorted(catalog.get("strings", {}).items()):
            if entry.get("extractionState") == "stale":
                continue
            localization = entry.get("localizations", {}).get(language, {})
            if entry.get("shouldTranslate") is False:
                value = "(stays English)"
            elif "variations" in localization:
                plural = localization["variations"].get("plural", {})
                value = " | ".join(f"{name}: {form.get('stringUnit', {}).get('value', '')}" for name, form in plural.items())
            else:
                value = localization.get("stringUnit", {}).get("value", "")
            writer.writerow([key, value, entry.get("comment", "")])
            rows += 1
    print(f"sync-string-catalog: {rows} rows written to {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--derived-data", default=DERIVED, help="DerivedData to read .stringsdata from")
    parser.add_argument("--check", action="store_true", help="exit 1 instead of writing when the catalog is behind")
    parser.add_argument("--translated", metavar="LANG", help="with --check: every live key needs a LANG translation")
    parser.add_argument("--prune", action="store_true", help="after the merge, drop keys the compiler no longer sees (stale)")
    parser.add_argument("--export", metavar="CSV", help="write key, pt-BR, comment for every live key and exit; needs no build (meet#811)")
    parser.add_argument("--info-plist-only", action="store_true", help="sync/check InfoPlist catalogs from project.yml without a Swift build")
    parser.add_argument("--built-products", metavar="DIR", help="also check Release bundles' compiled InfoPlist.strings under Build/Products")
    args = parser.parse_args()

    if args.export:
        return export(load_catalog(), args.export)

    try:
        info_result = sync_info_catalogs(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"sync-string-catalog: {error}", file=sys.stderr)
        return 2
    if args.info_plist_only:
        return info_result

    files = stringsdata_files(args.derived_data)
    if not files:
        print(f"sync-string-catalog: no .stringsdata under {args.derived_data}; build first", file=sys.stderr)
        return 2
    keys = extracted_keys(files)
    catalog = load_catalog()
    before = json.dumps(catalog, sort_keys=True)
    added, staled = merge(catalog, keys)
    changed = json.dumps(catalog, sort_keys=True) != before

    if args.check:
        problems = 0
        # A key the code has and the catalog lacks is the failure: it would
        # ship in English. A key that went stale is only noise until the next
        # sync, the same as in Xcode.
        if added:
            problems += 1
            print("Catalog is behind the code. Run scripts/sync-string-catalog.py and commit Resources/Localizable.xcstrings.", file=sys.stderr)
            for key in added:
                print(f"  new: {key!r}", file=sys.stderr)
        for key in staled:
            print(f"sync-string-catalog: stale, sync when convenient: {key!r}", file=sys.stderr)
        if args.translated:
            missing = untranslated(catalog, args.translated)
            if missing:
                problems += 1
                print(f"{len(missing)} keys have no {args.translated} translation:", file=sys.stderr)
                for key in missing:
                    print(f"  {key!r}", file=sys.stderr)
        return 1 if problems or info_result else 0

    pruned = 0
    if args.prune:
        stale = [key for key, entry in catalog["strings"].items() if entry.get("extractionState") == "stale"]
        for key in stale:
            del catalog["strings"][key]
        pruned = len(stale)
        changed = changed or pruned > 0
    if changed:
        save_catalog(catalog)
    live = sum(1 for e in catalog["strings"].values() if e.get("extractionState") != "stale")
    print(f"sync-string-catalog: {len(files)} files, {live} live keys, +{len(added)} new, {len(staled)} newly stale, {pruned} pruned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
