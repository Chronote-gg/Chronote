---
title: Docs Style Guide
slug: /maintaining-docs/style-guide
---

This guide is for contributors writing or editing Chronote's public documentation. Follow these standards to keep the docs consistent, accurate, and useful.

## Audience

Write for two audiences:

- **Server admins** who set up and configure Chronote (context, dictionary, auto-record, billing).
- **End users** who participate in meetings, read notes, and suggest corrections.

Do not write for internal engineers. Keep implementation details, API internals, and architecture decisions in the repo-internal `docs/` directory, not in this public docs site.

## Writing principles

**Lead with what the reader wants to do.** Start sections with the task or outcome, then provide the steps. Avoid lengthy explanations before actionable content.

**Be specific.** Use exact command names, parameter names, and permission names. Vague guidance like "check your settings" is less useful than "run `/autorecord list` to see configured rules."

**Show real examples.** When demonstrating commands, use realistic values:

- Good: `/context set-server context: Backend engineering team at Acme Corp`
- Bad: `/context set-server context: your context here`

**Keep it short.** Prefer short paragraphs (2-3 sentences), scannable headings, and tables over long prose. Users skim documentation.

## Content standards

### Where docs live

| Content type              | Location               |
| ------------------------- | ---------------------- |
| User-facing product docs  | `apps/docs-site/docs/` |
| Internal engineering docs | `docs/` (repo root)    |
| Architecture decisions    | `docs/adr-*.md`        |
| Prompt documentation      | `prompts/` directory   |

### Docs in pull requests

User-facing PRs should include a docs update in the same PR. If a change does not affect user behavior, add the `docs-exempt` label with a rationale in the PR description.

### Page structure

Each docs page should follow this structure:

1. **Front matter** with `title` and `slug`.
2. **Opening paragraph** that states what the page covers and who it is for.
3. **Body sections** organized by task or concept with clear headings.
4. **Tables** for reference material (commands, parameters, permissions).
5. **Cross-links** to related pages where relevant.

### Headings

- Use sentence case: "Setting up auto-record", not "Setting Up Auto-Record".
- Keep headings short and scannable (under 8 words).
- Use H2 (`##`) for major sections and H3 (`###`) for subsections. Avoid H4 and deeper.

### Code and commands

Format Discord commands as inline code: `/startmeeting`, `/context set-server`.

For command examples with parameters, use code blocks:

```
/dictionary add term: Kubernetes definition: Container orchestration platform
```

### Links

Use relative paths for internal links: `[Features](/features/)`, not full URLs.

Link to specific sections when a page covers multiple topics: `[Notes correction flow](/features/#notes-correction-flow)`.

## What's New page

The [What's New](/whats-new/) page tracks notable product changes.

- Keep entries curated and periodic. Not every PR needs a What's New entry.
- Bundle related changes into one concise update.
- Link to relevant docs pages for new features.
- Use the format: date heading, then a bulleted list of changes.

## Terminology

Use consistent terms across all docs:

| Use this    | Not this                            |
| ----------- | ----------------------------------- |
| meeting     | session, recording                  |
| notes       | summary, minutes (unless specific)  |
| auto-record | auto-recording, automatic recording |
| dictionary  | glossary, word list                 |
| context     | prompt context, AI context          |
| web portal  | dashboard, web app, portal          |
| correction  | edit, revision (in notes context)   |
