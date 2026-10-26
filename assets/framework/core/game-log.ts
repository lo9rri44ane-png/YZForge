/** 日志所需的最小配置；渠道、版本等前缀由应用装配。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
    readonly level: LogLevel;
    readonly prefix: string;
    readonly message: string;
    readonly values: readonly unknown[];
}
export type LogSink = (record: LogRecord) => void;
export interface LogOptions {
    readonly level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    readonly prefix: string;
    readonly sink?: LogSink;
}

/** 受当前配置日志级别控制的业务日志入口；既有 console 调用不会被全局替换。 */
export class GameLog {
    private readonly threshold: number;
    private readonly prefix: string;
    private readonly sink: LogSink;
    constructor(options: LogOptions) {
        this.threshold = ['debug', 'info', 'warn', 'error', 'silent'].indexOf(options.level);
        this.prefix = options.prefix;
        this.sink = options.sink ?? ((entry) => console[entry.level](entry.prefix, entry.message, ...entry.values));
    }
    private write(level: LogLevel, message: string, values: unknown[]): void {
        if (this.threshold > ['debug', 'info', 'warn', 'error'].indexOf(level)) return;
        const failed = (error: unknown) => {
            try {
                console.error('[YZForge] Log sink failed', error);
            } catch {
                /* Isolated diagnostic failure. */
            }
        };
        try {
            const result: unknown = this.sink(
                Object.freeze({ level, prefix: this.prefix, message, values: Object.freeze(values) }),
            );
            if (result && typeof (result as PromiseLike<unknown>).then === 'function')
                void Promise.resolve(result).catch(failed);
        } catch (error) {
            failed(error);
        }
    }
    /** 开发调试信息。 */
    debug(message: string, ...values: unknown[]): void {
        this.write('debug', message, values);
    }
    /** 常规运行信息。 */
    info(message: string, ...values: unknown[]): void {
        this.write('info', message, values);
    }
    /** 可恢复异常。 */
    warn(message: string, ...values: unknown[]): void {
        this.write('warn', message, values);
    }
    /** 错误信息；不要将登录凭证或隐私数据作为参数。 */
    error(message: string, ...values: unknown[]): void {
        this.write('error', message, values);
    }
}
