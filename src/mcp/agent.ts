import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props, ToolResult, VaultConfig } from "../types";
import { buildVaultConfig } from "../config";
import { VERSION } from "../version";
import { R2Client } from "../vault/r2-client";
import { SqlStore, VaultIndex, MAX_LIKE_PATTERN_BYTES, searchPatternBytes } from "../vault/index-store";
import { listNotes, readNote, createNote, replaceNote, replaceBody, deleteNote, patchNote, moveNote } from "./tools/notes";
import { generatePermalink, parseFrontmatter, patchFrontmatter } from "./tools/metadata";
import { getOrCreatePeriodicNote, appendToPeriodicNote } from "./tools/periodic";
import type { Period } from "../vault/periodic";
import { backfillIds } from "./tools/admin";
import {
  deleteAttachment,
  headAttachment,
  listAttachments,
  moveAttachment,
  readAttachment,
  uploadAttachmentUrl,
} from "./tools/attachments";
import { createUploadLink } from "../upload/tokens";
import { type McpContent, type McpResponse, errResponse, instrument } from "./instrument";
import type { Connection, ConnectionContext } from "agents";
import { log } from "../log";
import {
  type ConnLike,
  type JsonRpcId,
  decodeRequestIdsFromHeader,
  findCollidingRequestIds,
} from "./diagnostics";

// SDK-internal headers: the agents streamable-HTTP transport bridges each MCP
// POST to this Durable Object as a WebSocket upgrade carrying the HTTP method
// and the base64 JSON-RPC payload in these headers. Read here only for the
// read-only connection diagnostic in onConnect; if the SDK renames them the
// diagnostic silently no-ops (decodeRequestIdsFromHeader → []) and never affects
// request handling.
const MCP_HTTP_METHOD_HEADER = "cf-mcp-method";
const MCP_MESSAGE_HEADER = "cf-mcp-message";

const NotePath = z.string().min(1).regex(/\.md$/i, "path must end with .md");

// Cadence selector for the periodic-note tools. z.enum needs a literal tuple;
// the assignment below is a compile-time guard that it stays exactly in sync
// with the Period union in src/vault/periodic.ts.
const PeriodEnum = z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]);
// patch_frontmatter accepts scalar or inline-scalar-array values only; nested
// structures are rejected at the schema layer (the line-level editor cannot
// safely round-trip them).
const FmScalar = z.union([z.string(), z.number(), z.boolean()]);
const FmValue = z.union([FmScalar, z.array(FmScalar)]);
type _PeriodEnumExact = [Period] extends [z.infer<typeof PeriodEnum>]
  ? [z.infer<typeof PeriodEnum>] extends [Period]
    ? true
    : never
  : never;
const _periodEnumExact: _PeriodEnumExact = true;
void _periodEnumExact;

// Attachment paths accept any extension (the per-tool extension allowlist gives
// a richer error). This schema mirrors the R2Client.toKey safety check at the
// Zod layer so clients get a clean validation error: no `..`, no leading `/`,
// no backslash, no control characters.
const AttachmentPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^/\\][^\\]*$/, "must be a vault-relative path (no leading / or \\)")
  .refine((p) => !p.includes("..") && !hasControlChar(p), "invalid path");

/** True if the string contains an ASCII control character (0x00-0x1f) or DEL. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function okText(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

function okJson(value: unknown): McpResponse {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fromToolResult<T>(r: ToolResult<T>, render: (value: T) => string): McpResponse {
  if (r.ok) return okText(render(r.value));
  const { ok: _ok, reason, ...rest } = r;
  return errResponse(reason, rest);
}

// Multi-block variant — used by read_note to keep the raw note body as the
// primary text block (preserving the pre-0.7.0 client UX) while still
// surfacing the permalink as a second JSON-typed block when enabled.
function fromToolResultBlocks<T>(
  r: ToolResult<T>,
  render: (value: T) => string[],
): McpResponse {
  if (r.ok) {
    return { content: render(r.value).map((text) => ({ type: "text", text })) };
  }
  const { ok: _ok, reason, ...rest } = r;
  return errResponse(reason, rest);
}

// Mixed-block variant — used by read_attachment, which returns an `image`
// content block for image MIME types (so the client renders the bytes inline)
// followed by a JSON metadata text block. Failures still serialize to a single
// text block via errResponse.
function fromToolResultMixedBlocks<T>(
  r: ToolResult<T>,
  render: (value: T) => McpContent[],
): McpResponse {
  if (r.ok) return { content: render(r.value) };
  const { ok: _ok, reason, ...rest } = r;
  return errResponse(reason, rest);
}

export class ObsidianMCP extends McpAgent<Env, never, Props> {
  server = new McpServer({ name: "obsidian-vault", version: VERSION });
  private _index?: VaultIndex;

  private get vault(): R2Client {
    return new R2Client(this.env.VAULT, this.cfg);
  }

  private get cfg(): VaultConfig {
    return buildVaultConfig(this.env);
  }

  private get index(): VaultIndex {
    if (!this._index) {
      const sqlTag = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) =>
        this.sql(strings, ...values)) as unknown as ConstructorParameters<typeof SqlStore>[0];
      this._index = new VaultIndex(new SqlStore(sqlTag), this.vault);
      this._index.init();
    }
    return this._index;
  }

  // Read-only diagnostic for the read_note cross-request payload-bleed bug
  // (AIHandoff/bug-read-note-cross-request-payload-bleed). The agents SDK
  // streamable-HTTP transport routes each JSON-RPC response to a connection by
  // first-match on request id, which is only safe while ids are unique within
  // the session; two concurrent same-session requests sharing an id can cross
  // streams (one read_note returning another's body). It WARNs
  // (`mcp_request_id_collision`) whenever an incoming id is already in flight on
  // another connection of this session — the exact trigger — always on, since
  // that case is rare and high-signal (a standing canary). The per-POST
  // `mcp_post_connect` debug trace is gated behind CONNECTION_DIAGNOSTICS (default
  // off) to avoid log noise. Wrapped so a diagnostic failure can never break the
  // connection; always delegates to the SDK handler, which processes the request.
  async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    try {
      if (ctx.request.headers.get(MCP_HTTP_METHOD_HEADER) === "POST") {
        const requestIds = decodeRequestIdsFromHeader(
          ctx.request.headers.get(MCP_MESSAGE_HEADER),
        );
        if (requestIds.length > 0) {
          const sessionId = this.getSessionId();
          const open: ConnLike[] = Array.from(
            this.getConnections<{ requestIds?: JsonRpcId[] }>(),
            (c) => ({ id: c.id, state: (c.state as { requestIds?: JsonRpcId[] } | null) ?? null }),
          );
          const colliding = findCollidingRequestIds(requestIds, conn.id, open);
          if (colliding.length > 0) {
            // Always on: the collision WARN is rare (needs a misbehaving client)
            // and high-signal — a standing canary for the cross-conversation
            // response-bleed trigger recurring. Cheap: only emits on collision.
            log.warn("mcp_request_id_collision", {
              sessionId,
              connectionId: conn.id,
              requestIds,
              colliding,
            });
          } else if (this.env.CONNECTION_DIAGNOSTICS === "true") {
            // Per-POST trace — one debug line per tool call, so default-OFF to
            // avoid log noise (it roughly doubles instrument()'s per-call debug).
            // Flip CONNECTION_DIAGNOSTICS=true to study session/request-id behavior.
            log.debug("mcp_post_connect", { sessionId, connectionId: conn.id, requestIds });
          }
        }
      }
    } catch (e) {
      log.warn("mcp_connect_diagnostic_failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return super.onConnect(conn, ctx);
  }

  async init() {
    // Touch the index getter so schema migrations run on every DO wake.
    void this.index;

    this.server.tool(
      "list_notes",
      "List every markdown note in the vault. Returns an array of vault-relative paths.",
      {},
      async () =>
        instrument("list_notes", async () => okJson(await listNotes(this.vault, this.cfg))),
    );

    this.server.tool(
      "read_note",
      "Read the full contents of a single markdown note. The note body is returned as the first text block (raw markdown, including the frontmatter). A second text block always follows containing JSON `{permalink?, etag, frontmatter}` — `frontmatter` is the parsed YAML metadata object (empty `{}` if none), `etag` is the note's current R2 etag (pass it back as `if_match` on a later replace_note/replace_body/patch_note/patch_frontmatter to make that edit conditional — the edit then fails with reason='precondition_failed' instead of silently overwriting a change another writer made in between), and `permalink` (the short HTTP URL that resolves into Obsidian via the link-resolver Worker) is present only when PERMALINK_BASE_URL is configured. Clients that only inspect content[0] still get the raw body unchanged.",
      { path: NotePath },
      async ({ path }) =>
        instrument("read_note", async () =>
          fromToolResultBlocks(await readNote(this.vault, this.cfg, { path }), (v) => [
            v.content,
            JSON.stringify(
              v.permalink
                ? { permalink: v.permalink, etag: v.etag, frontmatter: v.frontmatter }
                : { etag: v.etag, frontmatter: v.frontmatter },
            ),
          ]),
        ),
    );

    this.server.tool(
      "search_notes",
      "Case-insensitive substring search across every note. Matches against either the note body OR the note's file path, so 'kevin' will find both `Notes about Kevin.md` (body match) and `People/Kevin Meeting.md` (filename-only match). Returns matching paths with short snippets around the first body-match position; filename-only matches return a generic body-prefix snippet — the `path` field itself is the signal for why the note matched. Backed by an incrementally-synced DO-SQLite index — typical calls run in single-digit milliseconds. The query must be short (≈48 bytes or fewer, a DO-SQLite LIKE limit); a longer query returns reason='query_too_long' — split it into a shorter distinctive substring.",
      { query: z.string().min(1), limit: z.number().int().positive().max(200).optional() },
      async ({ query, limit }) =>
        instrument("search_notes", async () => {
          // DO-SQLite caps a LIKE pattern at 50 bytes; search wraps the query as
          // `%query%`. Reject over-long queries with a typed error here rather
          // than letting the SQL layer throw a raw SQLITE_ERROR. See ROADMAP.md
          // for the FTS5 / coarse-prefix alternatives that would lift this cap.
          if (searchPatternBytes(query) > MAX_LIKE_PATTERN_BYTES) {
            return errResponse("query_too_long", {
              message: `Search query is too long: its match pattern exceeds Durable Object SQLite's ${MAX_LIKE_PATTERN_BYTES}-byte LIKE limit. Use a shorter substring (about ${MAX_LIKE_PATTERN_BYTES - 2} bytes or fewer).`,
              max_pattern_bytes: MAX_LIKE_PATTERN_BYTES,
            });
          }
          return okJson(await this.index.search(query, limit ?? 50));
        }),
    );

    this.server.tool(
      "create_note",
      "Create a new markdown note. A stable nanoid `id:` is auto-minted into the frontmatter when your content omits one — do NOT pre-generate an id yourself; a caller-supplied `id:` in the content is honored verbatim instead. Returns JSON `{path, etag, id, permalink}` on success (`id` is the minted or supplied id; permalink is null if PERMALINK_BASE_URL is unset). Fails with reason='exists' if a note already exists at this path.",
      { path: NotePath, content: z.string() },
      async (args) =>
        instrument("create_note", async () => {
          const r = await createNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, id: v.id, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "replace_note",
      "Full overwrite of a note — replaces everything including frontmatter, EXCEPT the note's `id:` field, which is always preserved from the existing note (or freshly minted if absent). External links keyed on the id stay stable across full-content rewrites. Returns JSON `{path, etag, permalink}` on success. Use only when authoring the entire file content, including the YAML frontmatter block. For body-only edits that preserve frontmatter, use replace_body. For targeted edits to specific lines, use patch_note. Fails with reason='not_found' if the note does not exist, reason='malformed_frontmatter' if the SUPPLIED content has an unterminated `---` opener (an unterminated frontmatter in the existing note is salvaged — a fresh id is minted on top). Pass optional `if_match` (an etag from read_note/parse_frontmatter or a prior write) to make this conditional — it then fails with reason='precondition_failed' if the note changed since, instead of silently overwriting a concurrent edit.",
      { path: NotePath, content: z.string(), if_match: z.string().optional() },
      async (args) =>
        instrument("replace_note", async () => {
          const r = await replaceNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, id: v.id, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "replace_body",
      "Replaces the body of a note (everything after the closing --- of the frontmatter) while preserving the existing frontmatter exactly. Returns JSON `{path, etag, permalink}` on success. Use when rewriting note content but keeping the note's identity, metadata, tags, and timestamps. For targeted edits to specific lines, prefer patch_note. For full overwrite including frontmatter, use replace_note. Fails with reason='not_found' if the note does not exist, reason='malformed_frontmatter' if the existing frontmatter is unterminated. Pass optional `if_match` (an etag from read_note/parse_frontmatter or a prior write) to make this conditional — it then fails with reason='precondition_failed' if the note changed since, instead of silently overwriting a concurrent edit.",
      { path: NotePath, body: z.string(), if_match: z.string().optional() },
      async (args) =>
        instrument("replace_body", async () => {
          const r = await replaceBody(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, id: v.id, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "patch_note",
      "Replace an anchor string within an existing note while preserving everything else. Returns JSON `{path, etag, count, permalink}` on success. Fails with reason='anchor_not_found' (anchor missing), 'ambiguous' (anchor appears multiple times — pass replace_all=true to replace all), or 'no_op' (old_str equals new_str). Use this for surgical edits. Pass optional `if_match` (an etag from read_note/parse_frontmatter or a prior write) to make this conditional — it then fails with reason='precondition_failed' if the note changed since, instead of silently overwriting a concurrent edit.",
      {
        path: NotePath,
        old_str: z.string().min(1),
        new_str: z.string(),
        replace_all: z.boolean().optional(),
        if_match: z.string().optional(),
      },
      async (args) =>
        instrument("patch_note", async () => {
          const r = await patchNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({
              path: v.path,
              etag: v.etag,
              count: v.count,
              id: v.id,
              permalink: v.permalink,
            }),
          );
        }),
    );

    this.server.tool(
      "move_note",
      "Move or rename a note. Updates all wikilinks across the vault that pointed to the old path, preserving aliases, heading anchors, and block references. Best-effort atomic — the move and link updates apply together, with reverse-order rollback if any step fails (R2 has no transactional API, so a crash mid-rollback can still leave partial state). Wikilinks inside fenced code blocks and inline code spans are not rewritten. Fails with reason='not_found' if from_path doesn't exist, reason='exists' if to_path already exists, reason='same_path' if from_path equals to_path.",
      { from_path: NotePath, to_path: NotePath },
      async (args) =>
        instrument("move_note", async () => {
          const r = await moveNote(this.vault, this.cfg, this.index, args);
          if (r.ok) {
            this.index.delete(r.value.from);
            this.index.upsertFromContent(
              r.value.moved.path,
              r.value.moved.content,
              r.value.moved.etag,
            );
            for (const n of r.value.notes_modified) {
              this.index.upsertFromContent(n.path, n.content, n.etag);
            }
          }
          return fromToolResult(r, (v) =>
            JSON.stringify({
              moved: true,
              from: v.from,
              to: v.to,
              links_updated: v.links_updated,
              notes_modified: v.notes_modified.map((n) => n.path),
              attachments_moved: v.attachments_moved,
            }),
          );
        }),
    );

    this.server.tool(
      "delete_note",
      "Delete a note. Idempotent: succeeds even if the note does not exist.",
      { path: NotePath },
      async (args) =>
        instrument("delete_note", async () => {
          await deleteNote(this.vault, this.cfg, args);
          this.index.delete(args.path);
          return okText(`deleted ${args.path}`);
        }),
    );

    this.server.tool(
      "parse_frontmatter",
      "Return the parsed YAML frontmatter of a note as an object, plus the note's current `etag` and a `permalink` field (the short HTTP URL that resolves into Obsidian, null when PERMALINK_BASE_URL is unset). Response shape: `{frontmatter, etag, permalink}`. Pass `etag` back as `if_match` on a later write to make it conditional (reason='precondition_failed' on a concurrent change). Fails with reason='not_found' if the note does not exist.",
      { path: NotePath },
      async (args) =>
        instrument("parse_frontmatter", async () =>
          fromToolResult(await parseFrontmatter(this.vault, this.cfg, args), (v) =>
            JSON.stringify({ frontmatter: v.frontmatter, etag: v.etag, permalink: v.permalink }),
          ),
        ),
    );

    this.server.tool(
      "patch_frontmatter",
      "Set and/or unset top-level YAML frontmatter fields on a note without rewriting the file. Edits happen at the line level, so untouched fields, key order, and comments are preserved exactly. `set` is an object of field→value (value may be a string, number, boolean, or an array of those — nested objects are rejected); `unset` is a list of field names to remove. The note's `id:` is immutable here: naming `id` in either `set` or `unset` fails with reason='id_immutable'. An id is ensured on write (minted if the note had none and returned in the result). Prefer this over patch_note for metadata edits — it cannot accidentally clip the id line. Returns JSON `{path, etag, id, permalink, changed_keys, removed_keys}`. Fails with reason='not_found' if the note is missing, reason='no_op' if both set and unset are empty, reason='unsupported_block_value' (with the offending `key`) if a targeted field holds a multi-line/block-style value — edit those by hand via replace_note. Pass optional `if_match` (an etag from read_note/parse_frontmatter or a prior write) to make this conditional — it then fails with reason='precondition_failed' if the note changed since, instead of silently overwriting a concurrent edit.",
      {
        path: NotePath,
        set: z.record(z.string(), FmValue).optional(),
        unset: z.array(z.string().min(1)).optional(),
        if_match: z.string().optional(),
      },
      async (args) =>
        instrument("patch_frontmatter", async () => {
          const r = await patchFrontmatter(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({
              path: v.path,
              etag: v.etag,
              id: v.id,
              permalink: v.permalink,
              changed_keys: v.changed_keys,
              removed_keys: v.removed_keys,
            }),
          );
        }),
    );

    this.server.tool(
      "generate_permalink",
      "Build a short HTTP permalink for a note. The URL routes through the link-resolver Worker (configured via PERMALINK_BASE_URL) and 302-redirects into Obsidian. Returns JSON `{path, permalink, kind}` where kind is 'id' (rename-stable, resolved by frontmatter id) or 'path' (fallback for notes without an id — breaks on rename, run backfill_ids to upgrade). Fails with reason='not_found' if the note does not exist, reason='permalink_disabled' if PERMALINK_BASE_URL is unset.",
      { path: NotePath },
      async (args) =>
        instrument("generate_permalink", async () =>
          fromToolResult(await generatePermalink(this.vault, this.cfg, args), (v) =>
            JSON.stringify(v),
          ),
        ),
    );

    this.server.tool(
      "list_tags",
      "List every unique tag across the vault, drawn from both YAML frontmatter and #inline tags in note bodies. Backed by an incrementally-synced DO-SQLite index.",
      {},
      async () => instrument("list_tags", async () => okJson(await this.index.listTags())),
    );

    this.server.tool(
      "list_backlinks",
      "Find every note containing a wikilink to the given target (matched against the target name, ignoring aliases and headings). Backed by an incrementally-synced DO-SQLite index.",
      { target: z.string().min(1) },
      async (args) =>
        instrument("list_backlinks", async () =>
          okJson(await this.index.listBacklinks(args.target)),
        ),
    );

    this.server.tool(
      "periodic_note_get_or_create",
      "Look up the periodic note for the given cadence covering today (or the supplied YYYY-MM-DD anchor), creating it from the cadence's heading plus a fresh nanoid id if it does not yet exist. `period` selects the cadence (daily/weekly/monthly/quarterly/yearly); the anchor date is bucketed into the week/month/quarter/year that contains it. Returns JSON `{path, created, id}` — `id` is the existing or freshly-minted note id, or null if an existing note has none. Fails with reason='period_not_configured' when no path template is set for that cadence (set the matching DAILY_/WEEKLY_/MONTHLY_/QUARTERLY_/YEARLY_NOTE_PATH_TEMPLATE).",
      {
        period: PeriodEnum,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
      async (args) =>
        instrument("periodic_note_get_or_create", async () => {
          const r = await getOrCreatePeriodicNote(this.vault, this.cfg, args);
          if (r.ok && r.value.created && r.value.etag !== null && r.value.content !== null) {
            this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          }
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, created: v.created, id: v.id }),
          );
        }),
    );

    this.server.tool(
      "periodic_note_append",
      "Append a block of text to the periodic note for the given cadence covering today (or the supplied anchor date), creating it if it does not exist. A newline boundary is inserted automatically if needed. Returns JSON `{path, id}` (`id` is null when the note has no frontmatter). Fails with reason='period_not_configured' when no path template is set for that cadence.",
      {
        period: PeriodEnum,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        content: z.string().min(1),
      },
      async (args) =>
        instrument("periodic_note_append", async () => {
          const r = await appendToPeriodicNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) => JSON.stringify({ path: v.path, id: v.id }));
        }),
    );

    this.server.tool(
      "backfill_ids",
      "Scan the vault and add a stable nanoid `id:` to the frontmatter of any note missing one. Default is dry-run (no writes) — pass dryRun=false to actually persist. `limit` caps how many notes are inspected. `prefix` (e.g. 'Daily Notes/') restricts the scan to one folder for smoke-testing. Notes that already have an `id` are skipped. Returns counts, up to 10 examples of newly-minted (path, id), and up to 20 malformed-frontmatter paths for follow-up. Designed to be re-runnable safely.",
      {
        dryRun: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        prefix: z.string().optional(),
      },
      async (args) =>
        instrument("backfill_ids", async () => {
          const r = await backfillIds(this.vault, this.cfg, args, (path, content, etag) => {
            this.index.upsertFromContent(path, content, etag);
          });
          return fromToolResult(r, (v) => JSON.stringify(v));
        }),
    );

    // NOTE: there is intentionally no `upload_attachment_data` (inline-base64)
    // tool. A tool call carries its arguments as the model's own output tokens,
    // so a base64 payload more than a few KB exhausts the model's output budget
    // and the call truncates mid-stream — unusable for real files. Binary uploads
    // go through `create_upload_link` (user taps a link) or `upload_attachment_url`
    // (server fetches a URL) instead.

    this.server.tool(
      "upload_attachment_url",
      "Fetch an asset from an HTTPS URL server-side and store it as a vault attachment. Prefer a direct asset URL (ending in .png/.jpg/.pdf/…) over a web page — HTML responses are rejected. Security: HTTPS only; the host must be in the server's ATTACHMENT_FETCH_HOST_ALLOWLIST (default-closed — if the allowlist is empty NO host is fetchable and every call fails with 'host_not_allowed'; the operator may set it to '*' to allow any host); no IP-literal or localhost hosts (this denylist applies even when the allowlist is '*'); all of this is re-validated across redirects; plus a size cap (ATTACHMENT_MAX_BYTES) and fetch timeout. If `filename` is omitted it is taken from the URL, else synthesized from the response Content-Type. On success returns JSON `{path, embed_markdown, permalink, etag, size, content_type}`. ANY failure is terminal and writes nothing to the vault — never assume the file was stored (or that a source attachment may now be deleted/completed) unless you received the success JSON. Fails with reason='invalid_url', 'insecure_url' (not https), 'host_not_allowed' (host not in the allowlist), 'disallowed_host' (IP-literal/loopback), 'too_many_redirects', 'fetch_failed', 'html_response', 'too_large', 'no_extension_inferable', 'disallowed_extension' (file type not in ATTACHMENT_ALLOWED_EXTENSIONS — the error carries the allowed list), or 'exists'.",
      {
        source_url: z.string().min(1),
        filename: z.string().optional(),
        target_note: NotePath.optional(),
        subfolder: z.string().optional(),
        overwrite: z.boolean().optional(),
        dest_path: AttachmentPath.optional(),
      },
      async (args) =>
        instrument("upload_attachment_url", async () =>
          fromToolResult(await uploadAttachmentUrl(this.vault, this.cfg, args), (v) =>
            JSON.stringify(v),
          ),
        ),
    );

    this.server.tool(
      "create_upload_link",
      "Mint a short-lived, single-use web link the USER taps to upload file(s) directly to the vault — this is THE way to get a local image/photo/PDF into the vault (a real file cannot be sent through a tool call at all; its bytes would blow the model's output budget). The bytes go straight from the user's browser to the server. Present the returned `upload_url` as a tappable link and tell the user to open it and pick/take the file(s). Mode is chosen by `filename` alone: (1) pass `filename` for a DETERMINISTIC single-file link — the file lands at exactly the returned `dest_path`, which you can then poll with head_attachment/read_attachment after the user says they've uploaded; (2) omit `filename` for a BATCH link — the user may pick up to `max_files` files (default 10) that land in `landing_dir`, which you find afterward via list_attachments. Any `max_files` value (even 1) stays batch mode; only `filename` triggers deterministic mode. `target_note` (a .md path) and `subfolder` set the destination folder. You don't need to know the final note at upload time — upload to your best guess (or a holding folder) and use move_attachment later to relocate. To extract text, call read_attachment on the stored file (it returns the image to you). The link expires (default 15 min, max 30) and works once. Returns JSON `{upload_url, expires_at, landing_dir, multiple, ...}` — `landing_dir` is the vault folder the file(s) land in, so after a batch upload you can call list_attachments scoped to that prefix instead of scanning the whole vault. `dest_path` and `embed_markdown` are included only in deterministic mode (when you passed `filename`) — **embed the file using the returned `embed_markdown` (or `dest_path`), never a path you reconstruct from the folder you asked for**, since the resolved destination may differ from your intended folder. `target_note`/`subfolder` are echoed only when you passed them. Fails with reason='upload_disabled' if the endpoint isn't configured.",
      {
        target_note: NotePath.optional(),
        subfolder: z.string().optional(),
        filename: z.string().optional(),
        max_files: z.number().int().positive().max(50).optional(),
        ttl_minutes: z.number().int().positive().max(30).optional(),
      },
      async (args) =>
        instrument("create_upload_link", async () =>
          fromToolResult(await createUploadLink(this.env, args), (v) => JSON.stringify(v)),
        ),
    );

    this.server.tool(
      "read_attachment",
      "Read a binary attachment back from the vault. For image types the bytes are returned as an MCP image content block (renderable inline) followed by a JSON metadata block. For non-image types (e.g. PDF) the response is a single JSON block containing the base64 bytes in `data_base64` — this can be large, so call head_attachment first to check `size` on uncertain files. Only allowlisted extensions are readable. Fails with reason='not_found' or 'disallowed_extension'.",
      { path: AttachmentPath },
      async ({ path }) =>
        instrument("read_attachment", async () =>
          fromToolResultMixedBlocks(await readAttachment(this.vault, this.cfg, { path }), (v) => {
            if (v.is_image) {
              return [
                { type: "image", data: v.data_base64, mimeType: v.content_type },
                {
                  type: "text",
                  text: JSON.stringify({
                    path: v.path,
                    size: v.size,
                    content_type: v.content_type,
                    etag: v.etag,
                  }),
                },
              ];
            }
            return [
              {
                type: "text",
                text: JSON.stringify({
                  path: v.path,
                  size: v.size,
                  content_type: v.content_type,
                  etag: v.etag,
                  data_base64: v.data_base64,
                }),
              },
            ];
          }),
        ),
    );

    this.server.tool(
      "head_attachment",
      "Return metadata for an attachment without downloading its bytes — JSON `{path, size, content_type, etag, uploaded}`. Use to check `size` before a read_attachment on a potentially large file. Fails with reason='not_found'.",
      { path: AttachmentPath },
      async ({ path }) =>
        instrument("head_attachment", async () =>
          fromToolResult(await headAttachment(this.vault, this.cfg, { path }), (v) =>
            JSON.stringify(v),
          ),
        ),
    );

    this.server.tool(
      "list_attachments",
      "List non-markdown attachments in the vault. Returns JSON `{items, cursor}` where each item is `{path, size, content_type, etag, uploaded}`. An empty `prefix` lists the whole vault's attachments; pass a `prefix` (e.g. 'Daily Notes/files/') to scope. `cursor` paginates (pass back the returned cursor; null means no more pages).",
      {
        prefix: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        cursor: z.string().optional(),
      },
      async (args) =>
        instrument("list_attachments", async () => okJson(await listAttachments(this.vault, this.cfg, args))),
    );

    this.server.tool(
      "move_attachment",
      "Move or rename an attachment within the vault, entirely server-side (no bytes pass through this call, so it works for large files). Use it to relocate a file you uploaded to a guess/holding location once you know the right note or name. Both paths must be allowlisted extensions (so a note can't be moved via this tool). By default it also rewrites the embed in EVERY note that referenced the old path (so links follow the file across one or many notes); pass update_embeds=false to move bytes only. Returns JSON `{from, to, embed_markdown, etag, size, content_type, notes_modified, referrers_unchanged}` where notes_modified lists the note paths whose embeds were rewritten, and referrers_unchanged lists notes that reference the file by bare filename (`![[name.ext]]`) and were left as-is because Obsidian resolves those by name regardless of folder (the link still works). Fails with reason='same_path', 'not_found', 'exists' (set overwrite=true to replace), or 'disallowed_extension'.",
      {
        from_path: AttachmentPath,
        to_path: AttachmentPath,
        overwrite: z.boolean().optional(),
        update_embeds: z.boolean().optional(),
      },
      async (args) =>
        instrument("move_attachment", async () => {
          const r = await moveAttachment(this.vault, this.cfg, this.index, args);
          if (r.ok) {
            for (const n of r.value.notes_modified) {
              this.index.upsertFromContent(n.path, n.content, n.etag);
            }
          }
          return fromToolResult(r, (v) =>
            JSON.stringify({
              from: v.from,
              to: v.to,
              embed_markdown: v.embed_markdown,
              etag: v.etag,
              size: v.size,
              content_type: v.content_type,
              notes_modified: v.notes_modified.map((n) => n.path),
              referrers_unchanged: v.referrers_unchanged,
            }),
          );
        }),
    );

    this.server.tool(
      "delete_attachment",
      "Delete an attachment. Idempotent: succeeds even if the file does not exist. Only allowlisted extensions can be deleted (so a markdown note can't be removed through this tool). Returns JSON `{path, deleted}`. Fails with reason='disallowed_extension'.",
      { path: AttachmentPath },
      async ({ path }) =>
        instrument("delete_attachment", async () =>
          fromToolResult(await deleteAttachment(this.vault, this.cfg, { path }), (v) =>
            JSON.stringify(v),
          ),
        ),
    );
  }
}
