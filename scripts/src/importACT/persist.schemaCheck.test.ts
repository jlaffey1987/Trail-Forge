import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Schema-readiness tests for the ACT/TET importer.
 *
 * These tests stub `global.fetch` to simulate the Supabase REST
 * responses we care about, then assert that `checkSchemaReady` reports
 * the right "missing safeguard" so the CLI in `index.ts` will refuse
 * to start.
 *
 * The most important scenario — and the reason for this test file — is
 * the missing unique index on `(source, source_url, segment_hash)`:
 * without it the importer is not idempotent and parallel re-runs would
 * silently insert duplicate rows.
 *
 * Run via: `pnpm --filter @workspace/scripts run test`
 */

process.env.SUPABASE_URL = "https://example.supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";

interface FakeFetchCall {
  url: string;
  method: string;
  prefer: string | null;
}

interface FakeFetchOptions {
  // PostgREST returns 400 with this JSON body when ON CONFLICT can't
  // find a matching unique/exclusion constraint.
  missingIndex: boolean;
  // Optional: simulate a column being absent from the trails table.
  missingColumns?: string[];
}

function installFakeFetch(opts: FakeFetchOptions): {
  calls: FakeFetchCall[];
  restore: () => void;
} {
  const calls: FakeFetchCall[] = [];
  const original = globalThis.fetch;
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const prefer =
      ((init?.headers as Record<string, string> | undefined) ?? {})["Prefer"] ?? null;
    calls.push({ url, method, prefer });

    // Column probe: GET /rest/v1/trails?select=<col>&limit=1
    if (method === "GET" && url.includes("/rest/v1/trails") && url.includes("select=")) {
      const selectMatch = url.match(/[?&]select=([^&]+)/);
      const col = selectMatch ? decodeURIComponent(selectMatch[1]) : "";
      if (opts.missingColumns?.includes(col)) {
        return new Response(
          JSON.stringify({
            code: "42703",
            message: `column trails.${col} does not exist`,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Index probe: POST /rest/v1/trails?on_conflict=...
    if (method === "POST" && url.includes("on_conflict=")) {
      if (opts.missingIndex) {
        // Real PostgREST body when the index is missing.
        return new Response(
          JSON.stringify({
            code: "42P10",
            details: null,
            hint: null,
            message:
              "there is no unique or exclusion constraint matching the ON CONFLICT specification",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      // Index present: PostgREST honoured tx=rollback and returned 201
      // with no body. We still pretend the row was inserted so the
      // cleanup DELETE path is exercised.
      return new Response("", {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }

    // Cleanup DELETE: DELETE /rest/v1/trails?source=eq.act&...
    if (method === "DELETE" && url.includes("/rest/v1/trails")) {
      return new Response("", {
        status: 204,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unhandled fake fetch: ${method} ${url}`);
  }) as typeof globalThis.fetch;

  globalThis.fetch = fakeFetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function freshImport() {
  // Re-import to keep tests isolated from each other; the module itself
  // holds no mutable state but this also guards against future refactors.
  const mod = await import(`./persist.js?cacheBust=${Math.random()}`);
  return mod as typeof import("./persist.js");
}

test("checkSchemaReady reports the missing unique index when ON CONFLICT fails", async () => {
  const fake = installFakeFetch({ missingIndex: true });
  try {
    const { checkSchemaReady } = await freshImport();
    const result = await checkSchemaReady();
    assert.equal(result.ok, false, "schema check must refuse to run");
    assert.deepEqual(
      result.missingColumns,
      [],
      "columns are present in this scenario — only the index is missing",
    );
    assert.equal(
      result.missingIndexes.length,
      1,
      "exactly one missing-index entry should be reported",
    );
    assert.match(
      result.missingIndexes[0],
      /trails_source_segment_unique/,
      "missing index name should be surfaced for actionable error output",
    );

    // Confirm the probe used the on_conflict + tx=rollback path so the
    // sentinel row never commits when the backend honours the override.
    const probe = fake.calls.find(
      (c) => c.method === "POST" && c.url.includes("on_conflict="),
    );
    assert.ok(probe, "expected an on_conflict probe POST");
    assert.match(probe!.prefer ?? "", /tx=rollback/);
    assert.match(probe!.url, /on_conflict=source%2Csource_url%2Csegment_hash/);
  } finally {
    fake.restore();
  }
});

test("checkSchemaReady passes when columns exist and the unique index is present", async () => {
  const fake = installFakeFetch({ missingIndex: false });
  try {
    const { checkSchemaReady } = await freshImport();
    const result = await checkSchemaReady();
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.missingIndexes, []);

    // The sentinel row must be cleaned up after the probe succeeds, even
    // if the backend ignored tx=rollback.
    const cleanup = fake.calls.find((c) => c.method === "DELETE");
    assert.ok(cleanup, "expected a cleanup DELETE for the sentinel probe row");
  } finally {
    fake.restore();
  }
});

test("checkSchemaReady reports missing columns and skips the index probe when key columns are absent", async () => {
  // If `segment_hash` doesn't exist as a column, ON CONFLICT on it
  // would always fail — surfacing 42P10 in that case would be misleading
  // (the real fix is to apply the migration that adds the column). The
  // index probe is only meaningful when the columns exist.
  const fake = installFakeFetch({
    missingIndex: true,
    missingColumns: ["segment_hash"],
  });
  try {
    const { checkSchemaReady } = await freshImport();
    const result = await checkSchemaReady();
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingColumns, ["segment_hash"]);
    assert.deepEqual(
      result.missingIndexes,
      [],
      "index probe should be skipped when the columns it references are missing",
    );

    const probe = fake.calls.find(
      (c) => c.method === "POST" && c.url.includes("on_conflict="),
    );
    assert.equal(probe, undefined, "no on_conflict probe should be issued in this scenario");
  } finally {
    fake.restore();
  }
});

test("checkUpsertIndex returns ok=false with code 42P10 when the index is missing", async () => {
  const fake = installFakeFetch({ missingIndex: true });
  try {
    const { checkUpsertIndex } = await freshImport();
    const result = await checkUpsertIndex();
    assert.equal(result.ok, false);
    assert.equal(result.code, "42P10");
  } finally {
    fake.restore();
  }
});
