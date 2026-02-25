const os = require("os");
const path = require("path");
const fs = require("fs");
const { randomBytes } = require("crypto");
const dotenv = require("dotenv");

const PLACEHOLDER_TOKENS = new Set(["change-me", "changeme", "your-token", "token"]);

const sanitizeHostId = (value, maxLength = 64) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, maxLength);

const sanitizeToken = (value, maxLength = 256) =>
  String(value || "")
    .trim()
    .slice(0, maxLength);

const maskToken = (value) => {
  const token = sanitizeToken(value, 256);
  if (!token) return "(empty)";
  if (token.length <= 4) return `${token[0]}***`;
  return `${token.slice(0, 2)}***${token.slice(-2)}`;
};

const resolveEnvPath = ({
  cwd = process.cwd(),
  execPath = process.execPath,
  dirname = __dirname,
} = {}) => {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(path.dirname(execPath), ".env"),
    path.join(dirname, ".env"),
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) return envPath;
  }

  return "";
};

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

const getHostIdStoragePathCandidates = ({
  envPath,
  cwd = process.cwd(),
  execPath = process.execPath,
} = {}) => {
  const envDerivedHostIdPath = envPath
    ? path.join(path.dirname(envPath), ".host-id")
    : "";
  const candidates = [
    path.join(cwd, ".host-id"),
    envDerivedHostIdPath,
    path.join(path.dirname(execPath), ".host-id"),
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

const readPersistedHostId = (options = {}) => {
  for (const hostIdPath of getHostIdStoragePathCandidates(options)) {
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

const persistHostId = (hostId, options = {}) => {
  for (const hostIdPath of getHostIdStoragePathCandidates(options)) {
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

const resolveHostId = (overrideHostId = "", options = {}) => {
  const normalizedOverrideHostId = sanitizeHostId(overrideHostId, 64);
  if (normalizedOverrideHostId) {
    const persistedPath = persistHostId(normalizedOverrideHostId, options);
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

  const persisted = readPersistedHostId(options);
  if (persisted?.hostId) {
    if (rawHostId) {
      console.log(
        `[agent] REMOTE_HOST_ID '${rawHostId}' is a default placeholder. Using saved host id '${persisted.hostId}'.`
      );
    }
    return persisted.hostId;
  }

  const generatedHostId = buildGeneratedHostId();
  const persistedPath = persistHostId(generatedHostId, options);
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

const buildBootstrapConfig = ({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  execPath = process.execPath,
  dirname = __dirname,
} = {}) => {
  const envPath = resolveEnvPath({ cwd, execPath, dirname });
  if (envPath) {
    dotenv.config({ path: envPath, quiet: true });
  }

  const launchOverrides = parseLaunchOverrides(argv);
  const serverUrl =
    launchOverrides.serverUrl ||
    process.env.REMOTE_SERVER_URL ||
    (String(process.env.REMOTE_USE_LOCALHOST || "").trim() === "1" &&
      "http://localhost:5000") ||
    "https://calling-app-backend-1.onrender.com";
  const remoteControlToken =
    launchOverrides.remoteControlToken ||
    sanitizeToken(process.env.REMOTE_CONTROL_TOKEN || "", 256);
  const hostId = resolveHostId(launchOverrides.hostId, { envPath, cwd, execPath });
  const remoteDebugEnabled = String(process.env.REMOTE_DEBUG || "").trim() === "1";
  const configuredDisplayId = String(
    launchOverrides.displayId || process.env.REMOTE_DISPLAY_ID || ""
  ).trim();
  const performanceMode = String(process.env.REMOTE_PERF_MODE || "auto")
    .trim()
    .toLowerCase();
  const baseFps =
    toPositiveNumber(launchOverrides.fps) ||
    toPositiveNumber(process.env.REMOTE_FPS) ||
    10;
  const minFps =
    toPositiveNumber(process.env.REMOTE_MIN_FPS) ||
    Math.max(2, Math.min(baseFps, Math.round(baseFps * 0.6)));
  const inputFps =
    toPositiveNumber(process.env.REMOTE_ACTIVE_INPUT_FPS) ||
    Math.max(minFps, Math.min(baseFps, Math.round(baseFps)));
  const typingFps =
    toPositiveNumber(process.env.REMOTE_TYPING_FPS) ||
    Math.max(minFps, Math.min(inputFps, Math.round(baseFps * 0.9)));
  const inputWindowMs = toPositiveNumber(process.env.REMOTE_INPUT_WINDOW_MS) || 1200;
  const typingWindowMs = toPositiveNumber(process.env.REMOTE_TYPING_WINDOW_MS) || 2200;
  const slowCaptureThresholdMs =
    toPositiveNumber(process.env.REMOTE_SLOW_CAPTURE_MS) || 450;
  const maxFrameBase64Length = 1_200_000;

  return {
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
    maxFrameBase64Length,
  };
};

module.exports = {
  PLACEHOLDER_TOKENS,
  buildBootstrapConfig,
  maskToken,
};
