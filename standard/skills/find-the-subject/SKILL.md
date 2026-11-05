---
name: find-the-subject
description: Find the subject (project, lead, organization or event) a request is about before you act on it. Use at the start of any task in a workspace that holds subjects, before you read, write, file or schedule anything.
---

# Find the subject

Every piece of work belongs to a subject: a project, a lead, an organization or an
event. Find it first. Work that is not filed to a subject is lost to the team.

## Procedure

1. **Read the request for names.** A client, a project name, a person, an
   event, a document title.
2. **Search for the subject.** Search with the most specific name first.
   Prefer a subject over a person, a document or a conversation.
3. **Choose one subject.**
   - One clear match: use it.
   - More than one match: show the person the candidates with their kind and
     one line each. Ask which one. Do not guess.
   - No match: say so. Ask the person whether the work belongs to another
     subject, or whether to create one. Do not create a subject without a yes.
4. **Keep the door.** Pass the subject's door (`subject:<kind>:<id>`) to every
   later step. Do not pass a name when a door exists.

## Rules

- Do not file work to a person when it is about a client. The client is the
  subject; the person is a participant.
- A request can touch two subjects. Name both, and file each output to the
  subject it is about.

## On Starlings

| Step | Tool |
| --- | --- |
| Search | `search` returns rows with a `door` |
| Confirm | `open` with the door returns the subject |
| Context for "now" requests | `now` lists the member's latest activity across subjects |
| Create a lead (after a yes) | `task` with `action: "create_lead"` |
