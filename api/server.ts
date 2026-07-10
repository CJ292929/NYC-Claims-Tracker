/**
 * Vercel Serverless Function entry point.
 *
 * This file wraps the Express app for Vercel's Node.js runtime.
 * It exports the Express app as the default export so Vercel can
 * invoke it as a serverless function.
 *
 * The frontend static files are served from the `dist/` directory
 * which Vite builds into. Vercel serves them automatically via the
 * outputDirectory setting in vercel.json.
 */
import "dotenv/config";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "../server/_core/oauth";
import { registerStorageProxy } from "../server/_core/storageProxy";
import { registerClaimUploadRoute } from "../server/claimUpload";
import { appRouter } from "../server/routers";
import { createContext } from "../server/_core/context";
import { serveStatic } from "../server/_core/vite";

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

registerStorageProxy(app);
registerOAuthRoutes(app);
registerClaimUploadRoute(app);

app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
  })
);

// Serve the Vite-built frontend static files
serveStatic(app);

export default app;
