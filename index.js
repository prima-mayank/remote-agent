const os = require("os");
const path = require("path");
const fs = require("fs");
const { randomBytes } = require("crypto");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const screenshot = require("screenshot-desktop");
const { io } = require("socket.io-client");

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

const sanitizeHostId = (value, maxLength = 64) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, maxLength);

const sanitizeToken = (value, maxLength = 256) =>
  String(value || "")
    .trim()
    .slice(0, maxLength);

const normalizeServerUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
};

const toPositiveNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseLaunchOverrides = (argv = []) => {
  const overrides = {
    serverUrl: "",
    hostId: "",
    remoteControlToken: "",
    displayId: "",
    fps: null,
    source: "",
  };

  const applyProtocolUrl = (candidate) => {
    const rawCandidate = String(candidate || "").trim();
    if (!rawCandidate) return false;

    let parsed;
    try {
      parsed = new URL(rawCandidate);
    } catch {
      return false;
    }

    if (String(parsed.protocol || "").toLowerCase() !== "hostapp:") {
      return false;
    }

    const protocolServerUrl = normalizeServerUrl(
      parsed.searchParams.get("server") ||
        parsed.searchParams.get("serverUrl") ||
        parsed.searchParams.get("url")
    );
    const protocolHostId = sanitizeHostId(
      parsed.searchParams.get("hostId") ||
        parsed.searchParams.get("hostid") ||
        parsed.searchParams.get("id"),
      64
    );
    const protocolToken = sanitizeToken(
      parsed.searchParams.get("token") ||
        parsed.searchParams.get("authToken") ||
        parsed.searchParams.get("auth"),
      256
    );
    const protocolDisplayId = String(
      parsed.searchParams.get("displayId") ||
        parsed.searchParams.get("display") ||
        ""
    ).trim();
    const protocolFps = toPositiveNumber(parsed.searchParams.get("fps"));

    if (protocolServerUrl) overrides.serverUrl = protocolServerUrl;
    if (protocolHostId) overrides.hostId = protocolHostId;
    if (protocolToken) overrides.remoteControlToken = protocolToken;
    if (protocolDisplayId) overrides.displayId = protocolDisplayId;
    if (protocolFps) overrides.fps = protocolFps;

    overrides.source = "protocol";
    return true;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg) continue;

    if (applyProtocolUrl(arg)) continue;

    if (arg.startsWith("--server=")) {
      const serverUrl = normalizeServerUrl(arg.slice("--server=".length));
      if (serverUrl) overrides.serverUrl = serverUrl;
      if (!overrides.source) overrides.source = "cli";
      continue;
    }

    if (arg.startsWith("--host-id=")) {
      const hostId = sanitizeHostId(arg.slice("--host-id=".length), 64);
      if (hostId) overrides.hostId = hostId;
      if (!overrides.source) overrides.source = "cli";
      continue;
    }

    if (arg.startsWith("--token=")) {
      const token = sanitizeToken(arg.slice("--token=".length), 256);
      if (token) overrides.remoteControlToken = token;
      if (!overrides.source) overrides.source = "cli";
      continue;
    }

    if (arg.startsWith("--display-id=")) {
      const displayId = String(arg.slice("--display-id=".length) || "").trim();
      if (displayId) overrides.displayId = displayId;
      if (!overrides.source) overrides.source = "cli";
      continue;
    }

    if (arg.startsWith("--fps=")) {
      const fps = toPositiveNumber(arg.slice("--fps=".length));
      if (fps) overrides.fps = fps;
      if (!overrides.source) overrides.source = "cli";
    }
  }

  return overrides;
};

const buildGeneratedHostId = () => {
  const hostPart = sanitizeHostId(os.hostname(), 20) || "device";
  const randomPart = randomBytes(3).toString("hex");
  return sanitizeHostId(`host-${hostPart}-${randomPart}`, 64);
};

const getUserHostIdStoragePath = () => {
  const appDataPath = String(process.env.APPDATA || "").trim();
  if (appDataPath) {
    return path.join(appDataPath, "calling-app-host-agent", ".host-id");
  }

  const homePath = String(os.homedir() || "").trim();
  if (homePath) {
    return path.join(homePath, ".calling-app-host-id");
  }

  return "";
};

const getHostIdStoragePathCandidates = () => {
  const envDerivedHostIdPath = envPath
    ? path.join(path.dirname(envPath), ".host-id")
    : "";
  const candidates = [
    path.join(process.cwd(), ".host-id"),
    envDerivedHostIdPath,
    path.join(path.dirname(process.execPath), ".host-id"),
  ];
  const userHostIdPath = getUserHostIdStoragePath();
  if (userHostIdPath) {
    candidates.push(userHostIdPath);
  }

  const normalizedCandidates = candidates
    .map((candidate) => String(candidate || "").trim())
    .filter((candidate) => !!candidate)
    .map((candidate) => path.resolve(candidate));

  return [...new Set(normalizedCandidates)];
};

const readPersistedHostId = () => {
  for (const hostIdPath of getHostIdStoragePathCandidates()) {
    try {
      if (!fs.existsSync(hostIdPath)) continue;
      const persistedHostId = sanitizeHostId(fs.readFileSync(hostIdPath, "utf8"), 64);
      if (persistedHostId) {
        return { hostId: persistedHostId, path: hostIdPath };
      }
    } catch {
      // noop
    }
  }
  return null;
};

const persistHostId = (hostId) => {
  for (const hostIdPath of getHostIdStoragePathCandidates()) {
    try {
      const hostIdDirPath = path.dirname(hostIdPath);
      if (!fs.existsSync(hostIdDirPath)) {
        fs.mkdirSync(hostIdDirPath, { recursive: true });
      }
      fs.writeFileSync(hostIdPath, `${hostId}\n`, "utf8");
      return hostIdPath;
    } catch {
      // try next path
    }
  }
  return "";
};

const resolveHostId = (overrideHostId = "") => {
  const normalizedOverrideHostId = sanitizeHostId(overrideHostId, 64);
  if (normalizedOverrideHostId) {
    const persistedPath = persistHostId(normalizedOverrideHostId);
    console.log(
      `[agent] using launch-provided host id '${normalizedOverrideHostId}'.`
    );
    if (persistedPath) {
      console.log(`[agent] persisted host id at ${persistedPath}`);
    }
    return normalizedOverrideHostId;
  }

  if (String(overrideHostId || "").trim() && !normalizedOverrideHostId) {
    console.warn(
      `[agent] launch host id '${overrideHostId}' became empty after sanitization.`
    );
  }

  const rawHostId = String(process.env.REMOTE_HOST_ID || "").trim();
  const normalizedHostId = sanitizeHostId(rawHostId, 64);
  const placeholderIds = new Set(["host1", "host-local-main", "host-local-peer", "host"]);
  const shouldAutoGenerate =
    !normalizedHostId || placeholderIds.has(normalizedHostId.toLowerCase());

  if (!shouldAutoGenerate) {
    if (rawHostId !== normalizedHostId) {
      console.log(
        `[agent] REMOTE_HOST_ID '${rawHostId}' normalized to '${normalizedHostId}'.`
      );
    }
    return normalizedHostId;
  }

  if (rawHostId && !normalizedHostId) {
    console.warn(
      `[agent] REMOTE_HOST_ID '${rawHostId}' became empty after sanitization. Generating host id.`
    );
  }

  const persisted = readPersistedHostId();
  if (persisted?.hostId) {
    if (rawHostId) {
      console.log(
        `[agent] REMOTE_HOST_ID '${rawHostId}' is a default placeholder. Using saved host id '${persisted.hostId}'.`
      );
    }
    return persisted.hostId;
  }

  const generatedHostId = buildGeneratedHostId();
  const persistedPath = persistHostId(generatedHostId);
  if (rawHostId) {
    console.log(
      `[agent] REMOTE_HOST_ID '${rawHostId}' is a default placeholder. Generated host id '${generatedHostId}'.`
    );
  } else {
    console.log(`[agent] REMOTE_HOST_ID not set. Generated host id '${generatedHostId}'.`);
  }
  if (persistedPath) {
    console.log(`[agent] persisted host id at ${persistedPath}`);
  } else {
    console.warn(
      "[agent] failed to persist generated host id. Host id may change after restart."
    );
  }
  return generatedHostId;
};

const launchOverrides = parseLaunchOverrides(process.argv.slice(2));
const serverUrl =
  launchOverrides.serverUrl ||
  process.env.REMOTE_SERVER_URL ||
  (String(process.env.REMOTE_USE_LOCALHOST || "").trim() === "1" &&
    "http://localhost:5000") ||
  "https://calling-app-backend-1.onrender.com";
const remoteControlToken =
  launchOverrides.remoteControlToken ||
  sanitizeToken(process.env.REMOTE_CONTROL_TOKEN || "", 256);
const hostId = resolveHostId(launchOverrides.hostId);
const remoteDebugEnabled = String(process.env.REMOTE_DEBUG || "").trim() === "1";
const configuredDisplayId = String(
  launchOverrides.displayId || process.env.REMOTE_DISPLAY_ID || ""
).trim();
const performanceMode = String(process.env.REMOTE_PERF_MODE || "auto")
  .trim()
  .toLowerCase();
const baseFps = Number.isFinite(Number(launchOverrides.fps))
  ? Number(launchOverrides.fps)
  : Number.isFinite(Number(process.env.REMOTE_FPS))
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
if (launchOverrides.source === "protocol") {
  console.log("[agent] launch source: hostapp protocol.");
}
if (launchOverrides.serverUrl) {
  console.log("[agent] server overridden by launch payload.");
}
if (launchOverrides.hostId) {
  console.log("[agent] host id overridden by launch payload.");
}
if (launchOverrides.remoteControlToken) {
  console.log("[agent] auth token provided by launch payload.");
}
if (launchOverrides.displayId) {
  console.log("[agent] display id overridden by launch payload.");
}
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
if (remoteDebugEnabled) {
  console.log("[agent] debug logging enabled.");
}

const logAgentDebug = (eventName, payload = {}) => {
  if (!remoteDebugEnabled) return;
  const normalizedEventName = String(eventName || "").trim() || "event";
  console.log(`[agent][debug] ${normalizedEventName}`, payload);
};

let activeSessionId = "";
let captureTimer = null;
let captureLoopRunning = false;
let captureInProgress = false;
let inputBridge = null;
let inputBridgeStopping = false;
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
          Number.isFinite(width) && Number.isFinite(height) ? ` ${width}x${height}` : "";
        const originLabel =
          Number.isFinite(left) && Number.isFinite(top) ? ` @(${left},${top})` : "";

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
  const normalizedTypingFps = Math.max(1, Math.min(typingFps, normalizedInputFps));

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

  inputBridge.on("error", (err) => {
    console.error(`[agent] input bridge failed: ${err?.message || err}`);
  });

  inputBridge.on("exit", (code, signal) => {
    const expectedStop = inputBridgeStopping;
    inputBridge = null;
    inputBridgeStopping = false;

    if (expectedStop) {
      return;
    }

    const formattedCode = Number.isInteger(code) ? String(code) : "unknown";
    const formattedSignal = signal || "none";
    console.error(
      `[agent] input bridge exited unexpectedly (code=${formattedCode}, signal=${formattedSignal}).`
    );
  });
};

const stopInputBridge = () => {
  if (!inputBridge) return;
  inputBridgeStopping = true;
  try {
    inputBridge.kill();
  } catch (e) {
    // noop
  }
  inputBridge = null;
};

const sendToInputBridge = (event) => {
  if (!inputBridge || inputBridge.killed || inputBridge.exitCode !== null) return;
  if (
    !inputBridge.stdin ||
    inputBridge.stdin.destroyed ||
    inputBridge.stdin.writableEnded ||
    !inputBridge.stdin.writable
  ) {
    return;
  }
  try {
    const payload = resolvedDisplayBounds ? { ...event, __display: resolvedDisplayBounds } : event;
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
    const captureOptions = displayId ? { format: "jpg", screen: displayId } : { format: "jpg" };
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

socket.on("remote-host-registered", ({ hostId: registeredHostId } = {}) => {
  const normalizedRegisteredHostId = String(registeredHostId || "").trim();
  console.log("[agent] host registered.");
  if (normalizedRegisteredHostId) {
    console.log(`[agent] Host ID: ${normalizedRegisteredHostId}`);
  }
});

socket.on("remote-session-started", ({ sessionId, hostId: sessionHostId } = {}) => {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedSessionHostId = String(sessionHostId || "").trim();
  if (!normalizedSessionId || normalizedSessionHostId !== hostId) return;
  activeSessionId = normalizedSessionId;
  console.log(`[agent] remote session started: ${normalizedSessionId}`);
  startCaptureLoop();
});

socket.on("remote-session-ended", ({ sessionId } = {}) => {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId || normalizedSessionId !== activeSessionId) return;
  console.log(`[agent] remote session ended: ${normalizedSessionId}`);
  activeSessionId = "";
  stopCaptureLoop();
});

socket.on("remote-input", ({ sessionId, event } = {}) => {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId || !event) return;
  if (normalizedSessionId !== activeSessionId) return;
  logAgentDebug("remote-input", {
    sessionId: normalizedSessionId,
    type: String(event?.type || ""),
    x: toFiniteNumber(event?.x),
    y: toFiniteNumber(event?.y),
    key: String(event?.key || ""),
    button: String(event?.button || ""),
  });

  const now = Date.now();
  lastInputAt = now;
  if (event.type === "key-down" || event.type === "key-up") {
    lastTypingAt = now;
  }

  sendToInputBridge(event);
});

socket.on("remote-session-error", ({ message, code } = {}) => {
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
