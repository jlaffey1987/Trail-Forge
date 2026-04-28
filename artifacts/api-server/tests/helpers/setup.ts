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

import { vi } from "vitest";
import type { Request } from "express";
import { MockSupa } from "./mockSupa";

let mockSupa = new MockSupa();
const aclState = { shouldFail: false };

export function getMockSupa(): MockSupa {
  return mockSupa;
}

export function resetMockSupa(): MockSupa {
  mockSupa = new MockSupa();
  aclState.shouldFail = false;
  return mockSupa;
}

export function setAclShouldFail(v: boolean): void {
  aclState.shouldFail = v;
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
    async trySetObjectEntityAclPolicy(): Promise<void> {
      if (aclState.shouldFail) throw new ObjectNotFoundError();
    }
  }
  return { ObjectNotFoundError, ObjectStorageService };
});
