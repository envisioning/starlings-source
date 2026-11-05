export type MeetClientPlatform = 'macos' | 'ios' | 'watchos' | 'android';

export interface StarlingsClientVersion {
  platform: MeetClientPlatform;
  version: string;
  build: string;
}

const CLIENT_VERSION_HEADER = /^(macos|ios|watchos|android)\/(\d+\.\d+\.\d+) \((\d+)\)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version header is telemetry only; malformed or unknown values are ignored. */
export function parseMeetClientVersion(value: string | null): StarlingsClientVersion | null {
  if (!value) return null;
  const match = CLIENT_VERSION_HEADER.exec(value.trim());
  if (!match || !SEMVER.test(match[2]!)) return null;
  return {
    platform: match[1] as MeetClientPlatform,
    version: match[2]!,
    build: match[3]!,
  };
}

/** Compare strict marketing versions, declining to guess on malformed input. */
export function compareMeetVersions(left: string, right: string): -1 | 0 | 1 | null {
  const lhs = SEMVER.exec(left);
  const rhs = SEMVER.exec(right);
  if (!lhs || !rhs) return null;
  for (let index = 1; index <= 3; index += 1) {
    const a = lhs[index]!;
    const b = rhs[index]!;
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

export interface MeetUpgradeEnvironment {
  MIN_RECOMMENDED_VERSION_MACOS?: string;
  MIN_RECOMMENDED_VERSION_IOS?: string;
  MIN_RECOMMENDED_VERSION_ANDROID?: string;
  IOS_TESTFLIGHT_URL?: string;
  ANDROID_UPDATE_URL?: string;
}

/** The floor variable for each platform that has one. The watch has none. */
function floorOf(platform: MeetClientPlatform, env: MeetUpgradeEnvironment): string | undefined {
  switch (platform) {
    case 'macos': return env.MIN_RECOMMENDED_VERSION_MACOS;
    case 'ios': return env.MIN_RECOMMENDED_VERSION_IOS;
    case 'android': return env.MIN_RECOMMENDED_VERSION_ANDROID;
    case 'watchos': return undefined;
  }
}

/** The update link for each platform that has one: TestFlight for iOS, the configured page for Android. */
function updateURLOf(platform: MeetClientPlatform, env: MeetUpgradeEnvironment): string | undefined {
  if (platform === 'ios') return env.IOS_TESTFLIGHT_URL;
  if (platform === 'android') return env.ANDROID_UPDATE_URL;
  return undefined;
}

/** Headers for a native client below its configured minimum; unset floors stay quiet. */
export function recommendedUpgradeHeaders(
  clientHeader: string | null,
  env: MeetUpgradeEnvironment,
): Record<string, string> {
  const client = parseMeetClientVersion(clientHeader);
  if (!client) return {};

  const minimum = floorOf(client.platform, env)?.trim();
  if (!minimum || compareMeetVersions(minimum, minimum) === null) return {};
  if (compareMeetVersions(client.version, minimum) !== -1) return {};

  const headers: Record<string, string> = { 'x-meet-upgrade': 'recommended' };
  // An empty or non-https link sends no link; the banner still shows.
  const updateURL = httpsURL(updateURLOf(client.platform, env));
  if (updateURL) headers['x-meet-update-url'] = updateURL;
  return headers;
}

function httpsURL(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.host && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
