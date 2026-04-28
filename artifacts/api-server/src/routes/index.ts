import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import meRouter from "./me";
import trailsRouter from "./trails";
import trailContentRouter from "./trailContent";
import groupsRouter from "./groups";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(meRouter);
router.use(trailsRouter);
router.use(trailContentRouter);
router.use(groupsRouter);

export default router;
