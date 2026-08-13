import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";

/**
 * Seal the suite from the operator's instance env, then pin what it needs.
 *
 * server/src/config.ts dotenv-loads the resolved Paperclip instance `.env` at
 * import time. On a box that also HOSTS an instance — which this fork's dev
 * machine does — that file is production config, so importing the server for a
 * test silently inherits it. `~/.paperclip/instances/default/.env` sets
 * PAPERCLIP_RESTRICT_AGENT_VISIBILITY=true, so every server test here ran with
 * the 四季 restriction on while CI ran with it off, and the same test could pass
 * in one place and fail in the other.
 *
 * That is not a theoretical hazard: an over-narrow authz rule was caught locally
 * only because the flag happened to be on, and would have gone green on CI.
 *
 * PAPERCLIP_CONFIG short-circuits the ancestor search in resolvePaperclipConfigPath,
 * so pointing it at an empty temp dir makes the dotenv load a no-op. This must run
 * before config.ts is imported — setupFiles run before test modules, and this file
 * deliberately imports nothing from the server.
 */
const sealedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-env-"));
process.env.PAPERCLIP_CONFIG = path.join(sealedConfigDir, "paperclip.json");

/**
 * Authorization flags, pinned OFF rather than inherited.
 *
 * Off is what the suite is written against: the fork's restriction tests set
 * PAPERCLIP_RESTRICT_AGENT_VISIBILITY themselves inside their own describe blocks
 * and delete it afterwards, while the tests covering upstream's default-open
 * behaviour sit at the top level and assume the upstream default.
 *
 * Before this seal those top-level tests passed only because a restriction block's
 * afterEach happened to have deleted the variable first — order-dependent cleanup,
 * the same disease one layer down. Pinning off removes the ordering dependence;
 * coverage WITH the restriction on comes from the blocks that opt in explicitly.
 */
delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
delete process.env.PAPERCLIP_PROJECT_PRIVACY;
delete process.env.PAPERCLIP_PROJECT_VISIBILITY;

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
