# enigma developer guide

Internal documentation for working on the `enigma` monorepo: how the project is
laid out, how to run the CLI from source, how to build it, and how to publish a
release.

This guide is for contributors. End-user docs live in the package README
(`packages/enigma-cli/README.md`).

## Contents

- [development.md](./development.md) - project layout, running the CLI from
  source, the dev loop, and the deterministic gates (`verify`, `check`, `guard`,
  `seal`).
- [building-and-publishing.md](./building-and-publishing.md) - building with
  tsup, versioning and re-sealing, the release flow, and how CI auto-publishes.
- [local-testing.md](./local-testing.md) - safely testing skill installs, the
  commit guard, and the runtime config without touching your real agent setup.

## Quick reference

| Task                         | Command                                              |
| ---------------------------- | --------------------------------------------------- |
| Run the CLI from source      | `npm run enigma -- <args>`                           |
| Build the publishable `dist` | `npm run build`                                      |
| Typecheck                    | `npm run typecheck`                                  |
| Re-seal skills (after edits) | `npm run seal`                                       |
| Integrity gate               | `npm run check`                                      |
| Commit guard (all files)     | `npm run guard`                                      |
| Full gate (typecheck+check+guard) | `npm run verify`                               |

All commands run from the repo root; the root scripts delegate to the
`enigma-cli` workspace.

## Prerequisites

- Node.js >= 18 (declared in `engines`). The repo is developed on newer Node
  too; stick to Node builtins and the declared deps so the floor stays at 18.
- npm with workspaces support (npm 7+). Install once with `npm install` at the
  repo root; this installs the `enigma-cli` workspace's dev dependencies
  (`tsup`, `tsx`, `typescript`, `@types/node`) and runtime dep
  (`@clack/prompts`).

## Layout at a glance

```
.
├─ package.json              # private root: workspaces + delegating scripts
├─ .github/workflows/        # ci.yml (verify+build), publish.yml (npm release)
├─ .githooks/                # this repo's own pre-commit (runs the guard)
├─ docs/
│  ├─ developers/            # this guide (tracked)
│  └─ internal/              # gitignored, private notes
└─ packages/
   └─ enigma-cli/            # the only publishable package (bin: enigma)
      ├─ src/                # TypeScript source (see development.md)
      ├─ assets/             # skills/ and memory/ shipped to agents
      ├─ dist/               # tsup build output (gitignored, published)
      ├─ tsup.config.ts      # two entries: enigma.js + guard.js
      └─ package.json        # the package that gets published to npm
```

There is no `lib/` directory and no `*.mjs` sources; those were removed when the
CLI was migrated to TypeScript. If you see a reference to `lib/*.mjs` or
`bin/enigma.mjs` anywhere, it is stale - the real sources are under `src/`.
