import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DIST } from "./helpers.mjs";

const { ToolRegistry } = await import(join(DIST, "registry.js"));
const { AgentConfigSchema } = await import(join(DIST, "types.js"));

function entry(provider, originalName) {
  return {
    ref: `t:${provider}.${originalName}`,
    provider,
    originalName,
    title: originalName,
    description: "",
    mainParams: [],
    example: {},
    tags: [],
    _inputSchema: {},
    cachedTokens: new Set(),
  };
}

function build() {
  const r = new ToolRegistry();
  r.register(entry("google-hope", "drive_share"));
  r.register(entry("google-hope", "drive_list_files"));
  r.register(entry("google-hope", "share_doc"));
  r.register(entry("google-sbceh", "drive_list_files"));
  return r;
}

const names = (view) => view.getAll().map((e) => `${e.provider}.${e.originalName}`).sort();

test("forProviders keeps only allowed providers", () => {
  assert.deepEqual(names(build().forProviders(new Set(["google-hope"]))), [
    "google-hope.drive_list_files",
    "google-hope.drive_share",
    "google-hope.share_doc",
  ]);
});

test("forProviders removes provider-specific and wildcard denies", () => {
  const view = build().forProviders(new Set(["google-hope"]), ["google-hope.drive_share", "*.share_doc"]);
  assert.deepEqual(names(view), ["google-hope.drive_list_files"]);
});

test("a deny never lets another provider back in", () => {
  const view = build().forProviders(new Set(["google-hope"]), ["google-hope.drive_share"]);
  assert.ok(!names(view).some((n) => n.startsWith("google-sbceh")));
});

test("unmatchedDenies reports entries that match no tool", () => {
  assert.deepEqual(build().unmatchedDenies(["google-hope.drive_share", "google-hope.drive_shair"]), ["google-hope.drive_shair"]);
});

test("AgentConfigSchema accepts well-formed deny entries and rejects malformed ones", () => {
  assert.ok(AgentConfigSchema.safeParse({ allow: ["a"], deny: ["a.tool", "*.tool"] }).success);
  assert.ok(!AgentConfigSchema.safeParse({ allow: ["a"], deny: ["no-dot"] }).success);
  assert.ok(!AgentConfigSchema.safeParse({ allow: ["a"], deny: ["a/../b.tool"] }).success);
});
