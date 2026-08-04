import winston, { createLogger, format } from 'winston'
import 'winston-daily-rotate-file'

const transport = new winston.transports.DailyRotateFile({
  filename: 'logs/application-%DATE%.log',
  datePattern: 'YYYY-MM-DD-HH',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '3d',
})

const logger = createLogger({
  level: 'info',
  format: format.json(),
  transports: [
    new winston.transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
    transport,
  ],
})

export default logger
