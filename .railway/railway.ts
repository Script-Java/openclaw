// Railway Infrastructure as Code for one OpenClaw Gateway service.
//
// Railway evaluates this file through its CLI (`railway config plan` /
// `railway config apply`, CLI 4.70+ with the `railway` npm package installed in
// the checkout). It replaces the deprecated railway.json config-as-code format.
// See docs/install/railway.mdx for the full deploy walkthrough.
//
// The service builds from Dockerfile.railway (selected with the
// RAILWAY_DOCKERFILE_PATH variable, the only way Railway accepts a custom
// Dockerfile path) and keeps all OpenClaw state on a volume mounted at /data.
// Every OpenClaw setting after first boot is edited in the Control UI, so the
// only variables here are the build selector and the admin token.
import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Name matches the volume Railway creates for a service by default so a plan
  // against an existing deployment does not propose a destructive replacement.
  const data = volume("openclaw-volume", { sizeMB: 1024 });

  const gateway = service("openclaw", {
    // Add `source: github("<owner>/openclaw", { branch: "main" })` to deploy
    // from GitHub on push; omit it to deploy with `railway up`.
    //
    // No Railway healthcheck on purpose: Railway only probes at deploy time,
    // from inside its edge range and without forwarded client headers, which
    // the Gateway rejects once that range is trusted for real browser traffic.
    // A volume-backed service has a cutover pause anyway, so the probe would
    // add nothing. The image's own HEALTHCHECK still covers container liveness.
    volumeMounts: {
      "/data": data,
    },
    env: {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.railway",
      // Set once with `railway variable set OPENCLAW_GATEWAY_TOKEN=...`;
      // preserve() keeps the value on Railway instead of in source.
      OPENCLAW_GATEWAY_TOKEN: preserve(),
    },
  });

  return project("openclaw", {
    resources: [gateway, data],
  });
});
