const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const screenshot = require("screenshot-desktop");
const { io } = require("socket.io-client");
const {
  PLACEHOLDER_TOKENS,
  buildBootstrapConfig,
  maskToken,
} = require("./lib/bootstrapConfig");

const {
  envPath,
  launchOverrides,
  serverUrl,
  remoteControlToken,
  hostId,
  remoteDebugEnabled,
  configuredDisplayId,
  performanceMode,
  baseFps,
  minFps,
  inputFps,
  typingFps,
  inputWindowMs,
  typingWindowMs,
  slowCaptureThresholdMs,
  maxFrameBase64Length: MAX_FRAME_BASE64_LENGTH,
} = buildBootstrapConfig({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  execPath: process.execPath,
  dirname: __dirname,
});

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
if (!remoteControlToken) {
  console.warn(
    "[agent] REMOTE_CONTROL_TOKEN is empty. If backend auth is enabled, set token in .env."
  );
} else if (PLACEHOLDER_TOKENS.has(remoteControlToken.toLowerCase())) {
  console.warn(
    "[agent] REMOTE_CONTROL_TOKEN appears to be a placeholder. Replace it with your backend token."
  );
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
  const computedDelay = Math.max(33, Math.floor(1000 / Math.max(1, effectiveFps)));
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
    scheduleNextCapture(20);
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
      slowCaptureBackoffUntil = Date.now() + 900;
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
  const message = String(error?.message || "unknown").trim() || "unknown";
  console.error(`[agent] connect error: ${message}`);

  if (message.toLowerCase() !== "unauthorized") {
    return;
  }

  const tokenState = !remoteControlToken
    ? "missing"
    : PLACEHOLDER_TOKENS.has(remoteControlToken.toLowerCase())
    ? "placeholder"
    : "provided";
  const envLocation = envPath || "(no .env found near app/exe)";
  const tokenPreview = maskToken(remoteControlToken);

  console.error(
    `[agent] auth rejected by server. Check REMOTE_CONTROL_TOKEN in ${envLocation}.`
  );
  console.error(`[agent] token state: ${tokenState}, token preview: ${tokenPreview}`);
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

