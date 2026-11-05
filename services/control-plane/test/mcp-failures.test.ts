import { CONTROL_ERROR_CODES } from '@starlings/contracts';
import { mcpToolFailureSchema } from '@starlings/contracts/mcp';
import { describe, expect, it } from 'vitest';
import {
  MCP_FAILURE_HINTS_BY_CODE,
  MCP_FAILURE_HINTS_FOR_OTHER_CODES,
  MCP_TOOL_FAILURE_HINTS,
  toolFailure,
} from '../src/mcp';
import mcpSource from '../src/mcp.ts?raw';

describe('MCP tool failures', () => {
  it('keeps a fallback hint for every control-plane code', () => {
    expect(Object.keys(MCP_FAILURE_HINTS_BY_CODE).sort()).toEqual([...CONTROL_ERROR_CODES].sort());
    expect(MCP_FAILURE_HINTS_BY_CODE).toMatchInlineSnapshot(`
      {
        "access_change_refused": "Ask another admin to make this access change.",
        "ambiguous_contact": "More than one contact holds that address. Tell the member to merge or correct them. Do not retry.",
        "artifact_denied": "Open a meeting artifact owned by or shared with this member.",
        "calendar_event_not_found": "Refresh the calendar and use a current event.",
        "calendar_expired": "Reconnect the member’s calendar and retry.",
        "calendar_failed": "Retry the calendar request later.",
        "calendar_not_connected": "Connect the member’s calendar and retry.",
        "calendar_not_invited": "Ask the event organizer to invite the member.",
        "calendar_wrong_account": "Use the calendar account that owns this event.",
        "capability_denied": "Ask an organization admin to grant the required capability.",
        "capacity_reached": "Wait for a participant to leave before retrying.",
        "client_update_required": "This route is retired for older apps. Tell the member to update Starlings. Do not retry.",
        "contact_email_taken": "That address is another contact's. Open that contact instead. Do not retry.",
        "core_account_missing": "Ask an administrator to connect the required Core account.",
        "device_not_found": "Sign in on this device again and retry.",
        "different_owner": "Use the account that owns this room.",
        "guest_not_admitted": "Ask the room host to admit the guest first.",
        "guest_removed": "Ask the host to invite the guest again.",
        "hash_mismatch": "Reopen the document and apply the change to its latest version.",
        "host_not_active": "Ask the room host to reopen the room before retrying.",
        "internal_error": "Retry the request later.",
        "invalid_question_answer": "Choose valid options from the question, following its selection rule.",
        "invalid_question_recipient": "Name one eligible human recipient who can answer in this conversation.",
        "invalid_request": "Check the tool arguments and use the documented input shape.",
        "link_expired": "Request a fresh invitation link.",
        "lobby_credentials_invalid": "Request a fresh lobby link from the host.",
        "lobby_credentials_missing": "Request a fresh lobby invitation.",
        "meeting_ended": "Read the finalized meeting artifact after the meeting ends.",
        "meeting_inactive": "Wait until the meeting ends, then read its finalized artifact.",
        "meeting_not_found": "Check the meeting id and room slug, then retry.",
        "message_not_editable": "Send a new message with the correction.",
        "message_not_replyable": "Choose an available text message in this conversation as the reply parent.",
        "not_configured": "Ask an administrator to configure this service, then retry.",
        "not_org_admin": "Ask an organization admin to perform this action.",
        "not_room_owner": "Ask the room owner to perform this action.",
        "notetaker_sender_required": "Ask the room owner to attribute the notetaker to a team member before admission.",
        "oauth_failed": "Reconnect the provider and retry the request.",
        "owner_auth_required": "Reconnect the Starlings connector and retry the request.",
        "participant_not_found": "Refresh the participant list and try again.",
        "peer_unavailable": "Try messaging the person instead.",
        "person_not_found": "Refresh the people list and use a current address.",
        "plan_kept_project_final": "The writable project was already picked; it cannot change. Do not retry.",
        "plan_not_supported": "This workspace cannot use that plan. Do not retry.",
        "plan_project_frozen": "Tell the member this project is read-only on the Free plan; an admin can upgrade. Do not retry.",
        "plan_project_limit": "Tell the member the Free plan holds one project; an admin can upgrade. Do not retry.",
        "question_not_open": "Refresh the conversation and use an open question.",
        "rate_limited": "Wait briefly before retrying the request.",
        "recorders_refused": "Ask the room owner to allow recording notetakers, then retry.",
        "records_moving": "These records are moving to a new store. Reads still work; retry the write in a few minutes.",
        "release_request_closed": "That release request is not open for this act. Ask again in a new card.",
        "request_already_decided": "Refresh the request and continue from its current state.",
        "request_not_found": "Refresh the work list and use a current task or subject.",
        "role_change_refused": "Choose a role change that preserves the final admin.",
        "room_not_found": "Check the room slug and use a room that exists.",
        "room_not_started": "Ask the room owner to start the meeting first.",
        "session_expired": "Reconnect the Starlings connector and retry the request.",
        "subject_access_denied": "Ask a manager of the subject for write access; this member can only read it.",
        "subject_not_found": "Check the subject id, or ask a manager of the subject to grant this member access.",
        "turnstile_failed": "Complete the security check and retry.",
        "untrusted_origin": "Retry the action from a trusted Starlings origin.",
        "upstream_shape": "Retry later or ask an administrator to check the connected service.",
        "workspace_closed": "The workspace was shut down by its owner. Tell the member. Do not retry.",
      }
    `);

    for (const code of CONTROL_ERROR_CODES) {
      const status = code === 'rate_limited' ? 429 : code === 'not_configured' ? 503 : 403;
      const result = toolFailure({ status, code, message: 'The route refused the request.' }, 'unlisted_tool');
      const payload = mcpToolFailureSchema.parse(result.structuredContent);
      expect(result.isError).toBe(true);
      expect(payload.error.hint).toBe(MCP_FAILURE_HINTS_BY_CODE[code]);
      expect(result.content[0]?.text).toBe(`${code}: The route refused the request. — ${payload.error.hint}`);
      expect(payload.error.retryable).toBe(code === 'rate_limited' || code === 'not_configured');
    }
  });

  it('snapshots MCP-local refusal codes and gives them fallbacks', () => {
    const codes = [...mcpSource.matchAll(/new ApiError\(\{([\s\S]*?)\}\)/gu)]
      .map((match) => match[1]?.match(/code:\s*'([^']+)'/u)?.[1])
      .filter((code): code is string => Boolean(code));
    const uniqueCodes = [...new Set(codes)].sort();
    expect(uniqueCodes).toMatchInlineSnapshot(`
      [
        "calendar_event_not_found",
        "capability_denied",
        "failed",
        "invalid_request",
        "member_not_found",
        "no_room",
        "outside_attendees",
        "person_not_found",
        "publish_refused",
        "quick_note_filed",
        "quick_note_not_found",
        "request_not_found",
      ]
    `);

    for (const code of uniqueCodes) {
      expect(
        MCP_FAILURE_HINTS_BY_CODE[code as keyof typeof MCP_FAILURE_HINTS_BY_CODE]
          ?? MCP_FAILURE_HINTS_FOR_OTHER_CODES[code],
      ).toBeTruthy();
      const result = toolFailure({ status: 400, code, message: 'The MCP tool refused the request.' }, 'unlisted_tool');
      expect(mcpToolFailureSchema.parse(result.structuredContent).error.hint).toBeTruthy();
    }

    expect(MCP_FAILURE_HINTS_FOR_OTHER_CODES).toMatchInlineSnapshot(`
      {
        "connector_paused": "Tell the member. Nothing reaches Starlings until they press Resume under Settings › Account › Connected agents; do not retry before they do.",
        "drafts_only": "This agent writes drafts only. Do not retry. Save it as a draft, or tell the person what to change so they can publish or edit it in Core.",
        "failed": "Retry the request later.",
        "in_progress": "The same call is still running. Retry in a few seconds.",
        "member_not_found": "Ask an administrator to add the member to Core’s team list.",
        "no_room": "Ask the member to create or choose a Starlings room.",
        "outside_attendees": "Invite outside attendees from the Starlings calendar.",
        "publish_refused": "Ask the member to share this document from Docs. Do not retry.",
        "quick_note_filed": "Call now() and pick a note whose state is \`open\`.",
        "quick_note_not_found": "Call now() and use an id from \`quick_notes\`.",
      }
    `);
  });

  it('uses a more useful hint for a tool-specific refusal', () => {
    expect(MCP_TOOL_FAILURE_HINTS).toMatchInlineSnapshot(`
      {
        "ask_decision": {
          "capability_denied": "Only the member it waits on, or whoever asked, can change it. Ask the member.",
          "invalid_request": "Give a question, two to six options with keys, a recommendation that is one of the keys, and default_by as YYYY-MM-DD. For withdraw or apply_default pass the decision id; apply_default only works after default_by.",
          "request_already_decided": "Read it back with ask_decision list or now(): it was answered, defaulted or withdrawn already.",
        },
        "open": {
          "calendar_event_not_found": "Refresh the calendar and open a current event door from search.",
          "invalid_request": "Use a door from a search result, or call now() to find an item and its door.",
          "request_not_found": "Refresh the task or subject with search or now(), then open its current door.",
        },
        "task": {
          "invalid_request": "To create a task, pass a subject door and title; a task's text goes in notes, not description. To change a task, pass its full id or task door and include a field to change; use now() or open() to look it up. To create a lead, pass action "create_lead", a title, and the organization_id or the organization name. To create a project, pass action "create_project" and a title.",
        },
        "transcript": {
          "meeting_ended": "Meetings are readable after they end. Try again after the meeting ends.",
          "meeting_inactive": "Meetings are readable after they end. Try again after the meeting ends.",
        },
      }
    `);
    const task = toolFailure({ status: 400, code: 'invalid_request', message: 'Pass a full task id.' }, 'task');
    expect(mcpToolFailureSchema.parse(task.structuredContent).error.hint).toContain('now() or open()');

    for (const code of ['meeting_ended', 'meeting_inactive']) {
      const transcript = toolFailure({ status: 410, code, message: 'The meeting is not over.' }, 'transcript');
      expect(mcpToolFailureSchema.parse(transcript.structuredContent).error.hint)
        .toBe('Meetings are readable after they end. Try again after the meeting ends.');
    }
  });

  it('marks transient failures retryable and carries a replacement door when available', () => {
    for (const [status, code] of [[429, 'rate_limited'], [503, 'not_configured'], [500, 'internal_error']] as const) {
      const failure = toolFailure({ status, code, message: 'Try again.', door: 'task:full-id' }, 'search');
      expect(mcpToolFailureSchema.parse(failure.structuredContent).error).toMatchObject({
        retryable: true,
        door: 'task:full-id',
      });
    }
    const badRequest = toolFailure({ status: 400, code: 'invalid_request', message: 'Check the input.' }, 'search');
    expect(mcpToolFailureSchema.parse(badRequest.structuredContent).error.retryable).toBe(false);
    const pending = toolFailure({ status: 409, code: 'in_progress', message: 'The same call is still running.' }, 'send_message');
    expect(mcpToolFailureSchema.parse(pending.structuredContent).error).toMatchObject({
      hint: 'The same call is still running. Retry in a few seconds.',
      retryable: true,
    });
  });
});
