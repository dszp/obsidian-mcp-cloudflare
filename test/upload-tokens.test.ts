import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  consumeUploadToken,
  createUploadLink,
  signUploadToken,
  timingSafeEqual,
  verifyUploadToken,
} from "../src/upload/tokens";

describe("timingSafeEqual", () => {
  it("compares equal/unequal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("upload tokens", () => {
  it("signs and verifies, carrying scope", async () => {
    const { token, expiresAt } = await signUploadToken(env, {
      target_note: "Projects/Plan.md",
      subfolder: "files",
    });
    expect(typeof token).toBe("string");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const r = await verifyUploadToken(env, token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.target_note).toBe("Projects/Plan.md");
      expect(r.value.subfolder).toBe("files");
      expect(r.value.jti).toBeTruthy();
    }
  });

  it("is single-use: verify fails after consume", async () => {
    const { token } = await signUploadToken(env, {});
    const first = await verifyUploadToken(env, token);
    expect(first.ok).toBe(true);
    if (first.ok) await consumeUploadToken(env, first.value.jti);
    const second = await verifyUploadToken(env, token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("token_used");
  });

  it("rejects a tampered signature", async () => {
    const { token } = await signUploadToken(env, {});
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    const r = await verifyUploadToken(env, tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_token");
  });

  it("rejects a malformed token", async () => {
    const r = await verifyUploadToken(env, "not-a-token");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_token");
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await signUploadToken(env, {});
    const otherEnv = { ...env, UPLOAD_TOKEN: "different-secret" } as Env;
    const r = await verifyUploadToken(otherEnv, token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_token");
  });
});

describe("createUploadLink", () => {
  it("returns a tappable URL with a verifiable token and landing_dir", async () => {
    const r = await createUploadLink(env, { target_note: "Projects/Plan.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.upload_url).toMatch(/^https:\/\/vault\.example\.test\/upload\?t=.*&multi=1$/);
    expect(r.value.multiple).toBe(true);
    expect(r.value.landing_dir).toBe("Projects/files"); // per_note_subfolder default
    expect(r.value.embed_markdown).toBeUndefined(); // batch mode: no single filename
    const token = new URL(r.value.upload_url).searchParams.get("t")!;
    const v = await verifyUploadToken(env, token);
    expect(v.ok && v.value.target_note).toBe("Projects/Plan.md");
  });

  it("deterministic link returns dest_path and its landing_dir", async () => {
    const r = await createUploadLink(env, { target_note: "Projects/Plan.md", filename: "diagram.png" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dest_path).toBe("Projects/files/diagram.png");
    // Matches the upload POST's embed exactly (full vault path, no target-note shortening).
    expect(r.value.embed_markdown).toBe("![[Projects/files/diagram.png]]");
    expect(r.value.landing_dir).toBe("Projects/files");
    expect(r.value.multiple).toBe(false);
    expect(r.value.upload_url).not.toContain("multi=1");
  });

  it("degrades to upload_disabled without SERVICE_BASE_URL", async () => {
    const r = await createUploadLink({ ...env, SERVICE_BASE_URL: "" } as unknown as Env, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("upload_disabled");
  });

  it("degrades to upload_disabled without UPLOAD_TOKEN", async () => {
    const r = await createUploadLink({ ...env, UPLOAD_TOKEN: "" } as Env, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("upload_disabled");
  });
});
