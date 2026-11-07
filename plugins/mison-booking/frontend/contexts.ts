import { createContext } from "react"

// Keep provider identities independent from component hot updates.
export const PortalContext = createContext<HTMLElement | null>(null)
export const PageActiveContext = createContext(true)
