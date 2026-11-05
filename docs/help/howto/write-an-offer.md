---
kind: howto
status: active
verified: 2026-11-05
summary: "Write an offer on a lead or an organization, send it, change it after sending, and record the buyer's answer"
capabilities: [owner-work]
owns: [web/src/OfferEditorPage.tsx, web/src/CatalogPage.tsx, Sources/WorkOfferEditor.swift, Sources/OfferParts.swift, iOS/MobileOfferView.swift, android/app/src/main/java/work/starlings/android/workspace/work/OfferScreen.kt, services/control-plane/src/offers-d1.ts, services/control-plane/src/routes/offers.ts, packages/contracts/src/offers.ts, packages/contracts/src/offer-values.ts]
---

# Write an offer

An offer lives on a lead or an organization. An admin turns **Offers** on under
**Admin › People › Workspace**. You edit offers on the web and the Mac. On iPhone
and Android you read an offer, share its link, duplicate it and record the buyer's
answer. An agent connected over MCP has the web's tools.

## Start one

1. Open the lead or the organization in Work.
2. In the **Offers** group, choose **+**.

A new offer is a draft, and no buyer can read it. If the organization has a
partner discount, the draft starts with it. To set one, use **Partner discount** in
the organization's Offers group on the web or the Mac.

## Add lines

A line from the catalog takes its name and description from the service, and
its price unless you change it. A custom line has your own title and price. An
optional line does not count in the total: the buyer may take it when they
accept.

The server works out every total. Prices are in EUR, and EUR is binding. In
another currency the figures are indicative.

## Send it

Choose **Send**. The offer needs a line that is not optional, a person it is
for, and a valid-until date in the future. Send freezes the rate and the totals
and gives you the link. Starlings sends no email: you share the link yourself.

## Change it after sending

Edit the offer as usual. The header says **Unsent changes**, and the buyer still
reads what you sent. Choose **Send update** to send the changes as a new version
on the same link. Earlier versions stay under **Versions**.

## Record the answer

Choose **Record accept** or **Record reject** when the buyer tells you. An
accepted offer is locked on the version the buyer read. Any unsent changes are
dropped. To change an accepted offer, duplicate it.

An accept does the same as the buyer's own accept:

- Optional lines the buyer took become regular lines.
- If the offer has recurring lines, it makes a license for a year, for the
  recurring total after the discount. The year starts on the agreement's start
  date, or else the day the offer was created. An offer that has a license keeps
  it.
- If the offer is on a lead with no project yet, it makes a project with the
  lead's title and organization, and closes the lead as won. A lead that has a
  project keeps it, and its status does not change.
- It proposes a **Kick off delivery** task on the new project, or else the lead.

**Open project** takes you to the project. Licenses show in the organization's
**Licenses** group when an admin has that module on. A workspace at its plan's
project limit refuses the accept, and nothing changes.

## Reuse an offer

**Duplicate** copies any offer to a new draft: lines, discount, notes, terms and
entity. The title starts empty. On the web and the Mac, choose a lead or an
organization to put the copy there. On a phone the copy stays on the same subject.
There are no templates. Duplicate an offer instead.

## The catalog

**Work › Catalog** lists every service. You can change a price, words and whether
a service is on the rate card. You cannot rename a service: create a new one and
take the old one off the rate card. A sent offer keeps its own words and price.

Payment terms, currencies, corporate entities, delivery conditions, offer links
and policies are under **Admin › Records**, on the web. **Commercial settings** on
the Mac's Catalog page opens it.
