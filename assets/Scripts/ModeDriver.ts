/**
 * 模式驱动接口：玩法规则全在 GameManager（仅一份），
 * 各模式的「业务流程差异」（起始关/进度读写/结算）收敛到各自 Driver 独立文件。
 * 当前实现：EndlessDriver（无限模式）；后续 DailyDriver（每日挑战，经 LoadingPage.target='daily' 接入）。
 */
export interface ModeDriver {
    readonly mode: 'endless' | 'daily';
    /**
     * 启动读进度：返回起始关卡号。
     * warmedLogin 为 Loading 场景预热的登录请求结果（有则复用，避免场景切换后重复 wx.login）。
     */
    getStartLevel(warmedLogin?: Promise<number>): Promise<number>;
    /** 过关/重置后保存进度（不阻塞玩法，内部自处理异常） */
    saveLevel(level: number): void;
    /**
     * 过关推进一站式：存储 + 返回下一关关号。
     * EndlessDriver：n+1 并写服务器进度；DailyDriver：2 关循环（过第 2 关上报通关后回卷第 1 关）。
     */
    advanceLevel(clearedLevel: number): number;
}
