---
kind: howto
status: active
verified: 2026-10-20
summary: "Let people sign up for an event at `/event/<slug>`, let them in with their own link, and send the follow-up"
capabilities: [entry-event-signup, event-follow-up]
owns: [web/src/EventSignupPage.tsx, services/control-plane/src/routes/events.ts, services/control-plane/src/event-signup-mail.ts, services/control-plane/src/event-page.ts]
---

# Run an event sign-up

An event with a room and a public slug has a sign-up page at
`/event/<slug>` on the workspace's address. Nobody signs in to use it.

1. Give the event a room and a public slug. The page opens at once. It
   shows the cover image, the host (the room's owner, with photo and
   name), the time in the event's zone, the length, and the event's
   description and **About** text. A visitor in another zone also sees the
   time in their own zone. From 5 sign-ups the page shows how many are
   going, and at 20 spots or fewer, how many are left.
2. Share the page. A link preview shows the event's title, description
   and image. A person enters a name and an email address and presses
   **Sign up**. The page then shows **Join with your link** and **Add to
   calendar** (Google Calendar, Outlook, or an `.ics` file). The mail they
   get holds the description, their own room link, a calendar invite and
   the event's call to action, when it has one. The calendar entry from
   the page and the mail's invite are the same entry.
3. Signing up again with the same address shows no link on the page. It
   sends the same link again by email. Sign-up closes at the start, or at
   90 people.
4. An hour before the start, each person gets a reminder with their link.
5. Start your room in the event window. A person with a sign-up link walks
   in without a knock, up to three times. The People list shows them as
   **Registered**. In the waiting room, **Make registered guests knock**
   closes that door for the rest of the event.
6. In the event, guests join with mic and camera off, and the transcript
   and notes go to the host only.
7. After the event, a workspace admin or the person who made the event
   sends the follow-up: the event's note and its call to action, to
   everyone who signed up, whether they came or not. Ask your Claude to
   send the event follow-up, or call `POST /api/events/<id>/follow-up`.
   A second send reaches only the people who did not get it.
   Each follow-up has an unsubscribe link. Someone who clicks it gets no
   further follow-ups from your workspace. Confirmations and reminders
   still reach them.
