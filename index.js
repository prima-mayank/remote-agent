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
const configuredDisplayId = String(process.env.REMOTE_DISPLAY_ID || "").trim();
const performanceMode = String(process.env.REMOTE_PERF_MODE || "auto").trim().toLowerCase();
const baseFps = Number.isFinite(Number(process.env.REMOTE_FPS))
  ? Number(process.env.REMOTE_FPS)
  : 6;
const minFps = Number.isFinite(Number(process.env.REMOTE_MIN_FPS))
  ? Number(process.env.REMOTE_MIN_FPS)
  : Math.max(1, Math.min(3, baseFps));
const inputFps = Number.isFinite(Number(process.env.REMOTE_ACTIVE_INPUT_FPS))
  ? Number(process.env.REMOTE_ACTIVE_INPUT_FPS)
  : Math.max(minFps, Math.min(3, baseFps));
const typingFps = Number.isFinite(Number(process.env.REMOTE_TYPING_FPS))
  ? Number(process.env.REMOTE_TYPING_FPS)
  : Math.max(1, Math.min(2, inputFps));
const inputWindowMs = Number.isFinite(Number(process.env.REMOTE_INPUT_WINDOW_MS))
  ? Number(process.env.REMOTE_INPUT_WINDOW_MS)
  : 1200;
const typingWindowMs = Number.isFinite(Number(process.env.REMOTE_TYPING_WINDOW_MS))
  ? Number(process.env.REMOTE_TYPING_WINDOW_MS)
  : 2200;
const slowCaptureThresholdMs = Number.isFinite(Number(process.env.REMOTE_SLOW_CAPTURE_MS))
  ? Number(process.env.REMOTE_SLOW_CAPTURE_MS)
  : 450;
const MAX_FRAME_BASE64_LENGTH = 800_000;

if (!hostId) {
  console.error("[agent] REMOTE_HOST_ID cannot be empty.");
  process.exit(1);
}

console.log(`[agent] booting...`);
console.log(`[agent] server: ${serverUrl}`);
console.log(`[agent] host: ${hostId}`);
console.log(`[agent] fps: ${Math.max(1, baseFps)} (mode=${performanceMode || "auto"})`);
if (performanceMode === "auto") {
  console.log(
    `[agent] perf profile: min=${Math.max(1, minFps)} input=${Math.max(
      1,
      inputFps
    )} typing=${Math.max(1, typingFps)}`
  );
}
if (configuredDisplayId) {
  console.log(`[agent] display (configured): ${configuredDisplayId}`);
}

let activeSessionId = "";
let captureTimer = null;
let captureLoopRunning = false;
let captureInProgress = false;
let inputBridge = null;
let resolvedDisplayId = configuredDisplayId;
let resolvedDisplayBounds = null;
let displayResolved = false;
let lastInputAt = 0;
let lastTypingAt = 0;
let slowCaptureBackoffUntil = 0;

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toDisplayBounds = (display) => {
  if (!display) return null;
  const left = toFiniteNumber(display.left);
  const top = toFiniteNumber(display.top);
  const width = toFiniteNumber(display.width);
  const height = toFiniteNumber(display.height);

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return { left, top, width, height };
};

const resolveDisplayId = async () => {
  if (displayResolved) return resolvedDisplayId;
  displayResolved = true;

  try {
    const displays = await screenshot.listDisplays();
    if (Array.isArray(displays) && displays.length > 0) {
      const normalizedDisplays = displays
        .map((display) => ({
          ...display,
          id: String(display?.id || "").trim(),
        }))
        .filter((display) => !!display.id);

      let selectedDisplay = null;
      if (configuredDisplayId) {
        selectedDisplay = normalizedDisplays.find(
          (display) => display.id === configuredDisplayId
        );
        if (!selectedDisplay) {
          console.warn(
            `[agent] configured display id '${configuredDisplayId}' not found. Falling back to auto selection.`
          );
        }
      }

      const originDisplay = normalizedDisplays.find(
        (display) => Number(display.left) === 0 && Number(display.top) === 0
      );
      if (!selectedDisplay) {
        selectedDisplay = originDisplay || normalizedDisplays[0];
      }

      if (selectedDisplay?.id) {
        resolvedDisplayId = selectedDisplay.id;
        resolvedDisplayBounds = toDisplayBounds(selectedDisplay);

        const width = Number(selectedDisplay.width);
        const height = Number(selectedDisplay.height);
        const left = Number(selectedDisplay.left);
        const top = Number(selectedDisplay.top);
        const sizeLabel =
          Number.isFinite(width) && Number.isFinite(height)
            ? ` ${width}x${height}`
            : "";
        const originLabel =
          Number.isFinite(left) && Number.isFinite(top)
            ? ` @(${left},${top})`
            : "";

        console.log(
          `[agent] display (${configuredDisplayId ? "resolved" : "auto"}): ${selectedDisplay.id}${sizeLabel}${originLabel}`
        );
      }
    }
  } catch (err) {
    console.warn("[agent] failed to resolve display list; falling back to default capture.");
    if (configuredDisplayId) {
      resolvedDisplayId = configuredDisplayId;
    }
  }

  return resolvedDisplayId;
};

const getEffectiveCaptureFps = () => {
  const normalizedBaseFps = Math.max(1, baseFps);
  if (performanceMode !== "auto") {
    return normalizedBaseFps;
  }

  const now = Date.now();
  const normalizedMinFps = Math.max(1, Math.min(minFps, normalizedBaseFps));
  const normalizedInputFps = Math.max(
    normalizedMinFps,
    Math.min(inputFps, normalizedBaseFps)
  );
  const normalizedTypingFps = Math.max(
    1,
    Math.min(typingFps, normalizedInputFps)
  );

  if (now - lastTypingAt <= typingWindowMs) {
    return normalizedTypingFps;
  }

  if (now - lastInputAt <= inputWindowMs) {
    return normalizedInputFps;
  }

  if (now <= slowCaptureBackoffUntil) {
    return normalizedInputFps;
  }

  return normalizedBaseFps;
};

const scheduleNextCapture = (delayMs = null) => {
  if (!captureLoopRunning || !activeSessionId) return;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }

  const effectiveFps = getEffectiveCaptureFps();
  const computedDelay = Math.max(80, Math.floor(1000 / Math.max(1, effectiveFps)));
  const nextDelay = Number.isFinite(Number(delayMs))
    ? Math.max(0, Math.floor(Number(delayMs)))
    : computedDelay;

  captureTimer = setTimeout(() => {
    captureTimer = null;
    void sendFrame();
  }, nextDelay);
};

const startInputBridge = async () => {
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

  await resolveDisplayId();

  const bridgeEnv = { ...process.env };
  if (resolvedDisplayBounds) {
    bridgeEnv.REMOTE_DISPLAY_LEFT = String(resolvedDisplayBounds.left);
    bridgeEnv.REMOTE_DISPLAY_TOP = String(resolvedDisplayBounds.top);
    bridgeEnv.REMOTE_DISPLAY_WIDTH = String(resolvedDisplayBounds.width);
    bridgeEnv.REMOTE_DISPLAY_HEIGHT = String(resolvedDisplayBounds.height);
  }

  inputBridge = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      stdio: ["pipe", "inherit", "inherit"],
      env: bridgeEnv,
    }
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
    const payload = resolvedDisplayBounds
      ? {
          ...event,
          __display: resolvedDisplayBounds,
        }
      : event;
    inputBridge.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.error("[agent] failed writing to input bridge:", err.message);
  }
};

const stopCaptureLoop = () => {
  captureLoopRunning = false;
  if (!captureTimer) return;
  clearTimeout(captureTimer);
  captureTimer = null;
};

const socket = io(serverUrl, {
  auth: remoteControlToken ? { token: remoteControlToken } : undefined,
  transports: ["polling", "websocket"],
});

const sendFrame = async () => {
  if (!activeSessionId || !captureLoopRunning) return;
  if (captureInProgress) {
    scheduleNextCapture(60);
    return;
  }

  const captureStartedAt = Date.now();
  captureInProgress = true;
  try {
    const displayId = await resolveDisplayId();
    const captureOptions = displayId
      ? { format: "jpg", screen: displayId }
      : { format: "jpg" };
    const frame = await screenshot(captureOptions);
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
    const captureDurationMs = Date.now() - captureStartedAt;
    if (performanceMode === "auto" && captureDurationMs >= slowCaptureThresholdMs) {
      slowCaptureBackoffUntil = Date.now() + 1600;
    }
    captureInProgress = false;
    scheduleNextCapture();
  }
};

const startCaptureLoop = () => {
  captureLoopRunning = true;
  scheduleNextCapture(0);
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

  const now = Date.now();
  lastInputAt = now;
  if (event.type === "key-down" || event.type === "key-up") {
    lastTypingAt = now;
  }

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

startInputBridge().catch((err) => {
  console.error("[agent] failed to start input bridge:", err?.message || err);
});

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
