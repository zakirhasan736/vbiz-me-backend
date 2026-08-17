import { getIo, ownerDashboardRoom, STAFF_DASHBOARD_ROOM } from './socket'

export const DASHBOARD_KPI_EVENT = 'dashboard:kpi'

export type DashboardKpiKind = 'view' | 'save'

export type DashboardKpiPayload = {
  kind: DashboardKpiKind
}

export const liveDashboardHub = {
  emitKpi(kind: DashboardKpiKind, ownerIds?: Array<string | null | undefined>) {
    const io = getIo()
    if (!io) return
    const payload: DashboardKpiPayload = { kind }
    io.to(STAFF_DASHBOARD_ROOM).emit(DASHBOARD_KPI_EVENT, payload)
    const rooms = new Set(
      (ownerIds || []).filter((id): id is string => Boolean(id)).map((id) => ownerDashboardRoom(id))
    )
    for (const room of rooms) {
      io.to(room).emit(DASHBOARD_KPI_EVENT, payload)
    }
  },
}

export default liveDashboardHub
