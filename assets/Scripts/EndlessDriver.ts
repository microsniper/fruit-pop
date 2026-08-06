import { loginAndGetProgress, saveProgress, getGameConfig } from './api';
import type { ClearAction, ModeDriver, ToolButtonSpec, ToolType } from './ModeDriver';
import { DEFAULT_LAYER_RULES, LayerRules } from './ModeDriver';
import { PropStore } from './PropStore';

/**
 * 无限模式驱动：进度永久累积，存 user_progress.level_num。
 *
 * 道具规则：三个道具全部不限次。
 * 按钮代价按优先级：免费道具 > 求助好友（当日独立额度）> 扣小太阳 > 看广告兜底。
 */
export class EndlessDriver implements ModeDriver {
    readonly mode = 'endless' as const;

    /** 当日求助已用次数（当日维度，进游戏时从后端拉取） */
    private helpUsed = 0;
    /** 求助上限兜底值（实际以后端 help_max 配置 endlessChallenge 为准） */
    static readonly HELP_MAX_DEFAULT = 4;

    // ===== 进度与结算 =====
    async getStartLevel(warmedLogin?: Promise<number>): Promise<number> {
        return warmedLogin ? await warmedLogin : await loginAndGetProgress();
    }

    saveLevel(level: number): void {
        saveProgress(level);
    }

    advanceLevel(clearedLevel: number): number {
        const next = clearedLevel + 1;
        saveProgress(next);
        return next;
    }

    /** 无限模式没有终点，每关都弹常规过关弹窗 */
    getClearAction(_clearedLevel: number): ClearAction {
        return 'modal';
    }

    // ===== 道具限次：全部不限 =====
    getToolLimit(_tool: ToolType): number {
        return Infinity;
    }
    getToolUsed(_tool: ToolType): number {
        return 0;
    }
    canUseTool(_tool: ToolType): boolean {
        return true;
    }
    useTool(_tool: ToolType): void {
        // 不限次，无需计数
    }
    isToolExhausted(_tool: ToolType): boolean {
        return false;
    }
    resetPerLevel(): void {
        // 不限次，无状态可重置
    }

    // ===== 失败与复活：沿用旧失败弹窗（内置重新挑战/看广告继续两个烘焙按钮）=====
    getFailPanelAsset(): string {
        return 'panel_fail';
    }
    supportsRevive(): boolean {
        return false;
    }
    canRevive(): boolean {
        return false;
    }
    useRevive(): void {
        // 无限模式不走复活流程
    }

    // ===== 特殊果限次：无限模式不限 =====
    getSpecialFruitLimit(): number {
        return Infinity;
    }
    getSpecialFruitUsed(): number {
        return 0;
    }
    canUseSpecialFruit(): boolean {
        return true;
    }
    useSpecialFruit(): void {
        // 不限次，无需计数
    }

    // ===== 求助好友（当日独立额度，与每日挑战分开计数；上限读后端 help_max 配置）=====
    hasHelpMechanism(): boolean {
        return true;
    }
    getHelpMode(): 'endlessChallenge' {
        return 'endlessChallenge';
    }
    getHelpLimit(): number {
        const v = getGameConfig().helpMax?.endlessChallenge;
        return v && v > 0 ? v : EndlessDriver.HELP_MAX_DEFAULT;
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

    // ===== 层流规则（后端 endless_layer_rules 按关卡区间）=====
    getLayerRules(level: number): LayerRules {
        // 第 1 关写死新手局：1 层 3 块板，不走配置
        if (level <= 1) {
            return { ...DEFAULT_LAYER_RULES, maxLayers: 1, maxPlates: 3, initialLoad: 1 };
        }
        // 按关号找第一个 level <= max 的区间，缺字段回落默认值；无配置整体回落默认值
        const ranges = getGameConfig().endlessLayerRules;
        if (!ranges || ranges.length === 0) return { ...DEFAULT_LAYER_RULES };
        const hit = ranges.find((r) => level <= (r.max ?? 0));
        return { ...DEFAULT_LAYER_RULES, ...(hit || {}) };
    }

    // ===== UI：分离式底图（标题/示意图，无烘焙按钮）+ 面板下方独立按钮 =====
    getPanelAsset(tool: ToolType): string {
        if (tool === 'addBasket') return 'panel_add_basket';
        if (tool === 'smash') return 'panel_smash_plate';
        if (tool === 'addTray') return 'panel_add_tray';
        return 'panel_clear_basket';
    }
    getPanelHeight(tool: ToolType): number {
        // 分离式底图按宽 320 缩放：加果篮 640x616→308、砸板子 640x604→302、清空果盘 640x634→317、加果盘 640x495→247
        if (tool === 'addBasket') return 308;
        if (tool === 'smash') return 302;
        if (tool === 'addTray') return 247;
        return 317;
    }
    /**
     * 独立按钮文案优先级规则：
     * 1. 背包有该道具的免费次数 → 「免费使用」
     * 2. 当日求助未满 → 「求助好友」
     * 3. 小太阳付得起 → 动作名 + 太阳价格（点击扣太阳）
     * 4. 兜底 → 动作名（点击看广告，按钮右上角带视频小图标）
     */
    getActionButton(tool: ToolType, cost: number, totalSuns: number): ToolButtonSpec {
        if (PropStore.getToolCount(tool) > 0) {
            return { text: '免费使用', pay: 'free' };
        }
        if (this.canHelp()) {
            return { text: '求助好友', pay: 'help' };
        }
        const actionName = tool === 'addBasket' ? '加果篮' : (tool === 'smash' ? '砸板子' : (tool === 'addTray' ? '加果盘' : '清空果盘'));
        if (totalSuns >= cost) {
            return { text: actionName, pay: 'suns', cost };
        }
        return { text: actionName, pay: 'ad' };
    }
}
