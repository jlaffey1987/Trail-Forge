import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  loadE2EState,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
  E2E_USER_VERIFICATION_CODE,
} from "./global-setup";

test.describe("trail detail flow @e2e", () => {
  test("posts a note, proposes an amendment, and the trail-card counts increment", async ({
    page,
  }) => {
    const { trailId } = loadE2EState();

    // Bypass Clerk's bot detection on the dev instance.
    await setupClerkTestingToken({ page });

    // Hit the home page first so <ClerkProvider> can mount and expose the
    // global `Clerk` helper that `clerk.signIn` drives. We also wait for the
    // app shell to settle before kicking off the programmatic sign-in.
    await page.goto("/");
    await page.waitForFunction(
      () => Boolean((window as unknown as { Clerk?: { loaded?: boolean } }).Clerk?.loaded),
      undefined,
      { timeout: 30_000 },
    );

    // The Clerk dev instance enforces password + email_code MFA. Drive the
    // sign-in directly through `window.Clerk` so we can also handle the
    // second factor with the well-known "+clerk_test" verification code.
    const signInResult = await page.evaluate(
      async ({ identifier, password, code }) => {
        type SignInAttempt = {
          status: string;
          createdSessionId: string | null;
          supportedFirstFactors?: unknown;
          supportedSecondFactors?: { strategy: string }[];
          prepareSecondFactor: (p: {
            strategy: string;
          }) => Promise<SignInAttempt>;
          attemptSecondFactor: (p: {
            strategy: string;
            code: string;
          }) => Promise<SignInAttempt>;
        };
        const w = window as unknown as {
          Clerk: {
            client: {
              signIn: {
                create: (p: unknown) => Promise<SignInAttempt>;
              };
            };
            setActive: (p: { session: string }) => Promise<void>;
            user: unknown;
          };
        };
        try {
          let attempt = await w.Clerk.client.signIn.create({
            strategy: "password",
            identifier,
            password,
          });
          if (attempt.status === "needs_second_factor") {
            const supports = (attempt.supportedSecondFactors ?? []).some(
              (f) => f.strategy === "email_code",
            );
            if (!supports) {
              return {
                ok: false,
                status: attempt.status,
                secondFactors: attempt.supportedSecondFactors,
              };
            }
            await attempt.prepareSecondFactor({ strategy: "email_code" });
            attempt = await attempt.attemptSecondFactor({
              strategy: "email_code",
              code,
            });
          }
          if (attempt.status !== "complete" || !attempt.createdSessionId) {
            return {
              ok: false,
              status: attempt.status,
              firstFactors: attempt.supportedFirstFactors,
              secondFactors: attempt.supportedSecondFactors,
            };
          }
          await w.Clerk.setActive({ session: attempt.createdSessionId });
          return { ok: true, status: attempt.status };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      {
        identifier: E2E_USER_EMAIL,
        password: E2E_USER_PASSWORD,
        code: E2E_USER_VERIFICATION_CODE,
      },
    );
    expect(signInResult.ok, JSON.stringify(signInResult)).toBe(true);

    // Wait for Clerk to actually surface a signed-in user before navigating —
    // signIn() resolves on API success but the SDK still needs a tick to push
    // the user into React state.
    await page.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user,
        ),
      undefined,
      { timeout: 15_000 },
    );

    // Land on Discover with the seeded trail's detail sheet pre-opened. The
    // ?trail= effect fires once the trails list has loaded, so we wait on the
    // sheet's name element rather than racing it.
    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });

    // Sheet header counts start at 0 / 0 / 0 for a freshly-cleaned trail.
    const counts = page.getByTestId("trail-detail-counts");
    await expect(counts).toHaveText(/0 notes\s*·\s*0 photos\s*·\s*0 pending edits/);

    // ---- Notes ----
    await page.getByTestId("trail-tab-notes").click();
    const notesPanel = page.getByTestId("trail-notes-panel");
    await expect(notesPanel).toBeVisible();

    const noteBody = `e2e note · ${Date.now()}`;
    await page.getByTestId("note-input").fill(noteBody);
    await page.getByTestId("note-submit").click();

    await expect(notesPanel.getByText(noteBody)).toBeVisible();
    await expect(counts).toHaveText(/1 notes\s*·\s*0 photos\s*·\s*0 pending edits/);
    await expect(
      page.getByTestId("trail-tab-notes").getByText("1", { exact: true }),
    ).toBeVisible();

    // ---- Amendments ----
    await page.getByTestId("trail-tab-amendments").click();
    const amendmentsPanel = page.getByTestId("trail-amendments-panel");
    await expect(amendmentsPanel).toBeVisible();

    await amendmentsPanel.getByTestId("amendment-toggle-form").click();

    const difficulty = page.getByTestId("amendment-difficulty");
    await difficulty.fill("");
    await difficulty.fill("7");

    const reason = `Re-rated harder after recent rain · ${Date.now()}`;
    await page.getByTestId("amendment-reason").fill(reason);

    await page.getByTestId("amendment-submit").click();

    // The new amendment row should be visible with our reason text.
    await expect(amendmentsPanel.getByText(reason)).toBeVisible();

    await expect(counts).toHaveText(
      /1 notes\s*·\s*0 photos\s*·\s*1 pending edits/,
    );
    await expect(
      page.getByTestId("trail-tab-amendments").getByText("1", { exact: true }),
    ).toBeVisible();

    // ---- Close + verify the card on Discover updates too ----
    await page.getByRole("button", { name: "Close" }).first().click();

    // Activity counts on the Discover card are fetched once on mount, so a
    // reload guarantees a fresh fetch rather than depending on background
    // polling.
    await page.reload();
    await expect(page.getByTestId(`discover-card-${trailId}`)).toBeVisible();
    await expect(
      page.getByTestId(`trail-card-counts-${trailId}`),
    ).toHaveText(/1 notes\s*·\s*0 photos\s*·\s*1 pending/);
  });
});
