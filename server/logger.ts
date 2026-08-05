import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const myFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  ),
  defaultMeta: { service: "x-ray-check" },
  transports: [
    // Console is REQUIRED in production too — hosts like Render only capture
    // stdout/stderr for their Logs dashboard, and the free-tier filesystem is
    // ephemeral anyway, so File transports below are invisible/lost on deploy.
    new winston.transports.Console({
      format:
        process.env.NODE_ENV !== "production"
          ? combine(colorize(), myFormat)
          : combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), myFormat),
    }),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});
