import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import meRouter from "./me";
import completionsRouter from "./completions";
import trailsRouter from "./trails";
import trailContentRouter from "./trailContent";
import groupsRouter from "./groups";
import aiRouter from "./ai";
import pushRouter from "./push";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(meRouter);
router.use(completionsRouter);
router.use(trailsRouter);
router.use(trailContentRouter);
router.use(groupsRouter);
router.use(aiRouter);
router.use(pushRouter);
router.use(chatRouter);

export default router;
