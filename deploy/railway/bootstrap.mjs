#!/usr/bin/env node
// Railway first-boot bootstrap for the OpenClaw Gateway.
//
// Railway offers no shell before a service's first boot, so this script does
// the minimum that `openclaw onboard` would do on a workstation and then leaves
// every later change to the Control UI (Settings and Config pages):
//
// - creates a minimal, schema-valid `openclaw.json` on the persistent volume
//   when none exists: local mode, LAN bind, shared-secret auth, and the Railway
//   public domain as the only allowed Control UI browser origin
// - on every boot, appends a newly assigned Railway or custom domain to
//   `gateway.controlUi.allowedOrigins` when it is missing, fills in
//   `gateway.publicOrigin` when it is unset, and fills in
//   `gateway.trustedProxies` with Railway's edge range when the key is absent
//   (the Gateway rejects forwarded traffic from an untrusted proxy)
// - never rewrites a setting an operator changed through the UI, and never
//   touches a config file it cannot parse as JSON
//
// The exported helpers are pure so `bootstrap.test.mjs` covers them without a
// filesystem; `runBootstrap` performs the writes and runs only when this file
// is executed directly (see entrypoint.sh).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves the volume-backed paths the Gateway will use. */
export function resolveBootstrapPaths(env) {
  const stateDir = trim(env.OPENCLAW_STATE_DIR) || "/data/.openclaw";
  return {
    stateDir,
    configPath: trim(env.OPENCLAW_CONFIG_PATH) || path.join(stateDir, "openclaw.json"),
    workspaceDir: trim(env.OPENCLAW_WORKSPACE_DIR) || "/data/workspace",
  };
}

/** Normalizes a domain or URL into an `https://host[:port]` browser origin. */
export function normalizeOrigin(raw) {
  const value = trim(raw);
  if (!value) {
    return undefined;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  return url.origin;
}

/**
 * Collects the browser origins the Control UI must accept, in priority order:
 * an explicit public origin, extra comma-separated origins, then the domain
 * Railway injects for the service.
 */
export function resolvePublicOrigins(env) {
  const origins = [];
  const add = (raw) => {
    const origin = normalizeOrigin(raw);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  };
  add(env.OPENCLAW_PUBLIC_ORIGIN);
  for (const part of String(env.OPENCLAW_CONTROL_UI_ORIGINS ?? "").split(",")) {
    add(part);
  }
  const railwayDomain = trim(env.RAILWAY_PUBLIC_DOMAIN);
  if (railwayDomain) {
    add(`https://${railwayDomain}`);
  }
  return origins;
}

/**
 * Railway's HTTP edge reaches the container from the 100.64.0.0/10 range and
 * adds forwarded client headers. The Gateway rejects proxy-shaped traffic from
 * an unlisted source, so that range must be trusted for any request to pass.
 */
export const RAILWAY_PROXY_CIDRS = ["100.64.0.0/10"];

/** Resolves the proxy sources to trust: an explicit list, else Railway's edge when running on Railway. */
export function resolveTrustedProxies(env) {
  const explicit = String(env.OPENCLAW_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicit.length > 0) {
    return explicit;
  }
  if (trim(env.RAILWAY_ENVIRONMENT) || trim(env.RAILWAY_PROJECT_ID) || trim(env.RAILWAY_PUBLIC_DOMAIN)) {
    return [...RAILWAY_PROXY_CIDRS];
  }
  return [];
}

/** Chooses the shared-secret auth mode from the environment the container received. */
export function resolveAuthPlan(env, generateToken = () => randomBytes(32).toString("hex")) {
  if (trim(env.OPENCLAW_GATEWAY_TOKEN)) {
    return { mode: "token", source: "env" };
  }
  if (trim(env.OPENCLAW_GATEWAY_PASSWORD)) {
    return { mode: "password", source: "env" };
  }
  return { mode: "token", source: "generated", token: generateToken() };
}

/** Builds the first `openclaw.json`. Every key here is editable later in the Control UI. */
export function buildInitialConfig({ origins, workspaceDir, auth, trustedProxies = [] }) {
  const controlUi = { enabled: true };
  if (origins.length > 0) {
    controlUi.allowedOrigins = [...origins];
  } else {
    // No domain is known yet (Railway assigns one after the first deploy).
    // Host-header fallback lets the UI load until origins are recorded; the
    // operator is warned at every boot while it stays enabled.
    controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  }
  const gatewayAuth = { mode: auth.mode };
  if (auth.source === "generated") {
    gatewayAuth.token = auth.token;
  }
  const publicOrigin = origins.find((origin) => origin.startsWith("https://"));
  return {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: gatewayAuth,
      controlUi,
      ...(publicOrigin ? { publicOrigin } : {}),
      ...(trustedProxies.length > 0 ? { trustedProxies: [...trustedProxies] } : {}),
    },
    agents: { defaults: { workspace: workspaceDir } },
  };
}

/**
 * Computes the additive sync for an existing config: missing browser origins,
 * an unset publicOrigin, and, when the operator never set one, the proxy trust
 * list. Returns the same object when nothing is missing so callers can skip
 * the write.
 */
export function planOriginSync(config, rawOrigins, { trustedProxies = [] } = {}) {
  const origins = [];
  for (const raw of rawOrigins) {
    const origin = normalizeOrigin(raw);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  const gateway = isRecord(config.gateway) ? config.gateway : {};
  const controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : {};
  const existing = Array.isArray(controlUi.allowedOrigins)
    ? controlUi.allowedOrigins.filter((value) => typeof value === "string")
    : [];
  const existingNormalized = new Set(existing.map((value) => normalizeOrigin(value)));
  const missing = origins.filter((origin) => !existingNormalized.has(origin));
  const nextPublicOrigin =
    typeof gateway.publicOrigin === "string" && gateway.publicOrigin.trim()
      ? undefined
      : origins.find((origin) => origin.startsWith("https://"));
  // Only fill trustedProxies when the key is absent: an operator-authored list,
  // including an empty one, is a deliberate security choice.
  const nextTrustedProxies =
    gateway.trustedProxies === undefined && trustedProxies.length > 0
      ? [...trustedProxies]
      : undefined;
  if (missing.length === 0 && !nextPublicOrigin && !nextTrustedProxies) {
    return { config, changed: false, added: [], publicOrigin: undefined, trustedProxies: undefined };
  }
  const next = {
    ...config,
    gateway: {
      ...gateway,
      ...(nextPublicOrigin ? { publicOrigin: nextPublicOrigin } : {}),
      ...(nextTrustedProxies ? { trustedProxies: nextTrustedProxies } : {}),
      controlUi: {
        ...controlUi,
        ...(missing.length > 0 ? { allowedOrigins: [...existing, ...missing] } : {}),
      },
    },
  };
  return {
    config: next,
    changed: true,
    added: missing,
    publicOrigin: nextPublicOrigin,
    trustedProxies: nextTrustedProxies,
  };
}

/** Reads the config file; JSON5 that plain JSON cannot parse is reported, not rewritten. */
export function readConfigFile(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  if (!raw.trim()) {
    return { kind: "missing" };
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? { kind: "ok", config: parsed } : { kind: "invalid", error: "not an object" };
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Replaces the config atomically so a crash mid-write cannot leave a truncated file. */
export function writeConfigFile(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${configPath}.railway-bootstrap.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

/** Runs the bootstrap against the real filesystem and returns what it did. */
export function runBootstrap({ env = process.env, log = console } = {}) {
  const paths = resolveBootstrapPaths(env);
  const origins = resolvePublicOrigins(env);
  const trustedProxies = resolveTrustedProxies(env);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.workspaceDir, { recursive: true });

  const existing = readConfigFile(paths.configPath);
  if (existing.kind === "invalid") {
    log.warn(
      `railway-bootstrap: ${paths.configPath} is not plain JSON (${existing.error}); leaving it unchanged. ` +
        "Add new browser origins under Settings -> Gateway -> Control UI if the UI reports 'origin not allowed'.",
    );
    return { action: "skipped", reason: "unparseable-config", configPath: paths.configPath };
  }

  if (existing.kind === "missing") {
    const auth = resolveAuthPlan(env);
    const config = buildInitialConfig({
      origins,
      workspaceDir: paths.workspaceDir,
      auth,
      trustedProxies,
    });
    writeConfigFile(paths.configPath, config);
    log.info(
      `railway-bootstrap: wrote ${paths.configPath} (bind=lan, auth=${auth.mode}, ` +
        `origins=${origins.length > 0 ? origins.join(",") : "none"}, ` +
        `trustedProxies=${trustedProxies.length > 0 ? trustedProxies.join(",") : "none"}). ` +
        "Every setting in it is editable from the Control UI.",
    );
    if (auth.source === "generated") {
      log.warn(
        "railway-bootstrap: OPENCLAW_GATEWAY_TOKEN was not set, so a gateway token was generated and stored " +
          `in ${paths.configPath}. Paste it into Control UI -> Settings -> Connection. It is printed once:\n` +
          `railway-bootstrap: gateway token = ${auth.token}`,
      );
    }
    if (origins.length === 0) {
      log.warn(
        "railway-bootstrap: no public domain is known yet, so gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback " +
          "was enabled. Generate a domain (Settings -> Networking), redeploy so it is added to allowedOrigins, " +
          "then turn the fallback off in the Control UI.",
      );
    }
    return { action: "created", configPath: paths.configPath, auth: auth.mode, origins };
  }

  const plan = planOriginSync(existing.config, origins, { trustedProxies });
  if (plan.changed) {
    writeConfigFile(paths.configPath, plan.config);
    const parts = [];
    if (plan.added.length > 0) {
      parts.push(`added ${plan.added.join(",")} to gateway.controlUi.allowedOrigins`);
    }
    if (plan.publicOrigin) {
      parts.push(`set gateway.publicOrigin=${plan.publicOrigin}`);
    }
    if (plan.trustedProxies) {
      parts.push(`set gateway.trustedProxies=${plan.trustedProxies.join(",")}`);
    }
    log.info(`railway-bootstrap: ${parts.join("; ")} in ${paths.configPath}.`);
  }
  const fallbackOn =
    plan.config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
  if (fallbackOn && origins.length > 0) {
    log.warn(
      "railway-bootstrap: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback is still true although " +
        `allowedOrigins now covers ${origins.join(",")}. Disable it in the Control UI (Settings -> Gateway -> Control UI).`,
    );
  }
  return {
    action: plan.changed ? "updated" : "unchanged",
    configPath: paths.configPath,
    added: plan.added,
    publicOrigin: plan.publicOrigin,
    trustedProxies: plan.trustedProxies,
  };
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (trim(process.env.OPENCLAW_RAILWAY_SKIP_BOOTSTRAP) === "1") {
    console.info("railway-bootstrap: skipped (OPENCLAW_RAILWAY_SKIP_BOOTSTRAP=1).");
  } else {
    try {
      runBootstrap();
    } catch (error) {
      console.error(
        `railway-bootstrap: failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
