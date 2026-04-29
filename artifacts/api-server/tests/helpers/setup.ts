/**
 * Vitest setup — register module-level mocks for `@clerk/express`,
 * the Supabase admin client, and ObjectStorage. Each test file gets a
 * fresh `MockSupa` instance via `resetMockSupa()` and an auth helper to
 * simulate signed-in / anonymous requests.
 *
 * `getAuth(req)` reads the per-request auth shim that `makeApp.ts` writes
 * onto the request object, so individual tests just call
 * `request(app(userId))` to authenticate.
 */

import { vi, type Mock } from "vitest";
import type { Request } from "express";
import { MockSupa } from "./mockSupa";

let mockSupa = new MockSupa();
const aclState = { shouldFail: false };

// `vi.mock(...)` factories are hoisted above imports, so any spies they
// reference must be declared via `vi.hoisted()` to avoid TDZ errors when
// the mocked module is resolved.
const objectStorageState = vi.hoisted(() => {
  const deleteObjectEntity = vi.fn(async (_path: string) => true);
  const trySetObjectEntityAclPolicy = vi.fn(
    async (_path: string, _opts: unknown) => {
      // The shouldFail flag is mirrored from the outer module on each
      // reset so this hoisted closure stays self-contained.
    },
  );
  return {
    deleteObjectEntity,
    trySetObjectEntityAclPolicy,
    aclShouldFail: { value: false },
  };
});

export function getMockSupa(): MockSupa {
  return mockSupa;
}

export function resetMockSupa(): MockSupa {
  mockSupa = new MockSupa();
  aclState.shouldFail = false;
  objectStorageState.aclShouldFail.value = false;
  objectStorageState.deleteObjectEntity.mockClear();
  objectStorageState.trySetObjectEntityAclPolicy.mockClear();
  return mockSupa;
}

export function setAclShouldFail(v: boolean): void {
  aclState.shouldFail = v;
  objectStorageState.aclShouldFail.value = v;
}

export function getObjectStorageMocks(): {
  deleteObjectEntity: Mock;
  trySetObjectEntityAclPolicy: Mock;
} {
  return {
    deleteObjectEntity: objectStorageState.deleteObjectEntity,
    trySetObjectEntityAclPolicy: objectStorageState.trySetObjectEntityAclPolicy,
  };
}

vi.mock("@clerk/express", () => {
  return {
    clerkMiddleware: () => (_req: Request, _res: unknown, next: () => void) => next(),
    getAuth: (req: Request) => {
      const auth = (req as Request & { __auth?: { userId: string | null } }).__auth;
      return auth ?? { userId: null };
    },
  };
});

vi.mock("../../src/lib/supabaseAdmin", () => ({
  getSupabaseAdmin: () => mockSupa,
}));

// `web-push` is a heavy native-ish module (gcm, jws, http2). We don't need
// the real thing in unit tests — we just need to make sure code that
// `import`s from it loads, and that `sendNotification` is observable so
// future fan-out tests can assert on it.
vi.mock("web-push", () => {
  const sendNotification = vi.fn(async () => ({ statusCode: 201 }));
  const setVapidDetails = vi.fn();
  const generateVAPIDKeys = vi.fn(() => ({
    publicKey: "test-public",
    privateKey: "test-private",
  }));
  return {
    default: { sendNotification, setVapidDetails, generateVAPIDKeys },
    sendNotification,
    setVapidDetails,
    generateVAPIDKeys,
  };
});

vi.mock("../../src/lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
    }
  }
  class ObjectStorageService {
    async getObjectEntityUploadURL(subPath: string): Promise<string> {
      return `https://upload.test/${subPath}`;
    }
    async trySetObjectEntityAclPolicy(
      path: string,
      opts: unknown,
    ): Promise<void> {
      await objectStorageState.trySetObjectEntityAclPolicy(path, opts);
      if (objectStorageState.aclShouldFail.value) {
        throw new ObjectNotFoundError();
      }
    }
    async deleteObjectEntity(path: string): Promise<boolean> {
      return objectStorageState.deleteObjectEntity(path);
    }
  }
  return { ObjectNotFoundError, ObjectStorageService };
});
