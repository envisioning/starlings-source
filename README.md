# Starlings

Starlings is a workspace for a small firm. People and agents work on the same record: every call, message, task and document is filed on the client or project it is about.

Calls run on LiveKit. The host keeps the transcript on their own device. There are native apps for Mac, iPhone, iPad, Android and Apple Watch, and a web app for everything else. The server is a set of Cloudflare Workers with one D1 database per workspace.

## Licence

The product is FSL-1.1-ALv2 ([LICENSE](LICENSE)). You can read, change and run it for your own use. You cannot sell it to others as a competing service. Each version becomes Apache-2.0 two years after its release. The Starlings Subject Spec in `standard/` is Apache-2.0 now.

The Starlings and Envisioning names and marks are not part of the licence ([NOTICE](NOTICE)). A fork needs its own name.

## What this repository is for

This is the source of the product, published so you can read what it does and check how it handles your data. Everything else is at your own risk: we have not tested a deployment from this tree, and we do not support one. Every `wrangler.jsonc` here is a template, with `replace-with-…` where your values go, and `packages/contracts/src/deployment-values.ts` holds an organisation's defaults.

## Run locally

We have not tested these steps from this tree. You need Node and pnpm for the Worker and the web app. The native apps also need an Apple Silicon Mac with Xcode 26 or later, XcodeGen and the LiveKit server CLI.

```sh
brew install livekit xcodegen
pnpm install
xcodegen generate
pnpm dev
```

`pnpm dev` starts the local stack. Then open `Starlings.xcodeproj` and run the `Starlings` scheme for the Mac or `Starlings-iOS` for iPhone and iPad. The public default builds without a signing team.

## Check a change

```sh
pnpm verify:fast
```

## Where things are

- `services/control-plane`: the Worker that serves a workspace
- `services/docs`, `services/keep`: the document store and the zero-knowledge vault
- `services/marketing`, `web/`: the site and the web app
- `packages/contracts`: every wire shape, in zod, with Swift and Kotlin generated from it
- `Sources`, `iOS`, `watchOS`, `android`: the native apps
- `standard`: the open Subject Spec
- `docs/help`: the product help, also served at `/help`
- `docs/adr`: why the big decisions went the way they did

## Contribute

We do not take pull requests yet. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems as [SECURITY.md](SECURITY.md) says, not in an issue.
