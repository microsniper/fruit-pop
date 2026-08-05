/**
 * 模式驱动接口：玩法规则全在 GameManager（仅一份），
 * 各模式的「规则差异」（起始关/进度读写/结算/道具限次/付费方式）收敛到各自 Driver 独立文件。
 *
 * GameManager 内不应再出现 `mode === 'daily'` 这类模式判断，
 * 需要区分模式时一律通过本接口取值。
 *
 * 当前实现：EndlessDriver（无限模式，道具不限次）；DailyDriver（每日挑战，每局限次+求助好友）。
 */

/** 道具类型（三个道具弹窗共用） */
export type ToolType = 'addBasket' | 'smash' | 'clear';

/**
 * 层流规则（各模式自行读后端配置合并默认值）：
 *   maxPlates   单层板子数上限（安全阀，实际受棋盘面积约束）
 *   maxLayers   一关最多层数
 *   initialLoad 开局一次性启用几层
 *   refillRatio 果量跌破首批总果量×此比例时启用下一层
 *   unburyRatio 被遮挡面积比跌破此值时灰板单独翻彩
 */
export interface LayerRules {
    maxPlates: number;
    maxLayers: number;
    initialLoad: number;
    refillRatio: number;
    unburyRatio: number;
}

/** 两个模式共用的兜底默认值（= 原 GameManager 写死常量） */
export const DEFAULT_LAYER_RULES: LayerRules = {
    maxPlates: 40, maxLayers: 10, initialLoad: 2, refillRatio: 0.7, unburyRatio: 0.6
};

/**
 * 过关后的走向：
 *   modal        弹常规过关弹窗，等玩家点「下一关」（无限模式全程）
 *   autoAdvance  不弹窗，直接进加载页加载下一关（每日挑战第 1 关）
 *   finish       弹本模式的收尾页（每日挑战第 2 关 = 整局完成）
 */
export type ClearAction = 'modal' | 'autoAdvance' | 'finish';

/**
 * 道具主按钮（橙钮）的付费方式：
 * suns=扣小太阳（无限模式）；help=求助好友分享（每日挑战，不扣小太阳）。
 * 广告按钮（蓝钮）两个模式都有，不走这里。
 */
export type ToolPayment =
    | { kind: 'suns'; cost: number }
    | { kind: 'help' };

export interface ModeDriver {
    readonly mode: 'endless' | 'daily';

    // ===== 进度与结算 =====
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
    /**
     * 过完 clearedLevel 关之后怎么走。GameManager 按此分派，内部不判断模式。
     */
    getClearAction(clearedLevel: number): ClearAction;

    // ===== 道具限次（每关维度）=====
    /** 本关该道具上限，Infinity 表示不限次 */
    getToolLimit(tool: ToolType): number;
    /** 本关该道具已用次数 */
    getToolUsed(tool: ToolType): number;
    /** 本关该道具是否还能用 */
    canUseTool(tool: ToolType): boolean;
    /** 记一次使用 */
    useTool(tool: ToolType): void;
    /** 是否已用完（canUseTool 的反面，供置灰判断用） */
    isToolExhausted(tool: ToolType): boolean;
    /** 每关开始时重置计数 */
    resetPerLevel(): void;

    // ===== 付费方式 =====
    /** 主按钮（橙钮）怎么付费。cost 为该道具的小太阳价格，help 模式下忽略 */
    getPrimaryPayment(tool: ToolType, cost: number): ToolPayment;

    // ===== 求助好友（仅每日挑战有，无限模式返回 false/0）=====
    /** 本模式是否有求助机制（无则跳过拉取求助次数等逻辑） */
    hasHelpMechanism(): boolean;
    canHelp(): boolean;
    useHelp(): void;
    isHelpExhausted(): boolean;
    setHelpUsed(used: number): void;
    getHelpUsed(): number;
    getRemainingHelp(): number;

    // ===== 层流规则 =====
    /**
     * 取当前关的层流规则：各模式读自己的后端配置合并 DEFAULT_LAYER_RULES。
     * 无限模式按关号落区间（endless_layer_rules，含第 1 关写死的新手局）；每日挑战忽略 level 参数。
     */
    getLayerRules(level: number): LayerRules;

    // ===== UI 差异 =====
    /** 道具弹窗底图资源名（不含 ui/ 前缀与 /spriteFrame 后缀） */
    getPanelAsset(tool: ToolType): string;
    /**
     * 道具弹窗面板高度（宽固定 320，高按底图原始比例）。
     * 两个模式的底图尺寸不同：daily 三张统一 640x1036 → 518；
     * 无限模式 clear 的底图是 640x983 → 492，另两张 640x1036 → 518。
     */
    getPanelHeight(tool: ToolType): number;
    /** 顶部是否显示小太阳余额 */
    showSunBalance(): boolean;
    /** 是否显示道具的小太阳价格标签 */
    showToolCost(): boolean;
}
