#!/usr/bin/env node

try {
  require("./index.js");
} catch (err) {
  console.error("[agent] startup failed:", err);
  process.exit(1);
}
