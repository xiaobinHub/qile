import { useEffect, useRef, useState } from "react"
import { getDocument, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import { Minus, Plus, RotateCcw } from "lucide-react"
import { Button } from "./ui/button"
import "./pdf-preview.css"

/** A native scrollport, with canvases allocated only near the visible pages. */
export default function PdfPreview({ url, title }: { url: string; title: string }) {
  const scrollport = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [ratio, setRatio] = useState(Math.SQRT2)
  useEffect(() => {
    const element = scrollport.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth - 32)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let alive = true
    setPdf(null)
    setError(false)
    setZoom(1)
    scrollport.current?.scrollTo(0, 0)
    let port: Worker | undefined
    let worker: PDFWorker | undefined
    let task: PDFDocumentLoadingTask
    try {
      port = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" })
      worker = PDFWorker.fromPort({ port })
      task = getDocument({
        url,
        worker,
        isEvalSupported: false,
        useSystemFonts: true,
        // Demand-load nearby pages; don't eagerly fetch a large courseware file.
        disableAutoFetch: true,
        disableStream: true,
      })
    } catch {
      worker?.destroy()
      port?.terminate()
      setError(true)
      return
    }
    void task.promise
      .then(async (document) => {
        const first = await document.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        if (alive) {
          setRatio(viewport.height / viewport.width)
          setPdf(document)
        }
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
      // LoadingTask owns its transport. Explicitly terminate the supplied port.
      void task
        .destroy()
        .catch(() => {})
        .finally(() => {
          worker?.destroy()
          port?.terminate()
        })
    }
  }, [url, attempt])
  return (
    <div className="pdf-preview">
      <div className="pdf-preview-tools" role="group" aria-label="PDF 缩放">
        <span role="status">
          {pdf ? `共 ${pdf.numPages} 页` : error ? "加载失败" : "正在加载 PDF…"}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="缩小 PDF"
          disabled={!pdf || zoom <= 0.75}
          onClick={() => setZoom((value) => Math.max(0.75, value - 0.25))}
        >
          <Minus />
        </Button>
        <Button
          variant="outline"
          disabled={!pdf}
          onClick={() => setZoom(1)}
          aria-label="PDF 适合宽度"
        >
          {zoom === 1 ? "适合宽度" : `${Math.round(zoom * 100)}%`}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="放大 PDF"
          disabled={!pdf || zoom >= 2}
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
        >
          <Plus />
        </Button>
      </div>
      <div
        className="pdf-preview-scroll"
        ref={scrollport}
        tabIndex={0}
        role="region"
        aria-label={`${title} PDF 页面`}
        aria-busy={!pdf && !error}
      >
        {error ? (
          <div className="pdf-preview-message" role="alert">
            <p>PDF 暂时无法加载，请重试或重新打开课件。</p>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <RotateCcw data-icon="inline-start" />
              重试
            </Button>
            <Button asChild variant="outline">
              <a href={url} target="_blank" rel="noopener noreferrer">
                打开原文件
              </a>
            </Button>
          </div>
        ) : pdf && width ? (
          <div className="pdf-preview-pages" style={{ width: Math.floor(width * zoom) }}>
            {Array.from({ length: pdf.numPages }, (_, index) => (
              <PdfPage
                key={index}
                pdf={pdf}
                number={index + 1}
                width={Math.floor(width * zoom)}
                ratio={ratio}
                scrollport={scrollport.current!}
              />
            ))}
          </div>
        ) : (
          <p className="pdf-preview-message" role="status">
            正在加载 PDF…
          </p>
        )}
      </div>
    </div>
  )
}

function PdfPage({
  pdf,
  number,
  width,
  ratio,
  scrollport,
}: {
  pdf: PDFDocumentProxy
  number: number
  width: number
  ratio: number
  scrollport: HTMLElement
}) {
  const element = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [nearby, setNearby] = useState(false)
  const [pageRatio, setPageRatio] = useState(ratio)
  const [failed, setFailed] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      root: scrollport,
      rootMargin: "600px 0px",
    })
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [scrollport])
  useEffect(() => {
    if (!nearby || !canvas.current) return
    const target = canvas.current
    let alive = true
    let render: RenderTask | undefined
    setFailed(false)
    setRendered(false)
    void pdf
      .getPage(number)
      .then(async (page) => {
        if (!alive) return
        const original = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / original.width })
        setPageRatio(original.height / original.width)
        // Bound memory on iPad, even for a very large page or a high DPI screen.
        const resolution = Math.min(
          devicePixelRatio || 1,
          2,
          Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
        )
        target.width = Math.max(1, Math.floor(viewport.width * resolution))
        target.height = Math.max(1, Math.floor(viewport.height * resolution))
        const context = target.getContext("2d")
        if (!context) throw new Error("Canvas unavailable")
        render = page.render({
          canvasContext: context,
          viewport,
          transform: [resolution, 0, 0, resolution, 0, 0],
        })
        await render.promise
        if (alive) setRendered(true)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      render?.cancel()
      // A new canvas is mounted per render, so cancelled rendering cannot race
      // with a resized page. Offscreen canvases release their backing stores.
      target.width = 0
      target.height = 0
    }
  }, [pdf, number, width, nearby, attempt])
  return (
    <div
      ref={element}
      className="pdf-preview-page"
      data-pdf-page={number}
      data-rendered={nearby && rendered}
      style={{ height: Math.ceil(width * pageRatio) }}
    >
      {nearby ? (
        <canvas
          key={`${width}:${attempt}`}
          ref={canvas}
          role="img"
          aria-label={`第 ${number} 页`}
        />
      ) : null}
      {nearby && failed ? (
        <div className="pdf-preview-page-message" role="alert">
          第 {number} 页加载失败
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            重试本页
          </Button>
        </div>
      ) : null}
      {!nearby || !rendered ? (
        <span className="pdf-preview-page-number" aria-hidden="true">
          第 {number} 页
        </span>
      ) : null}
    </div>
  )
}
