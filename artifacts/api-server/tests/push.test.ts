/**
 * Push subscription + preferences endpoints — backend coverage.
 *
 * Exercises:
 *   GET    /api/me/push/public-key    — returns 503 if VAPID env not set
 *   POST   /api/me/push/subscribe     — auth required, validates payload,
 *                                       upserts a `push_subscriptions` row
 *   DELETE /api/me/push/subscribe     — auth required, idempotent delete
 *                                       scoped to caller
 *   GET    /api/me/push/preferences   — defaults to true, reads users row
 *   PUT    /api/me/push/preferences   — auth required, persists toggle
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const USER_A = "user_alpha";
const USER_B = "user_beta";

function seedUsers() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: USER_A, push_notifications_enabled: true },
    { id: USER_B, push_notifications_enabled: false },
  ]);
  supa.seed("push_subscriptions", []);
  return supa;
}

const VAPID_KEYS_SAVE = {
  pub: process.env.VAPID_PUBLIC_KEY,
  priv: process.env.VAPID_PRIVATE_KEY,
};

beforeEach(() => {
  seedUsers();
});

afterEach(() => {
  if (VAPID_KEYS_SAVE.pub === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = VAPID_KEYS_SAVE.pub;
  if (VAPID_KEYS_SAVE.priv === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = VAPID_KEYS_SAVE.priv;
});

describe("GET /api/me/push/public-key", () => {
  it("returns 503 when VAPID is not configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const res = await request(makeApp(USER_A)).get("/api/me/push/public-key");
    expect(res.status).toBe(503);
    expect(res.body.configured).toBe(false);
  });

  it("returns the configured public key", async () => {
    process.env.VAPID_PUBLIC_KEY = "BPublicKeyForTesting12345";
    process.env.VAPID_PRIVATE_KEY = "PrivateKeyForTesting12345";
    const res = await request(makeApp(USER_A)).get("/api/me/push/public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("BPublicKeyForTesting12345");
  });

  it("does not require authentication (subscribe flow needs the key first)", async () => {
    process.env.VAPID_PUBLIC_KEY = "BPublicKeyForTesting12345";
    process.env.VAPID_PRIVATE_KEY = "PrivateKeyForTesting12345";
    const res = await request(makeApp(null)).get("/api/me/push/public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("BPublicKeyForTesting12345");
  });
});

describe("POST /api/me/push/subscribe", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp(null))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "p", auth: "a" },
      });
    expect(res.status).toBe(401);
  });

  it("rejects invalid payloads", async () => {
    const res = await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({ endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } });
    expect(res.status).toBe(400);
  });

  it("rejects endpoints outside the push-provider allowlist (SSRF guard)", async () => {
    const res = await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "https://attacker.example.com/internal/admin",
        keys: { p256dh: "p", auth: "a" },
      });
    expect(res.status).toBe(400);
    expect(getMockSupa().rows("push_subscriptions")).toHaveLength(0);
  });

  it("rejects http (non-https) endpoints", async () => {
    const res = await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "http://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "p", auth: "a" },
      });
    expect(res.status).toBe(400);
  });

  it("accepts Mozilla autopush endpoints", async () => {
    const res = await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint:
          "https://updates.push.services.mozilla.com/wpush/v2/abc-token",
        keys: { p256dh: "p", auth: "a" },
      });
    expect(res.status).toBe(200);
  });

  it("upserts a subscription row bound to the caller", async () => {
    const res = await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "pub-key", auth: "auth-secret" },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = getMockSupa().rows("push_subscriptions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER_A,
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "pub-key",
      auth: "auth-secret",
    });
    expect(rows[0]!.last_seen_at).toBeTruthy();
  });

  it("re-subscribing the same endpoint updates instead of duplicating", async () => {
    await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "v1", auth: "a1" },
      });
    await request(makeApp(USER_A))
      .post("/api/me/push/subscribe")
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "v2", auth: "a2" },
      });
    const rows = getMockSupa().rows("push_subscriptions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p256dh: "v2", auth: "a2" });
  });
});

describe("DELETE /api/me/push/subscribe", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp(null))
      .delete("/api/me/push/subscribe")
      .send({ endpoint: "https://fcm.googleapis.com/fcm/send/abc" });
    expect(res.status).toBe(401);
  });

  it("removes only the caller's matching endpoint", async () => {
    const supa = getMockSupa();
    supa.insertSeed("push_subscriptions", {
      user_id: USER_A,
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "p",
      auth: "a",
    });
    supa.insertSeed("push_subscriptions", {
      user_id: USER_B,
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "p",
      auth: "a",
    });
    const res = await request(makeApp(USER_A))
      .delete("/api/me/push/subscribe")
      .send({ endpoint: "https://fcm.googleapis.com/fcm/send/abc" });
    expect(res.status).toBe(200);
    const rows = getMockSupa().rows("push_subscriptions");
    // USER_B's row must remain — DELETE is scoped to the caller's user_id.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER_B);
  });

  it("is idempotent when the row doesn't exist", async () => {
    const res = await request(makeApp(USER_A))
      .delete("/api/me/push/subscribe")
      .send({ endpoint: "https://fcm.googleapis.com/fcm/send/never-registered" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("GET /api/me/push/preferences", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp(null)).get("/api/me/push/preferences");
    expect(res.status).toBe(401);
  });

  it("returns enabled=true for opt-in user", async () => {
    const res = await request(makeApp(USER_A)).get("/api/me/push/preferences");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it("returns enabled=false for opted-out user", async () => {
    const res = await request(makeApp(USER_B)).get("/api/me/push/preferences");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("defaults to enabled=true when the user row is missing", async () => {
    const res = await request(makeApp("user_unknown")).get(
      "/api/me/push/preferences",
    );
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});

describe("PUT /api/me/push/preferences", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp(null))
      .put("/api/me/push/preferences")
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it("rejects invalid payloads", async () => {
    const res = await request(makeApp(USER_A))
      .put("/api/me/push/preferences")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("persists the new preference", async () => {
    const res = await request(makeApp(USER_A))
      .put("/api/me/push/preferences")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    const row = getMockSupa()
      .rows("users")
      .find((r) => r.id === USER_A);
    expect(row?.push_notifications_enabled).toBe(false);
  });

  it("can re-enable after opting out", async () => {
    const res = await request(makeApp(USER_B))
      .put("/api/me/push/preferences")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    const row = getMockSupa()
      .rows("users")
      .find((r) => r.id === USER_B);
    expect(row?.push_notifications_enabled).toBe(true);
  });
});
