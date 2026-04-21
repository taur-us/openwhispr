const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { getSafeTempDir } = require("./safeTempDir");
const { convertToWav } = require("./ffmpegUtils");

const PORT_RANGE_START = 9178;
const PORT_RANGE_END = 9199;
const STARTUP_TIMEOUT_MS = 60000; // NPU pipeline loading can be slow
const HEALTH_CHECK_INTERVAL_MS = 10000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

class IntelNpuServerManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;
  }

  getFFmpegPath() {
    if (this.cachedFFmpegPath) return this.cachedFFmpegPath;
    try {
      let ffmpegPath = require("ffmpeg-static");
      ffmpegPath = path.normalize(ffmpegPath);
      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;
      if (unpackedPath && fs.existsSync(unpackedPath)) {
        this.cachedFFmpegPath = unpackedPath;
      } else if (fs.existsSync(ffmpegPath)) {
        this.cachedFFmpegPath = ffmpegPath;
      }
      this.canConvert = !!this.cachedFFmpegPath;
      return this.cachedFFmpegPath;
    } catch {
      return null;
    }
  }

  getServerScriptPath() {
    // Check development path first, then production
    const devPath = path.join(__dirname, "..", "..", "resources", "npu-server", "npu-server.py");
    if (fs.existsSync(devPath)) return devPath;

    const prodPath = path.join(process.resourcesPath, "npu-server", "npu-server.py");
    if (fs.existsSync(prodPath)) return prodPath;

    return null;
  }

  getPythonPath() {
    // Check for python3 first, then python
    const candidates =
      process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];

    for (const cmd of candidates) {
      try {
        const { execFileSync } = require("child_process");
        const result = execFileSync(cmd, ["--version"], {
          timeout: 5000,
          encoding: "utf-8",
        });
        if (result.includes("Python 3")) return cmd;
      } catch {
        // Try next candidate
      }
    }
    return null;
  }

  isAvailable() {
    return !!this.getServerScriptPath() && !!this.getPythonPath();
  }

  async _findFreePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      const free = await new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          server.close(() => resolve(true));
        });
        server.listen(port, "127.0.0.1");
      });
      if (free) return port;
    }
    throw new Error(`No free port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    if (this.ready && this.modelPath === modelPath) {
      debugLogger.debug("NPU server already running with correct model");
      return;
    }

    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    const scriptPath = this.getServerScriptPath();
    const pythonPath = this.getPythonPath();
    if (!scriptPath) throw new Error("NPU server script not found");
    if (!pythonPath) throw new Error("Python 3 not found");

    this.port = await this._findFreePort();
    const device = options.device || "NPU";

    const args = [
      scriptPath,
      "--model",
      modelPath,
      "--port",
      String(this.port),
      "--host",
      "127.0.0.1",
      "--device",
      device,
    ];

    debugLogger.info("Starting NPU server", {
      python: pythonPath,
      script: scriptPath,
      model: modelPath,
      port: this.port,
      device,
    });

    // Initialize FFmpeg
    this.getFFmpegPath();

    this.process = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.modelPath = modelPath;

    this.process.stdout.on("data", (data) => {
      debugLogger.debug(`[NPU stdout] ${data.toString().trim()}`);
    });

    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) debugLogger.debug(`[NPU stderr] ${msg}`);
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.info("NPU server exited", { code, signal });
      this.ready = false;
      this.stopHealthCheck();
      this.emit("server-stopped", { code, signal });
    });

    this.process.on("error", (err) => {
      debugLogger.error("NPU server process error", { error: err.message });
      this.ready = false;
    });

    // Wait for server to become ready
    await this._waitForReady();
    this.ready = true;
    this.startHealthCheck();

    debugLogger.info("NPU server ready", { port: this.port, device });
    this.emit("server-ready", { port: this.port });
  }

  async _waitForReady() {
    const startTime = Date.now();

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error("NPU server process exited during startup");
      }

      try {
        const healthy = await this._healthCheck();
        if (healthy) return;
      } catch {
        // Not ready yet
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`NPU server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  _healthCheck() {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Health check timeout"));
      });
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      try {
        const healthy = await this._healthCheck();
        if (!healthy && this.ready) {
          debugLogger.warn("NPU server health check failed");
          this.ready = false;
          this.emit("server-unhealthy");
        }
      } catch {
        if (this.ready) {
          debugLogger.warn("NPU server health check error");
          this.ready = false;
          this.emit("server-unhealthy");
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async stop() {
    this.stopHealthCheck();
    if (this.process) {
      debugLogger.info("Stopping NPU server", { pid: this.process.pid });
      const pid = this.process.pid;
      try {
        // Kill only the specific Python process, not the whole tree
        // Using proc.kill() to avoid taskkill /t which kills sibling processes
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      // Wait for exit
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        this.process?.on("exit", () => { clearTimeout(timeout); resolve(); });
      });
      this.process = null;
    }
    this.ready = false;
    this.modelPath = null;
    this.port = null;
  }

  getStatus() {
    return {
      running: this.ready,
      port: this.port,
      model: this.modelPath,
      pid: this.process?.pid || null,
    };
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("NPU server is not running");
    }

    const { language, initialPrompt } = options;

    // Convert to 16kHz mono WAV
    let finalBuffer = audioBuffer;
    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }
    finalBuffer = await this._convertToWav(audioBuffer);

    const boundary = `----NpuBoundary${Date.now()}`;
    const parts = [];

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
    );
    parts.push(finalBuffer);
    parts.push("\r\n");

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language || "auto"}\r\n`
    );

    if (initialPrompt) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `${initialPrompt}\r\n`
      );
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
    );
    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part));
    const body = Buffer.concat(bodyParts);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: 300000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            debugLogger.debug("NPU transcription completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });
            if (res.statusCode !== 200) {
              reject(new Error(`NPU server returned status ${res.statusCode}: ${data}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse NPU server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => reject(new Error(`NPU server request failed: ${error.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("NPU server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async _convertToWav(audioBuffer) {
    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `npu-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `npu-output-${timestamp}.wav`);

    try {
      fs.writeFileSync(tempInputPath, audioBuffer);
      await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });
      return fs.readFileSync(tempWavPath);
    } finally {
      try {
        fs.unlinkSync(tempInputPath);
      } catch {}
      try {
        fs.unlinkSync(tempWavPath);
      } catch {}
    }
  }
}

module.exports = IntelNpuServerManager;
