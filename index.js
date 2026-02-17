import os from "os";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import screenshot from "screenshot-desktop";
import { io } from "socket.io-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveEnvPath = () => {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(process.execPath), ".env"),
    path.join(__dirname, ".env"),
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) return envPath;
  }

  return "";
};

const envPath = resolveEnvPath();
if (envPath) {
  dotenv.config({ path: envPath, quiet: true });
}

const serverUrl = process.env.REMOTE_SERVER_URL || "http://localhost:5000";
const remoteControlToken = String(process.env.REMOTE_CONTROL_TOKEN || "").trim();
const hostId = String(process.env.REMOTE_HOST_ID || os.hostname()).trim();
const fps = Number.isFinite(Number(process.env.REMOTE_FPS))
  ? Number(process.env.REMOTE_FPS)
  : 6;
const captureIntervalMs = Math.max(120, Math.floor(1000 / Math.max(1, fps)));
const MAX_FRAME_BASE64_LENGTH = 800_000;

if (!hostId) {
  console.error("[agent] REMOTE_HOST_ID cannot be empty.");
  process.exit(1);
}

console.log(`[agent] booting...`);
console.log(`[agent] server: ${serverUrl}`);
console.log(`[agent] host: ${hostId}`);
console.log(`[agent] fps: ${Math.max(1, fps)}`);

let activeSessionId = "";
let captureTimer = null;
let captureInProgress = false;
let inputBridge = null;

const startInputBridge = () => {
  if (process.platform !== "win32") {
    console.warn(
      "[agent] input bridge is Windows-only right now. Frames will stream but control input is disabled."
    );
    return;
  }

  const scriptCandidates = [
    path.join(process.cwd(), "scripts", "windowsInputBridge.ps1"),
    path.join(path.dirname(process.execPath), "scripts", "windowsInputBridge.ps1"),
    path.join(__dirname, "scripts", "windowsInputBridge.ps1"),
  ];

  const scriptPath = scriptCandidates.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) {
    console.error("[agent] windowsInputBridge.ps1 not found. Input control is unavailable.");
    return;
  }

  inputBridge = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: ["pipe", "inherit", "inherit"] }
  );

  inputBridge.on("exit", (code) => {
    console.error(`[agent] input bridge exited with code ${code}`);
  });
};

const stopInputBridge = () => {
  if (!inputBridge) return;
  try {
    inputBridge.kill();
  } catch (e) {
    // noop
  }
  inputBridge = null;
};

const sendToInputBridge = (event) => {
  if (!inputBridge || inputBridge.killed) return;
  try {
    inputBridge.stdin.write(`${JSON.stringify(event)}\n`);
  } catch (err) {
    console.error("[agent] failed writing to input bridge:", err.message);
  }
};

const stopCaptureLoop = () => {
  if (!captureTimer) return;
  clearInterval(captureTimer);
  captureTimer = null;
};

const socket = io(serverUrl, {
  auth: remoteControlToken ? { token: remoteControlToken } : undefined,
  transports: ["polling", "websocket"],
});

const sendFrame = async () => {
  if (!activeSessionId || captureInProgress) return;

  captureInProgress = true;
  try {
    const frame = await screenshot({ format: "jpg" });
    const image = frame.toString("base64");
    if (!image || image.length > MAX_FRAME_BASE64_LENGTH) {
      return;
    }

    socket.emit("remote-host-frame", {
      sessionId: activeSessionId,
      image,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[agent] frame capture failed:", err.message);
  } finally {
    captureInProgress = false;
  }
};

const startCaptureLoop = () => {
  if (captureTimer) return;
  captureTimer = setInterval(sendFrame, captureIntervalMs);
  sendFrame();
};

socket.on("connect", () => {
  console.log(`[agent] connected to ${serverUrl}`);
  socket.emit("remote-host-register", { hostId });
});

socket.on("connect_error", (error) => {
  console.error(`[agent] connect error: ${error.message}`);
});

socket.on("remote-host-registered", ({ hostId: registeredHostId }) => {
  console.log("[agent] host registered.");
  console.log(`[agent] Host ID: ${registeredHostId}`);
});

socket.on("remote-session-started", ({ sessionId, hostId: sessionHostId }) => {
  if (!sessionId || sessionHostId !== hostId) return;
  activeSessionId = sessionId;
  console.log(`[agent] remote session started: ${sessionId}`);
  startCaptureLoop();
});

socket.on("remote-session-ended", ({ sessionId }) => {
  if (!sessionId || sessionId !== activeSessionId) return;
  console.log(`[agent] remote session ended: ${sessionId}`);
  activeSessionId = "";
  stopCaptureLoop();
});

socket.on("remote-input", ({ sessionId, event }) => {
  if (!sessionId || !event) return;
  if (sessionId !== activeSessionId) return;
  sendToInputBridge(event);
});

socket.on("remote-session-error", ({ message, code }) => {
  const errorMessage =
    typeof message === "string" && message.trim() ? message.trim() : "Unknown error";
  console.error(`[agent] session error (${code || "unknown"}): ${errorMessage}`);
});

socket.on("disconnect", () => {
  console.log("[agent] disconnected.");
  activeSessionId = "";
  stopCaptureLoop();
});

startInputBridge();

const shutdown = () => {
  stopCaptureLoop();
  stopInputBridge();
  try {
    socket.disconnect();
  } catch (e) {
    // noop
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
