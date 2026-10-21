export const WINDOWS_UNSUPPORTED_MESSAGE =
  "Cypress E2E is unsupported on Windows until #15 adds native hosted " +
  "validation; no child process was started.";

export function assertCypressPlatformSupported({
  platform = process.platform,
} = {}) {
  if (platform === "win32") {
    throw new Error(WINDOWS_UNSUPPORTED_MESSAGE);
  }
}
