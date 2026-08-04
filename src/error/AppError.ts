class AppError extends Error {
  public statusCode: number
  public code?: string
  public data?: unknown

  constructor(statusCode: number, message: string, options?: { code?: string; data?: unknown; stack?: string }) {
    super(message)
    this.statusCode = statusCode
    this.code = options?.code
    this.data = options?.data

    if (options?.stack) {
      this.stack = options.stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

export default AppError
