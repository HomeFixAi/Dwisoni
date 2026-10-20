import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quizBotRouter from "./quizBot";

const router: IRouter = Router();

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY,
  );
}

router.use(healthRouter);
if (isClerkConfigured()) {
  router.use(quizBotRouter);
} else {
  router.use((_req, res) => {
    res.status(503).json({ error: "Clerk autentifikatsiyasi sozlanmagan." });
  });
}

export default router;
