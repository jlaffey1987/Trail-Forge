import { test, expect } from "@playwright/test";
import { signInAsE2EUser, supabaseAdmin } from "./helpers";
import { loadE2EState } from "./global-setup";

test.describe("chat inbox flow @e2e", () => {
  test("opens inbox from header badge, sees empty state, navigates back", async ({
    page,
  }) => {
    await signInAsE2EUser(page);

    await page.waitForSelector('[data-testid="chat-messages-badge"]', {
      timeout: 30_000,
    });

    const badge = page.locator('[data-testid="chat-messages-badge"]');
    await expect(badge).toBeVisible();

    await badge.click();

    await expect(page).toHaveURL(/\/messages/);

    const inbox = page.locator('[data-testid="chat-inbox"]');
    await expect(inbox).toBeVisible({ timeout: 10_000 });

    const heading = inbox.getByText("Messages");
    await expect(heading).toBeVisible();

    const back = page.locator('[data-testid="chat-inbox-back"]');
    await expect(back).toBeVisible();
    await back.click();

    await expect(page).not.toHaveURL(/\/messages/);

    await expect(badge).toBeVisible({ timeout: 10_000 });
  });

  test("opens group chat room, sends a message, sees it in thread", async ({
    page,
  }) => {
    const { userId } = loadE2EState();
    const supa = supabaseAdmin();

    const groupName = `e2e-chat-group-${Date.now()}`;
    const { data: group } = await supa
      .from("groups")
      .insert({ name: groupName, created_by: userId })
      .select("id")
      .single();
    const groupId = (group as { id: string }).id;

    await supa.from("group_members").insert({
      group_id: groupId,
      user_id: userId,
      role: "owner",
    });

    const { data: chatRoom } = await supa
      .from("chat_rooms")
      .select("id")
      .eq("group_id", groupId)
      .eq("kind", "group")
      .maybeSingle();

    let roomId: string;
    if (chatRoom) {
      roomId = (chatRoom as { id: string }).id;
    } else {
      const { data: newRoom } = await supa
        .from("chat_rooms")
        .insert({ kind: "group", group_id: groupId })
        .select("id")
        .single();
      roomId = (newRoom as { id: string }).id;
      await supa.from("chat_room_members").insert({
        room_id: roomId,
        user_id: userId,
        role: "member",
      });
    }

    const hasMember = await supa
      .from("chat_room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!hasMember.data) {
      await supa.from("chat_room_members").insert({
        room_id: roomId,
        user_id: userId,
        role: "member",
      });
    }

    await signInAsE2EUser(page);

    await page.waitForSelector('[data-testid="chat-messages-badge"]', {
      timeout: 30_000,
    });
    await page.locator('[data-testid="chat-messages-badge"]').click();
    await expect(page).toHaveURL(/\/messages/);

    const roomLink = page.locator(`[data-testid="chat-room-${roomId}"]`);
    await expect(roomLink).toBeVisible({ timeout: 10_000 });
    await roomLink.click();

    await expect(page).toHaveURL(new RegExp(`/messages/${roomId}`));

    const composer = page.locator('[data-testid="chat-composer-input"]');
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const testMessage = `e2e-msg-${Date.now()}`;
    await composer.fill(testMessage);

    const sendBtn = page.locator('[data-testid="chat-send-button"]');
    await sendBtn.click();

    const sentMsg = page.locator(`text=${testMessage}`);
    await expect(sentMsg).toBeVisible({ timeout: 15_000 });

    await supa.from("chat_messages").delete().eq("room_id", roomId);
    await supa.from("chat_room_members").delete().eq("room_id", roomId);
    await supa.from("chat_rooms").delete().eq("id", roomId);
    await supa.from("group_members").delete().eq("group_id", groupId);
    await supa.from("groups").delete().eq("id", groupId);
  });
});
