// Run with: node --test deploy/railway/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildInitialConfig,
  normalizeOrigin,
  planOriginSync,
  readConfigFile,
  repairUnavailableSearchProvider,
  resolveAuthPlan,
  resolvePublicOrigins,
  resolveTrustedProxies,
  runBootstrap,
} from "./bootstrap.mjs";

const silentLog = { info() {}, warn() {}, error() {} };

test("normalizeOrigin accepts bare domains and strips paths, ports kept", () => {
  assert.equal(normalizeOrigin("example.up.railway.app"), "https://example.up.railway.app");
  assert.equal(normalizeOrigin("https://example.com/openclaw?x=1"), "https://example.com");
  assert.equal(normalizeOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeOrigin("  "), undefined);
  assert.equal(normalizeOrigin("ftp://example.com"), undefined);
  assert.equal(normalizeOrigin("not a url"), undefined);
});

test("resolvePublicOrigins merges explicit, extra, and Railway domains without duplicates", () => {
  assert.deepEqual(
    resolvePublicOrigins({
      OPENCLAW_PUBLIC_ORIGIN: "https://claw.example.com",
      OPENCLAW_CONTROL_UI_ORIGINS: "https://claw.example.com, other.example.com ,",
      RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app",
    }),
    ["https://claw.example.com", "https://other.example.com", "https://svc.up.railway.app"],
  );
  assert.deepEqual(resolvePublicOrigins({}), []);
});

test("resolveAuthPlan prefers env token, then env password, then generates a token", () => {
  assert.deepEqual(resolveAuthPlan({ OPENCLAW_GATEWAY_TOKEN: "abc" }), {
    mode: "token",
    source: "env",
  });
  assert.deepEqual(resolveAuthPlan({ OPENCLAW_GATEWAY_PASSWORD: "pw" }), {
    mode: "password",
    source: "env",
  });
  assert.deepEqual(
    resolveAuthPlan({}, () => "generated"),
    {
      mode: "token",
      source: "generated",
      token: "generated",
    },
  );
});

test("resolveTrustedProxies uses an explicit list, else Railway's edge range only on Railway", () => {
  assert.deepEqual(resolveTrustedProxies({ OPENCLAW_TRUSTED_PROXIES: "10.0.0.1, 10.0.0.2" }), [
    "10.0.0.1",
    "10.0.0.2",
  ]);
  assert.deepEqual(resolveTrustedProxies({ RAILWAY_ENVIRONMENT: "production" }), ["100.64.0.0/10"]);
  assert.deepEqual(resolveTrustedProxies({ RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app" }), [
    "100.64.0.0/10",
  ]);
  assert.deepEqual(resolveTrustedProxies({}), []);
});

test("buildInitialConfig records origins, publicOrigin, and trusted proxies, keeps env-provided secrets out of the file", () => {
  const config = buildInitialConfig({
    origins: ["https://svc.up.railway.app"],
    workspaceDir: "/data/workspace",
    auth: { mode: "token", source: "env" },
    trustedProxies: ["100.64.0.0/10"],
  });
  assert.deepEqual(config, {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token" },
      controlUi: { enabled: true, allowedOrigins: ["https://svc.up.railway.app"] },
      publicOrigin: "https://svc.up.railway.app",
      trustedProxies: ["100.64.0.0/10"],
    },
    agents: { defaults: { workspace: "/data/workspace" } },
    browser: { enabled: true, headless: true, noSandbox: true },
  });
  const bare = buildInitialConfig({
    origins: [],
    workspaceDir: "/w",
    auth: { mode: "token", source: "env" },
    containerDefaults: null,
  });
  assert.equal(bare.gateway.trustedProxies, undefined);
  assert.equal(bare.browser, undefined);
  assert.equal(bare.tools, undefined);
});

test("buildInitialConfig stores a generated token and enables host-header fallback without origins", () => {
  const config = buildInitialConfig({
    origins: [],
    workspaceDir: "/data/workspace",
    auth: { mode: "token", source: "generated", token: "tok" },
  });
  assert.equal(config.gateway.auth.token, "tok");
  assert.equal(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback, true);
  assert.equal(config.gateway.controlUi.allowedOrigins, undefined);
  assert.equal(config.gateway.publicOrigin, undefined);
});

test("planOriginSync is additive, idempotent, and preserves operator settings", () => {
  const existing = {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token", token: "keep" },
      controlUi: { enabled: true, allowedOrigins: ["https://old.example.com"] },
      publicOrigin: "https://old.example.com",
    },
    channels: { telegram: { enabled: true } },
  };
  const first = planOriginSync(existing, ["https://old.example.com/", "https://new.example.com"]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.added, ["https://new.example.com"]);
  assert.equal(first.publicOrigin, undefined, "existing publicOrigin is not replaced");
  assert.deepEqual(first.config.gateway.controlUi.allowedOrigins, [
    "https://old.example.com",
    "https://new.example.com",
  ]);
  assert.equal(first.config.gateway.auth.token, "keep");
  assert.deepEqual(first.config.channels, existing.channels);
  assert.deepEqual(
    existing.gateway.controlUi.allowedOrigins,
    ["https://old.example.com"],
    "input untouched",
  );

  const second = planOriginSync(first.config, ["https://new.example.com"]);
  assert.equal(second.changed, false);
  assert.equal(second.config, first.config);
});

test("planOriginSync fills a missing publicOrigin and tolerates a config without gateway", () => {
  const plan = planOriginSync({ agents: {} }, ["https://svc.up.railway.app"]);
  assert.equal(plan.changed, true);
  assert.equal(plan.publicOrigin, "https://svc.up.railway.app");
  assert.deepEqual(plan.config.gateway, {
    publicOrigin: "https://svc.up.railway.app",
    controlUi: { allowedOrigins: ["https://svc.up.railway.app"] },
  });
});

test("planOriginSync fills trustedProxies only when the key is absent", () => {
  const filled = planOriginSync(
    { gateway: { controlUi: { allowedOrigins: ["https://a.example.com"] } } },
    ["https://a.example.com"],
    { trustedProxies: ["100.64.0.0/10"] },
  );
  assert.equal(filled.changed, true);
  assert.deepEqual(filled.trustedProxies, ["100.64.0.0/10"]);
  assert.deepEqual(filled.config.gateway.trustedProxies, ["100.64.0.0/10"]);
  assert.equal(filled.publicOrigin, "https://a.example.com");

  const explicitEmpty = planOriginSync(
    {
      gateway: {
        publicOrigin: "https://a.example.com",
        trustedProxies: [],
        controlUi: { allowedOrigins: ["https://a.example.com"] },
      },
    },
    ["https://a.example.com"],
    { trustedProxies: ["100.64.0.0/10"] },
  );
  assert.equal(explicitEmpty.changed, false, "an operator-authored empty list is respected");
});

test("planOriginSync fills the container browser defaults only when browser is absent", () => {
  const defaults = { browser: { enabled: true, headless: true, noSandbox: true } };
  const base = {
    gateway: {
      publicOrigin: "https://a.example.com",
      trustedProxies: ["100.64.0.0/10"],
      controlUi: { allowedOrigins: ["https://a.example.com"] },
    },
  };
  const filled = planOriginSync(base, ["https://a.example.com"], {
    trustedProxies: ["100.64.0.0/10"],
    containerDefaults: defaults,
  });
  assert.equal(filled.changed, true);
  assert.deepEqual(filled.defaultsApplied, ["browser"]);
  assert.deepEqual(filled.config.browser, defaults.browser);
  assert.equal(filled.config.tools, undefined, "no search provider is invented");

  const operatorOwned = { ...base, browser: { headless: false } };
  const untouched = planOriginSync(operatorOwned, ["https://a.example.com"], {
    trustedProxies: ["100.64.0.0/10"],
    containerDefaults: defaults,
  });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.config, operatorOwned);
});

test("repairUnavailableSearchProvider drops only a duckduckgo provider whose plugin is missing", () => {
  const withProvider = {
    gateway: { mode: "local" },
    tools: {
      profile: "coding",
      web: { fetch: { enabled: true }, search: { provider: "duckduckgo" } },
    },
  };
  const repaired = repairUnavailableSearchProvider(withProvider, false);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.config.tools, { profile: "coding", web: { fetch: { enabled: true } } });
  assert.deepEqual(withProvider.tools.web.search, { provider: "duckduckgo" }, "input untouched");

  const onlyProvider = { tools: { web: { search: { provider: "duckduckgo" } } } };
  assert.deepEqual(repairUnavailableSearchProvider(onlyProvider, false).config, {});

  const installed = repairUnavailableSearchProvider(withProvider, true);
  assert.equal(installed.repaired, false);
  assert.equal(installed.config, withProvider);

  const brave = { tools: { web: { search: { provider: "brave" } } } };
  assert.equal(repairUnavailableSearchProvider(brave, false).repaired, false);
});

test("runBootstrap repairs a volume config that carries the retired duckduckgo default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-railway-"));
  try {
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
      OPENCLAW_GATEWAY_TOKEN: "env-token",
      RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app",
      OPENCLAW_RAILWAY_DUCKDUCKGO_PLUGIN_DIR: path.join(root, "no-such-plugin"),
    };
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    const configPath = path.join(root, "state", "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          publicOrigin: "https://svc.up.railway.app",
          trustedProxies: ["100.64.0.0/10"],
          controlUi: { allowedOrigins: ["https://svc.up.railway.app"] },
        },
        browser: { enabled: true, headless: true, noSandbox: true },
        tools: { web: { search: { provider: "duckduckgo" } } },
      }),
    );
    const result = runBootstrap({ env, log: silentLog });
    assert.equal(result.action, "updated");
    assert.equal(result.repairedSearchProvider, true);
    assert.equal(readConfigFile(configPath).config.tools, undefined);

    const again = runBootstrap({ env, log: silentLog });
    assert.equal(again.action, "unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runBootstrap creates, then syncs, then leaves an operator-edited config alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-railway-"));
  try {
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    };
    const created = runBootstrap({ env, log: silentLog });
    assert.equal(created.action, "created");
    const configPath = path.join(root, "state", "openclaw.json");
    assert.equal(created.configPath, configPath);
    assert.ok(fs.existsSync(path.join(root, "workspace")));
    const written = readConfigFile(configPath);
    assert.equal(written.kind, "ok");
    assert.equal(written.config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback, true);
    assert.equal(written.config.gateway.auth.token, undefined, "env token is not copied to disk");

    const synced = runBootstrap({
      env: { ...env, RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app" },
      log: silentLog,
    });
    assert.equal(synced.action, "updated");
    assert.deepEqual(synced.added, ["https://svc.up.railway.app"]);
    assert.deepEqual(synced.trustedProxies, ["100.64.0.0/10"]);
    assert.deepEqual(synced.defaultsApplied, [], "defaults were already written at creation");
    const afterSync = readConfigFile(configPath).config;
    assert.deepEqual(afterSync.browser, { enabled: true, headless: true, noSandbox: true });
    assert.equal(afterSync.tools, undefined);
    assert.deepEqual(afterSync.gateway.controlUi.allowedOrigins, ["https://svc.up.railway.app"]);
    assert.equal(afterSync.gateway.publicOrigin, "https://svc.up.railway.app");
    assert.deepEqual(afterSync.gateway.trustedProxies, ["100.64.0.0/10"]);
    assert.equal(
      afterSync.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback,
      true,
      "security flags are only ever changed by the operator",
    );

    // Operator edits through the UI must survive the next boot unchanged.
    afterSync.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = false;
    afterSync.agents.defaults.model = { primary: "anthropic/claude-sonnet-4-6" };
    fs.writeFileSync(configPath, JSON.stringify(afterSync));
    const unchanged = runBootstrap({
      env: { ...env, RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app" },
      log: silentLog,
    });
    assert.equal(unchanged.action, "unchanged");
    assert.deepEqual(readConfigFile(configPath).config, afterSync);

    // A JSON5 file with comments is left for the Gateway to parse.
    fs.writeFileSync(configPath, "// comment\n{ gateway: { mode: 'local' } }\n");
    const skipped = runBootstrap({ env, log: silentLog });
    assert.equal(skipped.action, "skipped");
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      "// comment\n{ gateway: { mode: 'local' } }\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runBootstrap generates and stores a token when no shared secret is provided", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-railway-"));
  try {
    const warnings = [];
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
      RAILWAY_PUBLIC_DOMAIN: "svc.up.railway.app",
    };
    runBootstrap({ env, log: { ...silentLog, warn: (message) => warnings.push(message) } });
    const config = readConfigFile(path.join(root, "state", "openclaw.json")).config;
    assert.match(config.gateway.auth.token, /^[0-9a-f]{64}$/);
    assert.ok(warnings.some((message) => message.includes(config.gateway.auth.token)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
