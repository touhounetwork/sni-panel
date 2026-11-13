// Limits for admin batch commands, shared by the panel API and the web UI.
// A leaf module: routers read these while being defined, so it must not
// import anything that leads back to the routers.

export const HOST_COMMAND_MIN_AGENT_VERSION = "3.10.0";
export const HOST_COMMAND_MAX_COMMAND_BYTES = 64 * 1024;
export const HOST_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
export const HOST_COMMAND_MIN_TIMEOUT_SECONDS = 10;
export const HOST_COMMAND_MAX_TIMEOUT_SECONDS = 3600;
export const HOST_COMMAND_DEFAULT_TIMEOUT_SECONDS = 300;
