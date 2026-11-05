# Contributing

Thank you for reading the spec closely enough to want to change it.

## Open an issue

Issues are the way in for now. Open one for:

- a question about what the spec means;
- a case where the spec, the schema and the conformance suite disagree;
- a proposal: a new record, field, subject kind or door kind.

For a proposal, say what an agent or a tool could do with the change that it
cannot do today, and give one example record.

## Pull requests

This repository is published from the Starlings source tree, and each sync
replaces its contents. A pull request merged here would be lost at the next
sync, so pull requests are not merged. If an issue leads to a change, the
change is made in the source and arrives here with the next sync, credited
in `CHANGELOG.md`.

When the spec has a second implementation, this repository becomes the
source and accepts pull requests with a Developer Certificate of Origin
sign-off.

## Implementations

If you implement the spec, open an issue with a link and your conformance
result. Implementations that pass the suite are listed in the changelog.
