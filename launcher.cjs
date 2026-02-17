#!/usr/bin/env node

(async () => {
  await import("./index.js");
})().catch((err) => {
  console.error("[agent] startup failed:", err);
  process.exit(1);
});
