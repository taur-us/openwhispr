const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { execFile } = require("child_process");
const debugLogger = require("./debugLogger");
const { detectIntelNpu } = require("../utils/npuDetection");
const IntelNpuServerManager = require("./intelNpuServer");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
  extractArchive,
} = require("./downloadUtils");
const { getSafeTempDir } = require("./safeTempDir");

// Available models with their HuggingFace OpenVINO IR locations
const NPU_MODELS = {
  "whisper-base": {
    name: "Whisper Base",
    description: "Fast and accurate on NPU",
    size: "~150MB",
    sizeMb: 150,
    hfRepo: "OpenVINO/whisper-base-fp16-ov",
  },
  "whisper-tiny": {
    name: "Whisper Tiny",
    description: "Fastest, lower accuracy",
    size: "~75MB",
    sizeMb: 75,
    hfRepo: "OpenVINO/whisper-tiny-fp16-ov",
  },
};

class IntelNpuManager {
  constructor() {
    this.serverManager = new IntelNpuServerManager();
    this.isInitialized = false;
    this.currentServerModel = null;
    this._downloadSignal = null;
    this._downloading = false;
  }

  getModelsDir() {
    const dir = path.join(app.getPath("userData"), "npu-models");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Bundled models ship inside resources/npu-models/<name>/ via
  // scripts/build-npu-bundle.ps1. Returns null if no bundled copy exists.
  getBundledModelPath(modelName) {
    if (!process.resourcesPath) return null;
    const bundled = path.join(process.resourcesPath, "npu-models", modelName);
    return fs.existsSync(bundled) ? bundled : null;
  }

  getModelPath(modelName) {
    // Bundled models take precedence over user-downloaded ones — the install
    // ships with a pre-staged whisper-base so colleagues don't need internet
    // access to HuggingFace on first run.
    const bundled = this.getBundledModelPath(modelName);
    if (bundled) return bundled;
    return path.join(this.getModelsDir(), modelName);
  }

  isModelDownloaded(modelName) {
    const modelDir = this.getModelPath(modelName);
    // OpenVINO IR models have an openvino_encoder_model.xml file
    return (
      fs.existsSync(modelDir) &&
      (fs.existsSync(path.join(modelDir, "openvino_encoder_model.xml")) ||
        fs.existsSync(path.join(modelDir, "openvino_model.xml")))
    );
  }

  async initializeAtStartup(settings = {}) {
    const startTime = Date.now();
    this.isInitialized = true;

    try {
      await cleanupStaleDownloads(this.getModelsDir());

      const { localTranscriptionProvider, npuModel } = settings;

      if (localTranscriptionProvider === "intel-npu" && npuModel && this.serverManager.isAvailable()) {
        const modelPath = this.getModelPath(npuModel);

        if (this.isModelDownloaded(npuModel)) {
          debugLogger.info("Pre-warming NPU server", { model: npuModel, modelPath });

          try {
            const serverStartTime = Date.now();
            await this.serverManager.start(modelPath);
            this.currentServerModel = npuModel;

            debugLogger.info("NPU server pre-warmed successfully", {
              model: npuModel,
              startupTimeMs: Date.now() - serverStartTime,
              port: this.serverManager.port,
            });
          } catch (err) {
            debugLogger.warn("NPU server pre-warm failed (will start on first use)", {
              error: err.message,
            });
          }
        } else {
          debugLogger.debug("Skipping NPU server pre-warm: model not downloaded", {
            model: npuModel,
          });
        }
      } else {
        debugLogger.debug("Skipping NPU server pre-warm", {
          reason:
            localTranscriptionProvider !== "intel-npu"
              ? "provider not intel-npu"
              : !npuModel
                ? "no model selected"
                : "server not available",
        });
      }
    } catch (error) {
      debugLogger.warn("Intel NPU initialization error", { error: error.message });
    }

    debugLogger.info("Intel NPU initialization complete", {
      totalTimeMs: Date.now() - startTime,
      serverRunning: this.serverManager.ready,
    });

    await this.logDependencyStatus();
  }

  async logDependencyStatus() {
    const npuInfo = await detectIntelNpu();
    const pythonAvailable = !!this.serverManager.getPythonPath();

    const status = {
      npu: npuInfo,
      python: pythonAvailable,
      serverScript: !!this.serverManager.getServerScriptPath(),
      models: [],
    };

    for (const [name] of Object.entries(NPU_MODELS)) {
      if (this.isModelDownloaded(name)) {
        status.models.push(name);
      }
    }

    debugLogger.info("Intel NPU dependency check", status);
    debugLogger.info(
      `[Intel NPU] NPU: ${npuInfo.hasNpu ? `✓ ${npuInfo.deviceName}` : "✗ Not found"}`
    );
    debugLogger.info(`[Intel NPU] Python: ${pythonAvailable ? "✓" : "✗ Not found"}`);
    debugLogger.info(
      `[Intel NPU] Models: ${status.models.length > 0 ? status.models.join(", ") : "None downloaded"}`
    );
  }

  async checkNpuAvailability() {
    const npuInfo = await detectIntelNpu();
    const pythonAvailable = !!this.serverManager.getPythonPath();

    // Check if openvino-genai is installed
    let openvinoAvailable = false;
    const pythonPath = this.serverManager.getPythonPath();
    if (pythonPath) {
      try {
        const { execFileSync } = require("child_process");
        execFileSync(pythonPath, ["-c", "import openvino_genai"], {
          timeout: 10000,
          encoding: "utf-8",
        });
        openvinoAvailable = true;
      } catch {
        openvinoAvailable = false;
      }
    }

    return {
      hasNpu: npuInfo.hasNpu,
      deviceName: npuInfo.deviceName || null,
      pythonAvailable,
      openvinoAvailable,
      serverAvailable: this.serverManager.isAvailable(),
    };
  }

  async installDependencies() {
    const pythonPath = this.serverManager.getPythonPath();
    if (!pythonPath) throw new Error("Python 3 not found");

    return new Promise((resolve, reject) => {
      // Pin openvino-genai/openvino/openvino-tokenizers to a matched 2025.4
      // release. The 2026.x line introduced a stricter language-token check
      // for the static NPU pipeline that breaks transcription, and OpenVINO
      // requires the three packages to share a version (tokenizers depends on
      // matching openvino runtime).
      const packages = [
        "openvino==2025.4.1",
        "openvino-genai==2025.4.1.0",
        "openvino-tokenizers==2025.4.1.0",
        "fastapi",
        "uvicorn",
        "python-multipart",
        "soundfile",
        "librosa",
      ];

      execFile(
        pythonPath,
        ["-m", "pip", "install", ...packages],
        { timeout: 300000 },
        (error, stdout, stderr) => {
          if (error) {
            debugLogger.error("Failed to install NPU dependencies", { error: error.message });
            reject(new Error(`Dependency install failed: ${error.message}`));
            return;
          }
          debugLogger.info("NPU dependencies installed successfully");
          resolve({ success: true });
        }
      );
    });
  }

  async downloadModel(modelName, progressCallback) {
    if (this._downloading) throw new Error("Download already in progress");
    if (!NPU_MODELS[modelName]) throw new Error(`Unknown model: ${modelName}`);

    this._downloading = true;
    const config = NPU_MODELS[modelName];
    const modelDir = this.getModelPath(modelName);

    try {
      debugLogger.info("NPU model download starting", { model: modelName, repo: config.hfRepo });

      fs.mkdirSync(modelDir, { recursive: true });

      const spaceCheck = await checkDiskSpace(modelDir, config.sizeMb * 1024 * 1024 * 2);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space. Need ~${config.sizeMb * 2}MB, only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      // Download pre-converted OpenVINO IR model from HuggingFace
      const pythonPath = this.serverManager.getPythonPath();
      if (!pythonPath) throw new Error("Python 3 not found");

      if (progressCallback) {
        progressCallback({ type: "progress", percentage: 10, message: "Downloading OpenVINO model from HuggingFace..." });
      }

      await new Promise((resolve, reject) => {
        const hfRepo = config.hfRepo;
        const script = `
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="${hfRepo}",
    local_dir=r"${modelDir.replace(/\\/g, "\\\\")}",
    local_dir_use_symlinks=False,
)
print("DOWNLOAD_COMPLETE")
`;
        const proc = execFile(
          pythonPath,
          ["-c", script],
          { timeout: 600000, maxBuffer: 50 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              debugLogger.error("Model download failed", { error: error.message, stderr });
              reject(new Error(`Model download failed: ${error.message}`));
              return;
            }
            if (stdout.includes("DOWNLOAD_COMPLETE")) {
              resolve();
            } else {
              reject(new Error("Download did not complete successfully"));
            }
          }
        );

        // Report progress periodically
        let progress = 10;
        const interval = setInterval(() => {
          progress = Math.min(progress + 8, 90);
          if (progressCallback) {
            progressCallback({ type: "progress", percentage: progress, message: "Downloading model files..." });
          }
        }, 3000);

        proc.on("exit", () => clearInterval(interval));
      });

      if (progressCallback) {
        progressCallback({ type: "complete", percentage: 100 });
      }

      debugLogger.info("NPU model download complete", { model: modelName, path: modelDir });
      return { success: true, path: modelDir };
    } catch (error) {
      // Clean up on failure
      try {
        fs.rmSync(modelDir, { recursive: true, force: true });
      } catch {}
      throw error;
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
    }
  }

  isDownloading() {
    return this._downloading;
  }

  async cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      return { success: true };
    }
    return { success: false, error: "No active download" };
  }

  async deleteModel(modelName) {
    // Never touch bundled models — they live inside the read-only install dir
    // and deleting them would corrupt the app.
    if (this.getBundledModelPath(modelName)) {
      return { success: false, error: "Bundled models cannot be deleted" };
    }
    const modelDir = path.join(this.getModelsDir(), modelName);
    if (fs.existsSync(modelDir)) {
      fs.rmSync(modelDir, { recursive: true, force: true });
      debugLogger.info("NPU model deleted", { model: modelName });
      return { success: true };
    }
    return { success: false, error: "Model not found" };
  }

  listModels() {
    const models = [];
    for (const [id, config] of Object.entries(NPU_MODELS)) {
      models.push({
        id,
        ...config,
        downloaded: this.isModelDownloaded(id),
      });
    }
    return models;
  }

  async startServer(modelName) {
    if (!this.serverManager.isAvailable()) {
      return { success: false, reason: "NPU server not available (Python or script missing)" };
    }

    const modelPath = this.getModelPath(modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.serverManager.start(modelPath);
      this.currentServerModel = modelName;
      debugLogger.info("NPU server started", { model: modelName, port: this.serverManager.port });
      return { success: true, port: this.serverManager.port };
    } catch (error) {
      debugLogger.error("Failed to start NPU server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.serverManager.stop();
    this.currentServerModel = null;
  }

  getServerStatus() {
    return this.serverManager.getStatus();
  }

  async transcribeLocalNpu(audioBlob, options = {}) {
    // Ensure we have a Buffer (IPC may deliver ArrayBuffer)
    const audioBuffer = Buffer.isBuffer(audioBlob) ? audioBlob : Buffer.from(audioBlob);

    debugLogger.logWhisperPipeline("transcribeLocalNpu - start", {
      options,
      audioBlobSize: audioBuffer.length,
      serverReady: this.serverManager.ready,
    });

    if (!this.serverManager.isAvailable()) {
      throw new Error("NPU server not available. Ensure Python and openvino-genai are installed.");
    }

    const model = options.model || "whisper-base";
    const language = options.language || null;
    const initialPrompt = options.initialPrompt || null;
    const modelPath = this.getModelPath(model);

    if (!this.isModelDownloaded(model)) {
      throw new Error(`NPU model "${model}" not downloaded. Please download it from Settings.`);
    }

    // Start server if not running or if model changed
    if (!this.serverManager.ready || this.currentServerModel !== model) {
      debugLogger.debug("Starting NPU server for model", { model });
      await this.serverManager.start(modelPath);
      this.currentServerModel = model;
    }

    return await this.serverManager.transcribe(audioBuffer, { language, initialPrompt });
  }
}

module.exports = { IntelNpuManager, NPU_MODELS };
