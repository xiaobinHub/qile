import { FRONTEND_PROTOCOL } from "../../../../packages/plugin-sdk/src/index"
import { ApiError } from "../lib/runtime"

export const frontendHeaders = {
  "X-Plugin-Frontend-Api": `${FRONTEND_PROTOCOL.major}.${FRONTEND_PROTOCOL.minor}`,
}

export function assertFrontendProtocol(value: unknown) {
  const required = value as { major: number; minMinor: number }
  if (
    value !== undefined &&
    (value === null ||
      typeof value !== "object" ||
      !Number.isInteger(required.major) ||
      !Number.isInteger(required.minMinor) ||
      required.major !== FRONTEND_PROTOCOL.major ||
      required.minMinor < 0 ||
      required.minMinor > FRONTEND_PROTOCOL.minor)
  )
    throw new ApiError(
      "此应用需要新版页面，请刷新整个页面后重试。",
      "conflict",
      409,
      "plugin_frontend_incompatible",
    )
}
