# mimi-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dev-MiMi/mimi-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dev-MiMi/mimi-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge for Node 22. One process serves git smart HTTP, GitHub REST v3, GraphQL and MCP from a shared in-memory store. There is no install step, git subprocess, external service or user interface.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=your-token MAKEFUN_LOGIN=your-login node main.ts
```

The server binds an ephemeral port and prints its address. Send `Authorization: Bearer your-token` on API and git requests. Git HTTP also accepts the token as the password in Basic authentication. `/healthz` is unauthenticated. If `MAKEFUN_LOGIN` is omitted, the first repository address establishes the store's owner.

In a bounty trial, `MAKEFUN_ENV_URL` is supplied automatically. The forge registers its chosen port there, polls `/done`, and exits when the suite finishes.

| Interface | Endpoint | Supported operations |
| --- | --- | --- |
| Git | `/{owner}/{repo}.git` | v2 upload-pack, v0 receive-pack, shallow fetches, branches, tags, fast-forward enforcement, delta pack ingestion |
| REST | `/api/v3` | repositories, branches, refs, commits, contents, labels, issues, comments, pull requests and squash merges |
| GraphQL | `/api/graphql` | repository and issue queries, cursor pagination, introspection, Relay ids, mutations, fragments, aliases and request batches |
| MCP | `/mcp` | Streamable HTTP JSON-RPC, discovery, initialization and six repository/issue/pull tools |

## Validation

```sh
node --test test/*.test.ts
```

With the unpacked make.fun kit and the server running:

```sh
node /path/to/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token your-token --perf --json
```

The full local conformance suite passes all 120 checks. Two fresh lifecycle trials also pass 120/120 and produce byte-identical state exports. Fifteen regression tests cover binary and delta packs, stale writes, conflicting and squash merges, mixed push reports, complete object graphs, GraphQL validation, HTTP framing, cache invalidation, API parity and deterministic output.

The first make.fun practice submission scored **902/1000**: feature 600, MCP 200, performance 102. The second scored **921/1000** with full feature and MCP marks. Practice scores are provisional. Local Termux performance differs substantially from the production sandbox.

The default transport parses HTTP/1.1 directly using Node's TCP server and caches complete responses for repeated reads. It supports keep-alive, pipelining, chunked bodies and `Expect: 100-continue`, and rejects ambiguous request lengths. Set `FORGE_HTTP_DRIVER=node` to use Node's standard HTTP transport with the same application handler.

Request routing and immutable response headers are cached independently of repository state. Authentication and repository lookup still run for every request; issue edits and comment changes invalidate cached issue bodies. Request timeouts apply to incomplete requests while keep-alive connections retain an idle timeout.

The store is ephemeral and resets when the process exits. This implements the bounty's documented GitHub API subset; it does not implement all of GitHub's APIs, persistent hosting, multiple users, or a complete GraphQL specification.

MIT licensed.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
