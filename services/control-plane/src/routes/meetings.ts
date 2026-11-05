import { isMemberEmail } from '../workspace-identity';
import {
  requestDeviceID,
} from '../auth';
import { subjectAccessFor } from '../subject-access';
import { requireCapability } from '../capabilities';
import { downstreamUsageReportSchema, MIN_MEETING_MILLISECONDS } from '../contracts';
import { recordDecision } from '../crm-actions';
import { log, parseQuery } from '../route-util';
import {
  closeLiveKitRoomQuietly,
  hostMutationAnswer,
  requireArtifactPrincipal,
  requireRoomOwner,
  sendHostMessageQuietly,
  syncHostBadge,
} from '../room-access';
import { recordNotesOwed } from '../notes-owed';
import { approveFollowUp, dismissFollowUp } from '../follow-ups';
import { meetingFollowUpApproveSchema, type MeetingFollowUpApproveResponse } from '@starlings/contracts';
import { recordDownstreamUsage } from '../downstream-usage';
import { ledgerMeetingChanges } from '../ledger';
import { proposeTaskCandidates, taskCandidatesEnabled } from '../task-candidates';
import {
  describeDuration,
  postSubjectEvent,
  subjectOfCategory,
} from '../threads';
import { deliveriesOf, mcpMeetingArtifact, requestDelivery } from '../deliveries';
import {
  meetingDecisionCandidateAnswerSchema,
  deviceScopedOwnerIdentity,
  hostClaimRequestSchema,
  hostOfferRequestSchema,
  hostOfferAnswerRequestSchema,
  isMobileOwnerIdentity,
  meetingCategorySchema,
  meetingChangesQuerySchema,
  linkPreviewQuerySchema,
  qualityReportSchema,
  HAND_LOWERED,
  handRaisedValue,
  handSchema,
  type HandResponse,
  type LowerHandsResponse,
  participantMuteSchema,
  participantRemoveSchema,
  screenShareStopSchema,
  taskCandidateRequestSchema,
  transcriptBatchSchema,
  HOST_HEARTBEAT_INTERVAL_MILLISECONDS,
  TRANSCRIPT_BODY_MAX_BYTES,
  type ControlErrorBody,
  type LinkPreviewResponse,
  type EndMeetingResponse,
  type FinalizeMeetingResponse,
  type HostHeartbeatResponse,
  type MeetingCategoryResponse,
  type TaskCandidatesResponse,
  type OwnerSession,
  type OkResponse,
  type MeetingChangesResponse,
  type MeetingQualityResponse,
  type MeetingDecisionCandidateMutationResponse,
  type HostMutationResponse,
  type HostOfferResponse,
  type HostOfferAnswerResponse,
  type LegacyChairMutationResponse,
  type ArtifactMaterialResponse,
  type ParticipantMuteResponse,
  type ParticipantRemoveResponse,
  type ScreenShareStopResponse,
  type TranscriptAppendResponse,
  endMeetingSchema,
  ambientMeetingSchema,
  transcriptDeleteSchema,
  transcriptRenameSchema,
  type TranscriptRenameResponse,
  type TranscriptViewResponse,
  meetingTranscriptQuerySchema,
  type McpMeetingArtifactResponse,
  type TranscriptDeleteResponse,
  type AmbientMeetingResponse,
  type AmbientMeetingsResponse,
} from '../contracts';
import { ControlError } from '../errors';
import {
  fetchCrmSubject,
  syncMeetingLogQuietly,
  workModelEnabled,
} from '../crm';
import { linkPreview } from '../link-preview';
import { isInternalRoomSlug } from '../internal-rooms';
import { assertUnderRateLimit, json, readBoundedJSON } from '../http';
import {
  lowerAllHands,
  muteParticipantAudio,
  setParticipantHand,
  removeParticipant,
  stopParticipantScreenShare,
  listLiveKitParticipantIdentities,
} from '../livekit';
import { RoomError } from '../room-coordinator';
import { eraseMeeting } from '../meeting-erasure';
import type { EraseMeetingResponse } from '@starlings/contracts';
import { defineRoute, PARAMS, type Route } from '../route-types';
import { ROOM_SLUG, roomOf } from './rooms';

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * A meeting's own routes under a room (docs/ROOM_ENTRY.md, docs/MEETING_LOG.md):
 * what a guest does with the meeting's artifact token, what the host does to the
 * call, and what the owner does to the record. The gate says which.
 */
export const meetingsRoutes: readonly Route[] = [
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/quality',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the meeting\'s signed artifact token, checked against this room and meeting' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      // Identity and role come from the signed artifact principal, so a client can
      // only ever report its own call quality.
      const principal = await requireArtifactPrincipal(request, env, slug, params.meetingId!);
      const body = qualityReportSchema.parse(await readBoundedJSON(request));
      await room.recordQuality(principal.meetingId, principal.identity, principal.role, body);
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/downstream-usage',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the meeting\'s signed artifact token, checked against this room and meeting' },
    handler: async ({ request, env, params }) => {
      const { slug } = await roomOf(env, params);
      const principal = await requireArtifactPrincipal(request, env, slug, params.meetingId!);
      const report = downstreamUsageReportSchema.parse(await readBoundedJSON(request));
      const now = Date.now();
      const monthStart = startOfUtcMonth(now);
      const previousMonthStart = startOfUtcMonth(monthStart - 1);
      if (report.month_start !== monthStart && report.month_start !== previousMonthStart) {
        throw new ControlError('Usage report is outside the current reporting window.', 400, 'invalid_request');
      }
      // A usage estimate is auxiliary telemetry. D1 trouble must never interrupt
      // a call or turn a valid artifact token into a failed media request.
      try {
        await recordDownstreamUsage(env, report, now);
      } catch {
        log('warn', 'downstream_usage.record.failed', {
          meetingId: principal.meetingId,
          room: slug,
        });
      }
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings/:meetingId/quality',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner' },
    handler: async ({ env, owner, params }) => {
      const { room } = await roomOf(env, params);
      return json({ participants: await room.meetingQuality(owner.sub, params.meetingId!) } satisfies MeetingQualityResponse);
    },
  }),

  // A guest's own hand, up or down.
  //
  // The attribute is written by the Worker rather than by the client: LiveKit
  // gates every self-service attribute write behind `canUpdateOwnMetadata`,
  // which this app keeps shut so a guest cannot rewrite the `owner` stamped
  // into their metadata at mint. The identity comes
  // from the artifact principal, never from the body, so this can only ever
  // raise the caller's own hand.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/hand',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the meeting\'s signed artifact token, checked against this room and meeting' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      const principal = await requireArtifactPrincipal(request, env, slug, params.meetingId!);
      const body = handSchema.parse(await readBoundedJSON(request));
      const livekitRoom = await room.liveKitRoomForMeeting(principal.meetingId);
      await setParticipantHand(
        env,
        livekitRoom,
        principal.identity,
        body.raised ? handRaisedValue() : HAND_LOWERED,
      );
      return json({ ok: true } satisfies HandResponse);
    },
  }),

  // Every hand at once, for the host. Owner-only: clearing the queue is a
  // moderation act, and a guest who could do it could silence the room's
  // questions without saying anything.
  defineRoute({
    method: 'DELETE',
    path: '/api/rooms/:slug/meetings/:meetingId/hands',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const { room } = await roomOf(env, params);
      const livekitRoom = await room.moderatedLiveKitRoom(owner.sub, params.meetingId!);
      return json({ lowered: await lowerAllHands(env, livekitRoom) } satisfies LowerHandsResponse);
    },
  }),

  // The same unfurl a member gets in a thread, for a guest in meeting chat.
  // Authorized by the meeting's artifact principal rather than a session:
  // guests have no account, and the thing being authorized is "you are in this
  // meeting", which is exactly what that token says.
  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings/:meetingId/link-preview',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the meeting\'s signed artifact token, checked against this room and meeting' },
    handler: async ({ request, env, url, params }) => {
      const { slug } = await roomOf(env, params);
      await requireArtifactPrincipal(request, env, slug, params.meetingId!);
      await assertUnderRateLimit(env.LINK_PREVIEW_LIMITER, request, 'link-preview');
      return json({
        preview: await linkPreview(parseQuery(linkPreviewQuerySchema, url).url, { env, origin: url.origin }),
      } satisfies LinkPreviewResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings/:meetingId/category',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner' },
    handler: async ({ env, params }) => {
      const { room } = await roomOf(env, params);
      const category = await room.meetingCategory(params.meetingId!);
      return json({
        meeting_kind: category.meetingKind,
        lead_id: category.leadId,
        project_id: category.projectId,
        partner_organization_id: category.partnerOrganizationId,
        subject_title: category.subjectTitle,
        categorized_by: category.categorizedBy,
        categorized_at: category.categorizedAt,
      } satisfies MeetingCategoryResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/rooms/:slug/meetings/:meetingId/category',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = meetingCategorySchema.parse(await readBoundedJSON(request));
      // A hosted meeting files on the five kinds the room and the Mac menu
      // know, a partner among them; event and personal are an import's kinds today.
      if (body.meeting_kind === 'event' || body.meeting_kind === 'personal') {
        throw new ControlError('A hosted meeting cannot file on that kind yet.', 400, 'invalid_request');
      }
      const filing = subjectOfCategory({
        meetingKind: body.meeting_kind,
        leadId: body.lead_id ?? null,
        projectId: body.project_id ?? null,
        partnerOrganizationId: body.partner_organization_id ?? null,
      });
      if (filing) (await subjectAccessFor(env, owner)).requireWrite(filing.kind, filing.id);
      const category = await room.setMeetingCategory(owner.sub, params.meetingId!, {
        meetingKind: body.meeting_kind,
        leadId: body.meeting_kind === 'lead' ? body.lead_id ?? null : null,
        projectId: body.meeting_kind === 'project' ? body.project_id ?? null : null,
        partnerOrganizationId: body.meeting_kind === 'partner' ? body.partner_organization_id ?? null : null,
        subjectTitle: body.subject_title ?? null,
        categorizedBy: owner.email,
      });
      // Push category onto the in-progress CRM row without waiting on end —
      // or, for a meeting already over (an ambient capture being filed), the
      // whole row through the ledger: that filing is what lets it reach Core
      // at all, and the ledger is what makes it arrive.
      if (await room.isEnded(params.meetingId!)) {
        ctx.waitUntil(requestDelivery(env, slug, params.meetingId!).catch(() => undefined));
      } else {
        ctx.waitUntil(syncMeetingLogQuietly(env, slug, params.meetingId!, 'started'));
      }
      // And say so in the subject's channel: the first line of the meeting's
      // trail there. The person is named in the text, never as the sender.
      const filedUnder = subjectOfCategory(category);
      if (filedUnder) {
        ctx.waitUntil(postSubjectEvent(
          env,
          filedUnder,
          `${owner.name || owner.email} filed a meeting here`,
          [{ kind: 'meeting', id: params.meetingId! }],
          { actor: { sub: owner.sub, email: owner.email } },
        ));
      }
      return json({
        meeting_kind: category.meetingKind,
        lead_id: category.leadId,
        project_id: category.projectId,
        partner_organization_id: category.partnerOrganizationId,
        subject_title: category.subjectTitle,
        categorized_by: category.categorizedBy,
        categorized_at: category.categorizedAt,
      } satisfies MeetingCategoryResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/task-candidates',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, params }) => {
      const body = taskCandidateRequestSchema.parse(await readBoundedJSON(request));
      if (!taskCandidatesEnabled(env)) {
        return json({ candidates: [], engine: 'off' } satisfies TaskCandidatesResponse);
      }
      try {
        const candidates = await proposeTaskCandidates(env, {
          excerpt: body.excerpt,
          ...(body.known_titles ? { knownTitles: body.known_titles } : {}),
        });
        return json({ candidates, engine: 'ai' } satisfies TaskCandidatesResponse);
      } catch (error) {
        // Suggestions are a courtesy, never a dependency: a model outage returns
        // nothing and the next chunk tries again. Never log the excerpt.
        console.error(JSON.stringify({
          level: 'error',
          message: 'tasks.candidates.failed',
          meetingId: params.meetingId!,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
        return json({ candidates: [], engine: 'ai' } satisfies TaskCandidatesResponse);
      }
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/heartbeat',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { room } = await roomOf(env, params);
      const deviceID = await requestDeviceID(request, env);
      const expiresAt = await room.heartbeat(owner.sub, params.meetingId!, deviceID, deviceID ? null : owner.email);
      const state = await room.hostState(owner.sub, params.meetingId!);
      ctx.waitUntil(syncHostBadge(env, room, params.meetingId!, state.livekitRoom));
      return json({
        ok: true,
        host_lease_expires_at: expiresAt,
        renew_after_ms: HOST_HEARTBEAT_INTERVAL_MILLISECONDS,
      } satisfies HostHeartbeatResponse);
    },
  }),

  // `/host/*` is the route; `/chair/*` is the same for 5.8.x Macs, with the
  // old answer shape, until.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/:role/claim',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid, role: { re: 'host|chair', sample: 'host' } },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { room } = await roomOf(env, params);
      const meetingId = params.meetingId!;
      const legacy = params.role === 'chair';
      const body = hostClaimRequestSchema.parse(await readBoundedJSON(request));
      const deviceID = await requestDeviceID(request, env);
      if (!deviceID) throw new RoomError('A signed-in device is required to take the host.', 409, 'host_not_active');
      const identity = deviceScopedOwnerIdentity(owner.email, body.device, deviceID);
      const state = await room.hostState(owner.sub, meetingId);
      const participants = await listLiveKitParticipantIdentities(env, state.livekitRoom);
      if (!participants.has(identity)) throw new RoomError('Join the meeting before taking the host.', 409, 'host_not_active');
      // Meetings created before per-device host state shipped have no recorded
      // host identity. Do not guess while another Envisioning owner is still
      // connected: an old client cannot receive the release request.
      if (state.hostIdentity === null && !state.hostReleased
        && [...participants].some((participant) => participant !== identity && isMemberEmail(env, participant))) {
        throw new RoomError('An owner device is still connected. Wait for it to leave, then try again.', 409, 'host_not_active');
      }
      const currentHost = state.hostIdentity;
      const currentConnected = currentHost !== null && participants.has(currentHost);
      // A phone host on a build before cannot receive a release
      // request, so a live one is only asked to hand over when it offered the
      // host itself (a phone that offers is a build that answers). One that
      // has left the call is simply replaced.
      // A member who accepted an offer rejoined under a new identity, and the
      // accept cleared the offer; the phone that offered still answers.
      const offered = state.hostOfferIdentity === identity || await room.isHostMember(owner.sub);
      if (currentHost && currentConnected && isMobileOwnerIdentity(currentHost) && !offered) {
        throw new RoomError('The host is on a phone. Move the host from there.', 409, 'host_not_active');
      }
      const result = await room.claimHost(owner.sub, meetingId, {
        deviceID,
        identity,
        expected: currentHost,
        currentConnected,
        pendingConnected: state.pendingHostIdentity !== null && participants.has(state.pendingHostIdentity),
        ifVacant: body.if_vacant === true,
      });
      if (result.status === 'release_requested' && currentHost) {
        await sendHostMessageQuietly(env, state.livekitRoom, {
          version: 1,
          type: 'release_requested',
          host_identity: currentHost,
          target_identity: identity,
        }, currentHost);
      } else {
        await sendHostMessageQuietly(env, state.livekitRoom, {
          version: 1,
          type: 'changed',
          host_identity: result.hostIdentity,
          target_identity: null,
        });
      }
      if (result.status === 'host') ctx.waitUntil(syncHostBadge(env, room, meetingId, state.livekitRoom));
      return json(hostMutationAnswer(legacy, result.status, result.hostIdentity, result.pendingIdentity, result.hostLeaseExpiresAt) satisfies HostMutationResponse | LegacyChairMutationResponse);
    },
  }),

  // The host asks one device in the call to host. Another device
  // of the same person claims on the message; another member is asked, and
  // answers below with their own signed session.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/host/offer',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { room } = await roomOf(env, params);
      const meetingId = params.meetingId!;
      const body = hostOfferRequestSchema.parse(await readBoundedJSON(request));
      const deviceID = await requestDeviceID(request, env);
      const state = await room.hostState(owner.sub, meetingId);
      const participants = await listLiveKitParticipantIdentities(env, state.livekitRoom);
      if (!participants.has(body.target_identity)) throw new RoomError('That person is no longer in the call.', 409, 'participant_not_found');
      // An owner-shaped identity carries its address (`mz+mac-…@`); a guest's is
      // random, and the address is the one they knocked with. Either is only a
      // claim here: accepting takes a session signed in as that address.
      const targetEmail = body.target_identity.startsWith('guest:')
        ? await room.guestEmail(meetingId, body.target_identity)
        : body.target_identity.replace(/\+[^@]*@/u, '@').toLowerCase();
      if (!targetEmail || !isMemberEmail(env, targetEmail)) {
        throw new RoomError('Only a member of this workspace can host.', 409, 'host_not_active');
      }
      const offer = await room.offerHost(
        owner.sub,
        meetingId,
        { deviceID, identity: owner.email },
        { identity: body.target_identity, email: targetEmail },
      );
      await sendHostMessageQuietly(env, state.livekitRoom, {
        version: 1,
        type: 'offered',
        host_identity: state.hostIdentity,
        target_identity: body.target_identity,
        from_name: owner.name,
      }, body.target_identity);
      return json({
        status: 'offered',
        target_identity: body.target_identity,
        expires_in_ms: offer.expiresAt - Date.now(),
      } satisfies HostOfferResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/host/offer/answer',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'hosting', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      // Not the room's owner: the member offered, signed in as themselves.
      const member = owner;
      const meetingId = params.meetingId!;
      const body = hostOfferAnswerRequestSchema.parse(await readBoundedJSON(request));
      // A decline reaches the host through its lobby poll: the offer is gone.
      await room.answerHostOffer({ sub: member.sub, email: member.email }, meetingId, body.accept);
      return json({
        status: body.accept ? 'accepted' : 'declined',
        room_slug: slug,
        meeting_id: meetingId,
      } satisfies HostOfferAnswerResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/:role/release',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid, role: { re: 'host|chair', sample: 'host' } },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { room } = await roomOf(env, params);
      const meetingId = params.meetingId!;
      const legacy = params.role === 'chair';
      const deviceID = await requestDeviceID(request, env);
      const state = await room.hostState(owner.sub, meetingId);
      const participants = state.pendingHostIdentity
        ? await listLiveKitParticipantIdentities(env, state.livekitRoom)
        : new Set<string>();
      const updated = await room.releaseHost(
        owner.sub,
        meetingId,
        deviceID,
        owner.email,
        state.pendingHostIdentity !== null && participants.has(state.pendingHostIdentity),
      );
      await sendHostMessageQuietly(env, state.livekitRoom, {
        version: 1,
        type: 'changed',
        host_identity: updated.hostIdentity,
        target_identity: null,
      });
      // The release may leave this device the host: its request came from a
      // device that has since left. The caller reads `host_identity`.
      const stillHost = updated.hostIdentity !== null && updated.hostIdentity === state.hostIdentity;
      ctx.waitUntil(syncHostBadge(env, room, meetingId, state.livekitRoom));
      return json(hostMutationAnswer(
        legacy,
        stillHost ? 'host' : 'released',
        updated.hostIdentity,
        updated.pendingHostIdentity,
        updated.hostLeaseExpiresAt,
      ) satisfies HostMutationResponse | LegacyChairMutationResponse);
    },
  }),

  // The host's one moderation control over what other people publish. It stops
  // a share in flight; it does not revoke the right to share, so someone who
  // was stopped mid-mistake can share again deliberately.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/screen-share/stop',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { room } = await roomOf(env, params);
      const body = screenShareStopSchema.parse(await readBoundedJSON(request));
      const livekitRoom = await room.moderatedLiveKitRoom(owner.sub, params.meetingId!);
      const stopped = await stopParticipantScreenShare(env, livekitRoom, body.identity, owner.name);
      return json({ stopped } satisfies ScreenShareStopResponse);
    },
  }),

  // Closing a microphone, one person or the whole room. Like stopping a share
  // it takes something away and gives nothing back: there is no route that
  // unmutes somebody, because opening a microphone is theirs to do.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/participants/mute',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { room } = await roomOf(env, params);
      const body = participantMuteSchema.parse(await readBoundedJSON(request));
      const livekitRoom = await room.moderatedLiveKitRoom(owner.sub, params.meetingId!);
      // The owner's own identity is their verified address, which is also how
      // "everyone else" excludes the host from a room-wide mute.
      const muted = await muteParticipantAudio(
        env,
        livekitRoom,
        body.identity ? { identity: body.identity } : { exceptIdentity: owner.email },
        owner.name,
      );
      return json({ muted } satisfies ParticipantMuteResponse);
    },
  }),

  // The strongest thing a host can do to somebody already in the room, and the
  // only one that outlives the moment: the admission is spent in the room
  // record before the SFU seat is taken, so a reconnect lands back at the door.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/participants/remove',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { room } = await roomOf(env, params);
      const body = participantRemoveSchema.parse(await readBoundedJSON(request));
      const meetingId = params.meetingId!;
      const livekitRoom = await room.moderatedLiveKitRoom(owner.sub, meetingId);
      await room.removeParticipant(owner.sub, meetingId, body.identity);
      await removeParticipant(env, livekitRoom, body.identity, owner.name);
      return json({ removed: true } satisfies ParticipantRemoveResponse);
    },
  }),

  // Owners keep their full record view. CRM members may read a finalized
  // meeting filed on a subject they can see in History; the artifact token
  // route stays for guests.
  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings/:meetingId/transcript',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'hosting' },
    handler: async ({ request, env, url, params }) => {
      const { slug, room } = await roomOf(env, params);
      const query = parseQuery(meetingTranscriptQuerySchema, url);
      const meetingId = params.meetingId!;
      let owner: OwnerSession | null = null;
      try {
        owner = await requireRoomOwner(request, env, slug);
      } catch (error) {
        if (!(error instanceof RoomError && error.code === 'not_room_owner')) throw error;
      }

      const view = await (async () => {
        if (owner) {
          try {
            const [artifact, category] = await Promise.all([
              room.artifactForViewer(meetingId, owner.email, 'owner'),
              room.meetingCategory(meetingId),
            ]);
            return { owner, artifact, category };
          } catch (error) {
            if (!(error instanceof RoomError && error.code === 'artifact_denied')) throw error;
          }
        }
        const member = await requireCapability(request, env, 'crmWork');
        const filedCategory = await room.meetingCategory(meetingId);
        const subject = subjectOfCategory(filedCategory);
        if (!subject) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
        // docs/ACCESS.md: a meeting filed on a subject this member cannot see
        // is not found, the same answer an unfiled meeting gives.
        if (!(await subjectAccessFor(env, member)).canSee(subject.kind, subject.id)) {
          throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
        }
        // History subjects are shared company-wide among crmWork members
        // (docs/MEETING_LOG.md and docs/WORK.md). Resolve this exact subject
        // through Core's History projection so stale references fail closed.
        if (!await fetchCrmSubject(env, subject.kind, subject.id)) {
          throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
        }
        const memberView = await room.artifactForFiledMember(meetingId, subject);
        return { owner: null, artifact: memberView.artifact, category: memberView.category };
      })();

      // Members can read only finalized, filed artifacts. Their structured
      // projection contains the same summary/transcript as the authorized
      // artifact; owner-only notes and attendee details stay private.
      if (!view.owner && view.artifact.endedAt === null) {
        throw new RoomError('The meeting artifact is available after the meeting ends.', 409, 'meeting_inactive');
      }
      if (query.structured) {
        if (view.artifact.endedAt === null) {
          throw new ControlError('The meeting artifact is available after the meeting ends.', 409, 'meeting_inactive');
        }
        if (view.owner) {
          const material = await room.meetingLogMaterial(meetingId);
          return json(mcpMeetingArtifact(material) satisfies McpMeetingArtifactResponse);
        }
        const subject = subjectOfCategory(view.category);
        const subjectDoor = subject ? `subject:${subject.kind}:${subject.id}` : null;
        return json({
          summary: view.artifact.summary,
          action_items: [],
          decisions: [],
          open_questions: [],
          attendees: [],
          subject: subjectDoor ? { door: subjectDoor } : null,
          started_at: view.artifact.startedAt,
          ended_at: view.artifact.endedAt,
          transcript: { segments: view.artifact.transcript },
        } satisfies McpMeetingArtifactResponse);
      }
      // Delivery state and decision controls belong to the room owner.
      const material = view.owner ? await room.meetingLogMaterial(meetingId) : null;
      const deliveries = view.owner ? await deliveriesOf(env, meetingId) : [];
      return json({
        artifact: view.artifact,
        category: { meeting_kind: view.category.meetingKind, subject_title: view.category.subjectTitle },
        deliveries,
        read_only: view.owner === null,
        notes_stale: material !== null && material.summary !== null && material.transcriptRevision > material.summaryRevision,
        action_items: material?.actionItems ?? [],
        decision_candidates: material?.decisionCandidates ?? [],
        // The owner's own roster, names only (never an address); a member's
        // header names the speakers instead.
        ...(material ? { attendees: material.participants.map((person) => person.name.trim()).filter(Boolean) } : {}),
      } satisfies TranscriptViewResponse);
    },
  }),

  // One decision the notes proposed, answered: recorded on the
  // meeting's subject with the meeting as its source, or dismissed. A
  // meeting filed nowhere has no subject to record on; the row waits.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/decision-candidates/:index',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid, index: { re: '\\d{1,2}', sample: '0' } },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { room } = await roomOf(env, params);
      const body = meetingDecisionCandidateAnswerSchema.parse(await readBoundedJSON(request));
      const meetingId = params.meetingId!;
      const index = Number(params.index);
      const material = await room.meetingLogMaterial(meetingId);
      const candidate = material.decisionCandidates[index];
      if (!candidate) return json({ error: 'No such candidate.' }, 404);
      if (candidate.decision_id || candidate.dismissed) {
        return json({ candidate } satisfies MeetingDecisionCandidateMutationResponse);
      }
      if (!body.accept) {
        const answeredCandidate = await room.answerDecisionCandidate(meetingId, index, { dismissed: true });
        if (!answeredCandidate) return json({ error: 'No such candidate.' }, 404);
        return json({ candidate: answeredCandidate } satisfies MeetingDecisionCandidateMutationResponse);
      }
      const subject = material.meetingKind === 'project' && material.projectId ? { kind: 'project' as const, id: material.projectId }
        : material.meetingKind === 'lead' && material.leadId ? { kind: 'lead' as const, id: material.leadId }
          : material.meetingKind === 'partner' && material.partnerOrganizationId ? { kind: 'organization' as const, id: material.partnerOrganizationId }
            : null;
      if (!subject) return json({ error: 'File the meeting under a project, lead or partner first.', code: 'invalid_request' } satisfies ControlErrorBody, 409);
      (await subjectAccessFor(env, owner)).requireWrite(subject.kind, subject.id);
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const decision = await recordDecision(env, ctx, owner, {
        subject_kind: subject.kind,
        subject_id: subject.id,
        body: candidate.what,
        source: 'meeting',
        source_ref: meetingId,
      });
      const answeredCandidate = await room.answerDecisionCandidate(meetingId, index, { decisionId: decision.id });
      if (!answeredCandidate) return json({ error: 'No such candidate.' }, 404);
      return json({ candidate: answeredCandidate, decision } satisfies MeetingDecisionCandidateMutationResponse);
    },
  }),

  // Lines the person struck out: gone from the record, then the Docs
  // document and Core hear the shorter transcript through the ordinary
  // sync. The notes are not rewritten — Admin › Rewrite notes does that.
  // A speaker renamed: every line with that id takes the name, then Docs
  // and Core hear it. Notes are not rewritten here either.
  defineRoute({
    method: 'PATCH',
    path: '/api/rooms/:slug/meetings/:meetingId/transcript',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = transcriptRenameSchema.parse(await readBoundedJSON(request));
      const renamed = await room.renameSpeaker(owner.sub, params.meetingId!, body.speaker_id, body.speaker_name);
      // The correction is owed downstream through the ledger, on
      // an ended meeting; a live one is carried by its end.
      if (renamed > 0 && await room.isEnded(params.meetingId!)) {
        ctx.waitUntil(requestDelivery(env, slug, params.meetingId!).catch(() => undefined));
      }
      return json({ renamed } satisfies TranscriptRenameResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/rooms/:slug/meetings/:meetingId/transcript',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = transcriptDeleteSchema.parse(await readBoundedJSON(request));
      const removed = await room.deleteTranscriptSegments(owner.sub, params.meetingId!, body.segment_ids);
      if (removed > 0 && await room.isEnded(params.meetingId!)) {
        ctx.waitUntil(requestDelivery(env, slug, params.meetingId!).catch(() => undefined));
      }
      return json({ removed } satisfies TranscriptDeleteResponse);
    },
  }),

  // The owner's own Delete meeting: the same erasure an org admin
  // runs, from every copy, with the receipt. Not in a shared team room, where
  // every member is an owner of the room and the meeting is everyone's: an
  // admin erases those (POST /api/admin/erase-meeting).
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/erase',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const { slug } = await roomOf(env, params);
      if (isInternalRoomSlug(env, slug)) {
        throw new RoomError('Ask an admin to delete a meeting in a shared room.', 403, 'not_room_owner');
      }
      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const requestId = `dr-${day}-${1 + Math.floor(Math.random() * 9999)}`;
      return json(await eraseMeeting(env, owner, { room_slug: slug, meeting_id: params.meetingId!, request_id: requestId }) satisfies EraseMeetingResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/transcript',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { room } = await roomOf(env, params);
      // A schema-legal batch (250 × 4000-char segments) far exceeds the default
      // body cap, so this route gets its own byte budget.
      const body = transcriptBatchSchema.parse(await readBoundedJSON(request, TRANSCRIPT_BODY_MAX_BYTES));
      if (body.segments.some((segment) => segment.meeting_id !== params.meetingId!)) {
        throw new RoomError('Transcript segment meeting IDs must match the route.', 400, 'invalid_request');
      }
      const accepted = await room.appendTranscript(owner.sub, params.meetingId!, body.segments);
      return json({ accepted } satisfies TranscriptAppendResponse);
    },
  }),

  // Host pressed End: close the SFU immediately so web guests are not stranded
  // while the Mac drains its transcript outbox. Artifact finalization still
  // rides POST …/finalize after segments upload.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/end',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = endMeetingSchema.parse(await readBoundedJSON(request).catch(() => ({})));
      const ended = await room.endMeeting(owner.sub, params.meetingId!);
      // The internal room belongs to no one (ADR 0001), so the host stepping
      // out must not end the all-hands for the people still in it: the record
      // ends, the SFU room stays up until it empties or somebody ends it for
      // everyone. A personal room is the owner's, and its meeting is too.
      const closeRoom = !isInternalRoomSlug(env, slug) || body.everyone === true;
      if (closeRoom) await closeLiveKitRoomQuietly(env, slug, ended.livekitRoom);
      // The meeting's trail in its subject's channel — once, on the end that
      // actually ended it. A retry, or /finalize after this, adds nothing.
      // Under five minutes is not a meeting (MIN_MEETING_MILLISECONDS): the artifact
      // job discards it, so the channel hears nothing either.
      if (!ended.alreadyEnded && ended.endedAt - ended.startedAt >= MIN_MEETING_MILLISECONDS) {
        const filedUnder = subjectOfCategory(await room.meetingCategory(params.meetingId!));
        if (filedUnder) {
          ctx.waitUntil(postSubjectEvent(
            env,
            filedUnder,
            `Meeting ended after ${describeDuration(ended.startedAt, ended.endedAt)} · notes on their way`,
            [{ kind: 'meeting', id: params.meetingId! }],
            { actor: { sub: owner.sub, email: owner.email } },
          ));
        }
      }
      return json({ status: 'ended', already_ended: ended.alreadyEnded, room_closed: closeRoom } satisfies EndMeetingResponse);
    },
  }),

  // After the call: the host approves the follow-up and its tasks,
  // or dismisses it. Approve answers the mail draft; Starlings sends nothing.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/follow-up',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { slug } = await roomOf(env, params);
      const body = meetingFollowUpApproveSchema.parse(await readBoundedJSON(request));
      return json(await approveFollowUp(env, slug, params.meetingId!, body, owner.email) satisfies MeetingFollowUpApproveResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/rooms/:slug/meetings/:meetingId/follow-up',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ env, params }) => {
      const { slug } = await roomOf(env, params);
      await dismissFollowUp(env, slug, params.meetingId!);
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/:meetingId/finalize',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const artifact = await room.finalizeMeeting(owner.sub, params.meetingId!);
      // Close the SFU room so guests are dropped instead of being left alone in a
      // meeting with no owner. Best effort: the transcript is what matters here,
      // and a stale room still fails the host-lease check on any re-entry.
      // Idempotent with POST …/end — DeleteRoom on an already-gone room is fine.
      // Not on the internal room: there the host leaving is not the end of the
      // call, and `…/end` with `everyone` is the way to end it.
      if (!isInternalRoomSlug(env, slug)) {
        const livekitRoom = await room.livekitRoomName(params.meetingId!);
        await closeLiveKitRoomQuietly(env, slug, livekitRoom);
      }
      // The record that this meeting is owed notes, before the job exists
      //. A failed insert fails the route: no job without a record.
      await recordNotesOwed(env, slug, params.meetingId!);
      await env.ARTIFACT_JOBS.send({ roomSlug: slug, meetingId: params.meetingId! });
      return json({ status: 'processing', artifact } satisfies FinalizeMeetingResponse, 202);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings/:meetingId/artifact',
    params: { slug: ROOM_SLUG, meetingId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the meeting\'s signed artifact token, checked against this room and meeting' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      const principal = await requireArtifactPrincipal(request, env, slug, params.meetingId!);
      return json(await room.artifactForViewer(principal.meetingId, principal.identity, principal.role) satisfies ArtifactMaterialResponse);
    },
  }),

  // The meetings the Mac captured outside any room, for the Meetings list
  //. Filing one is the meeting's category route.
  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/meetings',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-owner' },
    handler: async ({ env, url, params }) => {
      const { slug, room } = await roomOf(env, params);
      if (url.searchParams.get('capture') === 'ambient') {
        return json({ meetings: await room.ambientMeetings() } satisfies AmbientMeetingsResponse);
      }
      if (url.searchParams.has('since')) {
        const raw: Record<string, string> = { since: url.searchParams.get('since')! };
        const limit = url.searchParams.get('limit');
        if (limit !== null) raw.limit = limit;
        const query = meetingChangesQuerySchema.parse(raw);
        return json(await ledgerMeetingChanges(env, slug, query.since, query.limit) satisfies MeetingChangesResponse);
      }
      return json({ error: 'Not found.' }, 404);
    },
  }),

  // A meeting captured outside any room, arriving over with its roster; the
  // Mac then uploads the transcript and finalizes it like a hosted one.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/meetings/ambient',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = ambientMeetingSchema.parse(await readBoundedJSON(request));
      const created = await (await roomOf(env, params)).room.startAmbientMeeting(owner, {
        startedAt: Date.parse(body.started_at),
        endedAt: Date.parse(body.ended_at),
        title: body.title ?? null,
        attendees: body.attendees ?? [],
      });
      return json({ meeting_id: created.id } satisfies AmbientMeetingResponse, 201);
    },
  }),
];
