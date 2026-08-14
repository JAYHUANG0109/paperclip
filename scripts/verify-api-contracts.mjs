#!/usr/bin/env node
/**
 * Verify the API contracts this fork depends on, against a running instance.
 *
 * Complements the vitest suites rather than repeating them: these assertions run
 * against the DEPLOYED server, so they catch a bad build, a stale release, or a
 * config difference that unit tests cannot see by construction.
 *
 * Usage:
 *   PAPERCLIP_TOKEN=pcp_board_xxx node scripts/verify-api-contracts.mjs
 *
 * Options (env):
 *   PAPERCLIP_BASE_URL   default http://127.0.0.1:3100
 *   PAPERCLIP_TOKEN      board API key (Settings -> API keys). Required for the
 *                        write checks; without it only the public checks run.
 *   PAPERCLIP_COMPANY    issue prefix to test against, default the first company
 *                        the token can see.
 *
 * Creates ONE throwaway task and removes it. Exits non-zero if any check fails.
 */
const BASE = (process.env.PAPERCLIP_BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const TOKEN = process.env.PAPERCLIP_TOKEN || "";
const WANT_COMPANY = process.env.PAPERCLIP_COMPANY || "";

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, detail = "") {
  pass += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  fail += 1;
  console.log(`  FAIL  ${name}\n        ${detail}`);
}
function skipped(name, why) {
  skip += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

// ---------------------------------------------------------------- public
console.log(`\nverifying ${BASE}\n`);
console.log("public:");
{
  const r = await api("/api/health");
  if (r.status === 200 && r.body?.status === "ok") ok("health responds ok");
  else bad("health responds ok", `status=${r.status} body=${JSON.stringify(r.body).slice(0, 160)}`);

  const backup = r.body?.databaseBackup;
  if (!backup) skipped("database backup is healthy", "health does not report databaseBackup");
  else if (backup.status === "ok") ok("database backup is healthy");
  else bad("database backup is healthy", `status=${backup.status} warnings=${JSON.stringify(backup.warnings)}`);
}

// The Activity/Audit consolidation is CLIENT-side routing (React Router), so the
// server returns the SPA shell for both paths. Asserting a 3xx here would be
// wrong. What the server must do is serve the app rather than 404, so a bookmark
// of the old /audit path still loads something that can redirect.
{
  for (const path of ["/activity", "/audit"]) {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: "text/html" } });
    if (res.status === 200) ok(`serves the SPA shell for ${path}`);
    else bad(`serves the SPA shell for ${path}`, `status=${res.status} (the in-app redirect is covered by App.activity-routing.test.tsx)`);
  }
}

// ------------------------------------------------------------ authenticated
console.log("\nauthenticated:");
if (!TOKEN) {
  skipped("PATCH receipts", "set PAPERCLIP_TOKEN to a board API key");
  skipped("Prefer: return=minimal", "set PAPERCLIP_TOKEN to a board API key");
} else {
  const companies = await api("/api/companies");
  const list = Array.isArray(companies.body) ? companies.body : companies.body?.companies ?? [];
  const company = WANT_COMPANY
    ? list.find((c) => c.issuePrefix === WANT_COMPANY)
    : list[0];

  if (!company) {
    bad("resolve a company", `token sees ${list.length} companies; PAPERCLIP_COMPANY=${WANT_COMPANY || "(unset)"}`);
  } else {
    console.log(`  (using company ${company.issuePrefix})`);
    const created = await api(`/api/companies/${company.id}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `api-contract-check ${new Date().toISOString()}`,
        description: "Created by scripts/verify-api-contracts.mjs. Safe to delete.",
      }),
    });
    if (created.status !== 201 && created.status !== 200) {
      bad("create a throwaway task", `status=${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    } else {
      const issueId = created.body?.id;
      try {
        // ---- authoritative PATCH receipts (627728bdd) ----
        const patched = await api(`/api/issues/${issueId}`, {
          method: "PATCH",
          body: JSON.stringify({ priority: "high" }),
        });
        if (patched.status !== 200) {
          bad("PATCH returns 200", `status=${patched.status} ${JSON.stringify(patched.body).slice(0, 200)}`);
        } else if (!patched.body?.changes) {
          bad("PATCH returns a `changes` receipt", `keys=${Object.keys(patched.body || {}).join(",")}`);
        } else if (patched.body.changes.priority?.to !== "high") {
          bad("receipt reports the committed value", JSON.stringify(patched.body.changes).slice(0, 200));
        } else {
          ok("PATCH returns an authoritative `changes` receipt", "priority -> high");
        }

        // A no-op write must not invent a change.
        const noop = await api(`/api/issues/${issueId}`, {
          method: "PATCH",
          body: JSON.stringify({ priority: "high" }),
        });
        if (noop.status === 200 && !("priority" in (noop.body?.changes ?? {}))) {
          ok("no-op PATCH omits the unchanged field");
        } else {
          bad("no-op PATCH omits the unchanged field", JSON.stringify(noop.body?.changes ?? {}).slice(0, 200));
        }

        // ---- Prefer: return=minimal ----
        const minimal = await api(`/api/issues/${issueId}`, {
          method: "PATCH",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({ priority: "medium" }),
        });
        const applied = minimal.headers.get("preference-applied");
        if (minimal.status !== 200) {
          bad("Prefer: return=minimal", `status=${minimal.status}`);
        } else if (applied !== "return=minimal") {
          bad("responds with Preference-Applied", `got ${applied ?? "(absent)"}`);
        } else if (minimal.body?.description !== undefined) {
          bad("minimal body really is minimal", `body has ${Object.keys(minimal.body).length} keys incl. description`);
        } else {
          ok("Prefer: return=minimal honoured", `keys: ${Object.keys(minimal.body).join(",")}`);
        }
      } finally {
        const del = await api(`/api/issues/${issueId}`, { method: "DELETE" });
        if (del.status >= 200 && del.status < 300) ok("cleaned up the throwaway task");
        else console.log(`  NOTE  could not delete ${issueId} (status ${del.status}) — remove it by hand`);
      }
    }
  }
}

// ------------------------------------------------------------------ summary
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail > 0 ? 1 : 0);
