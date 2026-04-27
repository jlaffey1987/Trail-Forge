import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { CreateTrailBody, CreateTrailResponse } from "@workspace/api-zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

const router: IRouter = Router();

router.post("/trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = CreateTrailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required trail fields" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const insert: Record<string, unknown> = {
      ...parsed.data,
      owner_user_id: auth.userId,
    };
    const { data, error } = await supa
      .from("trails")
      .insert(insert)
      .select()
      .single();
    if (error) {
      req.log.error({ err: error }, "createTrail failed");
      res.status(500).json({ error: "Failed to create trail" });
      return;
    }
    res.json(CreateTrailResponse.parse(data));
  } catch (err) {
    req.log.error({ err }, "createTrail failed");
    res.status(500).json({ error: "Failed to create trail" });
  }
});

export default router;
