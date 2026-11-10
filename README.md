# headlamp-elevated-access

A [Headlamp](https://headlamp.dev) plugin for just-in-time Kubernetes access.
A person signed in to hosted Headlamp requests temporary elevated access to a
cluster with a reason. Once an approver accepts, the approved credential is
installed as Headlamp's own HttpOnly session cookie, without leaving the
browser.

The plugin never handles the credential. A small **access broker** on the same
origin talks to your approval system, for example a secrets manager with
approval workflows. After approval, the broker asks Headlamp's backend to set
the session cookie and relays only the `Set-Cookie` headers to the browser.
The token never reaches browser JavaScript, URLs, local storage or the
clipboard.

```
Headlamp + plugin ──► <broker path>/api ──► approval system (request, approve, unwrap)
                                   │
                                   └──► Headlamp backend POST /clusters/<c>/set-token
browser ◄── Set-Cookie: headlamp-auth-<c>.N (HttpOnly; Secure; SameSite=Strict)
```

## Features

- **Elevate** button in the top bar for clusters the broker offers.
- Reason entry, a pending view with a shareable request reference, and an
  expiry countdown.
- Automatic switch to the elevated credential once the request is approved.
- **Return to my own access** clears the elevated cookie.
- No credential handling in the browser.

Requires Headlamp ≥ 0.44 in in-cluster (hosted) mode with cookie-based
sessions (`-oidc-use-cookie` or token login).

## Installation

Install with Headlamp's plugin manager (Helm chart `pluginsManager`) from
Artifact Hub, or download the release tarball and extract it into Headlamp's
plugins directory.

The broker must be served on the **same origin** as Headlamp. The default path
is `/elevated-access`; users can change it under
*Settings → Plugins → headlamp-elevated-access*.

## Broker API contract

All paths are relative to the broker path (default `/elevated-access`). The
broker identifies the user, typically with an authenticating reverse proxy in
front of it. Mutating requests carry `X-Elevated-Access: 1` and
`Content-Type: application/json`. The broker must reject mutating requests
without them, and must not answer CORS preflights.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/config` | `{ "clusters": [{ "id", "label", "sourceClusters": [..], "targetCluster", "ttl" }], "approvalSystem"?: string }` |
| `POST` | `/api/requests` `{ cluster, reason }` | `201 { "id", "cluster", "reference"?, "approved": false, "approvers": [], "expiresAt" }` |
| `GET` | `/api/requests/{id}` | `{ "approved": bool, "approvers": [..], ... }`, or `404` once expired or cancelled |
| `POST` | `/api/requests/{id}/install` | `200 { "cluster", "targetCluster", "expiresAt" }` plus Headlamp's `Set-Cookie` headers. `409` if not approved. |
| `DELETE` | `/api/requests/{id}` | `200` |
| `GET` | `/oauth2/start?rd=…` | Sign-in entry point, used when `/api/*` returns `401` |

Field notes:

- `sourceClusters` are the Headlamp cluster names that show the button.
- `targetCluster` is the Headlamp cluster whose cookie receives the
  credential. It can be the same cluster, or a separate catalogue entry so
  users keep their own session alongside.
- `expiresAt` values are Unix seconds.

Broker requirements:

- Bind every request to the authenticated user, and return `404` for another
  user's request id.
- Fail closed if the approval system issues a credential without an approval
  step.
- Relay only Headlamp auth cookies, which are `HttpOnly` and `Secure`.
- Never log or return tokens.

## Security notes

- The plugin only sends requests to a same-origin path. Absolute and
  protocol-relative broker paths are rejected.
- UI state in `localStorage` (pending request id, expiry) holds no secrets.
- Headlamp's `POST /clusters/<c>/set-token` accepts unauthenticated requests.
  A hostile site could replace or clear a user's cluster cookie. This isn't
  introduced by this plugin; restrict access to Headlamp, for example with an
  IP allowlist or an authenticating proxy.
- Kubernetes service-account tokens can't be revoked early. Keep elevated
  TTLs short.

## Development

```
npm ci
npm start          # watch build for a local Headlamp
npm test           # vitest
npm run lint
npm run tsc
npm run build
npm run package    # tarball for release
```

Releases run through the **Release** workflow (`workflow_dispatch` with a
version). It builds and tests, packages the tarball, records its URL and
SHA256 in `artifacthub-pkg.yml`, then tags and publishes the GitHub release.

## License

Apache-2.0
