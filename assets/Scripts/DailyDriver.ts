import { saveDailyClear, DailyClearResponse, getGameConfig, fetchRewardConfig, drawReward, GameRewardModeEnum, RewardItem } from './api';
import type { ClearAction, ModeDriver, ToolButtonSpec, ToolType } from './ModeDriver';
import { DEFAULT_LAYER_RULES, LayerRules } from './ModeDriver';
import { PropStore } from './PropStore';

/**
 * 每日挑战驱动（省份 PK）：单关制（原第 2 关内容，配置 key "1"），通关上报后可重复挑战。
 * 进度存 localStorage 按天隔离（dailyLevel:日期），不上服务器；
 * 挑战开始时间前端计时（dailyStartTs，不按天隔离，跨零点通关也能算对用时），通关时随上报带给后端；未通关仅本地，后端无感知。
 *
 * 道具规则：每关加果篮限 2 次，砸板子/清空果盘各限 1 次；
 * 特殊果每关限 1 次且彩虹果/炸弹果共享计数（二选一）；
 * 主按钮代价是求助好友（当日上限读后端 help_max 配置），不扣金币，界面隐藏金币余额与价格。
 */
export class DailyDriver implements ModeDriver {
    readonly mode = 'daily' as const;
    /** 每日挑战总关数（单关制：原第 2 关内容作为唯一挑战关） */
    static readonly TOTAL_LEVELS = 1;

    // ===== 每关道具上限（加果篮可解两次，加果盘可解一次，其余道具本局各一次）=====
    static readonly ADD_BASKET_LIMIT = 2;
    static readonly SMASH_LIMIT = 1;
    static readonly CLEAR_TRAY_LIMIT = 1;
    static readonly ADD_TRAY_LIMIT = 1;
    /** 特殊果本局上限：彩虹果/炸弹果共享计数，只能选其中一个用一次 */
    static readonly SPECIAL_FRUIT_LIMIT = 1;
    /** 当日求助上限兜底值（实际以后端 help_max 配置 dailyChallenge 为准） */
    static readonly HELP_MAX_DEFAULT = 4;

    // ===== 每局道具次数（纯数据，UI 操作在 GameManager）=====
    private addBasketUsed = 0;
    private smashUsed = 0;
    private clearTrayUsed = 0;
    private addTrayUsed = 0;
    private specialFruitUsed = 0;
    private helpUsed = 0;
    /** 本局是否已复活（第 1+2 关整体为一局，一局只能复活一次） */
    private reviveUsedThisRun = false;

    // ===== 进度与结算 =====
    async getStartLevel(): Promise<number> {
        // 每次进入都从第1关开始：每日挑战是一整局体验（1→2→通关），退出即重置，不续玩
        // 每轮新开局都记录挑战开始时间（覆盖旧的，因为上一轮可能中途退出未通关）
        this.writeStartTs(Date.now());
        // 新一局：复活机会重置
        this.reviveUsedThisRun = false;
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
            // 通关即本局结束，下一轮是新一局：复活机会重置
            this.reviveUsedThisRun = false;
            return 1;
        }
        const next = clearedLevel + 1;
        localStorage.setItem(this.levelKey(), String(next));
        return next;
    }

    /**
     * 单关制：过完即通关上报，弹通关页（展示本次用时与今日最快）。
     */
    getClearAction(clearedLevel: number): ClearAction {
        return clearedLevel >= DailyDriver.TOTAL_LEVELS ? 'finish' : 'autoAdvance';
    }

    // ===== 道具限次 =====
    getToolLimit(tool: ToolType): number {
        if (tool === 'addBasket') return DailyDriver.ADD_BASKET_LIMIT;
        if (tool === 'smash') return DailyDriver.SMASH_LIMIT;
        if (tool === 'addTray') return DailyDriver.ADD_TRAY_LIMIT;
        return DailyDriver.CLEAR_TRAY_LIMIT;
    }
    getToolUsed(tool: ToolType): number {
        if (tool === 'addBasket') return this.addBasketUsed;
        if (tool === 'smash') return this.smashUsed;
        if (tool === 'addTray') return this.addTrayUsed;
        return this.clearTrayUsed;
    }
    canUseTool(tool: ToolType): boolean {
        return this.getToolUsed(tool) < this.getToolLimit(tool);
    }
    useTool(tool: ToolType): void {
        if (tool === 'addBasket') this.addBasketUsed++;
        else if (tool === 'smash') this.smashUsed++;
        else if (tool === 'addTray') this.addTrayUsed++;
        else this.clearTrayUsed++;
    }
    isToolExhausted(tool: ToolType): boolean {
        return !this.canUseTool(tool);
    }
    resetPerLevel(): void {
        this.addBasketUsed = 0;
        this.smashUsed = 0;
        this.clearTrayUsed = 0;
        this.addTrayUsed = 0;
        this.specialFruitUsed = 0;
    }

    // ===== 特殊果限次：本局 1 次，彩虹果/炸弹果二选一 =====
    getSpecialFruitLimit(): number {
        return DailyDriver.SPECIAL_FRUIT_LIMIT;
    }
    getSpecialFruitUsed(): number {
        return this.specialFruitUsed;
    }
    canUseSpecialFruit(): boolean {
        return this.specialFruitUsed < DailyDriver.SPECIAL_FRUIT_LIMIT;
    }
    useSpecialFruit(): void {
        this.specialFruitUsed++;
    }

    // ===== 求助好友（当日维度，跨关不重置；上限读后端 help_max 配置）=====
    hasHelpMechanism(): boolean {
        return true;
    }
    getHelpMode(): 'dailyChallenge' {
        return 'dailyChallenge';
    }
    getHelpLimit(): number {
        const v = getGameConfig().helpMax?.dailyChallenge;
        return v && v > 0 ? v : DailyDriver.HELP_MAX_DEFAULT;
    }
    canHelp(): boolean {
        return this.helpUsed < this.getHelpLimit();
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
        return Math.max(0, this.getHelpLimit() - this.helpUsed);
    }

    // ===== UI：分离式新底图（标题/示意图，无烘焙按钮）+ 面板下方独立按钮 =====
    getPanelAsset(tool: ToolType): string {
        if (tool === 'addBasket') return 'panel_add_basket';
        if (tool === 'smash') return 'panel_smash_plate';
        if (tool === 'addTray') return 'panel_add_tray';
        return 'panel_clear_basket';
    }
    getPanelHeight(tool: ToolType): number {
        // 分离式新底图按宽 320 缩放：加果篮 640x616→308、砸板子 640x604→302、清空果盘 640x634→317、加果盘 640x495→247
        if (tool === 'addBasket') return 308;
        if (tool === 'smash') return 302;
        if (tool === 'addTray') return 247;
        return 317;
    }
    /**
     * 独立按钮文案优先级规则：
     * 1. 背包有该道具的免费次数 → 「免费使用」（点击直接扣免费道具）
     * 2. 当日求助未满 → 「求助好友」（点击走求助分享）
     * 3. 兜底 → 动作名（加果篮/砸板子/清空果盘），点击看广告，按钮右上角带视频小图标
     */
    getActionButton(tool: ToolType): ToolButtonSpec {
        if (PropStore.getToolCount(tool) > 0) {
            return { text: '免费使用', pay: 'free' };
        }
        if (this.canHelp()) {
            return { text: '求助好友', pay: 'help' };
        }
        if (tool === 'addBasket') return { text: '加果篮', pay: 'ad' };
        if (tool === 'smash') return { text: '砸板子', pay: 'ad' };
        if (tool === 'addTray') return { text: '加果盘', pay: 'ad' };
        return { text: '清空果盘', pay: 'ad' };
    }

    // ===== 失败与复活：新失败弹窗 + 一局一次复活 =====
    getFailPanelAsset(): string {
        return 'panel_daily_fail';
    }
    supportsRevive(): boolean {
        return true;
    }
    canRevive(): boolean {
        return !this.reviveUsedThisRun;
    }
    useRevive(): void {
        this.reviveUsedThisRun = true;
    }

    // ===== 层流规则（后端 daily_challenge_layer_rules）=====
    /** 每日挑战不分关区间，level 参数忽略；行为 = 原 GameManager 里的 dailyLayerRules 读取 */
    getLayerRules(_level: number): LayerRules {
        const cfg = getGameConfig().dailyLayerRules;
        return { ...DEFAULT_LAYER_RULES, ...cfg };
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
        // endAt = 过关瞬间：与本次用时同一口径上报，后端按 endAt - startAt 算耗时，
        // 避免用服务器收到请求的时刻做终点导致「今日最快」比「本次用时」多出网络延迟
        const endAt = Date.now();
        this.lastRunSeconds = Math.max(0, Math.round((endAt - startAt) / 1000));
        localStorage.setItem(this.reportedKey(), '1');
        this.clearReport = saveDailyClear(startAt, endAt);
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
        // 不按天隔离：23:59 开局、跨零点通关时按天的 key 会读不到开始时间导致用时算成 0；
        // 开始时间每轮新开局都会覆盖写，单 key 即可
        return 'dailyStartTs';
    }

    private reportedKey(): string {
        return `dailyClearReported:${DailyDriver.todayStr()}`;
    }

    /**
     * 领取过关奖励：stage=1 查阶段1固定奖励（金币，包成单元素数组），stage=2 按权重无放回抽 2 条（池子不足有几条发几条）。
     * 配置在数据库（game_reward_config），接口本身无副作用；结果的实际发放由调用方（GameManager）处理。
     */
    async claimStageReward(stage: number): Promise<RewardItem[] | null> {
        if (stage === 1) {
            const fixed = await fetchRewardConfig(GameRewardModeEnum.DAILY_CHALLENGE);
            return fixed ? [fixed] : null;
        }
        return drawReward(GameRewardModeEnum.DAILY_CHALLENGE, stage, 2);
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
