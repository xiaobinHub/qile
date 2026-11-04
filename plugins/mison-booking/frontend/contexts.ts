import { createContext } from "react"
import type { PluginContext } from "./types"

// Keep provider identities independent from component hot updates.
export const PortalContext = createContext<HTMLElement | null>(null)
export const ImageContext = createContext<PluginContext | null>(null)
