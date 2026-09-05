import util from 'util';
import { execSync } from 'child_process';

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
  private isDebugEnabled = process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production';

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
      if (msgOrObj.err) {
        errObject = msgOrObj.err;
        message = extraArgs[0] ?? (msgOrObj.err.message || 'Error occurred');
      } else if (msgOrObj.msg) {
        message = msgOrObj.msg;
      } else if (extraArgs[0] && typeof extraArgs[0] === 'string') {
        message = extraArgs[0];
      } else {
        message = util.inspect(msgOrObj, { colors: true, depth: 2 });
      }
    } else {
      message = String(msgOrObj);
    }

    console.log(`${time} ${badge} ${textColor}${message}${ansi.reset}`);

    if (errObject && (level === 'ERROR' || level === 'FATAL')) {
      if (errObject.stack) {
        const stackLines = errObject.stack.split('\n').slice(1).map((l: string) => `    ${ansi.gray}${l.trim()}${ansi.reset}`);
        console.log(stackLines.join('\n'));
      }
    }
  }
}

export const Logger = new CustomLogger();
export type Logger = CustomLogger;
