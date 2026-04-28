import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import meRouter from "./me";
import trailsRouter from "./trails";
import trailContentRouter from "./trailContent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(meRouter);
router.use(trailsRouter);
router.use(trailContentRouter);

export default router;
