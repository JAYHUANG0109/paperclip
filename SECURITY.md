# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through GitHub's Security Advisory feature:
[https://github.com/JAYHUANG0109/paperclip/security/advisories/new](https://github.com/JAYHUANG0109/paperclip/security/advisories/new)

Do not open public issues for security vulnerabilities.

## Trust model

Paperclip is an **internal, single-organization** agent platform. It is designed to be
run by one company for its own people and agents — **not** as a hardened, public,
multi-tenant boundary between mutually distrusting customers.

It runs in one of two deployment modes:

- **Trusted-local** — for a single operator on their own machine. Convenience over
  isolation: there is no authentication wall and agents run with the host user's
  privileges.
- **Authenticated** — board users sign in; agents authenticate with API keys and
  short-lived per-run tokens; every mutating request is attributed to an actor.

Who is trusted, by design:

- **Organization admins / board users** can configure the platform and read
  operational data, including agent run transcripts and logs.
- **Agents** act on behalf of their *mapped* human owner and use that owner's stored
  credentials (e.g. their Odoo / Asana keys). An agent's authority is the authority
  its owner granted it.
- **Language-model tool use** is trusted *within policy*: the platform constrains
  which tools and actions an agent may take, but assumes the model's decisions inside
  those limits are acted on.

## Known limitations (what Paperclip does not, by itself, protect against)

Being explicit so operators can set expectations:

- **Admin visibility is not consent-gated.** Organization admins can read run
  transcripts and logs of agents in their organization. Treat admins as trusted.
- **Agents inherit their owner's access.** A misbehaving or prompt-injected agent
  operates with the credentials and permissions of the human it is mapped to. Scope
  each agent's owner and connected accounts accordingly (prefer read-only keys).
- **Confidentiality between conversations is coarse today.** State is scoped per
  person and per agent; finer per-room isolation is in progress. Until then, avoid
  putting secrets that must not cross conversations into a shared context.
- **Trusted-local deployments are not sandboxed.** In trusted-local mode (and on
  platforms without the Linux sandbox), agent processes are not network- or
  filesystem-confined. Enforcement in that mode is application-level only.
- **Credentials are used in plaintext at runtime.** Stored secrets are decrypted to
  be used by the agent process; they are not protected against a compromise of that
  process or its host.
- **Classifier / policy screening is a safety aid, not an authorization boundary.**
  Content screening reduces risk from untrusted input; it is not a guarantee.

## In scope for a report

- Authentication or authorization bypass between actors that *should* be isolated
  (e.g. one company's data reachable by another; an agent exceeding its granted scope).
- Secret disclosure beyond the trust model above (e.g. a secret leaking to an actor
  who should never see it).
- Injection, SSRF, or egress that reaches destinations the policy should deny.
- Remote code execution or privilege escalation on the server.

## Out of scope

- Capabilities available to already-trusted actors as described above (admin
  visibility; an agent using its own owner's credentials).
- Findings that require trusted-local mode's documented lack of isolation.
- Denial of service from self-hosting misconfiguration.
