import { describe, expect, it } from "vitest";
import {
  freeUserTrailCreateBlocked,
  freeUserTrailUpdateBlocked,
} from "../src/lib/tierPolicy";

describe("tierPolicy", () => {
  it("blocks free users from private/group trail creation", () => {
    expect(freeUserTrailCreateBlocked({ privacy: "private", groupIds: [] })).toBe(true);
    expect(freeUserTrailCreateBlocked({ privacy: "group", groupIds: [] })).toBe(true);
    expect(freeUserTrailCreateBlocked({ privacy: "public", groupIds: ["g1"] })).toBe(true);
    expect(freeUserTrailCreateBlocked({ privacy: "public", groupIds: [] })).toBe(false);
  });

  it("blocks free users from private/group trail updates", () => {
    expect(
      freeUserTrailUpdateBlocked({ privacy: "private", isPublic: undefined, groupIds: null }),
    ).toBe(true);
    expect(
      freeUserTrailUpdateBlocked({ privacy: undefined, isPublic: false, groupIds: null }),
    ).toBe(true);
    expect(
      freeUserTrailUpdateBlocked({ privacy: undefined, isPublic: undefined, groupIds: ["g1"] }),
    ).toBe(true);
    expect(
      freeUserTrailUpdateBlocked({ privacy: "public", isPublic: true, groupIds: [] }),
    ).toBe(false);
  });
});
