import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { Toast as Primitive } from "radix-ui"
import { X } from "lucide-react"
import { cn } from "@shared/lib/utils"

export type ToastMessage = {
  title: string
  description?: string
  variant?: "default" | "destructive"
}
const ToastContext = createContext<((message: ToastMessage) => void) | null>(null)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<(ToastMessage & { id: number; open: boolean })[]>([])
  const toast = useCallback((message: ToastMessage) => {
    setMessages((current) => [
      ...current.slice(-3),
      { ...message, id: Date.now() + Math.random(), open: true },
    ])
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      <Primitive.Provider swipeDirection="right" label="通知">
        {children}
        {messages.map((message) => (
          <Primitive.Root
            key={message.id}
            open={message.open}
            onOpenChange={(open) =>
              setMessages((current) =>
                current.map((item) => (item.id === message.id ? { ...item, open } : item)),
              )
            }
            className={cn(
              "relative grid grid-cols-[1fr_auto] gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
              message.variant === "destructive" && "border-destructive text-destructive",
            )}
          >
            <div>
              <Primitive.Title className="font-medium">{message.title}</Primitive.Title>
              {message.description && (
                <Primitive.Description className="mt-1 leading-5">
                  {message.description}
                </Primitive.Description>
              )}
            </div>
            <Primitive.Close
              data-slot="toast-close"
              aria-label="关闭通知"
              className="-m-2 flex size-10 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </Primitive.Close>
          </Primitive.Root>
        ))}
        <Primitive.Viewport className="fixed right-4 bottom-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </Primitive.Provider>
    </ToastContext.Provider>
  )
}
export function useToast() {
  const toast = useContext(ToastContext)
  if (!toast) throw new Error("useToast requires ToastProvider")
  return { toast }
}
