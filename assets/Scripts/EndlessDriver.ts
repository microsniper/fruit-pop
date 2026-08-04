import { loginAndGetProgress, saveProgress } from './api';
import type { ClearAction, ModeDriver, ToolPayment, ToolType } from './ModeDriver';

/**
 * 无限模式驱动：进度永久累积，存 user_progress.level_num。
 *
 * 道具规则：三个道具全部不限次，代价是小太阳（橙钮）或看广告（蓝钮）。
 * 玩家愿意看广告就可以一直用，不设每关上限。
 */
export class EndlessDriver implements ModeDriver {
    readonly mode = 'endless' as const;

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

    // ===== 付费方式：扣小太阳 =====
    getPrimaryPayment(_tool: ToolType, cost: number): ToolPayment {
        return { kind: 'suns', cost };
    }

    // ===== 求助好友：无限模式不提供 =====
    hasHelpMechanism(): boolean {
        return false;
    }
    canHelp(): boolean {
        return false;
    }
    useHelp(): void {
        // 无限模式无求助机制
    }
    isHelpExhausted(): boolean {
        return false;
    }
    setHelpUsed(_used: number): void {
        // 无限模式无求助机制
    }
    getHelpUsed(): number {
        return 0;
    }
    getRemainingHelp(): number {
        return 0;
    }

    // ===== UI =====
    getPanelAsset(tool: ToolType): string {
        if (tool === 'addBasket') return 'panel_add_basket';
        if (tool === 'smash') return 'panel_smash_plate';
        return 'panel_clear_basket';
    }
    getPanelHeight(tool: ToolType): number {
        // panel_clear_basket.png 是 640x983，另两张 640x1036
        return tool === 'clear' ? 492 : 518;
    }
    showSunBalance(): boolean {
        return true;
    }
    showToolCost(): boolean {
        return true;
    }
}
