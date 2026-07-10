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
 *
 * This file is bundled by esbuild into api/server.js (see the "build"
 * script in package.json). It intentionally does NOT live under api/
 * itself — Vercel's zero-config routing treats any file under api/ as
 * its own route by basename, so a TS source file here would collide
 * with the compiled api/server.js output of the same name.
 */
import "dotenv/config";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./_core/oauth";
import { registerStorageProxy } from "./_core/storageProxy";
import { registerClaimUploadRoute } from "./claimUpload";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { serveStatic } from "./_core/vite";

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
