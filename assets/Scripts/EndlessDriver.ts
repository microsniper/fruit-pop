import { loginAndGetProgress, saveProgress } from './api';
import type { ModeDriver } from './ModeDriver';

/**
 * 无限模式驱动：进度永久累积，存 user_progress.level_num。
 * 逻辑从 GameManager 平移（读进度/存进度），行为与原实现完全一致。
 */
export class EndlessDriver implements ModeDriver {
    readonly mode = 'endless' as const;

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
}
