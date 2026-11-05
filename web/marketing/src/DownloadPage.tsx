import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { DesktopIcon, PhoneIcon } from '@shared/action-icons';
import { AppShell, Arrow } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { HERO, PAGE, TILE, TILE_ICON } from './bento';

/**
 * /download — the Mac, iPhone and Android apps. A call's host runs one of them, so a
 * team needs a place to get them before its first call.
 *
 * Both links are this site's own paths (services/marketing/src/index.js):
 * /download/mac streams the latest notarized zip from R2, and /download/ios
 * redirects to the public TestFlight invite (IOS_TESTFLIGHT_URL in
 * services/marketing/wrangler.jsonc). /download/android streams the newest
 * signed APK from R2 (scripts/android-release.sh --publish). The apps still carry the Meet name
 * until the rename ships (STARLINGS (HQ Docs), phase 5); the note says so.
 */
const MAC_DOWNLOAD_URL = '/download/mac';
const IOS_DOWNLOAD_URL = '/download/ios';
const ANDROID_DOWNLOAD_URL = '/download/android';

export function DownloadPage() {
  useDocumentTitle('Download');

  return (
    <AppShell variant="wide" product="download">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>Download Starlings.</h1>
          <p className="lede">
            Whoever hosts a call runs it from the Mac or iPhone app. Everyone
            else joins from a browser, with nothing to install.
          </p>
        </header>

        <div className="grid grid-cols-3 gap-3 max-[960px]:grid-cols-1">
          <Card className={cn(TILE, 'gap-4')}>
            <span className={TILE_ICON} aria-hidden="true"><DesktopIcon /></span>
            <h2>Mac</h2>
            <p>Host calls, transcribe them on your Mac, and work in every part of Starlings from the window or the menu bar. The app updates itself.</p>
            <p>Requires macOS 14 or later.</p>
            <Button asChild className="self-start"><a href={MAC_DOWNLOAD_URL} data-event="Download" data-event-platform="mac">Download for Mac</a></Button>
          </Card>
          <Card className={cn(TILE, 'gap-4')}>
            <span className={TILE_ICON} aria-hidden="true"><PhoneIcon /></span>
            <h2>iPhone and iPad</h2>
            <p>Host or join calls from your phone, with widgets for your next meeting and today’s work. The app is in beta on TestFlight.</p>
            <p>Requires iOS 17 or later.</p>
            <Button asChild variant="outline" className="self-start"><a href={IOS_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" data-event="Download" data-event-platform="ios">Join the TestFlight beta<Arrow /></a></Button>
          </Card>
          <Card className={cn(TILE, 'gap-4')}>
            <span className={TILE_ICON} aria-hidden="true"><PhoneIcon /></span>
            <h2>Android</h2>
            <p>Starlings for Android is an early build. You install it from this page because it is not on Google Play yet. The first time, Android asks you to allow installs from your browser.</p>
            <p>Requires Android 12 or later on a 64-bit phone.</p>
            <Button asChild variant="outline" className="self-start"><a href={ANDROID_DOWNLOAD_URL} data-event="Download" data-event-platform="android">Download the APK</a></Button>
          </Card>
        </div>

        <p className="mt-6 max-w-[44rem] text-[14px] leading-[1.55] text-muted-foreground">
          The apps still show their earlier name, Meet, while the rename to
          Starlings is under way. You sign in with your company’s Google account.
          New to Starlings? <a href="/interest">Request early access</a> first.
        </p>
      </div>
    </AppShell>
  );
}
