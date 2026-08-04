import { saveDailyClear, DailyClearResponse } from './api';
import type { ClearAction, ModeDriver, ToolPayment, ToolType } from './ModeDriver';

/**
 * 每日挑战驱动（省份 PK）：每天仅 2 关，1→2→(通关上报)→1 循环，可重复挑战。
 * 进度存 localStorage 按天隔离（dailyLevel:日期），不上服务器；
 * 挑战开始时间前端计时（dailyStartTs:日期），通关时随上报带给后端；未通关仅本地，后端无感知。
 *
 * 道具规则：每关加果篮 2 次、砸板子 1 次、清空果盘 1 次；
 * 主按钮代价是求助好友（当日上限 4 次），不扣小太阳，界面隐藏小太阳余额与价格。
 */
export class DailyDriver implements ModeDriver {
    readonly mode = 'daily' as const;
    /** 每日挑战总关数 */
    static readonly TOTAL_LEVELS = 2;

    // ===== 每关道具上限 =====
    static readonly ADD_BASKET_LIMIT = 2;
    static readonly SMASH_LIMIT = 1;
    static readonly CLEAR_TRAY_LIMIT = 1;
    /** 当日求助上限 */
    static readonly HELP_MAX = 4;

    // ===== 每局道具次数（纯数据，UI 操作在 GameManager）=====
    private addBasketUsed = 0;
    private smashUsed = 0;
    private clearTrayUsed = 0;
    private helpUsed = 0;

    // ===== 进度与结算 =====
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
            // 通关：先按本轮开始时间上报，再回卷第 1 关，从主页可重新挑战
            this.reportClear();
            localStorage.setItem(this.levelKey(), '1');
            this.writeStartTs(Date.now());
            return 1;
        }
        const next = clearedLevel + 1;
        localStorage.setItem(this.levelKey(), String(next));
        return next;
    }

    /**
     * 第 1 关过完不弹窗，直接进加载页加载第 2 关；
     * 第 2 关过完整局结束，弹通关页（展示本次用时与今日最快）。
     */
    getClearAction(clearedLevel: number): ClearAction {
        return clearedLevel >= DailyDriver.TOTAL_LEVELS ? 'finish' : 'autoAdvance';
    }

    // ===== 道具限次 =====
    getToolLimit(tool: ToolType): number {
        if (tool === 'addBasket') return DailyDriver.ADD_BASKET_LIMIT;
        if (tool === 'smash') return DailyDriver.SMASH_LIMIT;
        return DailyDriver.CLEAR_TRAY_LIMIT;
    }
    getToolUsed(tool: ToolType): number {
        if (tool === 'addBasket') return this.addBasketUsed;
        if (tool === 'smash') return this.smashUsed;
        return this.clearTrayUsed;
    }
    canUseTool(tool: ToolType): boolean {
        return this.getToolUsed(tool) < this.getToolLimit(tool);
    }
    useTool(tool: ToolType): void {
        if (tool === 'addBasket') this.addBasketUsed++;
        else if (tool === 'smash') this.smashUsed++;
        else this.clearTrayUsed++;
    }
    isToolExhausted(tool: ToolType): boolean {
        return !this.canUseTool(tool);
    }
    resetPerLevel(): void {
        this.addBasketUsed = 0;
        this.smashUsed = 0;
        this.clearTrayUsed = 0;
    }

    // ===== 付费方式：求助好友，不扣小太阳 =====
    getPrimaryPayment(_tool: ToolType, _cost: number): ToolPayment {
        return { kind: 'help' };
    }

    // ===== 求助好友（当日维度，跨关不重置）=====
    hasHelpMechanism(): boolean {
        return true;
    }
    canHelp(): boolean {
        return this.helpUsed < DailyDriver.HELP_MAX;
    }
    useHelp(): void {
        this.helpUsed++;
    }
    isHelpExhausted(): boolean {
        return !this.canHelp();
    }
    setHelpUsed(used: number): void {
        this.helpUsed = used;
    }
    getHelpUsed(): number {
        return this.helpUsed;
    }
    getRemainingHelp(): number {
        return Math.max(0, DailyDriver.HELP_MAX - this.helpUsed);
    }

    // ===== UI：使用 _daily 变体底图，隐藏小太阳与价格 =====
    getPanelAsset(tool: ToolType): string {
        if (tool === 'addBasket') return 'panel_add_basket_daily';
        if (tool === 'smash') return 'panel_smash_plate_daily';
        return 'panel_clear_basket_daily';
    }
    getPanelHeight(_tool: ToolType): number {
        // 三张 daily 底图统一 640x1036，按宽 320 缩放 → 518
        return 518;
    }
    showSunBalance(): boolean {
        return false;
    }
    showToolCost(): boolean {
        return false;
    }

    // ===== 通关上报与本地存储 =====
    /** 本轮耗时（秒），通关瞬间按本地计时算出，通关页立即可用，不必等接口 */
    private lastRunSeconds = 0;
    /** 本次上报的在途请求，通关页 await 它拿今日最快 */
    private clearReport: Promise<DailyClearResponse | null> | null = null;

    /**
     * 通关上报：每次通关都报。
     * 后端一人一天一行，更快才刷新起止时间，所以重复挑战必须报上去才能刷新最快成绩。
     * localStorage 的 dailyClearReported 仅作「今天通关过」的展示标记，不再用于拦截上报。
     */
    private reportClear() {
        const startAt = this.readStartTs() || Date.now();
        this.lastRunSeconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
        localStorage.setItem(this.reportedKey(), '1');
        this.clearReport = saveDailyClear(startAt);
    }

    /** 本轮耗时（秒），本地算得，通关页展示「本次用时」 */
    getLastRunSeconds(): number {
        return this.lastRunSeconds;
    }

    /** 本次上报的在途请求；通关页用它拿「今日最快」，为 null 表示本轮还没通关过 */
    getClearReport(): Promise<DailyClearResponse | null> | null {
        return this.clearReport;
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
}
