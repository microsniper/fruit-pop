import { saveDailyClear } from './api';
import type { ModeDriver } from './ModeDriver';

/**
 * 每日挑战驱动（省份 PK）：每天仅 2 关，1→2→(通关上报)→1 循环，可重复挑战。
 * 进度存 localStorage 按天隔离（dailyLevel:日期），不上服务器；
 * 挑战开始时间前端计时（dailyStartTs:日期），通关时随上报带给后端；未通关仅本地，后端无感知。
 */
export class DailyDriver implements ModeDriver {
    readonly mode = 'daily' as const;
    /** 每日挑战总关数 */
    static readonly TOTAL_LEVELS = 2;

    async getStartLevel(): Promise<number> {
        // 每次进入都从第1关开始：每日挑战是一整局体验（1→2→通关），退出即重置，不续玩
        // 每轮新开局都记录挑战开始时间（覆盖旧的，因为上一轮可能中途退出未通关）
        this.writeStartTs(Date.now());
        return 1;
    }

    saveLevel(level: number): void {
        // 回第一关等显式重置：写当天进度
        localStorage.setItem(this.levelKey(), String(level));
    }

    advanceLevel(clearedLevel: number): number {
        if (clearedLevel >= DailyDriver.TOTAL_LEVELS) {
            // 通关：先按本轮开始时间上报（防重，后端 uk 幂等双保险），再回卷第 1 关开启新一轮
            this.reportClearOnce();
            localStorage.setItem(this.levelKey(), '1');
            this.writeStartTs(Date.now());
            return 1;
        }
        const next = clearedLevel + 1;
        localStorage.setItem(this.levelKey(), String(next));
        return next;
    }

    /** 通关上报：当天只报一次（localStorage 防重；上报成功才标记，失败下一轮通关再报） */
    private reportClearOnce() {
        const reportedKey = this.reportedKey();
        if (localStorage.getItem(reportedKey) === '1') return;
        const startAt = this.readStartTs() || Date.now();
        saveDailyClear(startAt).then((ok) => {
            if (ok) {
                localStorage.setItem(reportedKey, '1');
            }
        });
    }

    private readStartTs(): number {
        return parseInt(localStorage.getItem(this.startTsKey()) || '0', 10) || 0;
    }

    private writeStartTs(ts: number) {
        localStorage.setItem(this.startTsKey(), String(ts));
    }

    private levelKey(): string {
        return `dailyLevel:${DailyDriver.todayStr()}`;
    }

    private startTsKey(): string {
        return `dailyStartTs:${DailyDriver.todayStr()}`;
    }

    private reportedKey(): string {
        return `dailyClearReported:${DailyDriver.todayStr()}`;
    }

    /** 今日进度（首页按钮状态展示复用）：1=在第1关 2=在第2关 */
    static readTodayLevel(): number {
        const raw = parseInt(localStorage.getItem(`dailyLevel:${DailyDriver.todayStr()}`) || '1', 10);
        return raw >= 1 && raw <= DailyDriver.TOTAL_LEVELS ? raw : 1;
    }

    /** 今日是否已通关（本地防重标记，辅助展示用；严格状态以后端 /daily/status 为准） */
    static readTodayCleared(): boolean {
        return localStorage.getItem(`dailyClearReported:${DailyDriver.todayStr()}`) === '1';
    }

    private static todayStr(): string {
        const d = new Date();
        return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}`;
    }

    // ===== 每局道具次数管理（纯数据逻辑，UI 操作在 GameManager） =====
    private addBasketUsed = 0;
    private clearTrayUsed = 0;
    private smashUsed = 0;
    private helpUsed = 0;

    static readonly ADD_BASKET_LIMIT = 2;
    static readonly SMASH_LIMIT = 1;
    static readonly CLEAR_TRAY_LIMIT = 1;
    static readonly HELP_MAX = 4;

    canUseTool(type: 'addBasket' | 'smash' | 'clear'): boolean {
        return this.getToolUsed(type) < this.getToolLimit(type);
    }
    useTool(type: 'addBasket' | 'smash' | 'clear'): void {
        if (type === 'addBasket') this.addBasketUsed++;
        else if (type === 'smash') this.smashUsed++;
        else this.clearTrayUsed++;
    }
    isToolExhausted(type: 'addBasket' | 'smash' | 'clear'): boolean {
        return !this.canUseTool(type);
    }
    resetPerLevel(): void {
        this.addBasketUsed = 0;
        this.clearTrayUsed = 0;
        this.smashUsed = 0;
    }
    canHelp(): boolean { return this.helpUsed < DailyDriver.HELP_MAX; }
    useHelp(): void { this.helpUsed++; }
    isHelpExhausted(): boolean { return !this.canHelp(); }
    setHelpUsed(used: number): void { this.helpUsed = used; }
    getRemainingHelp(): number { return Math.max(0, DailyDriver.HELP_MAX - this.helpUsed); }

    private getToolUsed(type: string): number {
        if (type === 'addBasket') return this.addBasketUsed;
        if (type === 'smash') return this.smashUsed;
        return this.clearTrayUsed;
    }
    private getToolLimit(type: string): number {
        if (type === 'addBasket') return DailyDriver.ADD_BASKET_LIMIT;
        if (type === 'smash') return DailyDriver.SMASH_LIMIT;
        return DailyDriver.CLEAR_TRAY_LIMIT;
    }
}
