import { useEffect } from 'react';
import {
  QUALITY_DURATION_MAX_MS,
  QUALITY_RECONNECT_MAX,
  QUALITY_REPORT_INTERVAL_MILLISECONDS,
  DOWNSTREAM_USAGE_REPORT_INTERVAL_MILLISECONDS,
} from '@starlings/contracts/limits';
import { useRoomContext } from '@livekit/components-react';
import {
  ConnectionQuality,
  DisconnectReason,
  RemoteAudioTrack,
  RemoteVideoTrack,
  RoomEvent,
  type Participant,
} from 'livekit-client';
import { apiBase } from './config';
import { recordMeetError } from './meeting-error-log';
import type { ConnectionDetails } from './meeting-types';

type QualityBucket = 'excellent' | 'good' | 'poor' | 'lost';

const SEVERITY: Record<QualityBucket, number> = {
  lost: 0,
  poor: 1,
  good: 2,
  excellent: 3,
};

function bucketOf(quality: ConnectionQuality): QualityBucket | null {
  switch (quality) {
    case ConnectionQuality.Excellent: return 'excellent';
    case ConnectionQuality.Good: return 'good';
    case ConnectionQuality.Poor: return 'poor';
    case ConnectionQuality.Lost: return 'lost';
    default: return null;
  }
}

/** `DisconnectReason` is a numeric enum on the wire — the name is what helps. */
function describeDisconnect(reason: DisconnectReason | undefined): string {
  if (reason === undefined) return 'unknown';
  return DisconnectReason[reason] ?? String(reason);
}

type Accumulator = {
  startedAt: number;
  current: QualityBucket | null;
  since: number;
  totals: Record<QualityBucket, number>;
  reconnects: number;
  worst: QualityBucket | null;
  downstreamReporterID: string;
  downstreamMonthStart: number;
  downstreamBytes: number;
  downstreamBytesByTrack: Map<string, number>;
};

/**
 * Keyed by meeting so counters survive React remounts (StrictMode, re-entry
 * after a drop): totals are cumulative for the whole meeting, and a fresh
 * accumulator would overwrite the server row with smaller numbers. Bounded by
 * the number of meetings this tab joins, so entries are never pruned.
 */
const accumulators = new Map<string, Accumulator>();

function accumulatorFor(meetingId: string): Accumulator {
  const existing = accumulators.get(meetingId);
  if (existing) return existing;
  const now = Date.now();
  const created: Accumulator = {
    startedAt: now,
    current: null,
    since: now,
    totals: { excellent: 0, good: 0, poor: 0, lost: 0 },
    reconnects: 0,
    worst: null,
    downstreamReporterID: crypto.randomUUID(),
    downstreamMonthStart: utcMonthStart(now),
    downstreamBytes: 0,
    downstreamBytesByTrack: new Map(),
  };
  accumulators.set(meetingId, created);
  return created;
}

function utcMonthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function advance(state: Accumulator, now: number) {
  if (state.current) state.totals[state.current] += now - state.since;
  state.since = now;
}

/** Point-in-time quality counters for the in-meeting Debug copy report. */
export type QualitySnapshot = {
  connectedMs: number;
  excellentMs: number;
  goodMs: number;
  poorMs: number;
  lostMs: number;
  reconnectCount: number;
  current: QualityBucket | 'unknown';
  worst: QualityBucket | 'unknown';
};

export function qualitySnapshotFor(meetingId: string): QualitySnapshot | null {
  const state = accumulators.get(meetingId);
  if (!state) return null;
  const now = Date.now();
  const totals = { ...state.totals };
  if (state.current) totals[state.current] += now - state.since;
  return {
    connectedMs: now - state.startedAt,
    excellentMs: Math.round(totals.excellent),
    goodMs: Math.round(totals.good),
    poorMs: Math.round(totals.poor),
    lostMs: Math.round(totals.lost),
    reconnectCount: state.reconnects,
    current: state.current ?? 'unknown',
    worst: state.worst ?? 'unknown',
  };
}

/**
 * Reports this browser's own call quality so a bad meeting is visible without
 * waiting for someone to complain. Sends no IP, user agent, or network detail —
 * only time spent in each LiveKit connection-quality state.
 */
export function QualityReporter({ roomSlug, connection }: {
  roomSlug: string;
  connection: ConnectionDetails;
}) {
  const room = useRoomContext();
  const meetingId = connection.meeting_id;
  const artifactToken = connection.artifact_token;

  useEffect(() => {
    const state = accumulatorFor(meetingId);

    function onQualityChanged(quality: ConnectionQuality, participant?: Participant) {
      if (participant?.identity !== room.localParticipant.identity) return;
      advance(state, Date.now());
      const bucket = bucketOf(quality);
      state.current = bucket;
      if (bucket && (state.worst === null || SEVERITY[bucket] < SEVERITY[state.worst])) {
        state.worst = bucket;
      }
    }

    function onReconnecting() {
      state.reconnects += 1;
      recordMeetError('room', new Error('SFU connection lost — reconnecting'));
    }

    // Already the room's event listener for the whole meeting, so it is also
    // where room-level failures are recorded for the Debug report.
    function onDisconnected(reason?: DisconnectReason) {
      recordMeetError('room', new Error(`disconnected reason=${describeDisconnect(reason)}`));
    }

    function onMediaDevicesError(error: Error) {
      recordMeetError('media devices', error);
    }

    room.on(RoomEvent.ConnectionQualityChanged, onQualityChanged);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);

    async function flush(isFinal: boolean) {
      const now = Date.now();
      advance(state, now);
      await fetch(`${apiBase}/rooms/${roomSlug}/meetings/${meetingId}/quality`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${artifactToken}`,
          'content-type': 'application/json',
        },
        // keepalive lets the last report survive the page going away.
        keepalive: isFinal,
        // Clamped to the schema caps so a suspended-tab clock jump can never
        // make every subsequent report 400 silently.
        body: JSON.stringify({
          client: 'web',
          connected_ms: Math.min(now - state.startedAt, QUALITY_DURATION_MAX_MS),
          excellent_ms: Math.min(Math.round(state.totals.excellent), QUALITY_DURATION_MAX_MS),
          good_ms: Math.min(Math.round(state.totals.good), QUALITY_DURATION_MAX_MS),
          poor_ms: Math.min(Math.round(state.totals.poor), QUALITY_DURATION_MAX_MS),
          lost_ms: Math.min(Math.round(state.totals.lost), QUALITY_DURATION_MAX_MS),
          reconnect_count: Math.min(state.reconnects, QUALITY_RECONNECT_MAX),
          worst_quality: state.worst ?? 'unknown',
        }),
      });
    }

    let downstreamFlushPromise: Promise<void> | null = null;
    async function flushDownstreamUsage(isFinal: boolean) {
      if (downstreamFlushPromise) {
        await downstreamFlushPromise;
        if (!isFinal) return;
      }
      const current = writeDownstreamUsage(isFinal);
      downstreamFlushPromise = current;
      try {
        await current;
      } finally {
        if (downstreamFlushPromise === current) downstreamFlushPromise = null;
      }
    }

    async function writeDownstreamUsage(isFinal: boolean) {
      const monthStart = utcMonthStart(Date.now());
      if (monthStart !== state.downstreamMonthStart) {
        state.downstreamMonthStart = monthStart;
        state.downstreamBytes = 0;
      }

      const tracks: Array<{ id: string; collect: () => Promise<number | undefined> }> = [];
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.getTrackPublications()) {
          const track = publication.track;
          if (!track || !publication.isSubscribed || publication.isMuted) continue;
          if (track instanceof RemoteVideoTrack || track instanceof RemoteAudioTrack) {
            tracks.push({
              id: `${participant.sid}:${publication.trackSid}`,
              collect: async () => (await track.getReceiverStats())?.bytesReceived,
            });
          }
        }
      }

      const samples = await Promise.all(tracks.map(async (track) => ({ id: track.id, bytes: await track.collect() })));
      for (const { id, bytes } of samples) {
        if (bytes == null || !Number.isFinite(bytes) || bytes < 0) continue;
        const current = Math.floor(bytes);
        const previous = state.downstreamBytesByTrack.get(id);
        const delta = previous == null || current < previous ? current : current - previous;
        state.downstreamBytes = Math.min(state.downstreamBytes + delta, 5_000_000_000_000);
        state.downstreamBytesByTrack.set(id, current);
      }

      await fetch(`${apiBase}/rooms/${roomSlug}/meetings/${meetingId}/downstream-usage`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${artifactToken}`,
          'content-type': 'application/json',
        },
        keepalive: isFinal,
        body: JSON.stringify({
          reporter_id: state.downstreamReporterID,
          month_start: state.downstreamMonthStart,
          received_bytes: Math.min(state.downstreamBytes, 5_000_000_000_000),
        }),
      });
    }

    const timer = window.setInterval(() => {
      void flush(false).catch(() => {
        // Quality reporting must never disturb the meeting; the next flush
        // carries the same cumulative totals.
      });
    }, QUALITY_REPORT_INTERVAL_MILLISECONDS);
    const downstreamTimer = window.setInterval(() => {
      void flushDownstreamUsage(false).catch(() => {
        // Metering is auxiliary; the next cumulative report will catch up.
      });
    }, DOWNSTREAM_USAGE_REPORT_INTERVAL_MILLISECONDS);
    void flushDownstreamUsage(false).catch(() => {});

    // React cleanup never runs when the tab closes or iOS Safari discards the
    // page — pagehide/hidden are the only reliable last-flush moments there.
    function onPageHide() {
      void flush(true).catch(() => {});
      void flushDownstreamUsage(true).catch(() => {});
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') onPageHide();
    }
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      window.clearInterval(downstreamTimer);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      room.off(RoomEvent.ConnectionQualityChanged, onQualityChanged);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      void flush(true).catch(() => {});
      void flushDownstreamUsage(true).catch(() => {});
    };
  }, [room, roomSlug, meetingId, artifactToken]);

  return null;
}
