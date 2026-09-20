import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth";
import { talentRoutes } from "./routes/talents";
import { tagRoutes } from "./routes/tags";
import { communicationRoutes } from "./routes/communications";
import { riskRoutes } from "./routes/risks";
import { templateRoutes } from "./routes/templates";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  RESUMES: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("/api/*", cors());

// ---- API Routes ----
app.route("/api/auth", authRoutes);
app.route("/api/talents", talentRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/communications", communicationRoutes);
app.route("/api/risks", riskRoutes);
app.route("/api/templates", templateRoutes);

// ---- Health check ----
app.get("/api/health", (c) =>
  c.json({ status: "ok", time: new Date().toISOString() })
);

// ---- API 未匹配路径：明确返回 JSON 404 ----
// 必须放在下面 SPA 兜底之前。否则拼错的 /api/xxx 会落到静态资源兜底，
// 返回 index.html + 200，前端只看到 JSON 解析失败而不知道是路径写错了。
app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));

// ---- Fallback to static assets (SPA) ----
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
