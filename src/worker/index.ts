import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth";
import { talentRoutes } from "./routes/talents";
import { tagRoutes } from "./routes/tags";
import { communicationRoutes } from "./routes/communications";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("/api/*", cors());

app.route("/api/auth", authRoutes);
app.route("/api/talents", talentRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/communications", communicationRoutes);

app.get("/api/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
