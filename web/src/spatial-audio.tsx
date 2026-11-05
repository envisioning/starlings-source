/**
 * Spatial audio: each remote voice plays from where that person's
 * tile sits on the stage, so the ear finds the speaker before the eye does.
 *
 * LiveKit's `RoomAudioRenderer` is one `<audio>` element per track, all
 * centred. This replaces it: every remote microphone track becomes a Web
 * Audio source through an HRTF `PannerNode`, placed on the same arc the Mac
 * and iOS `SpatialAudioStage` use (±60° across the stage, a little elevation,
 * everyone at one distance). Where a tile is comes from the DOM — the
 * `data-meet-person` attribute `MeetParticipantTile` sets — measured after
 * layout, so a share taking the stage or a person leaving moves the voices
 * with the faces.
 *
 * Screen-share audio has no face to sit under and keeps its own flat
 * `<audio>` element. The browser's choice is remembered under `meet-media`.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { AudioTrack, useRoomContext, useTracks } from '@livekit/components-react';
import {
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Room,
} from 'livekit-client';
import { loadMeetMediaPreferences, saveMeetMediaPreferences } from './meet-media-preferences';
import { personKey } from './stage-layout';

export type SpatialAudioState = {
  /** The browser's preference. */
  wanted: boolean;
  /** Whether this browser has Web Audio with a panner at all. */
  supported: boolean;
};

let wanted = loadMeetMediaPreferences().spatialAudioOptIn;
const supported = typeof AudioContext !== 'undefined' && typeof PannerNode !== 'undefined';
const listeners = new Set<() => void>();
// Same-object snapshots: `useSyncExternalStore` compares with `Object.is`.
let snapshot: SpatialAudioState = { wanted, supported };

export function subscribeSpatialAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function spatialAudioState(): SpatialAudioState {
  return snapshot;
}

export function setSpatialAudioWanted(next: boolean): void {
  if (next === wanted) return;
  wanted = next;
  saveMeetMediaPreferences({ spatialAudioOptIn: next });
  snapshot = { wanted, supported };
  for (const listener of listeners) listener();
}

export function useSpatialAudioState(): SpatialAudioState {
  return useSyncExternalStore(subscribeSpatialAudio, spatialAudioState, spatialAudioState);
}

/** The Swift `SpatialAudioPosition.point`, in Web Audio's right-handed metres. */
function arcPoint(x: number, y: number): { x: number; y: number; z: number } {
  const azimuth = Math.max(-1, Math.min(1, x)) * (Math.PI / 3);
  const radius = 1.5;
  return {
    x: Math.sin(azimuth) * radius,
    y: Math.max(-1, Math.min(1, y)) * 0.4,
    z: -Math.cos(azimuth) * radius,
  };
}

type Source = {
  person: string;
  node: MediaStreamAudioSourceNode;
  panner: PannerNode;
  /** Chrome only feeds Web Audio from a remote track that some media element
   *  is also playing; this one is muted so it contributes no sound. */
  keepalive: HTMLAudioElement;
};

/** The graph for one call: one context, one panner per remote microphone. */
class SpatialMixer {
  private readonly context = new AudioContext({ latencyHint: 'interactive' });
  private readonly sources = new Map<string, Source>();
  private positions = new Map<string, { x: number; y: number }>();

  constructor() {
    const listener = this.context.listener;
    setParam(listener.positionX, 0);
    setParam(listener.positionY, 0);
    setParam(listener.positionZ, 0);
    setParam(listener.forwardX, 0);
    setParam(listener.forwardY, 0);
    setParam(listener.forwardZ, -1);
    setParam(listener.upX, 0);
    setParam(listener.upY, 1);
    setParam(listener.upZ, 0);
  }

  attach(track: RemoteAudioTrack, sid: string, person: string): void {
    if (this.sources.has(sid)) return;
    const stream = new MediaStream([track.mediaStreamTrack]);
    const node = this.context.createMediaStreamSource(stream);
    const panner = new PannerNode(this.context, {
      panningModel: 'HRTF',
      distanceModel: 'linear',
      refDistance: 1.5,
      maxDistance: 100,
      rolloffFactor: 0,
    });
    node.connect(panner).connect(this.context.destination);
    const keepalive = document.createElement('audio');
    keepalive.muted = true;
    keepalive.srcObject = stream;
    void keepalive.play().catch(() => undefined);
    this.sources.set(sid, { person, node, panner, keepalive });
    this.place(this.sources.get(sid)!);
  }

  detach(sid: string): void {
    const source = this.sources.get(sid);
    if (!source) return;
    this.sources.delete(sid);
    source.node.disconnect();
    source.panner.disconnect();
    source.keepalive.pause();
    source.keepalive.srcObject = null;
  }

  setPositions(next: Map<string, { x: number; y: number }>): void {
    this.positions = next;
    for (const source of this.sources.values()) this.place(source);
  }

  private place(source: Source): void {
    const at = this.positions.get(source.person) ?? { x: 0, y: 0 };
    const point = arcPoint(at.x, at.y);
    const when = this.context.currentTime;
    // A short glide: a tile that reflows should slide the voice, not jump it.
    source.panner.positionX.setTargetAtTime(point.x, when, 0.05);
    source.panner.positionY.setTargetAtTime(point.y, when, 0.05);
    source.panner.positionZ.setTargetAtTime(point.z, when, 0.05);
  }

  async setSinkId(deviceId: string): Promise<void> {
    const context = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (!context.setSinkId) return;
    try {
      await context.setSinkId(deviceId === 'default' ? '' : deviceId);
    } catch {
      // The device went away, or the browser refuses; the default output plays.
    }
  }

  resume(): void {
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
  }

  close(): void {
    for (const sid of Array.from(this.sources.keys())) this.detach(sid);
    void this.context.close().catch(() => undefined);
  }
}

function setParam(param: AudioParam, value: number): void {
  param.value = value;
}

function isRemoteMicrophone(track: RemoteTrack, publication: RemoteTrackPublication): track is RemoteAudioTrack {
  return track.kind === Track.Kind.Audio && publication.source === Track.Source.Microphone;
}

/**
 * Where every remote face is right now, as the stage draws it: the centre of
 * each `[data-meet-person]` tile inside the stage, normalised to -1…1 with
 * y up, the way the Swift stages report it.
 */
function measureTiles(): Map<string, { x: number; y: number }> {
  const stage = document.querySelector('[data-meet-stage]');
  const positions = new Map<string, { x: number; y: number }>();
  if (!stage) return positions;
  const bounds = stage.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return positions;
  for (const element of Array.from(stage.querySelectorAll<HTMLElement>('[data-meet-person]'))) {
    const person = element.dataset.meetPerson;
    if (!person) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1) continue;
    const cx = (rect.left + rect.width / 2 - bounds.left) / bounds.width;
    const cy = (rect.top + rect.height / 2 - bounds.top) / bounds.height;
    positions.set(person, { x: cx * 2 - 1, y: 1 - cy * 2 });
  }
  return positions;
}

/** The arc for the room this is mounted in. Mounted instead of `RoomAudioRenderer`. */
export function SpatialAudioRenderer() {
  const room = useRoomContext();
  useEffect(() => spatialize(room), [room]);

  // Shares keep the flat element the library would have given them.
  const shares = useTracks([Track.Source.ScreenShareAudio], { onlySubscribed: true })
    .filter((track) => !track.participant.isLocal);
  return (
    <div style={{ display: 'none' }}>
      {shares.map((track) => (
        <AudioTrack key={track.publication.trackSid} trackRef={track} />
      ))}
    </div>
  );
}

/** The mixer of the call under way, for the speaker picker to follow. */
let activeMixer: SpatialMixer | undefined;

/** Settings › Speaker chose an output; the arc plays through it too. */
export function applySpatialAudioOutput(deviceId: string): void {
  void activeMixer?.setSinkId(deviceId);
}

function spatialize(room: Room): () => void {
  const mixer = new SpatialMixer();
  activeMixer = mixer;
  void mixer.setSinkId(loadMeetMediaPreferences().audioOutputDeviceId);

  const attach = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (!isRemoteMicrophone(track, publication)) return;
    mixer.attach(track, publication.trackSid, personKey(participant.identity));
  };
  const detach = (_track: RemoteTrack, publication: RemoteTrackPublication) => {
    mixer.detach(publication.trackSid);
  };
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track) attach(publication.track, publication, participant);
    }
  }
  room.on(RoomEvent.TrackSubscribed, attach);
  room.on(RoomEvent.TrackUnsubscribed, detach);

  // The context starts suspended until the page has had a gesture; the
  // library's Start audio button and any click or key both count.
  const resume = () => mixer.resume();
  room.on(RoomEvent.AudioPlaybackStatusChanged, resume);
  window.addEventListener('pointerdown', resume, { passive: true });
  window.addEventListener('keydown', resume);

  // Tiles move when people come and go, when a share takes the stage, and
  // when the window resizes. One measurement per frame covers all of it.
  // The stage is observed once it exists; until then the room's own events
  // are what asks for a measurement.
  let frame = 0;
  let observed: Element | null = null;
  const resize = new ResizeObserver(() => schedule());
  const mutations = new MutationObserver(() => schedule());
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stage = document.querySelector('[data-meet-stage]');
      if (stage && stage !== observed) {
        if (observed) {
          resize.unobserve(observed);
        }
        observed = stage;
        resize.observe(stage);
        mutations.disconnect();
        mutations.observe(stage, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      }
      mixer.setPositions(measureTiles());
    });
  }
  const stageEvents = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
  ] as const;
  for (const event of stageEvents) room.on(event, schedule);
  window.addEventListener('resize', schedule);
  schedule();

  return () => {
    room.off(RoomEvent.TrackSubscribed, attach);
    room.off(RoomEvent.TrackUnsubscribed, detach);
    room.off(RoomEvent.AudioPlaybackStatusChanged, resume);
    for (const event of stageEvents) room.off(event, schedule);
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
    window.removeEventListener('resize', schedule);
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    mixer.close();
    if (activeMixer === mixer) activeMixer = undefined;
  };
}
