const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    )
  })
];

if (!process.env.VERCEL) {
  transports.push(new winston.transports.DailyRotateFile({
    filename: path.join('logs', 'scraper-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'info',
    maxFiles: '14d',
  }));
  transports.push(new winston.transports.DailyRotateFile({
    filename: path.join('logs', 'errors-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'warn',
    maxFiles: '14d',
  }));
}

const logger = winston.createLogger({
  format: logFormat,
  transports
});

module.exports = logger;
