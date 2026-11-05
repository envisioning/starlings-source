---
kind: howto
status: active
verified: 2026-10-20
summary: "Remove a channel whose project, lead, partner or event was deleted from the workspace, and put it back (admins)"
capabilities: [owner-channels]
owns: [services/control-plane/src/channel-removal.ts]
---

# Remove a channel without a subject

A channel belongs to a project, lead, partner or event. When the workspace deletes the
subject, the channel stays in everyone's list. An admin can remove it. Removing
hides the channel for everyone; its messages are kept, and you can restore it.

## Remove one

1. Open **Admin**, then **Jobs**. Find **Channels without a subject**.
2. The card lists every channel whose subject is gone from the workspace, with its
   kind, when it was created, its last message and how many messages it holds.
3. Choose **Remove** on the row. The channel leaves everyone's list, search and
   INBOX at their next refresh.

If the card says some channels were not checked yet, choose **Check more**. If
it says some **couldn't be checked**, the workspace could not check their subjects. They are not
listed and not removed. Try again in a moment.

## Put one back

The card lists channels you removed, newest first. Choose **Restore** on the
row. The channel returns with its whole history.

A channel also comes back by itself when its subject does: an event filed on
the subject, a message arriving for the channel, or someone opening the subject
again. Nothing is lost by removing one too early.

## What can't be removed

- A direct message, a group or Team. Only a project, lead, partner or event
  channel can be removed.
- A channel whose subject still exists. Starlings checks the workspace's
  record store by id. If the check fails, times out or answers with anything
  but "no such subject", nothing is removed.

Removing and restoring are admin actions and appear under **Changes** in Admin.
