import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import meRouter from "./me";
import trailsRouter from "./trails";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(meRouter);
router.use(trailsRouter);

export default router;
