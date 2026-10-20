import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Button, DateRangePicker, ErrorText, Modal } from "./ui"
import { printEngine } from "../domain/print"
import { addDays, fmtDate, isDone, parseDate, startWeek, today } from "../domain/calendar"
import type { BusinessData } from "../domain/types"
export function PrintDialog({ data, onClose }: { data: BusinessData; onClose: () => void }) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({
      from: startWeek(today()),
      to: addDays(startWeek(today()), 6),
    }),
    [pdf, setPdf] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [printing, setPrinting] = useState(false)
  const engine = useMemo(() => printEngine(data), [data]),
    pages = useMemo(
      () =>
        range.from && range.to && range.from <= range.to
          ? engine.printWeeks(range.from, range.to)
          : [],
      [engine, range],
    )
  const ipad =
    (/iPad/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) &&
    (("standalone" in navigator && navigator.standalone) ||
      matchMedia("(display-mode: standalone)").matches)
  const overflow = pages.some((p) => p.density === "overflow"),
    valid = pages.length > 0 && !overflow && pages.length <= 53
  useEffect(() => {
    setPdf("")
    setBusy(false)
    if (!ipad || !valid) return
    const controller = new AbortController()
    let url = ""
    setPdf("")
    setBusy(true)
    setError("")
    engine
      .buildPrintPdf(pages, range.from!, range.to!, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setPdf(url)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [pages, ipad, valid])
  useEffect(() => {
    if (!printing) return
    const after = () => setPrinting(false)
    window.addEventListener("afterprint", after)
    const frame = requestAnimationFrame(() => window.print())
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("afterprint", after)
    }
  }, [printing])
  return (
    <>
      <Modal
        id="printDialog"
        title="打印成长计划"
        description="按自然周生成 A4 横向计划，保留任务和完成标记。"
        onClose={onClose}
      >
        <div className="form-field">
          <label htmlFor="printRange">打印日期范围</label>
          <DateRangePicker id="printRange" value={range} onChange={setRange} />
        </div>
        <div className="print-shortcuts">
          {[0, 1].map((offset) => (
            <Button
              variant="outline"
              key={offset}
              onClick={() => {
                const from = addDays(startWeek(today()), offset * 7)
                setRange({ from, to: addDays(from, 6) })
              }}
            >
              {offset ? "下周" : "本周"}
            </Button>
          ))}
        </div>
        <div id="printPreview" className="notice">
          {valid
            ? `将打印 ${pages.length} 页自然周计划，共 ${pages.reduce((n, p) => n + p.items.length, 0)} 项任务。`
            : overflow
              ? "该周任务过多，无法完整放入一页，请调整日期或任务。"
              : "请选择正确的起止日期，最多打印 53 周。"}
        </div>
        <ErrorText id="printError" message={error} />
        <div className="form-actions">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          {ipad ? (
            valid && pdf && !busy ? (
              <Button id="printConfirmBtn" asChild>
                <a href={pdf} target="_blank" rel="noopener">
                  打开 PDF 文件
                </a>
              </Button>
            ) : (
              <Button id="printConfirmBtn" disabled>
                {busy ? "正在准备 PDF…" : "打开 PDF 文件"}
              </Button>
            )
          ) : (
            <Button id="printConfirmBtn" disabled={!valid} onClick={() => setPrinting(true)}>
              打印 A4 横向计划
            </Button>
          )}
        </div>
        {ipad && <p className="field-help">PDF 按 A4 横向排版，打开后可通过分享菜单打印。</p>}
      </Modal>
      {printing &&
        createPortal(
          <div className="print-pages" id="printPages">
            {pages.map((p) => {
              const week = engine.isoWeek(p.ws)
              return (
                <section className={`print-page ${p.density}`} key={p.ws}>
                  <h1>
                    {data.settings.childName} · 成长计划 {week.year}年 {week.week}周
                  </h1>
                  <div className="print-grid">
                    {p.dates.map((d) => (
                      <div
                        className="print-day"
                        key={d}
                        style={{ color: d < range.from! || d > range.to! ? "#aaa" : undefined }}
                      >
                        <h3>
                          <span className="print-weekday">
                            周{"日一二三四五六"[parseDate(d).getDay()]}
                          </span>
                          <small className="print-date">{fmtDate(d)}</small>
                        </h3>
                        {p.items
                          .filter((o) => o.date === d)
                          .map((o) => (
                            <div key={o.occurrenceKey} className="paper-task">
                              <span
                                className={`paper-check ${isDone(data, o) ? "checked" : ""}`}
                                aria-label={isDone(data, o) ? "已完成" : "未完成"}
                              />
                              <div>
                                <span className="paper-title">{o.title}</span>
                                <span className="paper-details">
                                  {o.startTime}–{o.endTime} · {o.points} 分
                                </span>
                              </div>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                  <div className="print-footer">
                    <div>本周获得积分：________</div>
                    <div>家长签字：________</div>
                    <div>备注：________________________</div>
                  </div>
                </section>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
