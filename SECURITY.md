# Security policy

volto executes model-generated commands and code. Its threat model is documented in
[SAFETY.md](SAFETY.md): it defends against **model mistakes**, and deliberately does not
promise to defend against an **induced model** (prompt injection). Please read that
document before reporting a boundary issue — several behaviors that look like bugs are
documented, intentional limits.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: on the repository page, go to
**Security → Report a vulnerability**. That opens a private advisory visible only to the
maintainers. Include:

- the version/commit you tested,
- the platform and sandbox mode,
- a minimal reproduction,
- the impact you believe it has (what crosses which boundary).

We will acknowledge the report, investigate, and keep you informed about the fix and the
disclosure timeline. Please give us a reasonable window before public disclosure.

## Supported versions

volto is pre-1.0 and experimental. Only the latest `main` and the latest published
pre-release receive security fixes; older versions are not supported.

## Scope

In scope:

- sandbox escapes (file writes outside the granted mode, credential-directory reads),
- permission-policy bypasses that cross a documented boundary,
- gateway authentication bypasses,
- credential leaks through logs, events or tool output.

Out of scope (documented in [SAFETY.md](SAFETY.md)):

- prompt injection through file contents, web pages or tool output,
- a hook or a memory entry that the host user themselves wrote,
- host credentials such as `~/.ssh` that the sandbox deliberately leaves readable,
- anything that requires running with `danger-full-access`.

If you are unsure whether something is in scope, report it privately anyway.