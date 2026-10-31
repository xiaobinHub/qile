import { useEffect, useState } from "react"
import { History } from "lucide-react"
import { errorMessage, isIgnoredError } from "@/lib/session"
import { EmptyState } from "@shared/components/empty-state"
import { FormFeedback } from "@shared/components/form-feedback"
import { Badge } from "@shared/components/ui/badge"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@shared/components/ui/card"
import { Skeleton } from "@shared/components/ui/skeleton"
import type { PluginRequest } from "./client"
import type { Deployment, Plugin } from "./types"

const stageLabels: Record<string, string> = {
  prepare: "准备中",
  preparing: "准备中",
  pending: "等待部署",
  updating: "更新中",
  drain: "等待旧任务结束",
  draining: "等待旧任务结束",
  activate: "切换中",
  activating: "切换中",
  ready: "就绪",
  success: "成功",
  succeeded: "成功",
  completed: "完成",
  failed: "失败",
  rollback: "回退",
  rolled_back: "已回退",
  rolling_back: "回退中",
  recover: "恢复",
  recovered: "已恢复",
  cancelled: "已取消",
  deploy: "部署",
}

function displayTime(value: string | null | undefined) {
  if (!value) return "未记录"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false })
}

export function DeploymentHistory({ plugin, request }: { plugin: Plugin; request: PluginRequest }) {
  const [records, setRecords] = useState<Deployment[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError("")
    request<{ deployments: Deployment[] }>(
      `plugins/${encodeURIComponent(plugin.id)}/deployments`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (active) setRecords(result.deployments)
      })
      .catch((failure) => {
        if (active && !isIgnoredError(failure)) setError(errorMessage(failure))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [plugin.id, plugin.revision, plugin.operationState, request])

  return (
    <Card className="plugin-detail-card" aria-labelledby="pluginDeploymentsTitle">
      <CardHeader>
        <CardTitle id="pluginDeploymentsTitle">版本与部署记录</CardTitle>
        <CardDescription>查看版本发布、切换、回退及失败记录。</CardDescription>
      </CardHeader>
      <CardContent aria-busy={loading}>
        <dl className="plugin-details-grid plugin-version-summary">
          <div>
            <dt>活动版本</dt>
            <dd>{plugin.version || "暂无活动版本"}</dd>
          </div>
          <div>
            <dt>发布标识</dt>
            <dd>{plugin.releaseId || "暂无"}</dd>
          </div>
        </dl>
        <FormFeedback message={error} />
        {!records && loading ? (
          <div role="status" aria-label="正在读取部署记录" className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : records?.length ? (
          <ol className="flex flex-col gap-3">
            {records.map((record, index) => (
              <li key={record.id || index} className="flex flex-col gap-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium">
                    {record.fromVersion || record.oldVersion
                      ? `${record.fromVersion || record.oldVersion} → `
                      : ""}
                    {record.toVersion || record.version || "版本未记录"}
                  </span>
                  {record.operation ? (
                    <Badge variant="secondary">
                      {stageLabels[record.operation] || record.operation}
                    </Badge>
                  ) : null}
                  <Badge
                    variant={
                      record.status === "failed" || record.phase === "failed"
                        ? "destructive"
                        : "outline"
                    }
                  >
                    {record.status
                      ? stageLabels[record.status] || record.status
                      : record.phase
                        ? stageLabels[record.phase] || record.phase
                        : "状态未记录"}
                  </Badge>
                  {record.phase && record.phase !== record.status ? (
                    <span className="text-caption text-muted-foreground">
                      阶段：{stageLabels[record.phase] || record.phase}
                    </span>
                  ) : null}
                </div>
                <dl className="grid min-w-0 gap-2 text-caption text-muted-foreground sm:grid-cols-2">
                  <div>
                    <dt>开始时间</dt>
                    <dd className="break-words">
                      {displayTime(record.startedAt || record.createdAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>完成时间</dt>
                    <dd className="break-words">{displayTime(record.completedAt)}</dd>
                  </div>
                  {record.updatedAt ? (
                    <div>
                      <dt>最后更新</dt>
                      <dd className="break-words">{displayTime(record.updatedAt)}</dd>
                    </div>
                  ) : null}
                  {record.releaseId ? (
                    <div>
                      <dt>发布标识</dt>
                      <dd className="break-all">{record.releaseId}</dd>
                    </div>
                  ) : null}
                  {record.id ? (
                    <div>
                      <dt>记录 ID</dt>
                      <dd className="break-all">{record.id}</dd>
                    </div>
                  ) : null}
                </dl>
                {record.error ? <FormFeedback message={record.error} /> : null}
                {record.errorCode && !record.error ? (
                  <FormFeedback message={`部署错误：${record.errorCode}`} />
                ) : null}
                {record.message && record.message !== record.error ? (
                  <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">
                    {record.message}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : !loading && !error ? (
          <EmptyState
            title="暂无部署记录"
            description="部署插件后，可在这里查看版本变化。"
            icon={<History className="size-6" />}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}
