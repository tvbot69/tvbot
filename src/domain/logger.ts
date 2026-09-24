import util from 'util';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface LogContext {
  traceId?: string;
  userId?: string;
  guildId?: string;
  commandName?: string;
  shardId?: number;
}

// Enable UTF-8 encoding for Windows terminals so Arabic, emojis, and symbols render cleanly
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // Ignore if permission denied or restricted
  }
}

// ANSI terminal color codes
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright foreground
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
};

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${ansi.dim}[${h}:${m}:${s}]${ansi.reset}`;
}

function formatLatency(ms: number): string {
  if (ms < 300) return `${ansi.green}${ms}ms${ansi.reset}`;
  if (ms < 1000) return `${ansi.yellow}${ms}ms${ansi.reset}`;
  return `${ansi.brightRed}${ms}ms${ansi.reset}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function padBoxLine(content: string, innerWidth: number = 58): string {
  const visibleLen = stripAnsi(content).length;
  const padding = Math.max(0, innerWidth - visibleLen);
  return `  ${ansi.brightCyan}│${ansi.reset} ${content}${' '.repeat(padding)} ${ansi.brightCyan}│${ansi.reset}`;
}

export class CustomLogger {
  public isDebugEnabled = process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production';
  public boundContext?: LogContext;
  private logDir = path.resolve(process.cwd(), 'logs');
  private fileLoggingEnabled = process.env.LOG_FILE !== 'false' && process.env.NODE_ENV !== 'test';

  public withContext(context: LogContext): CustomLogger {
    const child = new CustomLogger();
    child.isDebugEnabled = this.isDebugEnabled;
    child.boundContext = { ...(this.boundContext ?? {}), ...context };
    return child;
  }

  private writeLogToFile(level: string, message: string, err?: Error): void {
    if (!this.fileLoggingEnabled) return;
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const logFile = path.join(this.logDir, `tvbot-${dateStr}.log`);

      const cleanMsg = stripAnsi(message);
      const ctxPrefix = this.boundContext?.traceId ? `[trace:${this.boundContext.traceId}] ` : '';
      let logLine = `[${now.toISOString()}] [${level}] ${ctxPrefix}${cleanMsg}\n`;
      if (err?.stack) {
        logLine += `${err.stack}\n`;
      }
      fs.appendFileSync(logFile, logLine, 'utf8');
    } catch {
      // Don't crash application on filesystem logging failure
    }
  }

  public banner(): void {
    const innerWidth = 58;
    const top = `  ${ansi.brightCyan}╭${'─'.repeat(innerWidth + 2)}╮${ansi.reset}`;
    const bot = `  ${ansi.brightCyan}╰${'─'.repeat(innerWidth + 2)}╯${ansi.reset}`;

    const lines = [
      '',
      top,
      padBoxLine('', innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}████████╗██╗   ██╗██████╗  ██████╗ ████████╗${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}╚══██╔══╝██║   ██║██╔══██╗██╔═══██╗╚══██╔══╝${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║   ██║   ██║██████╔╝██║   ██║   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║   ╚██╗ ██╔╝██╔══██╗██║   ██║   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ██║    ╚████╔╝ ██████╔╝╚██████╔╝   ██║     ${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightCyan}${ansi.bold}   ╚═╝     ╚═══╝  ╚═════╝  ╚═════╝    ╚═╝   ${ansi.brightMagenta}v0.1.0${ansi.reset}`, innerWidth),
      padBoxLine('', innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Environment${ansi.gray} : ${ansi.green}${process.env.NODE_ENV || 'development'}${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Node.js${ansi.gray}     : ${ansi.yellow}${process.version}${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Framework${ansi.gray}   : ${ansi.brightBlue}Discord.js v14 + Prisma + PostgreSQL${ansi.reset}`, innerWidth),
      padBoxLine(`  ${ansi.brightWhite}✦ Audio${ansi.gray}       : ${ansi.magenta}Moonlink + Essentia DSP${ansi.reset}`, innerWidth),
      padBoxLine('', innerWidth),
      bot,
      '',
    ];

    console.log(lines.join('\n'));
  }

  public info(msgOrObj: any, ...args: any[]): void {
    this.print('INFO', `${ansi.brightCyan}${ansi.bold} INFO  ${ansi.reset}`, ansi.brightWhite, msgOrObj, args);
  }

  public warn(msgOrObj: any, ...args: any[]): void {
    this.print('WARN', `${ansi.bgYellow}${ansi.black}${ansi.bold} WARN  ${ansi.reset}`, ansi.brightYellow, msgOrObj, args);
  }

  public error(msgOrObj: any, ...args: any[]): void {
    this.print('ERROR', `${ansi.bgRed}${ansi.brightWhite}${ansi.bold} ERROR ${ansi.reset}`, ansi.brightRed, msgOrObj, args);
  }

  public fatal(msgOrObj: any, ...args: any[]): void {
    this.print('FATAL', `${ansi.bgRed}${ansi.brightWhite}${ansi.bold} FATAL ${ansi.reset}`, ansi.brightRed, msgOrObj, args);
  }

  public debug(msgOrObj: any, ...args: any[]): void {
    if (!this.isDebugEnabled) return;
    this.print('DEBUG', `${ansi.gray}${ansi.bold} DEBUG ${ansi.reset}`, ansi.gray, msgOrObj, args);
  }

  public ready(message: string): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgGreen}${ansi.black}${ansi.bold} READY ${ansi.reset}`;
    console.log(`${time} ${tag} ${ansi.brightGreen}${ansi.bold}${message}${ansi.reset}`);
  }

  public command(info: {
    commandName: string;
    args?: string;
    userName: string;
    guildName?: string | null;
    channelName?: string | null;
    durationMs: number;
    success?: boolean;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgCyan}${ansi.black}${ansi.bold}  CMD  ${ansi.reset}`;
    const cmdText = `${ansi.brightGreen}${ansi.bold}.${info.commandName}${ansi.reset}${info.args ? ` ${ansi.cyan}${info.args}${ansi.reset}` : ''}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const locationText = info.guildName
      ? `${ansi.dim}in${ansi.reset} ${ansi.magenta}#${info.channelName ?? 'unknown'}${ansi.reset} ${ansi.dim}(${info.guildName})${ansi.reset}`
      : `${ansi.dim}(DM)${ansi.reset}`;
    const latency = formatLatency(info.durationMs);

    console.log(`${time} ${tag} ${cmdText} ${ansi.dim}│${ansi.reset} ${userText} ${locationText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public slash(info: {
    commandName: string;
    subCommand?: string | null;
    options?: string;
    userName: string;
    guildName?: string | null;
    channelName?: string | null;
    durationMs: number;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgBlue}${ansi.brightWhite}${ansi.bold} SLASH ${ansi.reset}`;
    const fullCmd = info.subCommand ? `/${info.commandName} ${info.subCommand}` : `/${info.commandName}`;
    const cmdText = `${ansi.brightCyan}${ansi.bold}${fullCmd}${ansi.reset}${info.options ? ` ${ansi.cyan}${info.options}${ansi.reset}` : ''}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const locationText = info.guildName
      ? `${ansi.dim}in${ansi.reset} ${ansi.magenta}#${info.channelName ?? 'unknown'}${ansi.reset} ${ansi.dim}(${info.guildName})${ansi.reset}`
      : `${ansi.dim}(DM)${ansi.reset}`;
    const latency = formatLatency(info.durationMs);

    console.log(`${time} ${tag} ${cmdText} ${ansi.dim}│${ansi.reset} ${userText} ${locationText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public button(info: {
    customId: string;
    userName: string;
    guildName?: string | null;
    durationMs: number;
  }): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgMagenta}${ansi.brightWhite}${ansi.bold} INTER ${ansi.reset}`;
    const idText = `${ansi.brightMagenta}${info.customId}${ansi.reset}`;
    const userText = `${ansi.dim}by${ansi.reset} ${ansi.brightWhite}${info.userName}${ansi.reset}`;
    const guildText = info.guildName ? `${ansi.dim}(${info.guildName})${ansi.reset}` : '';
    const latency = formatLatency(info.durationMs);

    console.log(`${time} ${tag} ${idText} ${ansi.dim}│${ansi.reset} ${userText} ${guildText} ${ansi.dim}[${latency}${ansi.dim}]${ansi.reset}`);
  }

  public sync(message: string, durationMs?: number): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgYellow}${ansi.black}${ansi.bold} SYNC  ${ansi.reset}`;
    const latencyText = durationMs !== undefined ? ` ${ansi.dim}[${formatLatency(durationMs)}${ansi.dim}]${ansi.reset}` : '';
    console.log(`${time} ${tag} ${ansi.yellow}${message}${ansi.reset}${latencyText}`);
  }

  public generateReferenceId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  public commandUsed(info: {
    discordUserName: string;
    discordUserId: string;
    guildName?: string | null;
    guildId?: string | null;
    shardId?: number;
    commandResponse: string;
    responseTimeMs: number;
    messageContent: string;
  }): void {
    const shard = info.shardId ?? 0;
    const guildText = info.guildName ? `${info.guildName} / ${info.guildId}` : 'DM';
    this.info(
      `CommandUsed: ${info.discordUserName} / ${info.discordUserId} | ${guildText} #${shard} | ${info.commandResponse} | ${info.responseTimeMs}ms | ${info.messageContent}`
    );
  }

  public slashCommandUsed(info: {
    discordUserName: string;
    discordUserId: string;
    guildName?: string | null;
    guildId?: string | null;
    commandName: string;
    commandResponse: string;
    responseTimeMs: number;
  }): void {
    const guildText = info.guildName ? `${info.guildName} / ${info.guildId}` : 'UserApp';
    this.info(
      `SlashCommandUsed: ${info.discordUserName} / ${info.discordUserId} | ${guildText} | ${info.commandResponse} | ${info.responseTimeMs}ms | ${info.commandName}`
    );
  }

  public shardEvent(event: 'ready' | 'connected' | 'disconnected' | 'resumed', shardId: number, details?: string): void {
    const time = formatTimestamp();
    const tag = `${ansi.bgBlue}${ansi.brightWhite}${ansi.bold} SHARD ${ansi.reset}`;
    const desc = details ? ` - ${details}` : '';
    console.log(`${time} ${tag} ${ansi.brightBlue}Shard #${shardId} ${event}${desc}${ansi.reset}`);
  }

  public errorWithRef(
    error: unknown,
    context?: {
      commandName?: string;
      userName?: string;
      userId?: string;
      guildName?: string | null;
      guildId?: string | null;
      shardId?: number;
      messageContent?: string;
    }
  ): { referenceId: string; message: string } {
    const referenceId = this.generateReferenceId();
    const shard = context?.shardId ?? 0;
    const guildText = context?.guildName ? `${context.guildName} / ${context.guildId}` : 'DM';
    const userText = context?.userName ? `${context.userName} / ${context.userId}` : 'unknown';
    const contentText = context?.messageContent ?? (context?.commandName ? `.${context.commandName}` : 'unknown');

    const err = error instanceof Error ? error : new Error(String(error));
    this.error(
      `CommandUsed: Error ${referenceId} | ${userText} | ${guildText} #${shard} | Error (${err.message}) | ${contentText}`
    );
    if (err.stack) {
      const stackLines = err.stack.split('\n').map((l: string) => `    ${ansi.gray}${l.trim()}${ansi.reset}`);
      console.log(stackLines.join('\n'));
    }

    return {
      referenceId,
      message: err.message,
    };
  }

  private print(level: string, badge: string, textColor: string, msgOrObj: any, extraArgs: any[]): void {
    const time = formatTimestamp();
    let message = '';
    let errObject: any = null;

    if (typeof msgOrObj === 'string') {
      message = msgOrObj;
      if (extraArgs.length > 0) {
        message = util.format(msgOrObj, ...extraArgs);
      }
    } else if (msgOrObj instanceof Error) {
      errObject = msgOrObj;
      message = msgOrObj.message;
    } else if (typeof msgOrObj === 'object' && msgOrObj !== null) {
      // Pino-style (context, message): never drop the context object — its
      // fields (guildId, severity, reason, ...) are the actual diagnostics.
      const { err: errField, msg: msgField, ...contextRest } = msgOrObj as Record<string, unknown>;
      if (errField) {
        errObject = errField as any;
        message =
          extraArgs[0] ??
          ((errObject as Error)?.message || 'Error occurred');
      } else if (msgField) {
        message = msgField as string;
      } else if (extraArgs[0] && typeof extraArgs[0] === 'string') {
        message = extraArgs[0];
      } else {
        message = util.inspect(msgOrObj, { colors: false, depth: 3 });
      }
      if (Object.keys(contextRest).length > 0) {
        message += ` ${util.inspect(contextRest, { colors: false, depth: 3, breakLength: 140 })}`;
      }
    } else {
      message = String(msgOrObj);
    }

    const tracePrefix = this.boundContext?.traceId ? `${ansi.dim}[${this.boundContext.traceId}]${ansi.reset} ` : '';
    console.log(`${time} ${badge} ${tracePrefix}${textColor}${message}${ansi.reset}`);

    this.writeLogToFile(level, message, errObject);

    if (errObject && (level === 'ERROR' || level === 'FATAL')) {
      if (errObject.stack) {
        const stackLines = errObject.stack.split('\n').map((l: string) => `    ${ansi.gray}${l.trim()}${ansi.reset}`);
        console.log(stackLines.join('\n'));
      }
    }
  }
}

export const Logger = new CustomLogger();
export type Logger = CustomLogger;
