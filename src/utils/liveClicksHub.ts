import type { Response } from 'express'

export type LiveSocialClickRow = {
  label: string
  channel: string
  clickCount: number
}

type Subscriber = {
  userId: string
  res: Response
  heartbeat: ReturnType<typeof setInterval>
}

const HEARTBEAT_MS = 20_000

/** In-process SSE fanout keyed by owner userId (single-node). */
const rooms = new Map<string, Set<Subscriber>>()

const writeEvent = (res: Response, event: string, data: unknown) => {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export const liveClicksHub = {
  subscribe(userId: string, res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write(': connected\n\n')

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n')
      } catch {
        // Client gone; cleanup runs on close.
      }
    }, HEARTBEAT_MS)

    const sub: Subscriber = { userId, res, heartbeat }
    let set = rooms.get(userId)
    if (!set) {
      set = new Set()
      rooms.set(userId, set)
    }
    set.add(sub)

    const cleanup = () => {
      clearInterval(heartbeat)
      const room = rooms.get(userId)
      if (!room) return
      room.delete(sub)
      if (room.size === 0) rooms.delete(userId)
    }

    res.on('close', cleanup)
    res.on('error', cleanup)

    return cleanup
  },

  send(userId: string, event: string, data: unknown) {
    const room = rooms.get(userId)
    if (!room?.size) return
    for (const sub of room) {
      try {
        writeEvent(sub.res, event, data)
      } catch {
        // Ignore broken pipes; close handler removes the subscriber.
      }
    }
  },

  publishSnapshot(userId: string, clicks: LiveSocialClickRow[]) {
    this.send(userId, 'snapshot', { clicks })
  },

  publishClickUpdate(userId: string, clicks: LiveSocialClickRow[]) {
    this.send(userId, 'click_update', { clicks })
  },
}

export default liveClicksHub
