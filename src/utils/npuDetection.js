const { execFile } = require("child_process");

let cachedResult = null;

function detectIntelNpu() {
  if (cachedResult) return Promise.resolve(cachedResult);

  // NPU is only available on Windows and Linux with Intel Core Ultra processors
  if (process.platform === "darwin") {
    cachedResult = { hasNpu: false };
    return Promise.resolve(cachedResult);
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      // Check for Intel AI Boost PnP device via PowerShell
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-PnpDevice | Where-Object { $_.FriendlyName -like '*AI Boost*' -and $_.Status -eq 'OK' } | Select-Object -First 1 FriendlyName | ConvertTo-Json`,
        ],
        { timeout: 10000 },
        (error, stdout) => {
          if (error || !stdout || stdout.trim() === "" || stdout.trim() === "null") {
            cachedResult = { hasNpu: false };
            resolve(cachedResult);
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            const name = result?.FriendlyName || result;
            cachedResult = {
              hasNpu: true,
              deviceName: typeof name === "string" ? name : "Intel AI Boost",
            };
          } catch {
            cachedResult = { hasNpu: false };
          }
          resolve(cachedResult);
        }
      );
    });
  }

  // Linux: check for Intel NPU device
  return new Promise((resolve) => {
    execFile("lspci", ["-d", "8086:7d1d"], { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout || !stdout.trim()) {
        cachedResult = { hasNpu: false };
        resolve(cachedResult);
        return;
      }
      cachedResult = {
        hasNpu: true,
        deviceName: "Intel AI Boost",
      };
      resolve(cachedResult);
    });
  });
}

function clearCache() {
  cachedResult = null;
}

module.exports = { detectIntelNpu, clearCache };
