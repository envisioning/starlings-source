import {
  ConnectionQuality,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Track,
  type Room,
  type Participant,
  getBrowser,
} from 'livekit-client';
import { isWorkspaceMemberEmail } from './workspace-identity';
import { apiBase } from './config';
import { loadMeetMediaPreferences } from './meet-media-preferences';
import { noiseFilterHealth } from './noise-filter';
import { meetErrorLogLines } from './meeting-error-log';
import type { ConnectionDetails } from './meeting-types';
import { activeProcessorHealth } from './processor-health';
import { qualitySnapshotFor } from './QualityReporter';

const SAMPLE_GAP_MS = 500;

/** Debug dumps are copyable diagnostic data, not Markdown chat prose. */
export function isMeetingDebugReport(text: string): boolean {
  return text.startsWith('Meet web debug report\n') || text.startsWith('Meet Mac debug report\n');
}

type NetworkInformationLike = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  type?: string;
  saveData?: boolean;
};

/**
 * Builds a pasteable support dump for the in-meeting Debug control.
 * Omits tokens, lobby secrets, captions, and full emails — guests paste this
 * into Slack/email when a call is rough.
 */
export async function buildMeetingDebugReport(
  room: Room,
  roomSlug: string,
  connection: ConnectionDetails,
): Promise<string> {
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push('Meet web debug report');
  push(`collected_at: ${new Date().toISOString()}`);
  push(`page: ${safePageURL()}`);
  push(`api: ${apiBase}`);
  push(`livekit_url: ${sanitizeLiveKitURL(connection.server_url)}`);
  push(`room_slug: ${roomSlug}`);
  push(`meeting_id: ${connection.meeting_id}`);
  push(`livekit_room: ${connection.livekit_room}`);
  if (connection.started_at) {
    push(`meeting_started_at: ${new Date(connection.started_at).toISOString()}`);
  }
  push(`connection_state: ${room.state}`);
  push(`adaptive_stream: ${String(room.options.adaptiveStream)}`);
  push(`dynacast: ${String(room.options.dynacast)}`);

  const server = room.serverInfo;
  if (server) {
    push(
      `livekit_server: version=${server.version ?? '?'} region=${server.region ?? '?'} protocol=${server.protocol ?? '?'}`,
    );
  }

  push();
  push('## Client');
  const browser = getBrowser();
  if (browser) {
    push(
      `browser: ${browser.name} ${browser.version}${browser.os ? ` / ${browser.os}${browser.osVersion ? ` ${browser.osVersion}` : ''}` : ''}`,
    );
  }
  push(`user_agent: ${navigator.userAgent}`);
  push(`language: ${navigator.language}`);
  push(`online: ${String(navigator.onLine)}`);
  push(`hardware_concurrency: ${navigator.hardwareConcurrency || '?'}`);
  push(`device_memory_gb: ${deviceMemoryGB()}`);
  push(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  push(`viewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`);
  push(`network: ${describeNetwork()}`);

  push();
  push('## Session quality (this client)');
  const quality = qualitySnapshotFor(connection.meeting_id);
  if (quality) {
    push(`current: ${quality.current}`);
    push(`worst: ${quality.worst}`);
    push(`reconnects: ${quality.reconnectCount}`);
    push(`connected: ${formatDuration(quality.connectedMs)}`);
    push(
      `buckets: excellent=${formatDuration(quality.excellentMs)} good=${formatDuration(quality.goodMs)} poor=${formatDuration(quality.poorMs)} lost=${formatDuration(quality.lostMs)}`,
    );
  } else {
    push('(no quality samples yet)');
  }

  push();
  push(`## Participants (${1 + room.remoteParticipants.size})`);
  push(participantSummary(room.localParticipant, true));
  for (const remote of room.remoteParticipants.values()) {
    push(participantSummary(remote, false));
  }

  push();
  push('## Local publish (sampled)');
  const localLines = await sampleLocalTracks(room);
  if (localLines.length === 0) push('(no local A/V tracks)');
  else localLines.forEach(push);

  push();
  push('## Camera pipeline');
  cameraPipelineLines(room).forEach(push);

  push();
  push('## Microphone pipeline');
  microphonePipelineLines(room).forEach(push);

  push();
  push('## Remote subscribe (sampled)');
  const remoteLines = await sampleRemoteTracks(room);
  if (remoteLines.length === 0) push('(no remote A/V tracks)');
  else remoteLines.forEach(push);

  const ice = await sampleIcePaths(room);
  if (ice.length > 0) {
    push();
    push('## ICE (best-effort)');
    ice.forEach(push);
  }

  const errors = meetErrorLogLines();
  push();
  push(`## Recent errors (${errors.length})`);
  if (errors.length === 0) push('(none)');
  else errors.forEach((line) => push(line));

  push();
  push('## Notes');
  push('- No tokens, lobby secrets, captions, or full emails are included.');
  push('- Bitrate lines are approximate over a ~500ms sample window.');
  push('- Errors are the last 50 failures this tab hit, newest last;');
  push('  repeats collapse into one line with a count.');
  push('- Paste this into Slack/email when reporting a bad call.');

  return `${lines.join('\n')}\n`;
}

function safePageURL(): string {
  try {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return window.location.pathname;
  }
}

function sanitizeLiveKitURL(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return '(invalid livekit url)';
  }
}

function deviceMemoryGB(): string {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === 'number' ? String(memory) : '?';
}

function describeNetwork(): string {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!connection) return 'unknown';
  const parts: string[] = [];
  if (connection.effectiveType) parts.push(`effectiveType=${connection.effectiveType}`);
  if (typeof connection.downlink === 'number') parts.push(`downlink_mbps=${connection.downlink}`);
  if (typeof connection.rtt === 'number') parts.push(`rtt_ms=${connection.rtt}`);
  if (connection.type) parts.push(`type=${connection.type}`);
  if (connection.saveData) parts.push('saveData=true');
  return parts.length > 0 ? parts.join(' ') : 'unknown';
}

function participantSummary(participant: Participant, isLocal: boolean): string {
  const role = roleHint(participant.identity);
  const media = [
    participant.isMicrophoneEnabled ? 'mic' : 'mic-off',
    participant.isCameraEnabled ? 'cam' : 'cam-off',
    participant.isScreenShareEnabled ? 'screen' : null,
  ]
    .filter(Boolean)
    .join('+');
  return [
    isLocal ? 'local' : 'remote',
    `name=${quote(participant.name || '(unnamed)')}`,
    `identity=${redactIdentity(participant.identity)}`,
    `role=${role}`,
    `quality=${qualityLabel(participant.connectionQuality)}`,
    media,
  ].join(' ');
}

function roleHint(identity: string): string {
  const normalized = identity.toLowerCase();
  if (normalized.startsWith('guest:')) return 'guest';
  if (isWorkspaceMemberEmail(normalized)) return 'owner-like';
  return 'unknown';
}

/** Avoid pasting full emails / lobby-ish guest ids into support threads. */
function redactIdentity(identity: string): string {
  if (identity.startsWith('guest:')) {
    const rest = identity.slice('guest:'.length);
    return `guest:${rest.slice(0, 6)}…`;
  }
  const at = identity.indexOf('@');
  if (at > 0) {
    const local = identity.slice(0, at);
    const domain = identity.slice(at);
    const tip = local.length <= 1 ? local : `${local[0]}…`;
    return `${tip}${domain}`;
  }
  return identity.length <= 10 ? identity : `${identity.slice(0, 8)}…`;
}

function qualityLabel(quality: ConnectionQuality): string {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'excellent';
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
      return 'poor';
    case ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  if (minutes > 0) return `${minutes}m${pad2(seconds)}s`;
  return `${seconds}s`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatBitrate(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps) || bps < 0) return '?';
  if (bps < 1000) return `${Math.round(bps)}bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)}kbps`;
  return `${(bps / 1_000_000).toFixed(2)}Mbps`;
}

function bitrateFromBytes(
  beforeBytes: number | undefined,
  afterBytes: number | undefined,
  beforeTs: number,
  afterTs: number,
): number | undefined {
  if (beforeBytes === undefined || afterBytes === undefined) return undefined;
  const dt = afterTs - beforeTs;
  if (dt <= 0) return undefined;
  return ((afterBytes - beforeBytes) * 8 * 1000) / dt;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function sampleLocalTracks(room: Room): Promise<string[]> {
  type Sample = {
    label: string;
    kind: 'audio' | 'video';
    collect: () => Promise<LocalSample>;
  };

  const samples: Sample[] = [];
  for (const publication of room.localParticipant.getTrackPublications()) {
    const track = publication.track;
    if (!track || publication.isMuted) continue;
    const source = publication.source;
    if (track instanceof LocalVideoTrack) {
      samples.push({
        label: `video ${source}`,
        kind: 'video',
        collect: async () => {
          const stats = await track.getSenderStats();
          return { kind: 'video', stats };
        },
      });
    } else if (track instanceof LocalAudioTrack) {
      samples.push({
        label: `audio ${source}`,
        kind: 'audio',
        collect: async () => {
          const stats = await track.getSenderStats();
          return { kind: 'audio', stats };
        },
      });
    }
  }

  if (samples.length === 0) return [];

  const first = await Promise.all(samples.map((sample) => sample.collect()));
  await sleep(SAMPLE_GAP_MS);
  const second = await Promise.all(samples.map((sample) => sample.collect()));

  return samples.map((sample, index) => {
    const a = first[index];
    const b = second[index];
    if (sample.kind === 'video' && a.kind === 'video' && b.kind === 'video') {
      return formatLocalVideo(sample.label, a.stats, b.stats);
    }
    if (sample.kind === 'audio' && a.kind === 'audio' && b.kind === 'audio') {
      return formatLocalAudio(sample.label, a.stats, b.stats);
    }
    return `${sample.label}: (stats unavailable)`;
  });
}

function formatSettings(settings: MediaTrackSettings): string {
  return `${settings.width ?? '?'}x${settings.height ?? '?'}@${settings.frameRate ? Math.round(settings.frameRate) : '?'}`;
}

/**
 * Everything between the camera and the encoder. A blank publish line plus a
 * `paused=true` source here is the whole diagnosis in two lines — without it,
 * a dead background processor reads as a network fault.
 */
function cameraPipelineLines(room: Room): string[] {
  const lines: string[] = [];
  const choice = loadMeetMediaPreferences().backgroundEffect;
  lines.push(
    `background_effect: ${choice.mode}${choice.mode === 'generated' ? `/${choice.generator}/${choice.tone}` : ''}`,
  );

  const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
  const track = publication?.track;
  if (!(track instanceof LocalVideoTrack)) {
    lines.push('camera_track: (not published)');
    return lines;
  }

  const health = activeProcessorHealth();
  lines.push(
    `camera_track: muted=${String(track.isMuted)} upstream_paused=${String(track.isUpstreamPaused)}`,
  );

  // `mediaStreamTrack` is whatever feeds the encoder — the processor's canvas
  // capture when an effect is on, the camera itself otherwise. The raw camera
  // settings come from the source getter either way, so a dead effect and a
  // dead camera cannot be confused for each other.
  const published = track.mediaStreamTrack;
  lines.push(
    `published_source: ${health ? 'processed' : 'camera'} state=${published.readyState} `
      + `muted=${String(published.muted)} enabled=${String(published.enabled)} `
      + `${formatSettings(published.getSettings())}`,
  );
  lines.push(`camera_input: ${formatSettings(track.getSourceTrackSettings())}`);

  if (!health) {
    lines.push('processor: none');
    return lines;
  }
  lines.push(
    [
      `processor: path=${health.path}`,
      `frames_painted=${health.framesProduced ?? '?'}`,
      `ms_since_frame=${health.msSinceFrame ?? '?'}`,
      `source_paused=${String(health.sourcePaused ?? '?')}`,
      `resumes=${health.resumeAttempts ?? 0}`,
      `stalls=${health.stalls ?? 0}`,
      `rebuilds=${health.rebuilds ?? 0}`,
      `unrecoverable=${String(health.unrecoverable ?? false)}`,
    ].join(' '),
  );
  if (health.lastError) lines.push(`processor_error: ${health.lastError}`);
  return lines;
}

/**
 * What cleans the microphone before the encoder: the browser's constraints,
 * and Krisp when it took. `path=browser` with `wanted=true` and an error is a
 * filter that failed to start, not a guest who turned it off.
 */
function microphonePipelineLines(room: Room): string[] {
  const lines: string[] = [];
  const noise = noiseFilterHealth();
  lines.push(
    `noise_filter: path=${noise.path} wanted=${String(noise.wanted)} supported=${String(noise.supported ?? '?')}`,
  );
  if (noise.lastError) lines.push(`noise_filter_error: ${noise.lastError}`);

  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) {
    lines.push('microphone_track: (not published)');
    return lines;
  }
  lines.push(`microphone_track: muted=${String(track.isMuted)} processor=${track.getProcessor()?.name ?? 'none'}`);
  lines.push(`microphone_input: ${formatSettings(track.getSourceTrackSettings())}`);
  return lines;
}

type LocalSample =
  | { kind: 'video'; stats: Awaited<ReturnType<LocalVideoTrack['getSenderStats']>> }
  | { kind: 'audio'; stats: Awaited<ReturnType<LocalAudioTrack['getSenderStats']>> };

function formatLocalVideo(
  label: string,
  before: Awaited<ReturnType<LocalVideoTrack['getSenderStats']>>,
  after: Awaited<ReturnType<LocalVideoTrack['getSenderStats']>>,
): string {
  if (after.length === 0) return `${label}: (no sender stats)`;
  return after
    .map((layer) => {
      const prev = before.find((entry) => entry.rid === layer.rid) ?? before[0];
      const bitrate = bitrateFromBytes(
        prev?.bytesSent,
        layer.bytesSent,
        prev?.timestamp ?? layer.timestamp,
        layer.timestamp,
      );
      const parts = [
        `${label} rid=${layer.rid || '-'}`,
        `${layer.frameWidth ?? '?'}x${layer.frameHeight ?? '?'}@${Math.round(layer.framesPerSecond || 0)}`,
        // frames_sent is the one number that separates "the network is bad"
        // from "this camera has produced nothing" — a flat counter with a
        // healthy RTT means the source is dead, not the link.
        `frames_sent=${layer.framesSent ?? 0}(+${Math.max(0, (layer.framesSent ?? 0) - (prev?.framesSent ?? 0))})`,
        `bitrate≈${formatBitrate(bitrate)}`,
        `target=${formatBitrate(layer.targetBitrate)}`,
        `rtt_ms=${layer.roundTripTime !== undefined ? Math.round(layer.roundTripTime * 1000) : '?'}`,
        `lost=${layer.packetsLost ?? 0}`,
        `limitation=${layer.qualityLimitationReason || 'none'}`,
        `nack=${layer.nackCount} pli=${layer.pliCount} fir=${layer.firCount}`,
      ];
      return parts.join(' ');
    })
    .join('\n');
}

function formatLocalAudio(
  label: string,
  before: Awaited<ReturnType<LocalAudioTrack['getSenderStats']>> | undefined,
  after: Awaited<ReturnType<LocalAudioTrack['getSenderStats']>> | undefined,
): string {
  if (!after) return `${label}: (no sender stats)`;
  const bitrate = bitrateFromBytes(
    before?.bytesSent,
    after.bytesSent,
    before?.timestamp ?? after.timestamp,
    after.timestamp,
  );
  return [
    label,
    `bitrate≈${formatBitrate(bitrate)}`,
    `rtt_ms=${after.roundTripTime !== undefined ? Math.round(after.roundTripTime * 1000) : '?'}`,
    `jitter_ms=${after.jitter !== undefined ? (after.jitter * 1000).toFixed(1) : '?'}`,
    `lost=${after.packetsLost ?? 0}`,
  ].join(' ');
}

async function sampleRemoteTracks(room: Room): Promise<string[]> {
  type RemoteSample = {
    label: string;
    kind: 'audio' | 'video';
    collect: () => Promise<RemoteSampleResult>;
  };

  const samples: RemoteSample[] = [];
  for (const participant of room.remoteParticipants.values()) {
    const who = quote(participant.name || redactIdentity(participant.identity));
    for (const publication of participant.getTrackPublications()) {
      const track = publication.track;
      if (!track || !publication.isSubscribed || publication.isMuted) continue;
      const source = publication.source;
      if (track instanceof RemoteVideoTrack) {
        samples.push({
          label: `from ${who} video ${source}`,
          kind: 'video',
          collect: async () => ({ kind: 'video', stats: await track.getReceiverStats() }),
        });
      } else if (track instanceof RemoteAudioTrack) {
        samples.push({
          label: `from ${who} audio ${source}`,
          kind: 'audio',
          collect: async () => ({ kind: 'audio', stats: await track.getReceiverStats() }),
        });
      }
    }
  }

  if (samples.length === 0) return [];

  const first = await Promise.all(samples.map((sample) => sample.collect()));
  await sleep(SAMPLE_GAP_MS);
  const second = await Promise.all(samples.map((sample) => sample.collect()));

  return samples.map((sample, index) => {
    const a = first[index];
    const b = second[index];
    if (sample.kind === 'video' && a.kind === 'video' && b.kind === 'video') {
      return formatRemoteVideo(sample.label, a.stats, b.stats);
    }
    if (sample.kind === 'audio' && a.kind === 'audio' && b.kind === 'audio') {
      return formatRemoteAudio(sample.label, a.stats, b.stats);
    }
    return `${sample.label}: (stats unavailable)`;
  });
}

type RemoteSampleResult =
  | { kind: 'video'; stats: Awaited<ReturnType<RemoteVideoTrack['getReceiverStats']>> }
  | { kind: 'audio'; stats: Awaited<ReturnType<RemoteAudioTrack['getReceiverStats']>> };

function formatRemoteVideo(
  label: string,
  before: Awaited<ReturnType<RemoteVideoTrack['getReceiverStats']>> | undefined,
  after: Awaited<ReturnType<RemoteVideoTrack['getReceiverStats']>> | undefined,
): string {
  if (!after) return `${label}: (no receiver stats)`;
  const bitrate = bitrateFromBytes(
    before?.bytesReceived,
    after.bytesReceived,
    before?.timestamp ?? after.timestamp,
    after.timestamp,
  );
  return [
    label,
    `${after.frameWidth ?? '?'}x${after.frameHeight ?? '?'}`,
    `bitrate≈${formatBitrate(bitrate)}`,
    `decoded=${after.framesDecoded} dropped=${after.framesDropped}`,
    `lost=${after.packetsLost ?? 0}`,
    `jitter_ms=${after.jitter !== undefined ? (after.jitter * 1000).toFixed(1) : '?'}`,
    after.mimeType ? `codec=${after.mimeType}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function formatRemoteAudio(
  label: string,
  before: Awaited<ReturnType<RemoteAudioTrack['getReceiverStats']>> | undefined,
  after: Awaited<ReturnType<RemoteAudioTrack['getReceiverStats']>> | undefined,
): string {
  if (!after) return `${label}: (no receiver stats)`;
  const bitrate = bitrateFromBytes(
    before?.bytesReceived,
    after.bytesReceived,
    before?.timestamp ?? after.timestamp,
    after.timestamp,
  );
  return [
    label,
    `bitrate≈${formatBitrate(bitrate)}`,
    `lost=${after.packetsLost ?? 0}`,
    `jitter_ms=${after.jitter !== undefined ? (after.jitter * 1000).toFixed(1) : '?'}`,
    `concealment_events=${after.concealmentEvents ?? 0}`,
  ].join(' ');
}

/**
 * PeerConnection stats are on LiveKit's internal engine. Best-effort only —
 * never fail the report if the SDK shape changes.
 */
async function sampleIcePaths(room: Room): Promise<string[]> {
  try {
    const engine = room.engine as {
      pcManager?: {
        publisher?: { getStats: () => Promise<RTCStatsReport> };
        subscriber?: { getStats: () => Promise<RTCStatsReport> };
      };
    };
    const manager = engine.pcManager;
    if (!manager) return [];

    const lines: string[] = [];
    if (manager.publisher) {
      lines.push(...(await describeSelectedPair(await manager.publisher.getStats(), 'publisher')));
    }
    if (manager.subscriber) {
      lines.push(...(await describeSelectedPair(await manager.subscriber.getStats(), 'subscriber')));
    }
    return lines;
  } catch {
    return [];
  }
}

async function describeSelectedPair(report: RTCStatsReport, label: string): Promise<string[]> {
  const lines: string[] = [];
  for (const stat of report.values()) {
    if (stat.type !== 'transport') continue;
    const selectedId = (stat as RTCTransportStats & { selectedCandidatePairId?: string })
      .selectedCandidatePairId;
    if (!selectedId) continue;
    const pair = report.get(selectedId) as RTCIceCandidatePairStats | undefined;
    if (!pair || pair.type !== 'candidate-pair') continue;
    const local = pair.localCandidateId ? report.get(pair.localCandidateId) : undefined;
    const remote = pair.remoteCandidateId ? report.get(pair.remoteCandidateId) : undefined;
    const localType = local && 'candidateType' in local ? String(local.candidateType) : '?';
    const remoteType = remote && 'candidateType' in remote ? String(remote.candidateType) : '?';
    const protocol = local && 'protocol' in local ? String(local.protocol) : '?';
    const currentRtt =
      typeof pair.currentRoundTripTime === 'number'
        ? `${Math.round(pair.currentRoundTripTime * 1000)}ms`
        : '?';
    const available =
      typeof pair.availableOutgoingBitrate === 'number'
        ? formatBitrate(pair.availableOutgoingBitrate)
        : '?';
    lines.push(
      `${label}: local=${localType} remote=${remoteType} proto=${protocol} rtt=${currentRtt} available_out≈${available}`,
    );
  }
  return lines;
}
