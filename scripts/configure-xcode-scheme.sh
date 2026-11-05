#!/bin/sh
set -eu

scheme_path="Starlings.xcodeproj/xcshareddata/xcschemes/Starlings.xcscheme"

if [ ! -f "$scheme_path" ]; then
  echo "Missing generated scheme: $scheme_path" >&2
  exit 1
fi

# Apple's camera-effects VFX pipeline can crash when Xcode injects its Metal
# capture layer. Explicitly disable those diagnostics for normal Run actions;
# our own LiveKit background-blur processor remains available.
/usr/bin/perl -0pi -e 's/(debugServiceExtension = "internal"\n)(?!\s*enableGPUFrameCaptureMode)/$1      enableGPUFrameCaptureMode = "3"\n      enableGPUValidationMode = "1"\n/' "$scheme_path"
