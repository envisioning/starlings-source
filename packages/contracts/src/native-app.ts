// The Apple apps' identity: the bundle ID every target
// derives its own from, the App Group, the name the app has on disk, and the
// sign-in callback. Swift reads these through `ContractConstants`
// (scripts/gen-swift-registries.mjs); the Worker reads the callbacks.
//
// The same bundle ID is in two more places that cannot import this module:
// `STARLINGS_BUNDLE_ID` in project.yml (every target's bundle ID and the App
// Group entitlement) and scripts/app-names.sh (the release scripts). Change
// all three together.
//
// This file imports nothing: the marketing Worker loads it with plain Node
// (services/marketing/src/index.js), which resolves no extensionless import.

/** The Mac and iOS app. Every other target is this plus a suffix (`.share`, `.watchkitapp`). */
export const NATIVE_APP_BUNDLE_ID = 'com.starlingshq.app';
/** The App Group the iOS app, its extensions and the watch share. */
export const NATIVE_APP_GROUP = `group.${NATIVE_APP_BUNDLE_ID}` as const;
/**
 * The app's name on disk: the product (`Starlings.app`), and the folder it
 * writes under `~/Library/Application Support` and `~/Library/Logs`.
 */
export const NATIVE_APP_NAME = 'Starlings';
/** The iPhone link scheme that widgets, Live Activities and notifications write. */
export const NATIVE_LINK_SCHEME = 'starlings';
/** The scheme those surfaces wrote before; still registered and read so installed ones keep working. */
export const LEGACY_NATIVE_LINK_SCHEME = 'meet';

/**
 * Where the workspace sends a native sign-in back to: the app's bundle ID as
 * a scheme. The app passes it to `/api/auth/native/start` as `callback`.
 */
export const NATIVE_SIGN_IN_CALLBACK = `${NATIVE_APP_BUNDLE_ID}:/auth/callback` as const;
/**
 * The callback of the apps released before the rename (bundle ID
 * `com.envisioning.meet`). They send no `callback`, so a start without one
 * returns here. Retire it when no device reports a version older than the
 * rename.
 */
export const LEGACY_NATIVE_SIGN_IN_CALLBACK = 'com.envisioning.meet:/auth/callback';
/**
 * The https callback on a workspace host: `https://<host><this>`.
 * Only the signed app can claim it, through its associated domains, so no
 * other app on the device receives the code. The app uses it on iOS 17.4 and
 * later for a workspace host (`*.<suffix>`, the app's associated
 * domains in project.yml); every
 * other start keeps a scheme above.
 */
export const NATIVE_SIGN_IN_HTTPS_PATH = '/auth/native/callback';
/**
 * The app's ID in a host's apple-app-site-association: the team ID and the
 * bundle ID. The team is `DEVELOPMENT_TEAM` in the Apple overlay
 * (Config/Starlings.xcconfig) and `NATIVE_APPLE_TEAM_ID` in the Worker config.
 * Change both together.
 */
export const nativeAppId = (teamId: string): string => `${teamId}.${NATIVE_APP_BUNDLE_ID}`;
/**
 * The Android app's application ID (`applicationId` in
 * `android/app/build.gradle.kts`). Change both together.
 */
export const ANDROID_APP_PACKAGE = 'work.starlings.android';
/**
 * The SHA-256 of the Android release signing certificate
 * (`scripts/android-release-key.sh` prints it). Each workspace host names it
 * in `/.well-known/assetlinks.json`, so Android verifies the app's room-link
 * filters (#1238). A new release key changes it here and nowhere else.
 */
export const ANDROID_RELEASE_CERT_SHA256 = '5C:33:4A:69:02:4D:F7:3E:1C:26:91:28:F6:87:1A:65:D1:B5:D1:33:1E:F7:7B:88:54:97:69:89:86:13:E5:9F';
/**
 * The SHA-256 of the debug keystore on the Android build host, mini-4p
 * (`~/.android/debug.keystore`, `keytool -list -v -storepass android`).
 * Only a development Worker names it. A debug build from another Mac has
 * another key and does not verify.
 */
export const ANDROID_DEBUG_CERT_SHA256 = 'AC:F9:3D:7C:4F:3C:C5:C4:53:E8:E1:5C:20:17:E0:63:9E:26:9F:19:B9:3E:64:AE:D2:6A:9E:61:A3:A9:59:93';
/**
 * The Android app's callback: its application ID as a scheme
 * (`android/app/build.gradle.kts`). Like the Apple scheme, any app can
 * register it; the PKCE verifier, which never leaves the app that started the
 * sign-in, is what makes an intercepted code worthless.
 */
export const ANDROID_NATIVE_SIGN_IN_CALLBACK = 'work.starlings.android:/auth/callback';
/**
 * The only scheme callbacks a native sign-in may return to. Append only: the
 * start cookie stores a callback as its index here.
 */
export const NATIVE_SIGN_IN_CALLBACKS = [NATIVE_SIGN_IN_CALLBACK, LEGACY_NATIVE_SIGN_IN_CALLBACK, ANDROID_NATIVE_SIGN_IN_CALLBACK] as const;
export type NativeSignInCallback = (typeof NATIVE_SIGN_IN_CALLBACKS)[number];

/**
 * The notarized Mac zip, as the release uploads it to R2 and the product
 * site serves it: `the product site/download/mac/<version>/<this>`
 * (services/marketing). The Starlings update feed names this file.
 */
export const NATIVE_MAC_ZIP = `${NATIVE_APP_NAME}-macOS.zip` as const;
