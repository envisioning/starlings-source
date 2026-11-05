import { describe, expect, it } from 'vitest';
import {
  compareMeetVersions,
  parseMeetClientVersion,
  recommendedUpgradeHeaders,
} from '../src/client-version';

describe('native client versions', () => {
  it('parses a well-formed platform, marketing version, and build', () => {
    expect(parseMeetClientVersion('macos/4.7.2 (812)')).toEqual({
      platform: 'macos',
      version: '4.7.2',
      build: '812',
    });
  });

  it.each([
    'macos/4.7 (812)',
    'ios/04.7.2 (812)',
    'ios/4.7.2 (build-812)',
    'windows/4.7.2 (812)',
    'ios/4.7.2 (812) extra',
  ])('ignores malformed header %s', (header) => {
    expect(parseMeetClientVersion(header)).toBeNull();
  });

  it('compares numeric components rather than string order', () => {
    expect(compareMeetVersions('4.7.10', '4.7.9')).toBe(1);
    expect(compareMeetVersions('4.8.0', '4.7.9')).toBe(1);
    expect(compareMeetVersions('4.7.2', '4.7.2')).toBe(0);
    expect(compareMeetVersions('4.7.2', '4.7.3')).toBe(-1);
    expect(compareMeetVersions('99999999999999999.0.0', '99999999999999998.9.9')).toBe(1);
    expect(compareMeetVersions('4.7.2-beta', '4.7.3')).toBeNull();
  });

  it('recommends only below the configured platform minimum', () => {
    const env = {
      MIN_RECOMMENDED_VERSION_MACOS: '4.7.3',
      MIN_RECOMMENDED_VERSION_IOS: '4.8.0',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    };
    expect(recommendedUpgradeHeaders('macos/4.7.2 (812)', env)).toEqual({
      'x-meet-upgrade': 'recommended',
    });
    expect(recommendedUpgradeHeaders('ios/4.7.2 (813)', env)).toEqual({
      'x-meet-upgrade': 'recommended',
      'x-meet-update-url': env.IOS_TESTFLIGHT_URL,
    });
    expect(recommendedUpgradeHeaders('macos/4.7.3 (814)', env)).toEqual({});
    expect(recommendedUpgradeHeaders('ios/4.8.1 (815)', env)).toEqual({});
  });

  it('reads the Android app and holds it to its own floor, as iOS', () => {
    expect(parseMeetClientVersion('android/0.0.1 (1)')).toEqual({ platform: 'android', version: '0.0.1', build: '1' });
    const env = {
      MIN_RECOMMENDED_VERSION_IOS: '9.0.0',
      MIN_RECOMMENDED_VERSION_MACOS: '9.0.0',
      MIN_RECOMMENDED_VERSION_ANDROID: '0.2.0',
      ANDROID_UPDATE_URL: 'https://starlings.example/android',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    };
    expect(recommendedUpgradeHeaders('android/0.1.9 (7)', env)).toEqual({
      'x-meet-upgrade': 'recommended',
      'x-meet-update-url': 'https://starlings.example/android',
    });
    expect(recommendedUpgradeHeaders('android/0.2.0 (8)', env)).toEqual({});
    expect(recommendedUpgradeHeaders('android/1.0.0 (9)', env)).toEqual({});
  });

  it('sets no Android floor while its variable is empty, whatever the other floors say', () => {
    expect(recommendedUpgradeHeaders('android/0.0.1 (1)', {
      MIN_RECOMMENDED_VERSION_IOS: '9.0.0',
      MIN_RECOMMENDED_VERSION_MACOS: '9.0.0',
      MIN_RECOMMENDED_VERSION_ANDROID: '',
      ANDROID_UPDATE_URL: 'https://starlings.example/android',
    })).toEqual({});
    expect(recommendedUpgradeHeaders('android/0.0.1 (1)', { MIN_RECOMMENDED_VERSION_ANDROID: 'soon' })).toEqual({});
  });

  it('sends no Android link while the update URL is empty or not https', () => {
    for (const url of [undefined, '', '   ', 'http://starlings.example/android', 'https://user:pass@starlings.example/a']) {
      expect(recommendedUpgradeHeaders('android/0.1.0 (1)', {
        MIN_RECOMMENDED_VERSION_ANDROID: '0.2.0',
        ...(url === undefined ? {} : { ANDROID_UPDATE_URL: url }),
      })).toEqual({ 'x-meet-upgrade': 'recommended' });
    }
  });

  it('never sends the iOS link to Android, nor the Android link to iOS', () => {
    expect(recommendedUpgradeHeaders('android/0.1.0 (1)', {
      MIN_RECOMMENDED_VERSION_ANDROID: '0.2.0',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    })).toEqual({ 'x-meet-upgrade': 'recommended' });
    expect(recommendedUpgradeHeaders('ios/1.0.0 (1)', {
      MIN_RECOMMENDED_VERSION_IOS: '2.0.0',
      ANDROID_UPDATE_URL: 'https://starlings.example/android',
    })).toEqual({ 'x-meet-upgrade': 'recommended' });
  });

  it('stays quiet when the floor is unset or the client is watchOS', () => {
    expect(recommendedUpgradeHeaders('ios/1.0.0 (1)', {})).toEqual({});
    expect(recommendedUpgradeHeaders('watchos/1.0.0 (1)', {
      MIN_RECOMMENDED_VERSION_IOS: '9.0.0',
      MIN_RECOMMENDED_VERSION_MACOS: '9.0.0',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    })).toEqual({});
  });

  it('puts no update link on a Mac recommendation, and only an https one on iOS', () => {
    expect(recommendedUpgradeHeaders('macos/1.0.0 (1)', {
      MIN_RECOMMENDED_VERSION_MACOS: '2.0.0',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    })).toEqual({ 'x-meet-upgrade': 'recommended' });
    expect(recommendedUpgradeHeaders('ios/1.0.0 (1)', {
      MIN_RECOMMENDED_VERSION_IOS: '2.0.0',
      IOS_TESTFLIGHT_URL: 'http://testflight.apple.com/join/example',
    })).toEqual({ 'x-meet-upgrade': 'recommended' });
    expect(recommendedUpgradeHeaders('ios/1.0.0 (1)', {
      MIN_RECOMMENDED_VERSION_IOS: '2.0.0',
      IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example',
    })['x-meet-update-url']).toBe('https://testflight.apple.com/join/example');
  });
});
