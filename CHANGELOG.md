# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.16.0] - 2026-06-09

### Added

- **`create_upload_link` now returns `embed_markdown` in deterministic mode.** When a `filename` is passed, the response includes a ready-to-paste wikilink embed for the resolved `dest_path`, identical to what the upload POST returns (full vault-relative path). This closes a footgun where a caller would reconstruct the embed from the folder it *asked for* rather than the folder the file *resolves to* — under `per_note_subfolder`, a file attached to a root-level note lands in `files/` at the vault root, not the caller's intended subfolder, so a guessed `![[Conferences/files/x.png]]` embed breaks while the true `![[files/x.png]]` works. The tool description now also explicitly instructs callers to embed using the returned `embed_markdown`/`dest_path`, never a reconstructed path. Batch links (no `filename`) omit the field, as before.

### Changed

- **Attachment-upload tool descriptions now spell out the path-resolution semantics** so an AI caller can't repeat the broken-embed mistake. `upload_attachment_url`'s description gained the same "the destination is resolved server-side from `target_note`/`subfolder` (under the default `per_note_subfolder` mode `subfolder` sits under the note's *own* folder), so always embed/verify using the returned `path`/`embed_markdown`, never a reconstructed path" guidance that `create_upload_link` already carries. The `target_note` and `subfolder` parameters on both tools also gained inline `.describe()` hints stating that `subfolder` is resolved relative to the note's folder (not an absolute vault path) and that the returned path is authoritative. Description/metadata only — no tool-shape or behavior change.

## [0.15.1] - 2026-06-01

### Fixed

- **Vendored patch for the `agents` SDK cross-conversation response bleed (`cloudflare/agents#1632`).** `patch-package` patch (`patches/agents+0.12.3.patch`, `"postinstall": "patch-package"`, `agents` pinned to `0.12.3`) making `StreamableHTTPServerTransport.send()` route result/error responses to the **originating connection** (from `getCurrentAgent().connection`, distinct per concurrent request via the agent ALS scope) instead of the first connection matching the response's request id — falling back to the original scan when the ALS connection isn't the owner (so never worse than upstream). Eliminates the wrong-note response delivery seen when a client multiplexes conversations onto one `mcp-session-id` with colliding request ids (Claude Desktop/iOS). Temporary until upstream lands the fix — see the PR draft and remove then (bump `agents`, delete the patch + postinstall). Compiled-into-bundle and no-regression verified, and behavioral stress-test **PASSED**: 3 concurrent Claude Desktop lanes multiplexed onto one session, ~72 concurrent writes to two shared notes amid a continuous stream of same-session `id:1` collisions, **zero cross of any kind** (and the `if_match` guard caught all write contention cleanly).

## [0.15.0] - 2026-05-31

### Added

- **Optional `if_match` precondition on all write tools — fixes silent last-write-wins clobbering between concurrent editors.** `replace_note`, `replace_body`, `patch_note`, and `patch_frontmatter` now accept an optional `if_match` (an etag). When supplied, the write is committed via an R2 conditional put (`onlyIf: { etagMatches }`) and **fails with `reason='precondition_failed'` — writing nothing — if the note changed since that etag**, instead of silently overwriting a concurrent edit. Omitting `if_match` preserves the prior unconditional last-write-wins behavior (backward compatible). To support the read→edit flow, **`read_note` and `parse_frontmatter` now return the note's current `etag`** in their JSON block; a caller passes that etag back as `if_match`. The guard is atomic (R2 evaluates the condition at write time), closing the read-modify-write TOCTOU window — this is the "TOCTOU on create/update/append" the DO error review flagged as architectural obs #2, no longer dormant once concurrent conversations (e.g. one MCP client multiplexing chats) became routine. `create_note`'s create-vs-create race is unchanged (separate, narrower `exists` case). Confirmed via live multi-session testing; the workers-pool R2 (`workerd`) honors `onlyIf` on `put`.
- **Read-only connection diagnostic + standing collision canary for the `read_note` cross-request payload-bleed.** `ObsidianMCP.onConnect` emits a `mcp_request_id_collision` WARN whenever an incoming JSON-RPC request id is already in flight on another connection of the same session — **always on**, since that case is rare and high-signal (a standing canary for the cross-conversation bleed trigger recurring). The verbose per-POST `mcp_post_connect` debug trace (`{sessionId, connectionId, requestIds}`) is **gated behind the `CONNECTION_DIAGNOSTICS` var (default `"false"`)** to avoid one debug line per tool call; set it `"true"` and redeploy (or via `.dev.vars` locally) to study client session/request-id behavior. The collision is the precise trigger for the bleed, whose root cause is the `agents` SDK streamable-HTTP transport (`StreamableHTTPServerTransport.send()` routes responses by first-match on request id — verified unchanged through `agents@0.13.3`, so not fixable by an upgrade and not a defect in this repo's `read_note`, a clean R2 pass-through). Wrapped so a failure can never break a connection; always delegates to the SDK handler. The trigger was confirmed live (Claude Desktop multiplexes conversations onto one session with colliding ids; Claude Code uses unique ids and is unaffected). Filed upstream: `cloudflare/agents#1632` (transport) + a client-side report to Anthropic. See `AIHandoff/bug-read-note-cross-request-payload-bleed` for the full analysis.

## [0.14.0] - 2026-05-31

### Fixed

- **`move_attachment` is no longer non-atomic — the irreversible byte-delete now runs last.** Previously the tool copied bytes to the new path, **deleted the old object**, and only then rewrote embeds in referring notes — so any failure in the rewrite loop (an R2 read/write error on a referrer) stranded a committed byte-move with notes still pointing at the now-missing path, and the call surfaced an error a retrying caller could double-handle. The byte-delete of `from_path` is now deferred until after the copy *and* every embed rewrite succeed; on any rewrite failure the move rolls back (restores notes already rewritten this call, then undoes the destination copy — restoring prior bytes when `overwrite` clobbered an existing object, else deleting the copy) and returns `reason='embed_rewrite_failed'`, leaving the vault in its pre-move state. R2 has no cross-object transaction, so rollback is best-effort, but a rewrite-step failure can no longer leave a stranded half-move. (Defect B from the embed-rewrite bug note; Defect A — the `findReferrers` LIKE crash — was fixed in 0.13.0.)
- **`move_note` co-move had the same hazard one layer down — fixed.** Its note-commit path was already correct (write new, rewrite referrers, delete source last, with reverse-order rollback), but `comoveAttachments` copied **and deleted** a uniquely-owned attachment's bytes *before* the note commit, and the note-commit rollback never reverted the attachment move. A note-commit failure after a co-move therefore restored the source note pointing at an attachment path whose bytes had already been deleted (broken embed; bytes recoverable at the new path). `comoveAttachments` is now copy-only; the originals are deleted only after the note commit succeeds (irreversible step last, best-effort), and the commit's rollback deletes the new copies — so a failed `move_note` leaves attachments and notes in their pre-move state.

### Changed

- **BREAKING: the daily-note tools are renamed and generalized to all periodic cadences.** `get_or_create_daily_note` → **`periodic_note_get_or_create`** and `append_to_daily_note` → **`periodic_note_append`**, each now taking a required `period` argument (`daily`/`weekly`/`monthly`/`quarterly`/`yearly`). The optional `date` is an anchor (`YYYY-MM-DD`, default today) bucketed into the week/month/quarter/year containing it. The old tool names are removed — update any saved chats/automations, and reconnect clients to refresh the tool registry (see the README cache gotcha).
- **`read_note` always emits a second JSON metadata block.** It was `{permalink}` only when `PERMALINK_BASE_URL` was set; it is now `{permalink?, frontmatter}` and always present. `frontmatter` is the parsed YAML object (empty `{}` if none); `permalink` stays conditional. The raw body in `content[0]` is unchanged, so clients reading only `content[0]` are unaffected.

### Added

- **`patch_frontmatter` tool** — set and/or unset top-level YAML frontmatter fields without rewriting the file. Edits are line-level, so untouched fields, key order, and comments are preserved byte-for-byte. The note's `id:` is immutable (naming it in `set`/`unset` fails with `reason='id_immutable'`) and is ensured on write, so this can never clip the resolver-critical id the way a careless `patch_note` could. Values are scalars or inline scalar arrays; a key holding a multi-line/block-style value is refused (`reason='unsupported_block_value'`, with the offending `key`) rather than corrupted. Returns `{path, etag, id, permalink, changed_keys, removed_keys}`.
- **Weekly / monthly / quarterly / yearly periodic notes**, configured by four new opt-in env vars (`WEEKLY_/MONTHLY_/QUARTERLY_/YEARLY_NOTE_PATH_TEMPLATE`). New path tokens: `{{Q}}` (quarter), `{{WW}}` (ISO-8601 week, Monday-start), `{{GGGG}}` (ISO week-year — differs from `{{YYYY}}` near year boundaries, pair it with `{{WW}}`). A cadence with no template returns `reason='period_not_configured'`.
- **Note-write tools now return the resulting `id`.** `create_note`, `replace_note`, `replace_body`, and `patch_note` include `id` in their JSON result. `create_note`'s description now states the id is auto-minted when the content omits one (callers should not pre-generate one) and a caller-supplied id is honored verbatim.

## [0.13.0] - 2026-05-30

### Added

- **`ATTACHMENT_FETCH_HOST_ALLOWLIST` accepts `*` to allow any host.** The server-side URL-fetch tool (`upload_attachment_url`) stays default-closed (empty ⇒ no host fetchable), but an operator can now set the allowlist to the single value `*` to opt into fetching from arbitrary public links. It is not a glob (no `*.example.com` per-label matching) — `*` is the one literal meaning "allow all". The SSRF denylist still takes precedence (HTTPS-only; no IP-literal / loopback / `*.local` / `*.internal`; re-checked on every redirect hop), so even with `*` those hosts are rejected with `disallowed_host`.

### Fixed

- **`move_attachment` no longer fails (and partially-commits) when renaming a file with a long name.** The embed-rewrite lookup (`findReferrers`) built a `target LIKE '%/'||basename` pattern to catch partial-path embeds (`![[folder/name.ext]]`). Durable Object SQLite caps a `LIKE`/`GLOB` pattern at **50 bytes** ([docs](https://developers.cloudflare.com/durable-objects/platform/limits/)) — far below stock SQLite's 50,000 — so a basename of ~49+ bytes pushed the pattern over the limit and SQLite threw `LIKE or GLOB pattern too complex: SQLITE_ERROR`. Because the R2 byte-move had already committed by then, the call surfaced a generic error for an operation that had partially succeeded. The lookup now uses an indexed `target_tail` column (the link's last `/`-delimited segment) matched by equality — exactly equivalent to the old suffix match, with no pattern and therefore no length ceiling. `init()` adds and backfills `target_tail` in place on existing Durable Objects; the index is also recoverable from R2 via `ensureFresh()`.
- **`search_notes` returns a typed error instead of a raw `SQLITE_ERROR` for over-long queries.** The same 50-byte `LIKE` limit applies to search (its pattern is `%query%`), so a query longer than ≈48 bytes previously threw `unexpected_error` / "pattern too complex". It now returns `reason='query_too_long'` with the byte limit, before touching the index. (The latent bug existed for any long search query, not just `move_attachment`.)

### Documentation

- Added `ROADMAP.md` documenting two deferred ways to lift the `search_notes` length cap (FTS5; coarse-LIKE-prefix + in-app substring filter) with tradeoffs, and the settled architecture for a future "Obsidian R2 Freshness Trigger" push-to-sync plugin.
- README "Indexed reads" section now documents the 50-byte `LIKE` limit and how `findReferrers`/`search_notes` each handle it.

## [0.12.2] - 2026-05-30

### Fixed

- **Upload page file picker no longer blocks allowed file types on mobile.** The `GET /upload` file input had a hardcoded `accept="image/*,application/pdf"`; mobile browsers enforce `accept` strictly, so allowed-but-unlisted types (e.g. `.pptx`, `.docx`, `.xlsx`) were greyed out in the picker even though the server accepts them. The `accept` hint is now derived from the server's effective `ATTACHMENT_ALLOWED_EXTENSIONS` allowlist (emitting both the dotted extension and the MIME type, so Android Chrome and iOS Safari both match), and the `csv-or-default` allowlist resolution is centralized (`resolveAttachmentAllowlist`) across the upload handler, embed co-move, and the picker so the three can't drift apart again.

## [0.12.1] - 2026-05-30

### Security

- **Bumped transitive `qs` to 6.15.2** (lockfile only) to clear GHSA-affected `qs` 6.11.1–6.15.1 (remotely triggerable DoS via `qs.stringify` on null/undefined entries in comma-format arrays). Pulled in via `@modelcontextprotocol/sdk` → `express`; not exercised by the deployed Worker (which uses its own routing, not express's query parser), but flagged by Dependabot. Patch-level, no API change.
- **`scripts/setup.mjs` no longer logs the configured KV namespace id.** A KV namespace id is a non-secret resource identifier (not a credential), but setup output can land in terminal scrollback / CI logs. The already-configured "from .env" line no longer echoes the id at all (it's already in `.env`); the freshly-created line shows a partial id (`first 8…last 4`) to confirm what was made. Clears the `js/clear-text-logging` code-scanning alert at the source rather than relying on a dismissal.
- **Dev-tooling bump** (`@cloudflare/vitest-pool-workers` → 0.16.10, dedupes `wrangler` to 4.95.0) to clear the transitive `ws` uninitialized-memory-disclosure advisory (GHSA-58qx-3vcg-4xpx). Dev/test/deploy tooling only — not bundled into the deployed Worker. `npm audit` now reports 0 vulnerabilities.

## [0.12.0] - 2026-05-27

### Security

- **Consent page XSS fixed.** `src/auth/consent-page.ts` now HTML-escapes all interpolated values (`clientName`, `error`, `oauthReqInfo`). The consent/error responses are served with a strict `Content-Security-Policy` (`default-src 'none'`, `base-uri 'none'`, inline style only, scripts limited to Cloudflare's auto-injected analytics beacon, no `form-action` so the OAuth redirect isn't blocked), `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- **HTTPS enforced** on `/authorize`, `/upload`, and `/health` (plaintext HTTP → 308 redirect to HTTPS). Pair with the zone's "Always Use HTTPS" for `/mcp` and `/token` coverage.
- **Brute-force throttle on `/authorize`.** A KV-backed per-IP failed-attempt counter (`src/auth/rate-limit.ts`) returns HTTP 429 after 10 failures within a 15-minute sliding window. KV is eventually consistent, so a Cloudflare WAF rate-limiting rule on `/authorize` is still recommended for a hard guarantee (documented in README "Security model").
- **Timing-safe password comparison.** `AUTH_PASSWORD` is now compared with `timingSafeEqual` instead of `===`.
- **Minimum secret length (16 chars) enforced.** `npm run secrets:push` refuses to push an `AUTH_PASSWORD`/`UPLOAD_TOKEN` shorter than `MIN_SECRET_LEN` (16), and both handlers fail closed (HTTP 503) if a deployed secret is below the floor. 32+ random chars recommended.
- **`oauthReqInfo` consent blob is now HMAC-signed.** The OAuth consent state round-tripped through the browser is signed (HMAC-SHA256, keyed by `AUTH_PASSWORD`) on GET and verified on POST, so a tampered or unsigned blob is rejected (HTTP 400) before any field inside it (`clientId`, `scope`, `redirectUri`) is trusted.
- **Upload-link signing key is now separated from the bearer token.** The HMAC key for single-use upload links is derived from `UPLOAD_TOKEN` via HKDF-SHA256 (`obsv:upload-link-sign:v1`) instead of using the raw token, so the link-signing key and the bearer secret are no longer the same value. (Outstanding signed links are invalidated on deploy; they are single-use and ≤30-min TTL.)
- **CSRF protection on the consent form.** `/authorize` now uses a double-submit token: every consent render sets an `HttpOnly; Secure; SameSite=Strict` `obsv_csrf` cookie and embeds the same value as a hidden field; POST rejects (HTTP 403) any request whose form field doesn't match the cookie. A forged cross-site POST can neither read nor send the cookie.

### Fixed

- `patch_note` now rejects an empty `old_str` (`empty_old_str`) instead of treating `body.split("")` as a match between every character and rewriting the entire note.

## [0.11.0] - 2026-05-26

### Changed

- **BREAKING (`upload_attachment_url`):** the server-side URL-fetch path is now **default-closed**. A new `ATTACHMENT_FETCH_HOST_ALLOWLIST` wrangler var (CSV of hostnames) gates which hosts may be fetched; **when it is empty/unset the tool fetches from no host and returns `host_not_allowed`**. Previously any public HTTPS host (passing the SSRF denylist) was fetchable. The allowlist is re-checked on every redirect hop, and the SSRF denylist still takes precedence (IP-literal/loopback → `disallowed_host`). This is the critical guardrail for the planned cross-server attachment transfer (ROADMAP §9) — without it a prompt injection could redirect the server-side fetch to an attacker host. **To keep `upload_attachment_url` working after upgrade, set `ATTACHMENT_FETCH_HOST_ALLOWLIST` in `.env` and rerun `npm run setup`** (it flows through `.env` → `wrangler.jsonc`, unlike the other baked-in `ATTACHMENT_*` vars).
- `upload_attachment_url` failures are now documented as terminal (nothing is written to the vault on any error) so orchestrating callers don't assume a transfer succeeded; the tool description enumerates `host_not_allowed` and clarifies `disallowed_extension` carries the allowed list.

### Added

- `GET /health` — unauthenticated liveness/version probe returning `{ok, service, version}`. Served from the main Worker (the OAuth default handler), so it reflects the deployed version immediately, independent of the Durable Object's tool-registry cache. Useful for `curl` deploy checks and uptime monitoring; mirrors the companion `mstodo-mcp-cloudflare` endpoint.
- Attachment extension allowlist broadened to include `docx,xlsx,pptx,zip,txt` by default (`ATTACHMENT_ALLOWED_EXTENSIONS` in `wrangler.example.jsonc`); added a `zip` ↔ `application/zip` MIME mapping. Lets the URL-fetch and upload paths accept Office documents, zips, and plain text.
- The reported MCP server version is now read from `package.json` (via `src/version.ts`) instead of a hardcoded literal, so it can never drift from the released version. Bumping `package.json` is also what prompts Claude.ai clients to reload the tool registry.
- `npm run secrets:push` (`scripts/push-secrets.sh`) — pushes production Workers secrets to Cloudflare from a gitignored `.secrets.env`, resolving 1Password `op://` references via the `op` CLI and piping each value over stdin to `wrangler secret put` (no secret in argv/scrollback). Optional `OP_ACCOUNT` (env var or a line in `.secrets.env`) disambiguates which 1Password account owns the referenced vault. `.secrets.env` is separate from `.dev.vars`, which keeps throwaway local-dev literals for `wrangler dev`. New `.secrets.env.example` documents the shape; `DEPLOYMENT.md` covers the flow alongside the manual `wrangler secret put` steps.

## [0.10.0] - 2026-05-24

### Fixed

- `move_attachment` no longer silently skips the embed rewrite when a file is moved *into* a subtree of the referring note's own folder. The new target was being shortened (via `relativeForEmbed`) onto the existing embed text, so the `oldForm === newRel` no-op guard fired and the note was left pointing at the now-empty source path (e.g. moving `files/x.jpeg` → `Knowledge/Humor/files/x.jpeg` for a note in `Knowledge/Humor/`). On that collision the rewrite now falls back to the full vault path. This was the asymmetry behind "move there, move back" only updating the link the first time.

### Added

- `move_attachment` response now includes `referrers_unchanged: string[]` — notes that reference the moved file by bare filename (`![[name.ext]]`) and were intentionally left untouched (Obsidian resolves bare-filename links by name regardless of folder, so they self-heal on move). Previously these referrers were found but neither rewritten nor reported, so `notes_modified` undercounted what pointed at the file. Same-basename embeds that actually point at a *different* file (e.g. `![[Other/name.ext]]`) are correctly excluded.

## [0.9.0] - 2026-05-23

### Added — direct upload endpoint (large files / mobile photos)

- Authenticated HTTP upload path so users can get real photos into the vault, which MCP tool calls can't carry (tool-call payloads are capped by the client, and a user-uploaded image only reaches the model as vision, not reproducible bytes):
  - `POST /upload` (multipart) and a self-served `GET /upload` web page, on the Worker's public handler. Authenticated by an `Authorization: Bearer <UPLOAD_TOKEN>` (bookmarked page / iOS Shortcut) or a short-lived single-use `?t=` link token.
  - `create_upload_link` MCP tool — mints a tappable, expiring, single-use link (HMAC-signed, jti tracked in `OAUTH_KV`, consumed on first success) that Claude presents in chat. The `GET /upload` page verifies the signed link server-side and shows the destination the file will land at (hiding the folder fields, since the link fixes placement); a spent/expired link renders a "no longer usable" notice. A failed upload does not consume the link, so it can be retried. Two modes: a deterministic single-file link (`filename` → baked exact `dest_path` Claude can poll) and a batch link (the page accepts up to `max_files`). The response includes `landing_dir` (the folder uploads land in) so a batch upload is found via `list_attachments` scoped to that prefix rather than a whole-vault scan.
  - `move_attachment(from_path, to_path, overwrite?, update_embeds?)` MCP tool — server-side R2 move/rename (no bytes through the model) so a file uploaded to a guess/holding location can be relocated once the destination note is known. Allowlist-guarded. By default rewrites the embed in every note that referenced the old path (via the wikilink index) so links follow across one or many notes; `update_embeds: false` moves bytes only.
  - Server-side magic-byte content sniffing: corrects mislabeled files (a JPEG named `.png` → `.jpg`) and rejects a non-image masquerading as an image extension (`content_mismatch`). Folds in the earlier extension/MIME sanity-check idea.
  - Security: multipart-only (CSRF), never cookie auth; allowlist + `ATTACHMENT_MAX_BYTES` enforced; one-time links can't be replayed.
- New secret `UPLOAD_TOKEN` (bearer + link-signing key; unset disables the endpoint) and wrangler var `SERVICE_BASE_URL` (this Worker's origin; defaults to `https://${MCP_HOSTNAME}`).
- No inline-base64 upload tool is provided: a tool call carries its arguments as the model's output tokens, so a base64 payload beyond a few KB exhausts the output budget and truncates mid-stream. Binary uploads go through `create_upload_link` (user taps a link) or `upload_attachment_url` (server fetch).

### Added — attachment support

- Six new tools expose the vault's binary files (images, PDFs, configurable types) that Remotely Save already syncs into R2:
  - `upload_attachment_url` — fetch an HTTPS asset server-side, SSRF-guarded (HTTPS only, no IP-literal/loopback hosts, re-validated across redirects), size-capped, HTML rejected.
  - `read_attachment` — returns an MCP `image` content block for images, base64-in-JSON for other types.
  - `head_attachment` — metadata only (size/type/etag/uploaded) to check size before reading.
  - `list_attachments` — paginated listing of non-`.md` objects, optional `prefix` scope.
  - `delete_attachment` — idempotent; allowlist-guarded so it can't remove a note.
- New wrangler vars with safe defaults: `ATTACHMENTS_PATH_MODE`, `ATTACHMENTS_SUBFOLDER`, `ATTACHMENT_ALLOWED_EXTENSIONS`, `ATTACHMENT_MAX_BYTES`, `ATTACHMENTS_MOVE_WITH_NOTE`, `ATTACHMENT_URL_TIMEOUT_MS`.
- `R2Client` gains binary methods (`putBinary`, `getBinary`, `headBinary`, `listBinaries`) and an `ObjectExistsError` for non-clobber writes; the text `get`/`put`/`delete` stay `.md`-only.
- Pure helper module `src/vault/attachments.ts` (MIME/extension tables, filename sanitization, path-policy resolution, embed-markdown construction, SSRF host check) and tool module `src/mcp/tools/attachments.ts`.

### Changed

- `move_note` now optionally co-moves attachments uniquely embedded by the moving note (controlled by `ATTACHMENTS_MOVE_WITH_NOTE`, default `unique_refs`), rewriting embeds only when their relative form changes. Its response gains an `attachments_moved` array. Behavior is unchanged when a note embeds no allowlisted attachments.

### Documentation

- README now links to the [announcement blog post](https://dszp.dev/2026/05/23/two-workers-for-obsidian-and-claude-ai/) covering the motivation and design of both Workers.
- New "Attachments" section in README documenting the tools, path modes, config vars, co-move behavior, and the URL-fetch security model.

## [0.8.0] - 2026-05-23

First public release. Everything that was previously per-instance configuration is now `.env`-driven so anyone can deploy this without editing the codebase.

### Added

- `${PLACEHOLDER}`-driven configuration. `wrangler.example.jsonc` + `.env.example` are the committed templates; `wrangler.jsonc` and `.env` are generated locally by `npm run setup` and gitignored. Lets the same codebase deploy to anyone's Cloudflare account.
- `scripts/setup.mjs` — zero-dependency Node script that reads `.env`, idempotently creates the R2 bucket and `OAUTH_KV` KV namespace, captures the KV id back into `.env`, and substitutes placeholders into `wrangler.jsonc`. All wrangler shell-outs go through `execFileSync` (no shell interpolation) so values from `.env` can't become command injection.
- `npm run setup` and `npm run deploy:fresh` package scripts.
- `DEPLOYMENT.md` rewritten to combine first-time third-party setup with ongoing operations in a single doc.
- `LICENSE` (MIT) and author attribution in `package.json` and `README.md`.

### Changed

- README sanitized for public consumption — no per-instance hostnames, account ids, bucket names, or KV ids baked into prose. Architecture diagrams and tool descriptions use placeholders instead.
- CLAUDE.md sanitized similarly; kept the architectural context and gotchas, dropped per-installation specifics and personal git-signing notes.

### Removed

- `SETUP-NEW-USER.md` — merged into `DEPLOYMENT.md`.

## [0.7.0] - 2026-05-17

### Added — permalink generation

- New `PERMALINK_BASE_URL` wrangler var. When set, every note-returning tool produces a short HTTP permalink that 302-redirects into Obsidian via the sibling [`obsidian-link-resolver`](https://github.com/dszp/obsidian-link-resolver-cloudflare) Worker. Empty/unset disables the feature (all permalink fields become `null`, `generate_permalink` returns `reason='permalink_disabled'`). Per-vault scoping is by deploy — point a second MCP at its own `PERMALINK_BASE_URL`.
- `buildPermalink(baseUrl, path, id)` helper in `src/vault/markdown.ts`. Strategy:
  - id present → `${BASE}/n/<encoded id>?f=<encoded basename-no-ext>`. The `?f=` slug is decorative — the resolver ignores it and routes purely by id via Advanced URI's `uid=` lookup. Survives renames.
  - id null/empty → `${BASE}/p/?path=<encoded full path>` fallback. Works today but breaks on rename; backfill an id to upgrade.
- New `generate_permalink(path)` tool. Returns `{path, permalink, kind: 'id' | 'path'}`. `kind` lets the caller know whether the link is rename-stable. Soft-fails with `permalink_disabled` if base URL unset, `not_found` if the note doesn't exist.

### Changed — response shapes (0.7.0 is the first response-shape change since the initial release)

- `read_note` now returns **two** text content blocks when permalink is enabled: block 1 is the raw markdown body (unchanged), block 2 is JSON `{permalink}`. When `PERMALINK_BASE_URL` is unset, only the first block is emitted — pre-0.7.0 clients that read `content[0].text` continue to work either way.
- `create_note`, `replace_note`, `replace_body`, and `patch_note` now return JSON `{path, etag, permalink, ...}` instead of a plain text acknowledgement string. This is a documented shape change called out in each tool's description string. `permalink` is `null` when the feature is disabled.
- `parse_frontmatter` now returns JSON `{frontmatter, permalink}` instead of the raw frontmatter object. Same `null` semantics when disabled.

### Migration note

If you parse the previous ack strings (`"created Knowledge/foo.md"`, etc.) from the write tools, switch to JSON parsing. Failing closed when the response isn't the expected shape lets you survive future additions to the JSON.

## [0.6.1] - 2026-05-17

### Fixed

- `patch_note` now writes `new_str` literally even when it contains `$` metacharacters (`` $` ``, `$'`, `$&`, `$$`, `$n`). The single-replace branch previously routed through `String.prototype.replace(string, string)`, whose replacement-string semantics treat those sequences specially. A `new_str` containing `` $` `` (e.g. a regex literal followed by a backtick in a markdown code span) would splice the entire pre-match content of the file into the result. Fix: both branches now use `parts.join(args.new_str)`, which concatenates literally and has no substitution layer. Two regression tests pin all five metacharacters in both single and `replace_all` modes.

## [0.6.0] - 2026-05-17

### Added — stable note ids

- Every note created or replaced through the MCP now gets a stable `id:` field in its frontmatter (21-char nanoid in the URL-safe alphabet, regex `^[A-Za-z0-9_-]{21}$`). Ids are minted in `src/vault/markdown.ts::generateNoteId()` via `nanoid/customAlphabet`. Designed to pair with a separate HTTP resolver Worker that emits stable `obsidian://advanced-uri?uid=<id>` deep links — so external systems reference notes by id rather than by path, surviving renames.
- `ensureIdInFrontmatter(src, mintId)` and `extractIdFromFrontmatter(src)` in `src/vault/markdown.ts`. The ensure helper is byte-preserving: it injects `id: <newId>\n` right after the opening `---` fence if frontmatter exists, prepends a minimal block if not, and leaves source untouched when an `id` is already present. Field ordering and YAML formatting around other keys are preserved (no gray-matter round-trip).
- `setIdInFrontmatter(src, id)` — force-set variant used by `replace_note` to lock in the existing id regardless of what the caller submits. Makes id-stripping or id-rewriting impossible through `replace_note`.
- `backfill_ids` MCP tool (`src/mcp/tools/admin.ts::backfillIds`) — scans the vault and mints ids for notes that lack one. Default is `dryRun: true`. Supports `prefix` for folder-scoped runs and `limit` to cap inspection size. Reports counts, up to 10 example writes, and up to 20 malformed-frontmatter paths for follow-up. Idempotent and safe to re-run.

### Changed — id preservation across edits

- `create_note` now injects an id into the new note's frontmatter (or accepts a caller-supplied id and leaves bytes untouched if present).
- `replace_note` **preserves** the existing note's id even if the caller's content omits or changes it. External links keyed on the id stay stable across full-content rewrites. New error reason `malformed_frontmatter` fires when the **supplied** content has an unterminated `---` opener. A malformed existing note is salvaged: id extraction silently falls back to minting a fresh id rather than erroring, since `replace_note` is by definition rewriting the file.
- `get_or_create_daily_note` mints an id into the new daily note's frontmatter (previously the daily note was created with no frontmatter at all).

### Dependencies

- Added `nanoid@^5`.

## [0.5.0] - 2026-05-13

### Added — move_note (v0.5)

- `move_note(from_path, to_path)` MCP tool — moves or renames a note and rewrites every wikilink across the vault that pointed to the old path. Preserves aliases (`[[old|Display]]`), heading anchors (`[[old#Section]]`), block references (`[[old#^abc123]]`), embed markers (`![[old]]`), and full-path forms (`[[Folder/old]]`). Wikilinks inside fenced code blocks and inline code spans are not rewritten — they are treated as verbatim text. Returns `{ moved, from, to, links_updated, notes_modified }` on success. Failure reasons: `not_found`, `exists`, `same_path`.
- `rewriteWikilinksForMove()` in `src/vault/markdown.ts` — offset-based wikilink rewriter that masks out fenced/inline code regions before substitution, so surrounding whitespace and link spacing stay untouched.
- `VaultIndex.findReferrersFor(fromPath)` plus `Store.findReferrers(...)` — queries the `vault_wikilinks` index for candidate referring notes via a single SQL query (target equality against the basename, full path, or path-with-`.md`, plus a `LIKE '%/{basename}'` clause to catch path-suffix references). The move tool runs the precise per-file rewriter on each candidate to do the final resolution check; the index serves as a fast pre-filter so the move skips the rest of the vault entirely.

### Changed — move_note (v0.5)

- `move_note` commits with best-effort atomicity: writes the destination first, then each referrer rewrite, then deletes the source. On any failure, every successful write is reverted in reverse order. R2 has no transactional API, so a crash mid-rollback can still leave partial state — a future iteration could add conditional writes (`onlyIf: { etagMatches }`) once the latent concurrent-write race is also addressed.
- `McpServer` version bumped to `0.5.0`.

### Added — replace_note / replace_body split (v0.4)

- `replace_body(path, body)` MCP tool — replaces the body of a note while preserving the existing frontmatter byte-for-byte. Implementation is string-level boundary detection only (no YAML parse-and-reserialize) so nested mappings, quoted colons, Templater expressions, and CRLF line endings round-trip untouched. New failure reason `malformed_frontmatter` when the opening `---` has no closing fence — callers should escalate to `read_note` + `replace_note` rather than guess where the boundary is.
- `splitFrontmatterRaw()` in `src/vault/markdown.ts` — the boundary detector. Returns the raw frontmatter bytes (including the opening, the YAML, the closing fence, and the trailing newline) or `null` when no frontmatter exists; throws `MalformedFrontmatterError` otherwise.
- `replace_note(path, content)` MCP tool — the named full-overwrite operation (same behavior as the removed `update_note`). Tool description steers callers toward `replace_body` for body-only edits and `patch_note` for surgical edits.

### Removed — replace_note / replace_body split (v0.4)

- `update_note(path, content)` MCP tool. **Breaking change.** Replaced by the explicit `replace_note` + `replace_body` pair. Rationale: AI consumers don't surface ergonomic friction the way humans do — a tool that silently wipes frontmatter when the caller meant "edit the body" is the wrong default. Encoding the safe path at the tool-selection layer (named operations) is more reliable than encoding it in description text.

### Changed — replace_note / replace_body split (v0.4)

- `McpServer` version bumped to `0.4.0` to reflect the removed tool. MCP clients do not negotiate against this field; the user-visible effect is a one-time tool-list refresh (force-quit Claude Code, etc.).

### Added — DO-SQLite vault index (v0.3)

- `src/vault/index-store.ts` — `VaultIndex` + `Store` interface + `SqlStore` implementation. The index is persisted in the Durable Object's SQLite storage (tables `vault_notes`, `vault_tags`, `vault_wikilinks`, all prefixed `vault_` to avoid collision with the `agents` SDK's `cf_agents_*` internal tables).
- `VaultIndex.ensureFresh()` syncs the index with R2 by comparing etags: one R2 LIST plus fetches only for changed bodies. Called before every indexed read so external changes (e.g. Remotely Save syncing in new notes from Obsidian) get picked up without manual invalidation.
- Write-through index updates: every successful `create_note` / `update_note` / `patch_note` / `delete_note` / `append_to_daily_note` / new-day `get_or_create_daily_note` updates the index inline using the etag returned from `R2.put`, so the index never lags writes that go through this Worker.
- `escapeLikePattern()` escapes SQL `LIKE` meta-characters (`%`, `_`, `\`) and the queries use `ESCAPE '\\'` so substring searches behave the same as plain `String.includes` — a query of `_drafts` or `100%` no longer silently widens via SQL wildcards.
- `test/index-store.test.ts` — `VaultIndex` integration tests against an in-memory `Store` with a real `R2Client`, covering seeding, no-op sync, externally-added/changed/deleted notes, search, tags, backlinks, and write-through paths.
- `test/sql-store.test.ts` — `SqlStore` tested against a fake SQLite emulator that implements the LIKE-with-ESCAPE semantics exactly. Catches regressions where `%` or `_` in a search query would otherwise be treated as wildcards.
- `R2Client.put` now returns the resulting etag (was `void`). Required so write-through updates can index against the right version.
- `R2Client.listMarkdownWithMeta()` returns `{ path, etag }[]` for the diff in `ensureFresh()`. `listMarkdown()` is preserved as a convenience that returns paths only.

### Changed — DO-SQLite vault index (v0.3)

- **`search_notes`, `list_tags`, `list_backlinks` now read from the SQLite index** instead of scanning R2 on every call. Steady-state cost is one R2 LIST + one SQL query (single-digit milliseconds) rather than `O(N)` R2 GETs. Cold-DO first call still seeds the full index (`O(N)` R2 GETs) — same total work as before, just amortized differently.
- `src/vault/search.ts` deleted — `VaultIndex.search()` is the implementation.
- `src/mcp/tools/metadata.ts` no longer exports `listTags`/`listBacklinks` (moved into `VaultIndex`); `parseFrontmatter` remains as it's a single-note operation that doesn't benefit from indexing.
- `McpServer` version bumped to `0.3.0` to reflect the new index-backed read path and the additional `etag`/`content` fields in write-tool success values.

### Added — error-rate / observability (v0.2)

- `patch_note(path, old_str, new_str, replace_all?)` MCP tool — targeted in-place edit modeled on the Anthropic file-editor `str_replace` contract. `old_str` must be unique in the note unless `replace_all: true` is passed; missing anchor fails closed with `reason: "anchor_not_found"`. Avoids retransmitting full note bodies for small edits and gives implicit concurrent-edit detection via anchor presence.
- `src/vault/concurrency.ts` — `mapPool(items, limit, fn)` helper for bounded-parallel R2 fan-out.
- `src/log.ts` — structured JSON logging helper (`log.debug/info/warn/error`) that surfaces in Workers Logs as queryable events.
- Tool **descriptions** on every `this.server.tool(...)` registration. MCP clients (especially LLM-driven ones) now see human-readable guidance for each tool — including the explicit warning that `update_note` is a destructive full-content replace.
- Per-tool instrumentation in `src/mcp/agent.ts`: every invocation emits `{event: "tool", name, durationMs, ok}`. Unexpected handler exceptions are caught, logged as `tool_unexpected`, and returned as `isError: true` so they no longer escape as DO RPC errors.
- Structured logs in `src/auth/handler.ts` for every non-2xx return path (`non_oauth_path`, `auth_form_invalid`, `auth_failed`, `auth_method_not_allowed`) with appropriate log levels so probe traffic stops inflating the dashboard "Errors" metric.
- Structured log on path-validation rejection in `R2Client.toKey` (`invalid_path_rejected`).
- Structured log of vault list duration (`vault_list`).
- `test/concurrency.test.ts` covering `mapPool` ordering, concurrency cap, and the empty-input edge case.

### Changed — error-rate / observability (v0.2)

- **Search, list_tags, list_backlinks now fan out R2 reads via `mapPool`** with concurrency 25 instead of sequential `await` per note. Eliminates the dominant source of P99 tail latency and `client_disconnected` errors on Durable Object metrics. (Largely superseded by the v0.3 index for these specific tools, but the helper is still used during initial seed and elsewhere.)
- **Tool functions return typed `ToolResult<T>` instead of throwing on expected failures.** Affects `readNote`, `createNote`, `updateNote`, `patchNote`, `parseFrontmatter`. Each "expected" failure (missing note, anchor not found, etc.) now returns `{ ok: false, reason, ...context }` and is surfaced to the MCP client as `isError: true` — no longer counted as a Durable Object RPC error. New reason codes: `not_found`, `exists`, `anchor_not_found`, `ambiguous`, `no_op`.
- `read_note` now returns a textual reason on miss instead of an empty string, so the calling LLM can react.
- Pinned `account_id` in `wrangler.jsonc` to a specific account. Removes the interactive account-picker on `wrangler deploy`. (Superseded in [Unreleased] by `.env`-driven configuration.)
- Bumped `wrangler` devDependency to `^4.90.1`.

### Documentation

- README gotchas: documented the post-deploy "tool list is stale" problem at two layers — Durable Object instances continue serving pre-deploy code until they hibernate, and Claude Code's local tool registry is built at app launch and isn't refreshed by `/mcp` reconnect. Each layer has its own resolution; both must be cleared for a newly-added tool to be invokable.
- README gotchas: added a note about TOCTOU race on `create_note`/`update_note`/`append_to_daily_note` — currently dormant in single-user use, but a known limitation tracked for a future fix using R2 conditional writes.

## [0.1.0] - 2026-05-11

Initial release.

### Added

- Cloudflare Worker scaffold (`wrangler.jsonc`, `tsconfig.json`, `package.json`, `.gitignore`).
- R2 bucket binding (`VAULT`) for direct vault access without S3 round-trips.
- KV namespace (`OAUTH_KV`) for OAuth state.
- Durable Object class `ObsidianMCP` (binding `MCP_OBJECT`, SQLite storage) for stateful MCP sessions.
- `R2Client` wrapper (`src/vault/r2-client.ts`) with prefix-aware key normalization and path-traversal validation.
- Markdown parsing utilities (`src/vault/markdown.ts`): `parseNote`, `extractTags`, `extractWikilinks`. Tags merge frontmatter + inline `#tags` (nested-tag aware); wikilinks ignore code fences.
- Linear content search with snippets (`src/vault/search.ts`).
- Eleven MCP tools registered on `ObsidianMCP`:
  - `list_notes`, `read_note`, `search_notes`, `create_note`, `update_note`, `delete_note`
  - `parse_frontmatter`, `list_tags`, `list_backlinks`
  - `get_or_create_daily_note`, `append_to_daily_note`
- OAuth consent flow (`src/auth/`): password-gated `/authorize` page using `@cloudflare/workers-oauth-provider`.
- `OAuthProvider` wiring in `src/index.ts` with `/mcp`, `/authorize`, `/token`, `/register` endpoints (Dynamic Client Registration enabled so Claude.ai can self-register).
- Custom domain route (`custom_domain: true`).
- Vitest test suite: 25 tests across `r2-client`, `markdown`, `search`, and `tools` modules.
- `test/_test-worker.ts` stub entrypoint used by `vitest-pool-workers` (workaround for MCP SDK / `ajv` module-resolution failure when the project path contains a space).
- README, deployment runbook (`DEPLOYMENT.md`), new-user setup guide (`SETUP-NEW-USER.md`), and this changelog.

### Configuration

- `VAULT_PREFIX = ""` (empty — vault files at bucket root; must match Remotely Save's "Remote Prefix").
- `DAILY_NOTE_PATH_TEMPLATE = "Daily Notes/{{YYYY-MM-DD}}.md"`.
- `compatibility_date = "2026-05-01"`, `compatibility_flags = ["nodejs_compat"]`.
- `AUTH_PASSWORD` stored as a Workers secret (set via `wrangler secret put`).

### Notes

- End-to-end deployment verified: Obsidian (Mac) ↔ Remotely Save ↔ R2 ↔ Worker ↔ Claude.ai. Note creation through Claude.ai was confirmed and the new note synced back to Obsidian on the next Remotely Save interval.
- Documented gotchas encountered during build: `vitest-pool-workers` + space-in-path, `custom_domain` clashes with pre-existing DNS records, 30-minute negative DNS cache after record deletion.

[Unreleased]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.1.0...v0.5.0
[0.1.0]: https://github.com/dszp/obsidian-mcp-cloudflare/releases/tag/v0.1.0
