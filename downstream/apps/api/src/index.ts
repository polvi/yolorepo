import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { webOrigin } from "./env";
import { authenticate, oauthRoutes, unauthorized } from "./oauth";
import { handleMcp, PROTOCOL_VERSION } from "./mcp";
import { restRoutes } from "./rest";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());
app.route("/", oauthRoutes);
app.route("/", restRoutes);

app.post("/mcp", async (c) => {
  const user = await authenticate(c.env, c.req.raw);
  if (!user) return unauthorized(c.env);
  return handleMcp(c.env, c.req.raw, user);
});

// Streamable HTTP: GET on the MCP endpoint is not a message channel here
// (no server-initiated notifications); a browser hitting it gets pointed
// at the human-facing site.
app.get("/mcp", (c) =>
  c.json({ name: "downstream", protocol: PROTOCOL_VERSION, hint: `MCP endpoint — POST JSON-RPC here. Humans: ${webOrigin(c.env)}` }, 405),
);

app.get("/", (c) => c.redirect(webOrigin(c.env), 302));

export default app;
