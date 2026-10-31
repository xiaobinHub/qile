import type { ConfigValue, JSONSchema, PluginConfig, SchemaField } from "./types"

export type ConfigDraft = Record<string, ConfigValue>
export function schemaProblem(schema: JSONSchema) {
  if (
    !schema ||
    schema.type !== "object" ||
    (schema.properties !== undefined &&
      (!schema.properties ||
        typeof schema.properties !== "object" ||
        Array.isArray(schema.properties)))
  )
    return "配置格式暂不受支持，请联系管理员。"
  for (const field of Object.values(schema.properties || {})) {
    if (
      !field ||
      !["string", "number", "integer", "boolean", "array"].includes(field.type) ||
      (field.enum && (!Array.isArray(field.enum) || !field.enum.length)) ||
      (field.group !== undefined && typeof field.group !== "string") ||
      (field.type === "array" &&
        (field.items?.type !== "string" ||
          !Array.isArray(field.items.enum) ||
          !field.items.enum.length ||
          !field.items.enum.every((item) => typeof item === "string") ||
          (field.uniqueItems !== undefined && field.uniqueItems !== true))) ||
      (field.format &&
        !["date", "time", "date-time", "timezone", "email", "uri"].includes(field.format))
    )
      return "此应用使用了暂不支持的配置字段，请联系管理员。"
  }
  if (schema.required?.some((key) => !Object.hasOwn(schema.properties || {}, key)))
    return "配置中存在未定义的必填字段，请联系管理员。"
  return ""
}
export function configDraft(config: PluginConfig, schema: JSONSchema): ConfigDraft {
  return Object.fromEntries(
    Object.entries(schema.properties || {}).flatMap(([key, field]) => {
      const value = Object.hasOwn(config, key)
        ? config[key]
        : (field.default ??
          (field.type === "boolean" && schema.required?.includes(key) ? false : undefined))
      return value === undefined ? [] : [[key, Array.isArray(value) ? [...value] : value]]
    }),
  )
}
export function fieldInputType(field: SchemaField) {
  if (field.type === "number" || field.type === "integer") return "number"
  return { date: "date", time: "time", email: "email", uri: "url" }[field.format || ""] || "text"
}
export function validateConfig(draft: ConfigDraft, schema: JSONSchema) {
  const config: PluginConfig = {},
    errors: Record<string, string> = {}
  for (const [key, field] of Object.entries(schema.properties || {})) {
    let value = draft[key]
    const missing = value === undefined || (value === "" && !field.enum?.includes(""))
    if (missing) {
      if (schema.required?.includes(key)) errors[key] = "请填写此项。"
      continue
    }
    if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string" || !field.items?.enum.includes(item))
      )
        errors[key] = "请选择有效选项。"
      else if (field.uniqueItems !== false && new Set(value).size !== value.length)
        errors[key] = "选项不可重复。"
      else if (field.minItems !== undefined && value.length < field.minItems)
        errors[key] = `至少选择 ${field.minItems} 项。`
      else if (field.maxItems !== undefined && value.length > field.maxItems)
        errors[key] = `最多选择 ${field.maxItems} 项。`
    } else if (field.type === "integer" || field.type === "number") {
      value = typeof value === "string" && value.trim() ? Number(value) : value
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.type === "integer" && !Number.isInteger(value))
      )
        errors[key] = field.type === "integer" ? "请输入整数。" : "请输入有效数字。"
      else if (field.minimum !== undefined && value < field.minimum)
        errors[key] = `不能小于 ${field.minimum}。`
      else if (field.maximum !== undefined && value > field.maximum)
        errors[key] = `不能大于 ${field.maximum}。`
    } else if (typeof value !== field.type) errors[key] = "配置类型不正确。"
    if (field.enum && (Array.isArray(value) || !field.enum.includes(value)))
      errors[key] = "请选择有效选项。"
    if (typeof value === "string") {
      if (schema.required?.includes(key) && !value.trim() && !field.enum?.includes(""))
        errors[key] = "请填写此项。"
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        errors[key] = "请输入有效邮箱。"
      if (field.format === "uri") {
        try {
          const url = new URL(value)
          if (!["http:", "https:"].includes(url.protocol))
            errors[key] = "请输入完整的 http 或 https 网址。"
        } catch {
          errors[key] = "请输入完整的网址。"
        }
      }
      if (field.format === "timezone") {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format()
        } catch {
          errors[key] = "请输入有效时区，例如 Asia/Shanghai。"
        }
      }
      if (field.minLength !== undefined && Array.from(value).length < field.minLength)
        errors[key] = `至少填写 ${field.minLength} 个字符。`
      if (field.maxLength !== undefined && Array.from(value).length > field.maxLength)
        errors[key] = `最多填写 ${field.maxLength} 个字符。`
      if (
        field.format === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      )
        errors[key] = "请输入有效日期。"
      if (field.format === "time" && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value))
        errors[key] = "请输入有效时间。"
      if (
        field.format === "date-time" &&
        (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      )
        errors[key] = "请输入含时区的日期和时间，例如 2026-10-30T09:00:00+08:00。"
    }
    config[key] = value
  }
  return { config, errors }
}
