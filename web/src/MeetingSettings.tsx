import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  usePersistentUserChoices,
  useLayoutContext,
  useRoomContext,
} from '@livekit/components-react';
import {
  saveMeetMediaPreferences,
  supportsAudioOutputSelection,
} from './meet-media-preferences';
import { BackgroundEffectButtons, roomCameraTrack, useBackgroundEffect } from './use-background-effect';
import { noiseFilterHealth, setNoiseFilterWanted, subscribeNoiseFilter } from './noise-filter';
import { applySpatialAudioOutput, setSpatialAudioWanted, useSpatialAudioState } from './spatial-audio';
import { DeviceList } from './device-menu';
import { t } from './i18n';

function noiseFilterNote(noise: ReturnType<typeof noiseFilterHealth>): string {
  if (noise.supported === false) {
    return t('This browser cannot run noise cancellation. Its own noise suppression, echo cancellation, and auto gain stay on.');
  }
  if (noise.wanted && noise.path === 'browser' && noise.lastError) {
    return t('Noise cancellation couldn’t start; the browser’s own suppression is on.');
  }
  if (noise.path === 'krisp') {
    return t('Runs in this browser. Nothing is sent anywhere to clean it up.');
  }
  return t('Browser noise suppression, echo cancellation, and auto gain are on for this call.');
}

/** One settings group. */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function SettingsCheck({ children }: { children: ReactNode }) {
  return (
    <Label className="mt-2.5 flex cursor-pointer items-center gap-2.5 text-[13px] has-[:disabled]:cursor-default has-[:disabled]:text-muted-foreground font-normal leading-normal">
      {children}
    </Label>
  );
}

function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 mb-0 text-xs leading-normal text-muted-foreground">{children}</p>;
}

/**
 * In-meeting settings, a shadcn Dialog opened by the gear in the control bar.
 * Its open state is LiveKit's `showSettings` widget flag, so the gear's
 * pressed state and the dialog agree. Radix does Escape, click-away and
 * focus return.
 *
 * Device picks sync through LiveKit; speaker + background also persist under
 * `meet-media`. Background state is the shared store, so this dialog and the
 * camera menu agree.
 */
export function MeetingSettings() {
  const { widget } = useLayoutContext();
  const open = widget.state?.showSettings ?? false;
  const room = useRoomContext();
  const { saveAudioInputDeviceId, saveVideoInputDeviceId } = usePersistentUserChoices();
  const getTrack = useCallback(() => roomCameraTrack(room), [room]);
  const { choice, pending, error, change, setError } = useBackgroundEffect(getTrack);
  const noise = useSyncExternalStore(subscribeNoiseFilter, noiseFilterHealth);
  const [noisePending, setNoisePending] = useState(false);
  const spatial = useSpatialAudioState();

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) widget.dispatch?.({ msg: 'toggle_settings' });
  }, [widget]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[min(80vh,720px)] gap-5 overflow-y-auto p-5 sm:max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle>{t('Settings')}</DialogTitle>
        </DialogHeader>

        <SettingsSection title={t('Camera')}>
          <DeviceList
            variant="list"
            kind="videoinput"
            requestPermissions
            onActiveDeviceChange={(deviceId) => saveVideoInputDeviceId(deviceId || 'default')}
          />
        </SettingsSection>

        <SettingsSection title={t('Microphone')}>
          <DeviceList
            variant="list"
            kind="audioinput"
            requestPermissions
            onActiveDeviceChange={(deviceId) => saveAudioInputDeviceId(deviceId || 'default')}
          />
          <SettingsCheck>
            <Checkbox
              checked={noise.wanted}
              disabled={noisePending || noise.supported === false}
              onCheckedChange={(checked) => {
                setNoisePending(true);
                void setNoiseFilterWanted(room, checked === true).finally(() => setNoisePending(false));
              }}
            />
            {t('Noise cancellation')}
          </SettingsCheck>
          <SettingsNote>{noiseFilterNote(noise)}</SettingsNote>
        </SettingsSection>

        <SettingsSection title={t('Speaker')}>
          {supportsAudioOutputSelection() && (
            <DeviceList
              variant="list"
              kind="audiooutput"
              onActiveDeviceChange={(deviceId) => {
                saveMeetMediaPreferences({ audioOutputDeviceId: deviceId || 'default' });
                applySpatialAudioOutput(deviceId || 'default');
              }}
            />
          )}
          <SettingsCheck>
            <Checkbox
              checked={spatial.wanted}
              disabled={!spatial.supported}
              onCheckedChange={(checked) => setSpatialAudioWanted(checked === true)}
            />
            {t('Spatial audio')}
          </SettingsCheck>
          <SettingsNote>
            {spatial.supported
              ? t('Each voice comes from where that person’s tile is on the stage. Best on headphones.')
              : t('This browser cannot place voices in space.')}
          </SettingsNote>
        </SettingsSection>

        <SettingsSection title={t('Background')}>
          <BackgroundEffectButtons
            choice={choice}
            pending={pending}
            error={error}
            onChange={(next) => void change(next)}
            onError={setError}
            layout="row"
            clearable
          />
          <SettingsNote>{t('Blur and backgrounds stay on this browser until you change them.')}</SettingsNote>
        </SettingsSection>
      </DialogContent>
    </Dialog>
  );
}
