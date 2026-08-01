import { _decorator, Component, Node, Vec2, Vec3, Size, UITransform, Label, Color, tween, Graphics, director, Canvas, Widget, Mask, screen, Layers, Sprite, SpriteFrame, resources, ImageAsset, LabelOutline, UIOpacity, RigidBody2D, BoxCollider2D, CircleCollider2D, ERigidBody2DType, PhysicsSystem2D } from 'cc';
import { saveProgress, loginAndGetProgress, consumeShareCount, reportEvent, fetchGameConfig, GameConfig, getGameConfig } from './api';
import { SoundManager } from './SoundManager';
import { AdManager } from './AdManager';
import { BundleManager } from './BundleManager';
import { LoadingPage } from './LoadingPage';
import { HomePage } from './HomePage';
import { RankPage } from './RankPage';

// @ts-ignore
const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

void Widget;

export enum FruitColor {
    RED = 'red',
    BLUE = 'blue',
    YELLOW = 'yellow',
    PINK = 'pink',
    ORANGE = 'orange',
    GREEN = 'green',
    PURPLE = 'purple',
    CYAN = 'cyan',
    RAINBOW = 'rainbow'
}

type BoxColor = FruitColor | 'locked' | 'empty';
type PlateTheme = 'yellow' | 'blue';

/**
 * 板子的碰撞块：坐标系与 holes 完全一致（板局部像素、原点左上、y 向下）。
 * 只用矩形和圆两种，凑不出凹多边形，因此相交判定不需要 SAT 处理凹形分解。
 * 数据由 fit_colliders.py 从 PNG 的 alpha 轮廓自动拟合，附覆盖率/溢出率指标。
 */
type PlateCollider =
    | { kind: 'box'; cx: number; cy: number; w: number; h: number }
    | { kind: 'circle'; cx: number; cy: number; r: number };

/** 换算到世界坐标后的碰撞块 */
type WorldCollider =
    | { kind: 'box'; cx: number; cy: number; w: number; h: number }
    | { kind: 'circle'; cx: number; cy: number; r: number };

/** 一块已放板子的碰撞信息：外接圆用来做粗筛，shapes 才是精确形状 */
interface PlateBody {
    /** 粗筛外接圆圆心 */
    cx: number;
    cy: number;
    /** 粗筛外接圆半径 */
    br: number;
    shapes: WorldCollider[];
}

interface PlateTemplate {
    type: 'circle' | 'rect';
    w: number;
    h: number;
    holes: { x: number; y: number }[];
    /** 不规则形状的专属底图名（bundle_late/ui 下），有则整图渲染不走九宫格，且不参与 90 度旋转 */
    texture?: string;
    /**
     * 这个形状有没有预烘图。预烘图把白边和板子颜色一起画死在图里（bundle_late/plates 下，
     * 一色一张），渲染时按 bakedColor 选图、且不能再刷 tint —— 彩图再被乘一遍颜色会变暗发脏。
     * 白边和本体是同一个 Sprite，所以不会像双图方案那样错位、掉落时也不会脱节。
     */
    baked?: boolean;
    /** 精确碰撞体，缺省表示整块外接矩形就是实体（普通方板） */
    colliders?: PlateCollider[];
}

interface FruitData {
    id: string;
    color: FruitColor;
    x: number;
    y: number;
    removed: boolean;
}

interface PlateData {
    id: string;
    type: 'circle' | 'rect';
    color: PlateTheme;
    w: number;
    h: number;
    x: number;
    y: number;
    layer: number;
    fruits: FruitData[];
    holes: { x: number; y: number }[];
    removed: boolean;
    state?: 'stable' | 'falling' | 'supported' | 'removed';
    /** 掉落板被卡住（停在下层板上不再下落）：此时它仍遮挡别的果子，这些果子不可点 */
    stuck?: boolean;
    /** 卡住帧计数（内部用，连续多帧速度过小才判 stuck） */
    stuckFrames?: number;
    supportPlateId?: string;
    supportY?: number;
    isFalling?: boolean;
    fallDistance?: number;
    rotation?: number;
    gravityOrigin?: { x: number; y: number };
    /** 板子底色，生成关卡时定好存下来，避免重绘或灰彩过渡时跳色 */
    tint?: { r: number; g: number; b: number };
    /** 是否被上层板子埋住：埋住时只画灰色形状、藏起水果 */
    buried?: boolean;
    /** 不规则形状的专属底图名，从模板拷过来 */
    texture?: string;
    /** 这个形状是否有预烘图，从模板拷过来，见 PlateTemplate.baked */
    baked?: boolean;
    /** 预烘图用哪个色号（BAKED_PLATE_COLORS 里的名字），生成时定好，免得重绘跳色 */
    bakedColor?: string;
    /**
     * 精确碰撞体，已按缩放和旋转处理好的板局部坐标（原点左上、y 向下，与 holes 同口径）。
     * 缺省表示整块外接矩形就是它的实体（普通方板）。
     */
    colliders?: PlateCollider[];
    /** 属于第几批：0 是最上面那批，数字越大埋得越深 */
    wave?: number;
}

interface PlateBottomSample {
    localX: number;
    localY: number;
    worldX: number;
    worldY: number;
}

interface PlateSupportCandidate {
    plate: PlateData;
    dropDistance: number;
    supportRatio: number;
    continuousSamples: number;
    targetY: number;
}

interface BoxData {
    color: BoxColor;
    capacity: number;
    fruits: FruitColor[];
    isNew: boolean;
    isSlidingOut?: boolean;
    clearScheduled?: boolean;
    incomingCount?: number;
}

interface BoxSlotView {
    node: Node;
    hole: Graphics;
    fruitHost: Node;
}

interface BoxView {
    node: Node;
    /** 灰度底图 Sprite，通过 .color 动态染色 */
    bodySprite: Sprite;
    /** 锁状态的 X 图形覆盖层 */
    lockOverlay: Graphics;
    fruitIcon: Sprite;
    nameLabel: Label;
    lockLabel: Label;
    slots: BoxSlotView[];
    lastBodyColor: string;
}

interface TempSlotView {
    node: Node;
    hole: Graphics;
    fruitHost: Node;
}

interface ToolView {
    key: 'add' | 'clear';
    node: Node;
    iconLabel: Label;
    badge: Graphics;
    badgeLabel: Label;
}

const COLORS: FruitColor[] = [
    FruitColor.RED,
    FruitColor.BLUE,
    FruitColor.YELLOW,
    FruitColor.PINK,
    FruitColor.ORANGE,
    FruitColor.GREEN,
    FruitColor.PURPLE,
    FruitColor.CYAN
];

/**
 * 板子模板全集：形状收敛成 6 种（L / T / 十字 / 圆 / 小方板 / 大方板），每种都有预烘图。
 * 月牙和原来那 15 种方板尺寸（含长条串果板、宽横板、巨方板、两个假圆）已全部砍掉 ——
 * 预烘图是一形状一色一张，20 种形状要 140 张图。以后要加板子就补一套图再往这里加。
 *
 * 孔数按“孔密度均衡”定，让每种形状每个孔摊到的面积都接近，
 * 装箱按孔密度排序时才不会偏心某一种、铺出满屏同款：
 *   L / T / 十字  120×120 4孔 = 3600 px²/孔
 *   小方板        120×120 4孔 = 3600
 *   大方板        160×160 7孔 = 3657
 *   圆            96×96   3孔 = 3072
 */
const PLATE_TEMPLATES: PlateTemplate[] = [
    // 小方板：2×2 四孔，孔间距 55px
    {
        type: 'rect', w: 120, h: 120, texture: 'plate_square_s', baked: true,
        holes: [{ x: 0.27, y: 0.27 }, { x: 0.73, y: 0.27 }, { x: 0.27, y: 0.73 }, { x: 0.73, y: 0.73 }]
    },
    // 大方板：上排 3 + 居中 1 + 下排 3，孔间距 48px
    {
        type: 'rect', w: 160, h: 160, texture: 'plate_square_l', baked: true,
        holes: [
            { x: 0.20, y: 0.20 }, { x: 0.50, y: 0.20 }, { x: 0.80, y: 0.20 },
            { x: 0.50, y: 0.50 },
            { x: 0.20, y: 0.80 }, { x: 0.50, y: 0.80 }, { x: 0.80, y: 0.80 }
        ]
    }
];

/**
 * 造型板（异形）全家福：L / T / 十字 / 圆，每层保底各一块保证形状齐全。
 * 孔位都沿形状的实体区摆，避开缺口；月牙已砍掉，它的尖角被白边削钝后不好看。
 */
const SHAPE_PLATE_SET: PlateTemplate[] = [
    // L 形：竖臂在左、横臂在下
    {
        type: 'rect', w: 120, h: 120, texture: 'plate_L', baked: true,
        holes: [{ x: 27, y: 29 }, { x: 27, y: 65 }, { x: 65, y: 92 }, { x: 97, y: 92 }],
        // 竖臂 + 横臂，覆盖 100% / 溢出 1.0%，右上角真空着
        colliders: [
            { kind: 'box', cx: 28.2, cy: 32.8, w: 53.7, h: 63.0 },
            { kind: 'box', cx: 59.8, cy: 91.5, w: 117.0, h: 53.7 }
        ]
    },
    // T 形：横梁在上、竖杆居中
    {
        type: 'rect', w: 120, h: 120, texture: 'plate_T', baked: true,
        holes: [{ x: 24, y: 21 }, { x: 96, y: 21 }, { x: 60, y: 56 }, { x: 60, y: 94 }],
        // 横梁 + 竖杆，覆盖 100% / 溢出 1.9%
        colliders: [
            { kind: 'box', cx: 59.8, cy: 20.3, w: 117.0, h: 38.0 },
            { kind: 'box', cx: 59.8, cy: 79.0, w: 38.3, h: 78.7 }
        ]
    },
    // 十字：四臂各一颗
    {
        type: 'rect', w: 120, h: 120, texture: 'plate_cross', baked: true,
        holes: [{ x: 22, y: 60 }, { x: 98, y: 60 }, { x: 60, y: 22 }, { x: 60, y: 98 }],
        // 上竖臂 + 横梁 + 下竖臂，覆盖 100% / 溢出 2.3%，四个角真空着
        colliders: [
            { kind: 'box', cx: 59.8, cy: 21.0, w: 38.3, h: 39.3 },
            { kind: 'box', cx: 59.8, cy: 60.0, w: 117.0, h: 38.0 },
            { kind: 'box', cx: 60.0, cy: 98.8, w: 38.0, h: 39.0 }
        ]
    },
    // 圆盘
    {
        type: 'circle', w: 96, h: 96, texture: 'plate_circle', baked: true,
        holes: [{ x: 48, y: 34 }, { x: 32, y: 62 }, { x: 64, y: 62 }],
        // 正圆一个圆就够，覆盖 97.5% / 溢出 0%
        colliders: [{ kind: 'circle', cx: 47.7, cy: 47.7, r: 46.3 }]
    }
];

/** 板子糖果调色盘：紫罗兰、天空蓝、薄荷绿、蜜桃粉、暖沙黄、青蓝，每块板随机取一色 */
const PLATE_TINT_PALETTE = [
    { r: 158, g: 122, b: 222 },
    { r: 110, g: 168, b: 235 },
    { r: 122, g: 208, b: 168 },
    { r: 240, g: 152, b: 175 },
    { r: 214, g: 182, b: 122 },
    { r: 105, g: 200, b: 212 }
];
/** 预烘板子图所在目录（bundle_late 下），图名格式为 <texture>_<色名> */
const BAKED_PLATE_DIR = 'plates';
/**
 * 预烘图的色名，顺序必须与 PLATE_TINT_PALETTE 严格一一对应：
 * 铺板时抽到第几个调色盘颜色，就拿同下标的色名去拼图名。
 * 调色盘改了这里必须跟着改，否则图上颜色会跟逻辑上的 tint 对不上。
 */
const BAKED_PLATE_COLORS = ['violet', 'sky', 'mint', 'peach', 'sand', 'teal'];
/**
 * 未启用层用的灰版预烘图后缀。得单独出一张而不能拿彩图凑：
 * 置灰是拿 Sprite.color 乘一遍灰，彩图再乘灰只会得到“暗彩色”而不是干净的灰。
 */
const BAKED_PLATE_GRAY = 'gray';

const BOX_COLORS: Record<FruitColor, Color> = {
    [FruitColor.RED]: new Color(235, 100, 90),
    [FruitColor.BLUE]: new Color(250, 210, 80),    // 玉米黄
    [FruitColor.YELLOW]: new Color(250, 205, 70),
    [FruitColor.PINK]: new Color(245, 140, 170),
    [FruitColor.ORANGE]: new Color(255, 170, 80),
    [FruitColor.GREEN]: new Color(120, 210, 140),
    [FruitColor.PURPLE]: new Color(175, 105, 215),
    [FruitColor.CYAN]: new Color(255, 150, 70),     // 胡萝卜橙
    [FruitColor.RAINBOW]: new Color(255, 255, 255)  // 彩虹果（白色底）
};

const FRUIT_FACE_COLORS: Record<FruitColor, Color> = {
    red: new Color(200, 60, 50, 255),
    blue: new Color(210, 170, 35, 255),   // 玉米暗色
    yellow: new Color(225, 175, 40, 255),
    pink: new Color(220, 100, 130, 255),
    orange: new Color(230, 135, 45, 255),
    green: new Color(80, 170, 100, 255),
    purple: new Color(135, 70, 175, 255),
    cyan: new Color(210, 100, 30, 255),   // 胡萝卜暗色
    rainbow: new Color(180, 180, 180)     // 彩虹果暗色
};

const PAGE_CONTENT_SCALE = 0.9;
const TOP_CONTENT_OFFSET = 24;
/** 未启用层（垫在最底下作预告的下一层）的统一灰，与底图叠乘后只剩形状 */
const PLATE_BURIED_COLOR = new Color(120, 126, 132, 230);
/** 覆盖率采样网格边长：单块板子最多 9x9 个采样点 */
const PLATE_COVER_SAMPLE_GRID = 9;
/** 层被启用时，这一层板子灰→彩的过渡时长 */
const PLATE_REVEAL_DURATION = 0.35;
/** 一关最多几层，直接决定单关时长 */
const LAYER_MAX_COUNT = 8;
/** 开局一次性启用几层（首批），这几层全部彩色 */
const LAYER_INITIAL_LOAD = 3;
/** 剩余果子跌到“首批总果量 × 这个比例”以下，就从最底下再启用一层 */
const LAYER_REFILL_RATIO = 0.7;
/**
 * 灰板提前解锁的遮挡阈值。未启用层的板子除了等果子数量跌破补层阈值，
 * 还多一条放行通道：自己被上层盖住的面积比跌到这个值以下，就单独翻彩。
 * 解决的是“上面的板子都掉完了，底下露出一片灰板却摸不得，而果子数又没跌破阈值”。
 * 翻彩按单块板结算（同一层里可能一部分亮了、一部分还灰着）；
 * 而数量跌破阈值那条通道依旧是整层一起亮。
 */
const PLATE_UNBURY_COVER_RATIO = 0.6;
/** 单层铺满时的板子数量上限，循环安全阀 */
const LAYER_MAX_PLATES = 40;
/**
 * 板子整体缩放。铺板改成规则化装箱后已经不需要靠缩小换密度，回到原尺寸。
 * 留着这个旋钮方便日后调：离线仿真 1.0 占地 79.8%，0.9 是 74.4%，
 * 往上调到 1.1 反而掉到 76%（板子太大方板挤不进去，一层只剩 0.2 块方板），1.0 就是上限。
 * 注：显式标 number 而不是让它推成字面量类型，否则 scaleTemplate 里跟 1 比大小会被当成永假。
 */
const PLATE_SCALE: number = 1.0;
/**
 * 装箱扫描步长（px）。每块板子按这个步长扫网格，碰到第一个放得下的位置就放。
 * 离线测过密度与开销的取舍：步长 4 占地 80.6%、每层 51 万次相交检测；
 * 步长 8 占地 79.1%、每层 12.8 万次；步长 14 就掉到 72.7% 了。
 * 8 是拐点：密度几乎不掉，开销只有四分之一。
 */
const PACK_SCAN_STEP = 8;
/**
 * 模板重复次数：装箱时把整副模板池重复这么多遍再排序，同一个模板因此一层能出多次。
 * 取4 是因为一层最多就铺 8 块左右，再多副牌只是白扫网格。
 */
const PACK_TEMPLATE_COPIES = 4;
/**
 * 排序扰动幅度：排序权重乘上 1±这个值的随机数。
 * BLF 是确定性算法，不加扰动的话每层铺出来的布局会一模一样，玩家一眼看出是模板。
 */
const PACK_ORDER_JITTER = 0.15;
/**
 * 每层先保底铺几块方板。形状收敛后孔密度均衡，方板在排序里不再占优、个头又大，
 * 不保底的话离线仿真里一层只剩 0.47 块，而它是画面里唯一的规整形状，全是异形会显得碎。
 * 保底 2 块：孔位 30.9、占地 80.1%；保底 1 块方板只有 1.07 块；保底 3 块就挤掉孔位了。
 */
const LAYER_RECT_PLATE_FIRST = 2;
/**
 * 每层保底铺几块异形板（L / T / 十字 / 圆）。取 4 就是全家福各一块，
 * 保证每层形状齐全；它们个头小，不保底会排到最后反而难进场。
 */
const LAYER_SHAPE_PLATE_FIRST = 4;

let tutorialShown = false;
let rainbowIntroduced = false;
let challengeTipShown = false;

@ccclass('GameManager')
export class GameManager extends Component {
    private static _physicsGravitySet = false;
    /** 碰撞矩阵是否已按当前关卡 wave 配置（initGame 重置，每关重配） */
    private static _collisionMatrixConfigured = false;
    /** 物理组件是否就绪：initGame 期间为 false（跳过物理创建），场景稳定后置 true 统一初始化 */
    private _physicsReady = true;
    public rootNode: Node | null = null;
    public currentLevel = 1;
    private maxTempHoles = 5;
    /** 飞行中的水果颜色：让选色统计池在飞行窗口期也能看见未落地水果，避免清篮换色刷出无关颜色导致死局 */
    private flyingFruitColors: FruitColor[] = [];
    private totalFruits = 0;
    private removedFruits = 0;
    private sunsCollectedThisLevel = 0;
    public totalSuns = 0;
    /** 小太阳不足提示横幅节点：用于幂等控制，显示期间忽略重复触发 */
    private sunShortageTipNode: Node | null = null;
    /** 暂存区满 4 时指向解锁果篮的引导小手节点 */
    private tempFullGuideNode: Node | null = null;
    /** 跟小手同步呼吸（缩放脉动）的锁定果篮节点：小手在它就呼吸，小手没了就停 */
    private tempGuideBreathNode: Node | null = null;
    /** 引导“已武装”：暂存区掉回 4 以下重新武装，再次达 4 才弹，避免一直停在 4/5 重复弹 */
    private tempGuideArmed = true;
    private gameOver = false;
    private gameConfig: GameConfig | null = null;
    private loadingNode: Node | null = null;

    private boxes: BoxData[] = [];
    private tempHoles: FruitColor[] = [];
    private incomingTempCount: number = 0;
    private plates: PlateData[] = [];
    private tools = { add: 0, clear: 1 };

    public topAreaNode: Node | null = null;
    public boardAreaNode: Node | null = null;
    private boardContentNode: Node | null = null;
    private boardEffectNode: Node | null = null;
    public bottomAreaNode: Node | null = null;
    private boxesContainerNode: Node | null = null;
    public tempContainerNode: Node | null = null;
    public sunCountLabel: Label | null = null;
    public sunIconNode: Node | null = null;
    private toolContainerNode: Node | null = null;
    public modalLayerNode: Node | null = null;
    /** 首页与排行榜页：逻辑已拆到独立文件，通过 gm 引用协作 */
    public readonly homePage = new HomePage(this);
    public readonly rankPage = new RankPage(this);
    /** 新手引导/奖励弹窗是否已触发过（改为首次进入无限模式时触发） */
    private welcomeFlowShown = false;
    private fruitSprites: Map<string, SpriteFrame> = new Map();
    private fruitsLoaded = false;
    /** 灰度果篮底图，运行时动态染色 */
    private basketSpriteFrame: SpriteFrame | null = null;
    private plateSpriteFrame: SpriteFrame | null = null;
    /** 不规则板子的专属底图缓存，key 是模板里的 texture 名 */
    private plateTextureFrames: Map<string, SpriteFrame> = new Map();
    /** 分享图片本地路径缓存 */
    private shareImageUrls: Record<string, string> = {};
    /** 待执行的分享奖励回调 */
    private pendingShareCallback: (() => void) | null = null;
    /** 记录点击分享拉起微信面板时的时间戳，用于防御秒关白嫖 */
    private shareStartTime = 0;
    /** 上次收集水果的时间戳（毫秒），用于连击判定 */
    private lastCollectTime = 0;


    /** 记录上次求助成功的时间戳，用于本地3分钟CD控制（已废弃CD，仅保留变量防报错） */
    private lastHelpTime = 0;
    private readonly HELP_COOLDOWN_MS = 3 * 60 * 1000;

    /** 获取求助按钮状态：是否可用，以及CD倒计时 */
    public getHelpButtonState(): { disabled: boolean; text: string } {
        if (this.isShareLimitReached()) {
            return { disabled: true, text: '今日已达上限' };
        }
        
        return { disabled: false, text: '求助群友' };
    }

    public soundEnabled: boolean = true;
    public vibrationEnabled: boolean = true;
    
    public getTodayStr(): string {
        const d = new Date();
        return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}`;
    }

    private isShareLimitReached(): boolean {
        try {
            if (typeof wx !== 'undefined') {
                return wx.getStorageSync('share_limit_date') === this.getTodayStr();
            }
            return localStorage.getItem('share_limit_date') === this.getTodayStr();
        } catch (e) {
            return false;
        }
    }

    private setShareLimitReached() {
        try {
            if (typeof wx !== 'undefined') {
                wx.setStorageSync('share_limit_date', this.getTodayStr());
            } else {
                localStorage.setItem('share_limit_date', this.getTodayStr());
            }
        } catch (e) {}
    }
    /** 当前连击次数 */
    private comboCount = 0;
    private titleLabel: Label | null = null;
    private levelBadgeLabel: Label | null = null;
    private progressLabel: Label | null = null;
    private plateNodes = new Map<string, Node>();
    private fallingPlateNodes = new Map<string, Node>();
    private boxViews: BoxView[] = [];
    private tempBgGraphics: Graphics | null = null;
    
    // 省略其他不相关的变量
    private tempSlotViews: TempSlotView[] = [];
    private toolViews: ToolView[] = [];

    public screenWidth = 0;
    public screenHeight = 0;
    private topHeight = 0;
    private boardHeight = 0;
    private bottomHeight = 0;
        private boardWidth = 0;
    /** 这一关一共几批，开局就定好 */
    private maxWave = 0;
    /** 剩余果子跌到这个数以下就启用下一层（= 首批总果量 × LAYER_REFILL_RATIO） */
    private refillThreshold = 0;
    /** 已经建过节点的最深批次，再深的批次等玩家挖到了才加载 */
    private loadedWave = 0;

    async start() {
        this.setupLayout();

        // 注意：不要注册 wx.onNeedPrivacyAuthorization 自动同意，
        // 否则微信官方隐私弹窗不会出现，且违反微信隐私规范。
        // 由 wx.requirePrivacyAuthorize 触发微信官方的隐私弹窗。

        // 恢复小太阳数量
        const storedSuns = localStorage.getItem('totalSuns');
        if (storedSuns) {
            this.totalSuns = parseInt(storedSuns, 10) || 0;
        }

        const storedSound = localStorage.getItem('soundEnabled');
        this.soundEnabled = storedSound !== 'false';
        const storedVibration = localStorage.getItem('vibrationEnabled');
        this.vibrationEnabled = storedVibration !== 'false';

        this.initSound();
        this.initAd();
        // 经由 Loading 场景进入时：资源/登录已在加载页完成，直接复用预热结果，跳过旧转圈与 2 秒等待
        const fromLoading = LoadingPage.consumeLaunched();
        const warmup = LoadingPage.consumeWarmup();
        if (!fromLoading) {
            this.showLoadingOverlay();
        }
        const loadStart = Date.now();
        this.currentLevel = warmup ? await warmup.login : await loginAndGetProgress();
        this.gameConfig = warmup ? await warmup.config : await fetchGameConfig();
        
        BundleManager.getInstance().preload();  // 后台预加载分包
        await this.loadFruitSprites();  // 确保水果图片加载完成后再初始化游戏
        await this.loadBasketBase();    // 加载灰度果篮底图
        this.preloadShareImages();      // 预加载分享图片
        // 物理延迟激活：场景切换中创建刚体可能导致 Box2D broadphase 状态异常，先跳过物理，等 enter() 后统一初始化
        this._physicsReady = false;
        this.initGame();
        const elapsed = (Date.now() - loadStart) / 1000;
        const delay = fromLoading ? 0 : Math.max(0, 2.0 - elapsed);
        const enter = () => {
            this.hideLoadingOverlay();
            if (LoadingPage.consumeTarget() === 'endless') {
                // 目标无限模式：initGame 已建好对局视图，直接补新手/奖励引导
                this.initAllPlatePhysics();
                this.showWelcomeFlowIfNeeded();
            } else {
                // 先进首页选择模式，新手引导/奖励弹窗延后到首次进入无限模式时再弹
                // 不初始化物理：homePage.render() 会清掉板子节点，物理刚体不需要
                this._physicsReady = true;
                this.homePage.render();
            }
        };
        // 经 Loading 进入（delay=0）时同帧执行：initGame 渲染的对局在同帧被 homePage.render 清空（进主页）
        // 或直接展示（进无限模式），既不闪现对局画面，也避免 scheduleOnce 跨帧的时序问题
        if (delay <= 0) {
            enter();
        } else {
            this.scheduleOnce(enter, delay);
        }
    }

    private initSound() {
        const scene = director.getScene();
        if (!scene) return;
        const soundNode = new Node('SoundManager');
        soundNode.addComponent(SoundManager);
        scene.addChild(soundNode);
    }

    private initAd() {
        const scene = director.getScene();
        if (!scene) return;
        const adNode = new Node('AdManager');
        adNode.addComponent(AdManager);
        scene.addChild(adNode);
    }

    private showTutorialIfNeeded(onClose?: () => void) {
        if (this.currentLevel !== 1 || tutorialShown) {
            if (onClose) onClose();
            return;
        }

        tutorialShown = true;

        this.renderCommonTip('🎉 欢迎来到果园', '🍎 点击果子 → 投入同色果篮\n🧺 凑满果篮 → 自动清空继续\n🪵 板子清空 → 掉落露出新果子\n\n没合适果篮？先放果盘暂存！', onClose);
    }

    private showRainbowTutorial() {
        this.renderCommonTip('🌈 彩虹果！', '彩虹果是万能果实！\n✨ 它可以放入任意果篮，无视颜色\n哪里有空位就能去哪里\n\n合理利用彩虹果，轻松过关～');
    }

    /**
     * 每日奖励领取成功动画：多个金色太阳粒子从宝箱中心沿贝塞尔弧线飞向顶部太阳图标，
     * 逐个到达时计数从 startSuns 滚动增加到 startSuns+amount，太阳图标同步 punch 缩放。
     * 全部到达后回调 onComplete（关闭弹窗）。
     */
    public playDailyRewardSunFly(startWorldPos: Vec3, startSuns: number, amount: number, onComplete: () => void) {
        const layer = this.modalLayerNode;
        const sunWorldPos = this.getSunWorldPos();
        const layerTransform = layer?.getComponent(UITransform);
        if (!layer || !sunWorldPos || !layerTransform) {
            // 顶部太阳图标不可用时直接更新数字并结束
            if (this.sunCountLabel && this.sunCountLabel.isValid) {
                this.sunCountLabel.string = `${startSuns + amount}`;
            }
            onComplete();
            return;
        }

        const startLocal = layerTransform.convertToNodeSpaceAR(startWorldPos);
        const targetLocal = layerTransform.convertToNodeSpaceAR(sunWorldPos);

        const count = 10;
        const particleSize = 9;
        const goldColor = new Color(255, 220, 50, 255);
        let arrived = 0;

        for (let i = 0; i < count; i++) {
            const delay = i * 0.06;
            this.scheduleOnce(() => {
                if (!layer.isValid) return;
                // 金色太阳粒子（圆点+发光外圈，与果篮收集动画同款）
                const particleNode = new Node(`RewardSun_${i}`);
                const glowGraphic = particleNode.addComponent(Graphics);
                glowGraphic.fillColor = new Color(255, 240, 100, 100);
                glowGraphic.circle(0, 0, particleSize + 4);
                glowGraphic.fill();
                const particleGraphic = particleNode.addComponent(Graphics);
                particleGraphic.fillColor = goldColor;
                particleGraphic.circle(0, 0, particleSize);
                particleGraphic.fill();

                particleNode.setPosition(new Vec3(startLocal.x, startLocal.y, 0));
                particleNode.layer = Layers.Enum.UI_2D;
                layer.addChild(particleNode);
                particleNode.setSiblingIndex(9999);

                // 二次贝塞尔曲线飞行：控制点抬高形成弧度，每个粒子略错开
                const ctrlX = (startLocal.x + targetLocal.x) / 2 + (i % 2 === 0 ? 40 : -40);
                const ctrlY = Math.max(startLocal.y, targetLocal.y) + 60 + i * 8;
                const progress = { t: 0 };

                tween(progress)
                    .to(0.5, { t: 1 }, {
                        onUpdate: () => {
                            if (!particleNode.isValid) return;
                            const t = progress.t;
                            const inv = 1 - t;
                            const x = inv * inv * startLocal.x + 2 * inv * t * ctrlX + t * t * targetLocal.x;
                            const y = inv * inv * startLocal.y + 2 * inv * t * ctrlY + t * t * targetLocal.y;
                            particleNode.setPosition(new Vec3(x, y, 0));
                            const s = 1.3 - t; // 从 1.3 缩到 0.3
                            particleNode.setScale(new Vec3(s, s, 1));
                        }
                    })
                    .call(() => {
                        if (particleNode.isValid) particleNode.destroy();
                        arrived++;
                        // 计数随粒子到达滚动增加
                        if (this.sunCountLabel && this.sunCountLabel.isValid) {
                            this.sunCountLabel.string = `${startSuns + Math.round(amount * arrived / count)}`;
                        }
                        // 太阳图标 punch 缩放
                        if (this.sunIconNode && this.sunIconNode.isValid) {
                            this.sunIconNode.setScale(new Vec3(1, 1, 1));
                            tween(this.sunIconNode)
                                .to(0.08, { scale: new Vec3(1.25, 1.25, 1) })
                                .to(0.08, { scale: new Vec3(1, 1, 1) })
                                .start();
                        }
                        if (arrived === count) {
                            onComplete();
                        }
                    })
                    .start();
            }, delay);
        }
    }

    private showChallengeTip() {
        this.renderCommonTip('⚡ 挑战关卡', '果篮刷新变懒了！\n不再优先帮你匹配颜色，\n规划好再摘，别让暂存盘塞满～');
    }

    /**
     * 通用提示弹窗：panel_common_tip.png（标题“提示”与“知道了”按钮已画在图里）
     * 内容文案写在白色面板区域，点“知道了”关闭。新手/彩虹果/挑战关提示共用。
     */
    public renderCommonTip(title: string, content: string, onConfirm?: () => void) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        // 遮罩
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 面板：该图 trimType=auto（trim 后可见区 421x461），宽 310，高按可见区域等比校正，杜绝变形
        const panelW = 310;
        const panelNode = this.createNode('CommonTipPanel', this.modalLayerNode, 0, 0, panelW, panelW * 461 / 421);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_common_tip/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                // 按 trim 后可见区域（rect）等比校正高度，不能用 originalSize（含已裁剪的透明边）
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
                }
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 标题：25 号深棕粗体，位于白板上方（坐标按 trim 后可见区比例计算）
        this.createLabel(panelNode, title, 0, 0.183 * panelTransform.height, 25, new Color(96, 64, 32, 255), true);

        // 内容文案：写在白色面板区域（坐标与尺寸均按 trim 后可见区比例跟随面板）
        const contentNode = this.createNode('TipContent', panelNode, 0, -0.10 * panelTransform.height, panelW * 0.80, panelTransform.height * 0.435);
        const contentLabel = contentNode.addComponent(Label);
        contentLabel.string = content;
        contentLabel.fontSize = 18;
        contentLabel.lineHeight = 30;
        contentLabel.color = new Color(96, 64, 32, 255); // 深棕，果园卡通风
        contentLabel.isBold = true;
        contentLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        contentLabel.verticalAlign = Label.VerticalAlign.CENTER;
        contentLabel.overflow = Label.Overflow.SHRINK;

        // “知道了”按钮热区（trim 后按钮中心约在可见区高 91.5% 处，热区放宽便于点击）
        const btnOk = this.createNode('BtnOk', panelNode, 0, -0.415 * panelTransform.height, panelW * 0.5, 56);
        btnOk.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
            if (onConfirm) onConfirm();
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 二次确认弹窗：panel_confirm_home.png（图内没有任何文字，标题/正文/两颗按钮文案全部 Label 叠加）。
     * 左绿钮=取消，右橙钮=确认。不可逆操作（丢弃本局进度/小太阳）才用它，单纯告知走 renderCommonTip。
     */
    public renderConfirmTip(
        title: string,
        content: string,
        cancelText: string,
        confirmText: string,
        onConfirm: () => void,
        onCancel?: () => void,
    ) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        // 遮罩：点空白处等同于取消，不做静默关闭
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
            if (onCancel) onCancel();
        }, this);

        // 面板：该图已预裁到可见区（970x891），trim 开关不影响坐标；高仍按 rect 等比校正，杜绝变形
        const panelW = 320;
        const panelNode = this.createNode('ConfirmTipPanel', this.modalLayerNode, 0, 0, panelW, panelW * 891 / 970);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_confirm_home/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
                }
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 以下坐标均为图上实测比例：缎带中心 fy=0.1375，白色虚线内板中心 fy=0.4602（宽 0.783 / 高 0.395），
        // 双钮中心 fy=0.7811、左绿 fx=0.3062 / 右橙 fx=0.6948，钮宽 0.330、钮高 0.130
        const ph = panelTransform.height;

        // 标题：写在空白绿缎带上，白字加深绿描边
        const titleLabel = this.createLabel(panelNode, title, 0, (0.5 - 0.1375) * ph, 21, new Color(255, 255, 255, 255), true);
        const titleOutline = titleLabel.node.addComponent(LabelOutline);
        if (titleOutline) {
            titleOutline.color = new Color(38, 100, 38, 255);
            titleOutline.width = 2;
        }

        // 正文：写在白色虚线内板里，宽到虚线内沿（内板 0.783），给最长那行留得下位置，避免 SHRINK 把字缩小
        const contentNode = this.createNode('ConfirmContent', panelNode, 0, (0.5 - 0.4602) * ph, panelW * 0.76, ph * 0.34);
        const contentLabel = contentNode.addComponent(Label);
        contentLabel.string = content;
        contentLabel.fontSize = 16;
        contentLabel.lineHeight = 25;
        contentLabel.color = new Color(96, 64, 32, 255); // 深棕，与通用提示弹窗保持一致
        contentLabel.isBold = true;
        contentLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        contentLabel.verticalAlign = Label.VerticalAlign.CENTER;
        contentLabel.overflow = Label.Overflow.SHRINK;

        // 两颗按钮：热区略大于图上胶囊，保证手指点得到
        const btnW = panelW * 0.35;
        const btnH = ph * 0.16;
        const btnY = (0.5 - 0.7811) * ph;

        const btnCancel = this.createNode('BtnCancel', panelNode, (0.3062 - 0.5) * panelW, btnY, btnW, btnH);
        const cancelLabel = this.createLabel(btnCancel, cancelText, 0, 0, 18, new Color(255, 255, 255, 255), true);
        const cancelOutline = cancelLabel.node.addComponent(LabelOutline);
        if (cancelOutline) {
            cancelOutline.color = new Color(38, 100, 38, 255);
            cancelOutline.width = 2;
        }
        btnCancel.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.modalLayerNode!.removeAllChildren();
            if (onCancel) onCancel();
        }, this);

        const btnConfirm = this.createNode('BtnConfirm', panelNode, (0.6948 - 0.5) * panelW, btnY, btnW, btnH);
        const confirmLabel = this.createLabel(btnConfirm, confirmText, 0, 0, 18, new Color(255, 255, 255, 255), true);
        const confirmOutline = confirmLabel.node.addComponent(LabelOutline);
        if (confirmOutline) {
            confirmOutline.color = new Color(180, 90, 20, 255);
            confirmOutline.width = 2;
        }
        btnConfirm.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.modalLayerNode!.removeAllChildren();
            onConfirm();
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 挑战失败弹窗：panel_fail.png，暂存区满时弹出。重新挑战=重开本关；继续游戏=看广告清空暂存区 */
    private renderFailModal() {
        if (!this.modalLayerNode) return;
        this.removeTempFullGuide();
        this.modalLayerNode.removeAllChildren();

        // 遮罩
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 面板：新版立体风 640x1029（已裁紧），宽 280，高按原图等比
        const panelW = 280;
        const panelNode = this.createNode('FailPanel', this.modalLayerNode, 0, 0, panelW, panelW * 1029 / 640);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();

        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_fail/spriteFrame', SpriteFrame).then((sf) => {
            if (!sf || !sprite || !sprite.isValid) return;
            sprite.spriteFrame = sf;
            // 按 trim 后可见区域（rect）等比校正高度
            const rect = sf.rect;
            if (rect && rect.width > 0) {
                panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
            }
            const pw = panelTransform.width;
            const ph = panelTransform.height;
            // 可见区比例坐标 → 面板本地坐标（比例基于新图 640x1029 像素分析）
            const px = (fx: number) => (fx - 0.5) * pw;
            const py = (fy: number) => (0.5 - fy) * ph;

            // 顶部太阳数量：太阳右侧留白条内，浅色底用深棕字，左对齐
            const sunsLabel = this.createLabel(panelNode, `${this.totalSuns}`, px(0.36), py(0.247), 24, new Color(110, 75, 45, 255), true);
            const sunsTransform = sunsLabel.node.getComponent(UITransform);
            if (sunsTransform) sunsTransform.setAnchorPoint(0, 0.5);
            sunsLabel.horizontalAlign = 0; // LEFT

            // “历史最好成绩”下方白色留白块：第 X 关（X 为当前关数）
            this.createLabel(panelNode, `第 ${this.currentLevel} 关`, 0, py(0.511), 26, new Color(50, 50, 50, 255), true);

            // 橙钮上方空隙的红色小字提示（与加果篮/清空果盘弹窗底图里的红字提示同款观感）
            this.createLabel(panelNode, '重新挑战会清空小太阳哦', 0, py(0.618), 13, new Color(215, 60, 50, 255), true);

            // 重新挑战（橙黄按钮热区）：挑战失败，清零小太阳后重开当前关卡
            const btnRetry = this.createNode('BtnRetry', panelNode, 0, py(0.694), pw * 0.60, ph * 0.10);
            btnRetry.on(Node.EventType.TOUCH_END, () => {
                this.gameOver = false;
                this.totalSuns = 0;
                localStorage.setItem('totalSuns', '0');
                this.modalLayerNode!.removeAllChildren();
                this.initGame();
            }, this);

            // 继续游戏（蓝按钮热区）：唤起广告，看完后清空暂存区
            const btnContinue = this.createNode('BtnContinue', panelNode, 0, py(0.853), pw * 0.60, ph * 0.10);
            btnContinue.on(Node.EventType.TOUCH_END, () => {
                this.showAdThen(() => {
                    this.gameOver = false;
                    this.tempHoles = [];
                    this.renderTopUI();
                    this.modalLayerNode!.removeAllChildren();
                }, 'revive');
            }, this);
        }).catch(() => {});
    }

    public showLoadingOverlay() {
        const scene = director.getScene();
        if (!scene || !this.rootNode) return;

        this.loadingNode = this.createNode('LoadingOverlay', this.rootNode, 0, 0, this.screenWidth, this.screenHeight);
        this.loadingNode.setSiblingIndex(998);

        const mask = this.createGraphicsNode('Mask', this.loadingNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(225, 240, 210, 255), 0);

        const centerY = 30;
        const ringSize = 80;
        const spinner = this.createNode('Spinner', this.loadingNode, 0, centerY, ringSize, ringSize);

        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const dotX = Math.cos(angle) * 26;
            const dotY = Math.sin(angle) * 26;
            const dotG = this.createGraphicsNode(`Dot_${i}`, spinner, 14, 14, dotX, dotY);
            const alpha = 80 + i * 22;
            const size = 4 + i * 0.4;
            const dg = dotG.getComponent(Graphics)!;
            dg.fillColor = new Color(100, 160, 80, alpha);
            dg.circle(0, 0, size);
            dg.fill();
        }

        tween(spinner).by(1.2, { angle: -360 }).repeatForever().start();

        const innerG = this.createGraphicsNode('Inner', spinner, 30, 30, 0, 0);
        this.drawCircle(innerG.getComponent(Graphics)!, 13, new Color(250, 160, 60, 255), 2, new Color(200, 100, 30, 240));

        const title = this.createLabel(this.loadingNode, '摘呀摘呀摘', 0, centerY - 60, 24, new Color(80, 60, 35, 255), true);
        title.getComponent(Label)!.horizontalAlign = 1;

        const subtitle = this.createLabel(this.loadingNode, '采摘中...', 0, centerY - 90, 14, new Color(130, 100, 70, 255), false);
        subtitle.getComponent(Label)!.horizontalAlign = 1;
    }

    public hideLoadingOverlay() {
        if (!this.loadingNode || !this.loadingNode.isValid) return;

        tween(this.loadingNode)
            .to(0.25, { scale: new Vec3(0.9, 0.9, 1) })
            .call(() => {
                if (this.loadingNode && this.loadingNode.isValid) {
                    this.loadingNode.destroy();
                    this.loadingNode = null;
                }
            })
            .start();
    }

    private findCanvasNode() {
        const scene = director.getScene();
        if (!scene) return null;

        const stack: Node[] = [scene];
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current.name === 'Canvas') {
                return current;
            }
            const children = current.children;
            for (let i = 0; i < children.length; i++) {
                stack.push(children[i]);
            }
        }
        return null;
    }


    private setupLayout() {
        // 使用固定的内部逻辑分辨率，确保所有硬编码的尺寸比例正常
        this.screenWidth = 375;
        this.screenHeight = 812;
        
        this.topHeight = this.screenHeight * 0.28;
        this.bottomHeight = this.screenHeight * 0.10;
        this.boardHeight = this.screenHeight - this.topHeight - this.bottomHeight;
        this.boardWidth = this.screenWidth * 0.94;

        if (this.rootNode) {
            this.rootNode.destroy();
        }
        this.plateNodes.clear();
        this.fallingPlateNodes.clear();
        this.boxViews = [];
        this.tempBgGraphics = null;
        this.tempSlotViews = [];
        this.toolViews = [];
        // 重建布局时太阳/设置排行榜按钮的旧节点已销毁，置空引用触发重建
        this.sunCountLabel = null;
        this.sunIconNode = null;

        this.rootNode = new Node('GameRoot');
        this.rootNode.layer = Layers.Enum.UI_2D;
        const uiTransform = this.rootNode.addComponent(UITransform);
        uiTransform.setContentSize(this.screenWidth, this.screenHeight);

        // 寻找场景真实的 Canvas，以计算缩放比例
        let canvasNode: Node | null = null;
        const scene = director.getScene();
        if (scene) {
            const canvasComp = scene.getComponentInChildren(Canvas);
            if (canvasComp) {
                canvasNode = canvasComp.node;
            }
        }

        let scale = 1;
        if (canvasNode) {
            this.rootNode.parent = canvasNode;
            
            // 尝试通过 screen.windowSize 获取尺寸
            const windowSize = screen.windowSize;
            let visibleWidth = windowSize.width;
            let visibleHeight = windowSize.height;

            if (visibleWidth > 0 && visibleHeight > 0) {
                // 如果是真机高分屏，尺寸可能会极大，需要除以 devicePixelRatio 转换回逻辑像素
                const dpr = screen.devicePixelRatio || 1;
                visibleWidth = visibleWidth / dpr;
                visibleHeight = visibleHeight / dpr;

                const scaleX = visibleWidth / this.screenWidth;
                const scaleY = visibleHeight / this.screenHeight;
                scale = Math.min(scaleX, scaleY);
            } else {
                const canvasUI = canvasNode.getComponent(UITransform);
                if (canvasUI && canvasUI.width > 0 && canvasUI.height > 0) {
                    const scaleX = canvasUI.width / this.screenWidth;
                    const scaleY = canvasUI.height / this.screenHeight;
                    scale = Math.min(scaleX, scaleY);
                }
            }
        } else {
            this.rootNode.parent = this.node.parent || this.node;
        }

        // 整体缩小一圈，让真机上更接近原来的 Vue 版留白感
        this.rootNode.setScale(new Vec3(scale * PAGE_CONTENT_SCALE, scale * PAGE_CONTENT_SCALE, 1));
        this.rootNode.setPosition(new Vec3(0, 0, 0));

        // 清理当前测试节点的默认文字
        const defaultLabelNode = this.node.getChildByName('Label');
        if (defaultLabelNode) {
            defaultLabelNode.active = false;
        }

        const background = this.createGraphicsNode('Background', this.rootNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(background.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(235, 245, 225, 255), 0);

        const topY = this.screenHeight / 2 - this.topHeight / 2;
        const boardY = -this.screenHeight / 2 + this.bottomHeight + this.boardHeight / 2;
        const bottomY = -this.screenHeight / 2 + this.bottomHeight / 2;

        this.topAreaNode = this.createNode('TopArea', this.rootNode, 0, topY, this.screenWidth, this.topHeight);
        // 背景图独立裁切层：等比缩放填满，溢出部分裁掉，不影响其他子元素
        const topBgClip = this.createNode('TopBgClip', this.topAreaNode, 0, 0, this.screenWidth, this.topHeight);
        topBgClip.addComponent(Mask);
        const topBg = this.createNode('TopBg', topBgClip, 0, 0, this.screenWidth, this.topHeight);
        const topBgSprite = topBg.addComponent(Sprite);
        topBgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/bg_top/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && topBgSprite && topBgSprite.isValid) {
                topBgSprite.spriteFrame = sf;
                // 等比缩放填满区域（cover-fit），居中裁切，避免变形
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scaleX = this.screenWidth / rect.width;
                    const scaleY = this.topHeight / rect.height;
                    const scale = Math.max(scaleX, scaleY);
                    const bgTransform = topBg.getComponent(UITransform)!;
                    bgTransform.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        }).catch(() => {});

        this.boardAreaNode = this.createNode('BoardArea', this.rootNode, 0, boardY, this.screenWidth, this.boardHeight);
        const boardMask = this.boardAreaNode.addComponent(Mask);
        
        const boardBg = this.createGraphicsNode('BoardBg', this.boardAreaNode, this.screenWidth, this.boardHeight, 0, 0);
        this.drawRoundedRect(boardBg.getComponent(Graphics)!, this.screenWidth, this.boardHeight, new Color(210, 225, 190, 255), 0);

        this.boardContentNode = this.createNode('BoardContent', this.boardAreaNode, 0, 0, this.boardWidth, this.boardHeight - 20);
        this.boardEffectNode = this.createNode('BoardEffect', this.boardAreaNode, 0, 0, this.boardWidth, this.boardHeight - 20);

        this.bottomAreaNode = this.createNode('BottomArea', this.rootNode, 0, bottomY, this.screenWidth, this.bottomHeight);
        const bottomBg = this.createGraphicsNode('BottomBg', this.bottomAreaNode, this.screenWidth, this.bottomHeight, 0, 0);
        this.drawRoundedRect(bottomBg.getComponent(Graphics)!, this.screenWidth, this.bottomHeight, new Color(220, 230, 200, 255), 0);

        this.modalLayerNode = this.createNode('ModalLayer', this.rootNode, 0, 0, this.screenWidth, this.screenHeight);
        this.modalLayerNode.setSiblingIndex(999);

        this.buildStaticTopUI();
        this.boxesContainerNode = this.createNode('Boxes', this.topAreaNode, 0, 8 - TOP_CONTENT_OFFSET, this.screenWidth - 40, 130);
        // 暂存区向上移动 10px
        this.tempContainerNode = this.createNode('TempSlots', this.topAreaNode, 0, -this.topHeight * 0.35 - TOP_CONTENT_OFFSET + 10, this.screenWidth - 60, 90);
        this.toolContainerNode = this.createNode('Tools', this.bottomAreaNode, 0, 0, this.screenWidth - 40, this.bottomHeight - 10);
    }

    private buildStaticTopUI() {
        if (!this.topAreaNode) return;

        const topInnerY = this.topHeight / 2 - 42 - TOP_CONTENT_OFFSET;

        // 往上抬 16px，避免徽章底边被下方果篮卡片行遮挡
        const badgeY = topInnerY + 24;
        this.levelBadgeLabel = this.createLabel(this.topAreaNode, '第 1 关', 0, badgeY, 22, new Color(255, 255, 255, 255), true);

        const badge = this.createGraphicsNode('LevelBadgeBg', this.topAreaNode, 130, 44, 0, badgeY);
        badge.setSiblingIndex(0);
        this.drawRoundedRect(badge.getComponent(Graphics)!, 130, 44, new Color(130, 160, 90, 255), 22);

        // 设置+排行榜按钮已移至暂存区左侧（ensureTempSlotViews），与小太阳对称

        this.progressLabel = null;
    }

    private initGame() {
        this.gameOver = false;
        // 碰撞矩阵按当前关卡 wave 重配（每关 wave 不同，重置配置标志）
        GameManager._collisionMatrixConfigured = false;
        this.plates = [];
        this.tempHoles = [];
        this.tempGuideArmed = true;
        this.removeTempFullGuide();
        this.flyingFruitColors = [];
        this.removedFruits = 0;
        this.sunsCollectedThisLevel = 0;
        this.tools = { add: 0, clear: 1 };
        this.resetCombo();
        this.plateNodes.forEach((node) => {
            if (node && node.isValid) {
                this.destroyNodeRecursively(node);
            }
        });
        this.plateNodes.clear();
        this.fallingPlateNodes.forEach((node) => {
            if (node && node.isValid) {
                this.destroyNodeRecursively(node);
            }
        });
        this.fallingPlateNodes.clear();
        if (this.boardContentNode) {
            this.boardContentNode.removeAllChildren();
        }
        if (this.boardEffectNode) {
            this.boardEffectNode.removeAllChildren();
        }
        this.boxViews.forEach((view) => {
            if (view.node && view.node.isValid) {
                view.node.destroy();
            }
        });
        this.boxViews = [];
        this.boxes.forEach((box) => {
            box.clearScheduled = false;
        });
        this.boxes = [
            { color: FruitColor.YELLOW, capacity: 3, fruits: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: FruitColor.BLUE, capacity: 3, fruits: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: 'locked', capacity: 3, fruits: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: 'locked', capacity: 3, fruits: [], isNew: false, isSlidingOut: false, clearScheduled: false }
        ];
        this.generateLevel();
        
        this.boxes[0].capacity = this.getNextCapacityForColor(this.boxes[0].color, this.boxes[0]);
        this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
        
        this.ensurePrimaryBoxes();
        this.renderAll();

        // 彩虹果提示：仅第 6 关弹出（彩虹果从第 6 关开始出现）
        if (this.currentLevel === 6 && !rainbowIntroduced) {
            rainbowIntroduced = true;
            this.scheduleOnce(() => {
                // 延迟期间可能已经退回首页，那就把标志退回去下次再弹；
                // 不回滚的话这个提示就永久丢了，比弹错地方更隐蔽
                if (!this.isGameViewAlive()) {
                    rainbowIntroduced = false;
                    return;
                }
                this.showRainbowTutorial();
            }, 0.5);
        }

        // 挑战关卡，弹出挑战提示
        const interval = this.gameConfig?.challengeInterval || 5;
        if (this.currentLevel % interval === 0 && !challengeTipShown) {
            challengeTipShown = true;
            this.scheduleOnce(() => {
                if (!this.isGameViewAlive()) {
                    challengeTipShown = false;
                    return;
                }
                this.showChallengeTip();
            }, 0.8);
        }
    }

    /**
     * 当前还在不在游戏页。返回首页/排行榜会走 teardownGameView 把这几个容器置空，
     * 所以 boardAreaNode 还在就说明玩家没离开局。
     * 延迟弹的提示都要先过这一道：不然 scheduleOnce 的回调会把弹窗画到首页上。
     */
    private isGameViewAlive() {
        return !!this.boardAreaNode;
    }

    private destroyNodeRecursively(node: Node) {
        if (node.isValid) {
            node.destroy();
        }
    }

    private renderAll() {
        this.renderTopUI();
        this.renderBoard();
        this.renderTools();
        this.renderModal(null);
    }

    private renderTopUI() {
        this.ensurePrimaryBoxes();
        this.normalizeEndgameBoxes();

        if (this.titleLabel) {
            this.titleLabel.string = '果园大丰收';
        }
        if (this.levelBadgeLabel) {
            this.levelBadgeLabel.string = `第 ${this.currentLevel} 关`;
        }
        this.renderBoxes();
        this.renderTempSlots();
    }

    private renderBoxes() {
        if (!this.boxesContainerNode) return;
        this.ensureBoxViews();

        const boxWidth = Math.min(84, this.screenWidth * 0.2);
        const boxHeight = boxWidth * 1.33; // 保持 3:4 左右的原始比例
        const gap = (this.screenWidth - 40 - boxWidth * 4) / 3;
        const startX = -((boxWidth * 4 + gap * 3) / 2) + boxWidth / 2;

        this.boxes.forEach((box, index) => {
            if (index < 2 && !this.isValidPrimaryBoxFruitColor(box.color)) {
                const fallback = this.getPrimaryBoxFruitFallbackColor(index);
                this.updateBoxColor(box, fallback);
            }

            const x = startX + index * (boxWidth + gap);
            const view = this.boxViews[index];
            const boxNode = view.node;
            boxNode.setPosition(new Vec3(x, 0, 0));
            boxNode.active = true;
            const isLocked = box.color === 'locked';
            const isEmpty = box.color === 'empty';
            const isActive = !isLocked && !isEmpty;

            const bodyColor = isLocked
                ? new Color(92, 255, 176, 255) // 未解锁果篮改为 #5cffb0
                : isEmpty
                    ? new Color(180, 170, 150, 255)
                    : this.getBoxColor(box.color);
            const colorKey = `${box.color}_${box.capacity}`;
            if (view.lastBodyColor !== colorKey) {
                // 使用灰度底图 + 动态染色
                if (this.basketSpriteFrame) {
                    view.bodySprite.spriteFrame = this.basketSpriteFrame;
                    view.bodySprite.color = bodyColor;
                }

                // 锁状态覆盖层 (仅显示背景变暗，不画X)
                if (isLocked) {
                    view.lockOverlay.node.active = true;
                    view.lockOverlay.clear();
                    view.lockOverlay.fillColor = new Color(0, 0, 0, 80); // 加一层半透明黑底让它看起来像锁住的
                    view.lockOverlay.roundRect(-boxWidth/2, -boxHeight/2, boxWidth, boxHeight, 15);
                    view.lockOverlay.fill();
                } else {
                    view.lockOverlay.node.active = false;
                }
                
                // 设置水果图标和文字
                if (isActive && this.isValidPrimaryBoxFruitColor(box.color)) {
                    const spriteFrame = this.getFruitSprite(box.color);
                    if (spriteFrame) {
                        view.fruitIcon.spriteFrame = spriteFrame;
                        // 取消 CUSTOM 模式，让图片自动获取原始尺寸
                        view.fruitIcon.sizeMode = Sprite.SizeMode.RAW;
                        const origW = spriteFrame.width;
                        const origH = spriteFrame.height;
                        // 动态缩放节点以适应 52 的最大边 (之前是 46)
                        const maxSize = 52;
                        const scale = Math.min(maxSize / origW, maxSize / origH);
                        view.fruitIcon.node.scale = new Vec3(scale, scale, 1);
                        
                        view.nameLabel.string = this.FRUIT_NAME_MAP[box.color] || '';
                        view.nameLabel.node.active = true;
                    } else {
                        view.fruitIcon.node.active = false;
                        view.nameLabel.string = this.FRUIT_NAME_MAP[box.color] || '';
                        view.nameLabel.node.active = true;
                    }
                } else {
                    view.fruitIcon.node.active = false;
                    view.nameLabel.node.active = false;
                }

                view.lastBodyColor = colorKey;
            }

            // 始终隐藏背景大图标，汉字保留
            if (isActive && this.isValidPrimaryBoxFruitColor(box.color)) {
                view.fruitIcon.node.active = false;
            }

            view.lockLabel.node.active = isLocked;
            const boxCapacity = box.capacity || 3;
            const fruitIconSize = boxCapacity >= 6 ? 20 : (boxCapacity >= 5 ? 22 : (boxCapacity >= 4 ? 24 : 26));
            const boxSlots = this.getBoxSlotPositions(boxCapacity);

            view.slots.forEach((slotView, slotIndex) => {
                const active = slotIndex < boxCapacity;
                slotView.node.active = active && !isLocked;

                const slotPos = boxSlots[slotIndex];
                if (slotPos) {
                    slotView.node.setPosition(new Vec3(slotPos.x, slotPos.y, 0));
                }
                
                // 动态绘制孔洞大小 (现在使用Sprite图片代替Graphics)
                const holeRadius = boxCapacity >= 6 ? 10 : 12;
                slotView.hole.clear(); // 清除之前用Graphics画的孔
                
                // 给 hole 节点添加 Sprite
                let holeSprite = slotView.hole.node.getComponent(Sprite);
                if (!holeSprite) {
                    holeSprite = slotView.hole.node.addComponent(Sprite);
                }
                holeSprite.sizeMode = Sprite.SizeMode.CUSTOM;
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hole/spriteFrame', SpriteFrame).then((sf) => {
                    if (sf && holeSprite && holeSprite.isValid) {
                        holeSprite.spriteFrame = sf;
                    }
                }).catch(() => {});
                const holeTransform = slotView.hole.node.getComponent(UITransform);
                if (holeTransform) {
                    // 圆的直径是半径的2倍，再加上一点边距，所以乘以 2.2
                    holeTransform.setContentSize(holeRadius * 2.2, holeRadius * 2.2);
                }

                if (!active) {
                    this.updateFruitHost(slotView.fruitHost, fruitIconSize);
                    return;
                }

                if (isLocked) {
                    this.updateFruitHost(slotView.fruitHost, fruitIconSize);
                    return;
                }

                const fruitColor = box.color === 'empty' ? undefined : box.fruits[slotIndex];
                slotView.hole.node.active = !fruitColor;
                this.updateFruitHost(slotView.fruitHost, fruitIconSize, fruitColor);
            });

            if (box.isNew) {
                boxNode.scale = new Vec3(0.92, 0.92, 1);
                tween(boxNode).to(0.18, { scale: new Vec3(1.04, 1.04, 1) }).to(0.16, { scale: new Vec3(1, 1, 1) }).start();
                box.isNew = false;
            } else {
                boxNode.setScale(new Vec3(1, 1, 1));
            }
        });
    }

    private renderTempSlots() {
        if (!this.tempContainerNode) return;
        this.ensureTempSlotViews();

        this.tempSlotViews.forEach((slotView, index) => {
            const color = this.tempHoles[index];
            this.updateFruitHost(slotView.fruitHost, 26, color);
            
            // 确保不画黑圆，只用图片
            if (slotView.hole) {
                slotView.hole.clear();
            }
        });

        // 更新小太阳数量
        if (this.sunCountLabel && this.sunCountLabel.isValid) {
            this.sunCountLabel.string = `${this.totalSuns}`;
        }

        // 暂存区满 4 引导（每次 renderTopUI 都会跑，能盖住放果/自动填充/清篮等所有暂存变化）
        this.updateTempFullGuide();
    }

    /**
     * 暂存区数量变化后判定要不要弹引导小手：
     * 掉回 4 以下重新武装；达 4+ 且已武装且场上有锁定果篮才弹（弹一次就解除武装）。
     */
    private updateTempFullGuide() {
        if (this.tempHoles.length < 4) {
            this.tempGuideArmed = true;
            return;
        }
        if (this.tempGuideArmed && this.boxes.some((box) => box.color === 'locked')) {
            this.tempGuideArmed = false;
            this.showTempFullGuide();
        }
    }

    /** 弹引导小手：指向第一个锁定果篮，提示点击解锁；停留 10 秒自动消失 */
    private showTempFullGuide() {
        if (!this.boxesContainerNode || !this.boxesContainerNode.isValid) return;
        const lockedIndex = this.boxes.findIndex((box) => box.color === 'locked');
        if (lockedIndex < 0) return;
        const lockedView = this.boxViews[lockedIndex];
        if (!lockedView || !lockedView.node || !lockedView.node.isValid) return;

        this.removeTempFullGuide();

        // 让这个锁定果篮跟小手一起呼吸（缩放脉动）：小手在它就呼吸，小手没了（removeTempFullGuide）就停并复位
        this.tempGuideBreathNode = lockedView.node;
        lockedView.node.setScale(new Vec3(1, 1, 1));
        tween(lockedView.node)
            .to(0.6, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'sineInOut' })
            .to(0.6, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        // 手图 144x256，指尖朝左上；手放果篮右下，指尖落在果篮上（照 HomePage 引导手的做法）
        const handH = 62;
        const handW = Math.round(handH * 144 / 256);
        const boxX = lockedView.node.position.x;
        const hx = boxX + handW * 0.4;
        const hy = -handH * 0.42;
        const handNode = this.createNode('TempFullGuideHand', this.boxesContainerNode, hx, hy, handW, handH);
        handNode.setSiblingIndex(9999);
        this.tempFullGuideNode = handNode;
        const handSprite = handNode.addComponent(Sprite);
        handSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hand_guide/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && handSprite.isValid) {
                handSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 朝果篮方向（左上）反复轻戳；手指不挂触摸，不挡果篮点击
        tween(handNode)
            .to(0.45, { position: new Vec3(hx - 5, hy + 7, 0) }, { easing: 'sineInOut' })
            .to(0.45, { position: new Vec3(hx, hy, 0) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        // 10 秒后自动消失
        this.scheduleOnce(() => this.removeTempFullGuide(), 10);
    }

    /** 移除引导小手并停掉果篮呼吸（解锁果篮/切关/gameOver/10秒到时都会调） */
    private removeTempFullGuide() {
        if (this.tempFullGuideNode && this.tempFullGuideNode.isValid) {
            this.tempFullGuideNode.destroy();
        }
        this.tempFullGuideNode = null;
        // 停掉锁定果篮的呼吸并复位到原尺寸
        if (this.tempGuideBreathNode && this.tempGuideBreathNode.isValid) {
            tween(this.tempGuideBreathNode).stop();
            this.tempGuideBreathNode.setScale(new Vec3(1, 1, 1));
        }
        this.tempGuideBreathNode = null;
    }

    private renderTools() {
        if (!this.toolContainerNode) return;
        this.ensureToolViews();

        const toolList = [
            { key: 'add' as const, label: '加果篮', icon: '🧺', count: this.tools.add },
            { key: 'clear' as const, label: '清空果盘', icon: '🧹', count: this.tools.clear }
        ];
        toolList.forEach((tool, index) => {
            const view = this.toolViews[index];
            view.iconLabel.string = '';
            view.iconLabel.node.active = false;
            // 屏蔽徽章更新，因为已经隐藏
            // const badgeColor = (tool.count <= 0 && tool.key !== 'add' && tool.key !== 'clear') ? new Color(160, 150, 130, 255) : new Color(220, 160, 50, 255);
            // this.drawCircle(view.badge, 13, badgeColor, 3, new Color(255, 245, 220, 255));
            // view.badgeLabel.string = String(tool.count > 0 ? tool.count : '+');
        });
    }

    private renderBoard() {
        if (!this.boardContentNode) return;
        this.boardContentNode.removeAllChildren();
        this.plateNodes.clear();

        // 首批（wave <= loadedWave）全部彩色可点；再多建一层灰板垫在最底下做预告
        const visiblePlates = this.plates
            .filter((plate) => !plate.removed && (plate.wave ?? 0) <= this.loadedWave + 1)
            .sort((a, b) => a.layer - b.layer);
        // 先整体算一遍置灰状态，再建节点：createPlateNode 直接读 plate.buried
        visiblePlates.forEach((plate) => {
            plate.buried = this.isPlateBuried(plate);
        });
        visiblePlates.forEach((plate) => {
            this.createPlateNode(this.boardContentNode!, plate, true);
        });
        this.ensureLayerBudget();
    }

    private renderAddBasketModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 使用 panel_add_basket.png（新版立体风 640x1036），按照宽度 320 缩放，高度约为 518
        const panelW = 320;
        const panelH = 518;
        const panelNode = this.createNode('AddBasketPanel', this.modalLayerNode, 0, 0, panelW, panelH);
        
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_add_basket/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮（右上角 X，新图 X 中心约在 (137, 236)）
        const closeBtn = this.createNode('CloseBtn', panelNode, panelW / 2 - 23, panelH / 2 - 23, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
        }, this);

        // 顶部太阳图标已在底图中绘制，这里只补数量（新图太阳右侧是白色留白条，用深棕字）
        const topSunsLabel = this.createLabel(panelNode, `${this.totalSuns}`, -46, 133, 24, new Color(110, 75, 45, 255), true);
        // 修改锚点和对齐方式为左对齐，防止数字变大（如1000000）时向左延伸遮挡太阳图标
        const topSunsTransform = topSunsLabel.node.getComponent(UITransform);
        if (topSunsTransform) topSunsTransform.setAnchorPoint(0, 0.5);
        topSunsLabel.horizontalAlign = 0; // LEFT

        // 2. 第一个按钮：消耗小太阳加果篮（橙色按钮）
        // 价格从游戏配置读取，默认 20
        const addCost = this.gameConfig?.toolCosts?.addBasket ?? 20;
        // 热区覆盖橙色按钮+右侧绿色价格标签整行
        const btnSuns = this.createNode('BtnSuns', panelNode, 16, -90, 222, 48);
        btnSuns.on(Node.EventType.TOUCH_END, () => {
            const lockedBox = this.boxes.find((box) => box.color === 'locked');
            if (!lockedBox) {
                if (typeof wx !== 'undefined' && wx.showToast) {
                    wx.showToast({ title: '无果篮可解锁', icon: 'none' });
                }
                return;
            }
            if (this.totalSuns < addCost) {
                this.showSunShortageTip();
                return;
            }
            this.totalSuns -= addCost;
            localStorage.setItem('totalSuns', this.totalSuns.toString());
            if (this.sunCountLabel && this.sunCountLabel.isValid) {
                this.sunCountLabel.string = `${this.totalSuns}`;
            }
            this.handleUnlockBox(lockedBox);
            this.renderBasketUnlockModal();
        }, this);
        // 价格数字（绿色标签内太阳右侧留白处）
        const costLabel = this.createLabel(panelNode, `${addCost}`, 91, -88, 18, new Color(0, 0, 0, 255), true);
        const costTransform = costLabel.node.getComponent(UITransform);
        if (costTransform) costTransform.setAnchorPoint(0, 0.5);
        costLabel.horizontalAlign = 0; // LEFT

        // 3. 第二个按钮：看广告解锁（蓝色按钮）
        const btnAd = this.createNode('BtnAd', panelNode, -5, -149, 180, 48);
        btnAd.on(Node.EventType.TOUCH_END, () => {
            const lockedBox = this.boxes.find((box) => box.color === 'locked');
            if (!lockedBox) {
                if (typeof wx !== 'undefined' && wx.showToast) {
                    wx.showToast({ title: '无果篮可解锁', icon: 'none' });
                }
                return;
            }
            this.showAdThen(() => {
                this.handleUnlockBox(lockedBox);
                this.renderBasketUnlockModal();
            }, 'unlock_basket');
        }, this);

        // 4. 第三个按钮：继续游戏（绿色按钮）
        const btnContinue = this.createNode('BtnContinue', panelNode, -5, -209, 180, 48);
        btnContinue.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
        }, this);
    }

    /** 小太阳不足提示横条：从屏幕底部升至中间，停顿 2 秒后向上飞出屏幕（不关闭当前弹窗） */
    private showSunShortageTip() {
        if (!this.modalLayerNode) return;
        // 幂等：横幅还在显示中（未飞出销毁）时忽略重复触发，防止连点叠加多个横幅
        if (this.sunShortageTipNode && this.sunShortageTipNode.isValid) return;

        // 图片宽占满屏幕，高按原图 1000x200（5:1）等比缩放
        const tipW = this.screenWidth;
        const tipH = tipW * 0.2;
        const startY = -this.screenHeight / 2 - tipH;
        const endY = this.screenHeight / 2 + tipH;
        const tipNode = this.createNode('SunShortageTip', this.modalLayerNode, 0, startY, tipW, tipH);
        tipNode.setSiblingIndex(9999);
        this.sunShortageTipNode = tipNode;

        const sprite = tipNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_sun_shortage/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 文案：小太阳数量不足（白色字体，配深色底图）
        this.createLabel(tipNode, '小太阳数量不足', 0, 0, 24, new Color(255, 255, 255, 255), true);

        // 底部升起（带回弹）→ 停顿 2 秒 → 加速向上飞出屏幕 → 销毁
        tween(tipNode)
            .to(0.35, { position: new Vec3(0, 0, 0) }, { easing: 'backOut' })
            .delay(2.0)
            .to(0.35, { position: new Vec3(0, endY, 0) }, { easing: 'sineIn' })
            .call(() => {
                if (tipNode.isValid) tipNode.destroy();
                if (this.sunShortageTipNode === tipNode) this.sunShortageTipNode = null;
            })
            .start();
    }

    /** 清空果盘确认弹窗：使用 panel_clear_basket.png（与加果篮面板同尺寸、同布局） */
    private renderClearBasketModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // panel_clear_basket.png（新版立体风 640x983），按宽 320 缩放，高约 492
        const panelW = 320;
        const panelH = 492;
        const panelNode = this.createNode('ClearBasketPanel', this.modalLayerNode, 0, 0, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_clear_basket/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮（右上角 X）
        const closeBtn = this.createNode('CloseBtn', panelNode, panelW / 2 - 22, panelH / 2 - 26, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
        }, this);

        // 顶部太阳图标已在底图中绘制，这里只补数量（新图太阳右侧是白色留白条，用深棕字）
        const topSunsLabel = this.createLabel(panelNode, `${this.totalSuns}`, -58, 149, 24, new Color(110, 75, 45, 255), true);
        const topSunsTransform = topSunsLabel.node.getComponent(UITransform);
        if (topSunsTransform) topSunsTransform.setAnchorPoint(0, 0.5);
        topSunsLabel.horizontalAlign = 0; // LEFT

        // 清空果盘价格（小太阳），从游戏配置读取，默认 20
        const clearCost = this.gameConfig?.toolCosts?.clearTray ?? 20;
        const doClearTray = () => {
            this.tryConsumeTool('clear', () => {
                this.tempHoles = [];
                this.renderTopUI();
                // 若清空后恰好达成过关条件，过关弹窗优先，不再弹出清空成功图
                const willWin = !this.gameOver
                    && this.fallingPlateNodes.size === 0
                    && !this.plates.some((plate) => plate.state === 'falling')
                    && this.plates.every((plate) => plate.removed);
                if (!willWin) {
                    this.renderClearTraySuccessModal();
                }
                this.checkWin();
            });
        };

        // 2. 第一个按钮：消耗小太阳清空果盘（橙色按钮，热区覆盖右侧绿色价格标签整行）
        const btnSuns = this.createNode('BtnSuns', panelNode, 18, -70, 250, 48);
        btnSuns.on(Node.EventType.TOUCH_END, () => {
            if (this.totalSuns < clearCost) {
                this.showSunShortageTip();
                return;
            }
            this.totalSuns -= clearCost;
            localStorage.setItem('totalSuns', this.totalSuns.toString());
            if (this.sunCountLabel && this.sunCountLabel.isValid) {
                this.sunCountLabel.string = `${this.totalSuns}`;
            }
            this.modalLayerNode!.removeAllChildren();
            doClearTray();
        }, this);
        // 价格数字（绿色标签内太阳右侧留白处）
        const costLabel = this.createLabel(panelNode, `${clearCost}`, 72, -68, 18, new Color(0, 0, 0, 255), true);
        const costTransform = costLabel.node.getComponent(UITransform);
        if (costTransform) costTransform.setAnchorPoint(0, 0.5);
        costLabel.horizontalAlign = 0; // LEFT

        // 3. 第二个按钮：看广告清空（蓝色按钮）
        const btnAd = this.createNode('BtnAd', panelNode, -6, -132, 210, 48);
        btnAd.on(Node.EventType.TOUCH_END, () => {
            this.showAdThen(() => {
                this.modalLayerNode!.removeAllChildren();
                doClearTray();
            }, 'clear_tray');
        }, this);

        // 4. 第三个按钮：继续游戏（绿色按钮）
        const btnContinue = this.createNode('BtnContinue', panelNode, -6, -199, 212, 48);
        btnContinue.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
        }, this);
    }

    /** 清空果盘成功弹窗：使用 panel_clear_tray.png，动效与加果篮成功弹窗一致 */
    private renderClearTraySuccessModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 使用 panel_clear_tray.png，原图 800x1000，按宽度 320 缩放高度 400
        const panelW = 320;
        const panelH = 400;
        const panelNode = this.createNode('ClearTrayPanel', this.modalLayerNode, 0, 0, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_clear_tray/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 图片上未绘制按钮，点击任意位置关闭
        const closeModal = () => {
            if (this.modalLayerNode) this.modalLayerNode.removeAllChildren();
        };
        mask.on(Node.EventType.TOUCH_END, closeModal, this);
        panelNode.on(Node.EventType.TOUCH_END, closeModal, this);

        // 动态效果：遮罩淡入 + 从小到大三回弹 + 星星爆发 + 上下慢浮动（与加果篮成功弹窗一致）
        // 1. 遮罩淡入
        const maskOpacity = mask.addComponent(UIOpacity);
        maskOpacity.opacity = 0;
        tween(maskOpacity).to(0.25, { opacity: 150 }).start();

        // 2. 从小到大 → 来回回弹三下（振幅递减）
        panelNode.setScale(new Vec3(0, 0, 1));
        tween(panelNode)
            // 从小到大
            .to(0.3, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            // 回弹第一下
            .to(0.12, { scale: new Vec3(0.92, 0.92, 1) }, { easing: 'sineInOut' })
            .to(0.12, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'sineInOut' })
            // 回弹第二下
            .to(0.11, { scale: new Vec3(0.96, 0.96, 1) }, { easing: 'sineInOut' })
            .to(0.11, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            // 回弹第三下
            .to(0.1, { scale: new Vec3(0.99, 0.99, 1) }, { easing: 'sineInOut' })
            .to(0.1, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .start();

        // 3. 星星粒子爆发（从中心向外飞散）
        const starColors = [
            new Color(255, 215, 0, 255),   // 金色
            new Color(255, 255, 120, 255), // 亮黄
            new Color(255, 180, 50, 255),  // 橙黄
            new Color(255, 255, 255, 255), // 白色
        ];
        for (let i = 0; i < 14; i++) {
            const starSize = 8 + Math.random() * 6;
            const star = this.createGraphicsNode('Star', this.modalLayerNode!, starSize, starSize, 0, 0);
            const g = star.getComponent(Graphics)!;
            const color = starColors[Math.floor(Math.random() * starColors.length)];
            this.drawStar(g, starSize, color);

            const starOpacity = star.addComponent(UIOpacity);

            const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.6;
            const distance = 110 + Math.random() * 90;
            const targetX = Math.cos(angle) * distance;
            const targetY = Math.sin(angle) * distance;
            const flyDuration = 0.35 + Math.random() * 0.25;

            star.setScale(new Vec3(0, 0, 1));

            // 缩放 + 飞散 + 旋转
            tween(star)
                .to(flyDuration * 0.35, { scale: new Vec3(1.3, 1.3, 1) }, { easing: 'backOut' })
                .to(flyDuration * 0.65, {
                    position: new Vec3(targetX, targetY, 0),
                    scale: new Vec3(0.5, 0.5, 1),
                    angle: (Math.random() - 0.5) * 720
                }, { easing: 'quadOut' })
                .start();

            // 淡出销毁
            tween(starOpacity)
                .delay(flyDuration * 0.55)
                .to(0.2, { opacity: 0 })
                .call(() => { if (star.isValid) star.destroy(); })
                .start();
        }

        // 4. 回弹结束后上下慢慢浮动
        this.scheduleOnce(() => {
            if (panelNode && panelNode.isValid) {
                tween(panelNode)
                    .repeatForever(
                        tween()
                            .to(1.5, { position: new Vec3(0, 5, 0) }, { easing: 'sineInOut' })
                            .to(1.5, { position: new Vec3(0, -5, 0) }, { easing: 'sineInOut' })
                    )
                    .start();
            }
        }, 1.0);
    }

    private renderBasketUnlockModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 使用 panel_basket_unlock.png，宽度 320，高度按原图比例
        const panelW = 320;
        const panelH = 454;
        const panelNode = this.createNode('BasketUnlockPanel', this.modalLayerNode, 0, 0, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_basket_unlock/spriteFrame', SpriteFrame).then((spriteFrame) => {
            if (spriteFrame && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = spriteFrame;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 动态效果：遮罩淡入 + 弹性弹出 + 星星爆发 + 呼吸浮动
        // 1. 遮罩淡入
        const maskOpacity = mask.addComponent(UIOpacity);
        maskOpacity.opacity = 0;
        tween(maskOpacity).to(0.25, { opacity: 150 }).start();

        // 2. 弹窗动效：从小到大 → 来回回弹三下（振幅递减）
        panelNode.setScale(new Vec3(0, 0, 1));
        tween(panelNode)
            // 从小到大
            .to(0.3, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            // 回弹第一下
            .to(0.12, { scale: new Vec3(0.92, 0.92, 1) }, { easing: 'sineInOut' })
            .to(0.12, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'sineInOut' })
            // 回弹第二下
            .to(0.11, { scale: new Vec3(0.96, 0.96, 1) }, { easing: 'sineInOut' })
            .to(0.11, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            // 回弹第三下
            .to(0.1, { scale: new Vec3(0.99, 0.99, 1) }, { easing: 'sineInOut' })
            .to(0.1, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .start();

        // 3. 星星粒子爆发（从中心向外飞散）
        const starColors = [
            new Color(255, 215, 0, 255),   // 金色
            new Color(255, 255, 120, 255), // 亮黄
            new Color(255, 180, 50, 255),  // 橙黄
            new Color(255, 255, 255, 255), // 白色
        ];
        for (let i = 0; i < 14; i++) {
            const starSize = 8 + Math.random() * 6;
            const star = this.createGraphicsNode('Star', this.modalLayerNode!, starSize, starSize, 0, 0);
            const g = star.getComponent(Graphics)!;
            const color = starColors[Math.floor(Math.random() * starColors.length)];
            this.drawStar(g, starSize, color);

            const starOpacity = star.addComponent(UIOpacity);

            const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.6;
            const distance = 110 + Math.random() * 90;
            const targetX = Math.cos(angle) * distance;
            const targetY = Math.sin(angle) * distance;
            const flyDuration = 0.35 + Math.random() * 0.25;

            star.setScale(new Vec3(0, 0, 1));

            // 缩放 + 飞散 + 旋转
            tween(star)
                .to(flyDuration * 0.35, { scale: new Vec3(1.3, 1.3, 1) }, { easing: 'backOut' })
                .to(flyDuration * 0.65, {
                    position: new Vec3(targetX, targetY, 0),
                    scale: new Vec3(0.5, 0.5, 1),
                    angle: (Math.random() - 0.5) * 720
                }, { easing: 'quadOut' })
                .start();

            // 淡出销毁
            tween(starOpacity)
                .delay(flyDuration * 0.55)
                .to(0.2, { opacity: 0 })
                .call(() => { if (star.isValid) star.destroy(); })
                .start();
        }

        // 4. 回弹结束后上下慢慢浮动
        this.scheduleOnce(() => {
            if (panelNode && panelNode.isValid) {
                tween(panelNode)
                    .repeatForever(
                        tween()
                            .to(1.5, { position: new Vec3(0, 5, 0) }, { easing: 'sineInOut' })
                            .to(1.5, { position: new Vec3(0, -5, 0) }, { easing: 'sineInOut' })
                    )
                    .start();
            }
        }, 1.0);

        // "太棒了"按钮点击区域
        const btnAwesome = this.createNode('BtnAwesome', panelNode, 0, -155, 200, 60);
        btnAwesome.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.removeAllChildren();
        }, this);
    }

    private renderSettingsModal(show: boolean) {
        if (!this.modalLayerNode) return;
        if (!show) {
            this.modalLayerNode.removeAllChildren();
            return;
        }

        this.modalLayerNode.removeAllChildren();
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 背景关闭
        mask.on(Node.EventType.TOUCH_END, () => {
            this.renderSettingsModal(false);
        }, this);

        // 设置面板：使用图片 panel_settings.png（新版立体风 640x993）
        // 按宽 320 缩放（scale 0.5），高约 496
        const panelW = 320;
        const panelH = 496;
        const panelNode = this.createNode('SettingsPanel', this.modalLayerNode, 0, 0, panelW, panelH);
        
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_settings/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 使用图片上自带的关闭按钮，只保留一个隐形的点击区域
        const closeBtnSize = 60;
        // 新图右上红色 X 钮实测中心 (133, 194)
        const closeBtn = this.createNode('CloseBtn', panelNode, 133, 194, closeBtnSize, closeBtnSize);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            this.renderSettingsModal(false);
        }, this);

        // 声音开关：与图上喇叭图标垂直中心对齐（新图实测 cocos y=113，开关落在内嵌条右侧留白区）
        const toggleSound = this.createToggle(panelNode, 0, 113, this.soundEnabled, (isOn) => {
            this.soundEnabled = isOn;
            localStorage.setItem('soundEnabled', String(isOn));
            SoundManager.getInstance()?.setMute(!isOn);
            if (isOn) {
                SoundManager.getInstance()?.playBGM();
            } else {
                SoundManager.getInstance()?.stopBGM();
            }
        });

        // 震动开关：与图上震动图标垂直中心对齐（新图实测 cocos y=38）
        const toggleVibration = this.createToggle(panelNode, 0, 38, this.vibrationEnabled, (isOn) => {
            this.vibrationEnabled = isOn;
            localStorage.setItem('vibrationEnabled', String(isOn));
            if (isOn) this.triggerVibration('light');
        });

        // 重新挑战（橙黄按钮）：热区中心对齐新图实测位置 (-5, -51)
        const btnRestart = this.createNode('BtnRestart', panelNode, -5, -51, 200, 52);
        btnRestart.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '重新挑战',
                this.buildDiscardLevelTip('重新挑战'),
                '继续游戏',
                '重新挑战',
                () => {
                    this.discardCurrentLevelSuns();
                    this.ensureGameUI();
                    this.initGame();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);

        // 回第一关（蓝色按钮）：热区中心对齐新图实测位置 (-6, -110)
        const btnFirstLevel = this.createNode('BtnFirstLevel', panelNode, -6, -110, 200, 52);
        btnFirstLevel.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '回第一关',
                this.buildDiscardLevelTip('从第 1 关重新开始'),
                '继续游戏',
                '回第一关',
                () => {
                    this.discardCurrentLevelSuns();
                    this.currentLevel = 1;
                    saveProgress(this.currentLevel);
                    this.ensureGameUI();
                    this.initGame();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);

        // 返回主页（绿色按钮）：热区中心对齐新图实测位置 (-5, -186)
        const btnContinue = this.createNode('BtnContinue', panelNode, -5, -186, 204, 56);
        btnContinue.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '返回主页',
                this.buildDiscardLevelTip('返回主页'),
                '继续游戏',
                '返回主页',
                () => {
                    this.discardCurrentLevelSuns();
                    this.homePage.render();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);
    }

    /** 放弃本局类操作的确认文案：本局没采到太阳时只提进度，避开"将不作数 0 个"这种废话 */
    private buildDiscardLevelTip(action: string) {
        if (this.sunsCollectedThisLevel > 0) {
            return `本局进度将被放弃，\n已采摘的 ${this.sunsCollectedThisLevel} 个小太阳也不作数。\n确定要${action}吗？`;
        }
        return `本局进度将被放弃，\n重新开始一局新关卡。\n确定要${action}吗？`;
    }

    public createToggle(parent: Node, x: number, y: number, initialState: boolean, onChange: (state: boolean) => void) {
        const toggleW = 60;
        const toggleH = 30;
        // 把开关向右偏移，假设图标在左边，开关在右边对齐
        const offsetX = 60; 
        
        const node = this.createNode('Toggle', parent, x + offsetX, y, toggleW, toggleH);
        
        const bgG = this.createGraphicsNode('ToggleBg', node, toggleW, toggleH, 0, 0).getComponent(Graphics)!;
        const knob = this.createNode('ToggleKnob', node, 0, 0, 26, 26);
        const knobG = this.createGraphicsNode('KnobVisual', knob, 26, 26, 0, 0).getComponent(Graphics)!;

        let isOn = initialState;

        const updateVisual = () => {
            bgG.clear();
            bgG.fillColor = isOn ? new Color(100, 200, 100, 255) : new Color(200, 200, 200, 255);
            bgG.roundRect(-toggleW / 2, -toggleH / 2, toggleW, toggleH, toggleH / 2);
            bgG.fill();

            knobG.clear();
            knobG.fillColor = new Color(255, 255, 255, 255);
            knobG.circle(0, 0, 13);
            knobG.fill();

            const targetX = isOn ? (toggleW / 2 - 15) : (-toggleW / 2 + 15);
            tween(knob).stop();
            tween(knob).to(0.1, { position: new Vec3(targetX, 0, 0) }).start();
        };

        updateVisual();

        node.on(Node.EventType.TOUCH_END, () => {
            isOn = !isOn;
            updateVisual();
            onChange(isOn);
        }, this);

        return node;
    }

    private renderModal(config: { title: string; sub: string; button?: string; onConfirm?: () => void; height?: number; secondButton?: string; secondOnConfirm?: () => void; hideClose?: boolean; onCancel?: () => void } | null) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();
        if (!config) return;

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 110), 0);

        const panelH = config.height || 300;
        const panelW = this.screenWidth * 0.82;
        const panel = this.createNode('Panel', this.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.createGraphicsNode('PanelBg', panel, panelW, panelH, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(255, 255, 255, 255), 24);

        if (!config.hideClose) {
            const closeBtnSize = 40;
            const closeBtn = this.createNode('CloseBtn', panel, panelW / 2 - closeBtnSize / 2 - 5, panelH / 2 - closeBtnSize / 2 - 5, closeBtnSize, closeBtnSize);
            this.createLabel(closeBtn, '×', 0, 2, 32, new Color(180, 180, 180, 255), true);
            closeBtn.on(Node.EventType.TOUCH_END, () => {
                this.renderModal(null);
                if (config.onCancel) config.onCancel();
            }, this);
        }

        this.createLabel(panel, config.title, 0, panelH / 2 - 40, 26, new Color(32, 36, 42, 255), true);

        const subH = panelH - 130;
        const subNode = this.createNode('SubLabel', panel, 0, 0, panelW - 40, subH);
        const subLabel = subNode.addComponent(Label);
        subLabel.string = config.sub;
        subLabel.fontSize = 16;
        subLabel.lineHeight = 26;
        subLabel.color = new Color(88, 95, 108, 255);
        subLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        subLabel.verticalAlign = Label.VerticalAlign.CENTER;
        subLabel.overflow = Label.Overflow.SHRINK; // 允许文字自动缩放或者折行
        subLabel.enableWrapText = true;

        const hasSecond = config.secondButton && config.secondOnConfirm;
        const btnW = hasSecond && config.button ? 126 : 160;
        const btnH = 48;
        const btnRadius = 24;

        if (config.button) {
            const button = this.createNode('Confirm', panel, hasSecond ? -74 : 0, -panelH / 2 + 45, btnW, btnH);
            const buttonBg = this.createGraphicsNode('BtnBg', button, btnW, btnH, 0, 0);
            this.drawRoundedRect(buttonBg.getComponent(Graphics)!, btnW, btnH, new Color(100, 160, 85, 255), btnRadius);
            this.createLabel(button, config.button, 0, 0, 18, new Color(255, 255, 255, 255), true);
            button.on(Node.EventType.TOUCH_END, () => {
                this.renderModal(null);
                if (config.onConfirm) config.onConfirm();
            }, this);
        }

        if (hasSecond) {
            const limitReached = this.isShareLimitReached();

            // 如果没有主按钮(button)，则次要按钮(求助按钮)居中显示
            const btnX = config.button ? 74 : 0;
            const btn2W = config.button ? btnW : 180;
            const btn2 = this.createNode('SecondBtn', panel, btnX, -panelH / 2 + 45, btn2W, btnH);
            const btn2Bg = this.createGraphicsNode('Btn2Bg', btn2, btn2W, btnH, 0, 0);
            
            // 始终画原来的橙色按钮
            this.drawRoundedRect(btn2Bg.getComponent(Graphics)!, btn2W, btnH, new Color(245, 140, 40, 255), btnRadius);
            
            if (limitReached) {
                // 原文字居中，透明度调得很低作为底纹
                this.createLabel(btn2, config.secondButton!, 0, 0, 18, new Color(255, 255, 255, 50), true);
                
                // 黑色半透明蒙层
                const overlay = this.createGraphicsNode('Overlay', btn2, btn2W, btnH, 0, 0);
                this.drawRoundedRect(overlay.getComponent(Graphics)!, btn2W, btnH, new Color(0, 0, 0, 110), btnRadius);
                
                // "今日已达上限" 盖在正中间
                const limitLabelNode = this.createNode('LimitLabel', btn2, 0, 0, btn2W, btnH);
                const limitLabel = limitLabelNode.addComponent(Label);
                limitLabel.string = '今日已达上限';
                limitLabel.fontSize = 16;
                limitLabel.color = new Color(255, 255, 255, 255);
                limitLabel.isBold = true;
                limitLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
                limitLabel.verticalAlign = Label.VerticalAlign.CENTER;
            } else {
                // 正常状态
                this.createLabel(btn2, config.secondButton!, 0, 0, 18, new Color(255, 255, 255, 255), true);
            }

            btn2.on(Node.EventType.TOUCH_END, () => {
                if (limitReached) {
                    if (typeof wx !== 'undefined') {
                        wx.showToast({ title: '今日已达上限', icon: 'none' });
                    }
                    return;
                }
                this.renderModal(null);
                config.secondOnConfirm!();
            }, this);
        }
    }

    private getProgressText() {
        if (this.totalFruits <= 0) return '0%';
        return `${Math.floor((this.removedFruits / this.totalFruits) * 100)}%`;
    }

    private generateLevel() {
        this.plates = [];

        const levelNum = this.currentLevel;
        const numColors = Math.min(COLORS.length, 4 + Math.floor((levelNum - 1) / 2));
        const activeColors = COLORS.slice(0, numColors);
        this.boxes[0].color = 'empty';
        this.boxes[1].color = 'empty';
        this.boxes[2].color = 'locked';
        this.boxes[3].color = 'locked';
        this.boxes.forEach((box) => {
            box.fruits = [];
            box.isNew = false;
            box.isSlidingOut = false;
        });
        // 一关分成几层：每 2 关多一层、封顶 8 层，板子和水果的总量全靠这个涨
        const waveCount = Math.min(LAYER_MAX_COUNT, 2 + Math.floor((levelNum - 1) / 2));
        // 彩虹果沿用原来的关卡门槛，发给最上面几批，早点让玩家用上
        let rainbowTotal = 0;
        if (levelNum >= 6) {
            rainbowTotal = levelNum >= 20 ? 3 : levelNum >= 12 ? 2 : 1;
        }
        this.maxWave = waveCount - 1;

        // 形状收敛成 6 种之后，模板池是固定的，不再按关卡动态往里加板子。
        // 原来关卡 5 / 10 / 20 会陆续解锁恶心长条、宽横板、巨方板，那套已经删掉 ——
        // 它们没有预烘图，混进来会退回老的无刷色渲染，一层里白边有的有有的没有。
        // 现在关卡之间的难度差异只靠层数（每 2 关多一层，封顶 8 层）。
        const availableTemplates = PLATE_TEMPLATES;

        let plateIndex = 0;
        let fruitIndex = 0;
        const waveColorLists: FruitColor[][] = [];
        this.totalFruits = 0;

        for (let wave = 0; wave < waveCount; wave++) {
            // 先把这一层的板子铺满棋盘，再按孔位总数定这层发多少果子：
            // 果量向下取整到 3 的倍数（三胞胎必须同层，否则玩家拿到 1 个就得占着暂存区等下层），
            // 多余孔位空着不放果，不影响观感
            const wavePlates = this.buildWavePlates(wave, waveCount, availableTemplates, plateIndex);
            plateIndex += wavePlates.length;
            this.plates.push(...wavePlates);

            const holeCount = wavePlates.reduce((sum, plate) => sum + plate.holes.length, 0);
            const triplets = Math.max(1, Math.floor(holeCount / 3));
            // 每层最多 6 种颜色轮流出场，相邻层允许撞色；
            // 孔数不按场上可达数钳制（完全交给后端权重），颜色分散不影响果篮难度
            const wavePalette = [...activeColors].sort(() => Math.random() - 0.5).slice(0, Math.min(activeColors.length, 6));
            const waveFruits: FruitColor[] = [];
            for (let i = 0; i < triplets; i++) {
                // 轮流发色，保证选中的颜色都出场、分布均匀
                const color = wavePalette[i % wavePalette.length];
                waveFruits.push(color, color, color);
            }
            if (wave < rainbowTotal) {
                waveFruits.push(FruitColor.RAINBOW);
            }
            waveFruits.sort(() => Math.random() - 0.5);
            waveColorLists.push(waveFruits);

            const placed = this.placeFruitsInWave(wavePlates, waveFruits, fruitIndex);
            fruitIndex += placed;
            this.totalFruits += placed;
        }

        // 果篮初始色只能取最上层的颜色：更深的层还埋着点不到，
        // 一开局就摆个点不到的颜色，等于白送一个果篮位
        const firstWaveColors = [...new Set(waveColorLists[0] || [])].filter((color) => color !== FruitColor.RAINBOW);
        this.boxes[0].color = firstWaveColors[0] || FruitColor.YELLOW;
        if (firstWaveColors.length > 1) {
            this.boxes[1].color = firstWaveColors[1];
        } else {
            const otherColors = activeColors.filter((color) => color !== firstWaveColors[0]);
            this.boxes[1].color = otherColors.length > 0
                ? otherColors[Math.floor(Math.random() * otherColors.length)]
                : (firstWaveColors[0] || FruitColor.BLUE);
        }

        this.plates = this.plates.filter((plate) => plate.fruits.length > 0);
        // 开局一次性启用 5 层（首批，全彩色），后面按“剩余果子跌破首批总量的 70%”逐层启用
        this.loadedWave = Math.min(this.maxWave, LAYER_INITIAL_LOAD - 1);
        const initialFruits = this.plates
            .filter((plate) => (plate.wave ?? 0) <= this.loadedWave)
            .reduce((sum, plate) => sum + plate.fruits.length, 0);
        this.refillThreshold = Math.floor(initialFruits * LAYER_REFILL_RATIO);
    }

    /**
     * 造一层板子：层内平铺、互不压盖（隔 2px 间隙），用规则化装箱（Bottom-Left-Fill）一块块贴着铺。
     * 先上五种造型板保底（全家福，凹形先铺能让后面的方板嵌进凹口），
     * 再把模板池重复几遍、按孔密度排序逐块往缝里塞，最后整体平移居中。
     * 果子数量由孔位总数反推，而不是先定果数再凑板子。层间靠 layer 分深浅，wave 0 在最上层。
     */
    private buildWavePlates(
        wave: number,
        waveCount: number,
        templates: PlateTemplate[],
        startIndex: number
    ): PlateData[] {
        const paddingX = 10;
        // 上边留得比下边多：顶部要避开头部 UI，底部紧着果篮
        const paddingTop = 60;
        const paddingBottom = 40;
        const placedBodies: PlateBody[] = [];
        const plates: PlateData[] = [];
    
        // 模板池拆成方板和异形两半：两边各有保底阶段，后面再合起来按孔密度铺
        const scaledRects = templates.map((template) => this.scaleTemplate(template));
        const scaledShapes = SHAPE_PLATE_SET.map((template) => this.scaleTemplate(template));
        const pool = [...scaledRects, ...scaledShapes];
    
        const pushPlate = (template: PlateTemplate, placement: { x: number; y: number; rotation: number; renderW: number; renderH: number }) => {
            placedBodies.push(this.buildPlateBody(
                template, placement.x, placement.y, placement.rotation, placement.renderW, placement.renderH
            ));
            // 调色盘取色只抽一次下标：tint 给老路径用，色名给预烘图选图用，两边必须是同一个颜色
            const tintIndex = Math.floor(Math.random() * PLATE_TINT_PALETTE.length);
            plates.push({
                id: `p${startIndex + plates.length}`,
                type: template.type,
                color: Math.random() > 0.5 ? 'yellow' : 'blue',
                w: placement.renderW,
                h: placement.renderH,
                x: placement.x,
                y: placement.y,
                // wave 0 要压在最上面，所以层越浅 layer 越大；
                // 层内按生成顺序排微层（互不重叠，纯稳定渲染顺序），层间隔 100 给足余量
                layer: (waveCount - 1 - wave) * 100 + plates.length,
                wave,
                fruits: [],
                holes: this.mapTemplateHoles(template, placement.rotation),
                removed: false,
                state: 'stable',
                supportPlateId: undefined,
                supportY: undefined,
                isFalling: false,
                fallDistance: 0,
                rotation: 0,
                // 糖果调色盘随机取色，一次定色后不再变
                tint: { ...PLATE_TINT_PALETTE[tintIndex] },
                texture: template.texture,
                baked: template.baked,
                bakedColor: BAKED_PLATE_COLORS[tintIndex],
                colliders: this.mapTemplateColliders(template, placement.rotation),
                buried: false
            });
        };
    
        // 每层随机换一个扫描起始角（左上/右上/左下/右下）。装箱是确定性算法，
        // 固定从一个角扫的话，先铺的板子永远堆在那半边、后铺的永远在另半边，
        // 每层都是同一个分层感，比布局细节重复更扎眼
        const fromLeft = Math.random() > 0.5;
        const fromTop = Math.random() > 0.5;

        // 第一阶段：方板保底。它们个头大，得趁空地还整的时候先放进去，
        // 排到后面就只剩碎缝、一块也塞不下，理由见 LAYER_RECT_PLATE_FIRST
        const shuffledRects = [...scaledRects].sort(() => Math.random() - 0.5);
        for (let i = 0; i < Math.min(LAYER_RECT_PLATE_FIRST, shuffledRects.length); i++) {
            const placement = this.findPackedPlacement(shuffledRects[i], placedBodies, paddingX, paddingTop, paddingBottom, fromLeft, fromTop);
            if (placement) pushPlate(shuffledRects[i], placement);
        }

        // 第二阶段：异形板全家福各一块保底，保证每层形状齐全。
        // 它们是凹形的，后面的板子能嵌进 L 的缺口、十字的四个角里
        const shapeSet = [...scaledShapes].sort(() => Math.random() - 0.5);
        for (let i = 0; i < Math.min(LAYER_SHAPE_PLATE_FIRST, shapeSet.length); i++) {
            const placement = this.findPackedPlacement(shapeSet[i], placedBodies, paddingX, paddingTop, paddingBottom, fromLeft, fromTop);
            if (placement) pushPlate(shapeSet[i], placement);
        }

        // 第三阶段：整副模板池重复几遍，按孔密度（一个孔摊到多少面积）从划算到不划算排，
        // 逐块扫第一个放得下的位置。形状收敛后 6 种的孔密度已经拉到 3072~3657，
        // 排序基本不再偏心某一种，所以也不需要造型板配额上限了 ——
        // 反而是方板因为个头大需要第一阶段那个保底
        const deck: { template: PlateTemplate; weight: number }[] = [];
        for (let copy = 0; copy < PACK_TEMPLATE_COPIES; copy++) {
            pool.forEach((template) => deck.push({
                template,
                weight: (template.w * template.h / Math.max(1, template.holes.length))
                    * (1 + (Math.random() * 2 - 1) * PACK_ORDER_JITTER)
            }));
        }
        deck.sort((a, b) => a.weight - b.weight);
        for (const entry of deck) {
            if (plates.length >= LAYER_MAX_PLATES) break;
            const placement = this.findPackedPlacement(entry.template, placedBodies, paddingX, paddingTop, paddingBottom, fromLeft, fromTop);
            if (placement) pushPlate(entry.template, placement);
        }

        // 收尾：装箱天生把板子全堆在扫描起始角那一侧，整体平移一次让包围盒落回可用区正中。
        // 只动 plates 的坐标就够，placedBodies 是局部变量，出了这个函数就不用了
        if (plates.length > 0) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            plates.forEach((plate) => {
                minX = Math.min(minX, plate.x - plate.w / 2);
                maxX = Math.max(maxX, plate.x + plate.w / 2);
                minY = Math.min(minY, plate.y - plate.h / 2);
                maxY = Math.max(maxY, plate.y + plate.h / 2);
            });
            // 上下留边不对称，所以可用区中心不在 y = 0
            const centerY = ((this.boardHeight / 2 - paddingTop) + (-this.boardHeight / 2 + paddingBottom)) / 2;
            const dx = -(minX + maxX) / 2;
            const dy = centerY - (minY + maxY) / 2;
            plates.forEach((plate) => {
                plate.x += dx;
                plate.y += dy;
            });
        }

        return plates;
    }

    /**
     * 按 PLATE_SCALE 缩一份模板出来（原模板不动）。
     * 比例孔位（0~1 那种）跟着 w/h 自动缩，不用管；像素孔位和碰撞体得显式缩。
     */
    private scaleTemplate(template: PlateTemplate): PlateTemplate {
        if (PLATE_SCALE === 1) return template;
        const s = PLATE_SCALE;
        const isRatio = template.holes[0].x <= 1 && template.holes[0].y <= 1;
        return {
            ...template,
            w: template.w * s,
            h: template.h * s,
            holes: isRatio ? template.holes : template.holes.map((hole) => ({ x: hole.x * s, y: hole.y * s })),
            colliders: template.colliders?.map((collider) => collider.kind === 'circle'
                ? { kind: 'circle' as const, cx: collider.cx * s, cy: collider.cy * s, r: collider.r * s }
                : { kind: 'box' as const, cx: collider.cx * s, cy: collider.cy * s, w: collider.w * s, h: collider.h * s })
        };
    }

    /**
     * 把模板的碰撞体映射到指定旋转角下的板局部坐标（原点左上、y 向下，跟 mapTemplateHoles 同口径）。
     * 铺板时的 buildPlateBody 和运行时的 isPointInsidePlate 共用这一套公式，免得两边对不上。
     */
    private mapTemplateColliders(template: PlateTemplate, rotation: number): PlateCollider[] | undefined {
        if (!template.colliders || template.colliders.length === 0) return undefined;
        return template.colliders.map((collider) => {
            if (rotation !== 90) return collider;
            // 绕模板中心转 90 度，转完中心变成 (h/2, w/2)，跟孔位用同一套公式；矩形长宽跟着互换
            const dx = collider.cx - template.w / 2;
            const dy = collider.cy - template.h / 2;
            const cx = template.h / 2 - dy;
            const cy = template.w / 2 + dx;
            return collider.kind === 'circle'
                ? { kind: 'circle' as const, cx, cy, r: collider.r }
                : { kind: 'box' as const, cx, cy, w: collider.h, h: collider.w };
        });
    }

    /**
     * 把模板的局部碰撞体换算到世界坐标，并算出粗筛用的外接圆。
     * 局部→世界的口径与孔位完全一致：cx 往右、cy 往下，换算后 y 翻转。
     * 没配碰撞体的普通方板，整块外接矩形就是它的实体。
     */
    private buildPlateBody(
        template: PlateTemplate,
        x: number,
        y: number,
        rotation: number,
        renderW: number,
        renderH: number
    ): PlateBody {
        const colliders = this.mapTemplateColliders(template, rotation);
        const shapes: WorldCollider[] = [];

        if (!colliders) {
            shapes.push({ kind: 'box', cx: x, cy: y, w: renderW, h: renderH });
        } else {
            colliders.forEach((collider) => {
                const cx = x + (collider.cx - renderW / 2);
                const cy = y + (renderH / 2 - collider.cy);
                shapes.push(collider.kind === 'circle'
                    ? { kind: 'circle', cx, cy, r: collider.r }
                    : { kind: 'box', cx, cy, w: collider.w, h: collider.h });
            });
        }

        // 粗筛外接圆：包住所有形状，两块板的外接圆不相交就不必逐形状比
        let br = 0;
        shapes.forEach((shape) => {
            const reach = shape.kind === 'circle'
                ? Math.hypot(shape.cx - x, shape.cy - y) + shape.r
                : Math.hypot(Math.abs(shape.cx - x) + shape.w / 2, Math.abs(shape.cy - y) + shape.h / 2);
            if (reach > br) br = reach;
        });
        return { cx: x, cy: y, br, shapes };
    }

    /** 两个碰撞块是否相交（gap 当作形状膨胀量，保证板与板之间留出缝） */
    private shapesIntersect(a: WorldCollider, b: WorldCollider, gap: number): boolean {
        if (a.kind === 'circle' && b.kind === 'circle') {
            const rr = a.r + b.r + gap;
            const dx = a.cx - b.cx;
            const dy = a.cy - b.cy;
            return dx * dx + dy * dy < rr * rr;
        }
        if (a.kind === 'box' && b.kind === 'box') {
            return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + gap
                && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + gap;
        }
        // 圆 × 矩形：把圆心夹到矩形边界内得到最近点，比这个点到圆心的距离
        const circle = (a.kind === 'circle' ? a : b) as { kind: 'circle'; cx: number; cy: number; r: number };
        const box = (a.kind === 'box' ? a : b) as { kind: 'box'; cx: number; cy: number; w: number; h: number };
        const halfW = box.w / 2;
        const halfH = box.h / 2;
        const nearestX = Math.max(box.cx - halfW, Math.min(circle.cx, box.cx + halfW));
        const nearestY = Math.max(box.cy - halfH, Math.min(circle.cy, box.cy + halfH));
        const dx = circle.cx - nearestX;
        const dy = circle.cy - nearestY;
        const reach = circle.r + gap;
        return dx * dx + dy * dy < reach * reach;
    }

    /** 两块板子是否撞上：先比外接圆粗筛，再逐形状精判 */
    private bodiesOverlap(a: PlateBody, b: PlateBody, gap: number): boolean {
        const dx = a.cx - b.cx;
        const dy = a.cy - b.cy;
        const reach = a.br + b.br + gap;
        if (dx * dx + dy * dy >= reach * reach) return false;
        for (const shapeA of a.shapes) {
            for (const shapeB of b.shapes) {
                if (this.shapesIntersect(shapeA, shapeB, gap)) return true;
            }
        }
        return false;
    }

    /**
     * 给模板在棋盘里扫一个放得下的位置（Bottom-Left-Fill 装箱）：
     * 按 PACK_SCAN_STEP 的步长走网格，用精确碰撞体判重叠（L 的缺口、月牙的开口允许别的板嵌进来），
     * 撞到第一个不压别人的点就放。以前是随机撒 120 个点挑离已放板子最远的，
     * 那样板子互相隔着缝、一层占地只有 64%，改成贴着铺能到 80%。
     * fromLeft / fromTop 决定从哪个角开始扫，找不到返回 null
     */
    private findPackedPlacement(
        template: PlateTemplate,
        placedBodies: PlateBody[],
        paddingX: number,
        paddingTop: number,
        paddingBottom: number,
        fromLeft: boolean,
        fromTop: boolean
    ): { x: number; y: number; rotation: number; renderW: number; renderH: number } | null {
        const gap = 2;
        // 造型板有专属底图，转了图就歪，只能 0 度；方板可以转 90 度
        const rotations = (template.type === 'circle' || template.texture) ? [0] : [0, 90];

        for (const rotation of rotations) {
            const renderW = rotation === 90 ? template.h : template.w;
            const renderH = rotation === 90 ? template.w : template.h;
            const maxX = this.boardWidth / 2 - renderW / 2 - paddingX;
            // 上下留边不一样，所以 y 的可用区间是非对称的
            const maxYUp = this.boardHeight / 2 - renderH / 2 - paddingTop;
            const maxYDown = this.boardHeight / 2 - renderH / 2 - paddingBottom;
            if (maxX < 0 || maxYUp + maxYDown < 0) continue; // 这个朝向塞不进棋盘

            const xs: number[] = [];
            for (let x = -maxX; x <= maxX; x += PACK_SCAN_STEP) xs.push(x);
            const ys: number[] = [];
            for (let y = maxYUp; y >= -maxYDown; y -= PACK_SCAN_STEP) ys.push(y);
            if (!fromLeft) xs.reverse();
            if (!fromTop) ys.reverse();

            for (const y of ys) {
                for (const x of xs) {
                    const body = this.buildPlateBody(template, x, y, rotation, renderW, renderH);
                    if (placedBodies.some((placed) => this.bodiesOverlap(body, placed, gap))) continue;
                    return { x, y, rotation, renderW, renderH };
                }
            }
        }
        return null;
    }

    /** 模板孔位换算成板内像素坐标：兼容 0~1 比例写法和直接写像素的长条板 */
    private mapTemplateHoles(template: PlateTemplate, rotation: number) {
        const isRatio = template.holes[0].x <= 1 && template.holes[0].y <= 1;
        return template.holes.map((hole) => {
            if (rotation === 90) {
                if (isRatio) {
                    // 标准化坐标旋转 90 度：x'=y, y'=1-x
                    return { x: hole.y * template.h, y: (1 - hole.x) * template.w };
                }
                // 已经是像素坐标，绕中心 (w/2, h/2) 转 90 度，转完中心变成 (h/2, w/2)
                const dx = hole.x - template.w / 2;
                const dy = hole.y - template.h / 2;
                return { x: template.h / 2 - dy, y: template.w / 2 + dx };
            }
            return isRatio
                ? { x: hole.x * template.w, y: hole.y * template.h }
                : { x: hole.x, y: hole.y };
        });
    }

    /** 把一批水果洒进这批板子的孔位，返回实际放下的个数 */
    private placeFruitsInWave(plates: PlateData[], fruits: FruitColor[], startId: number) {
        // 孔位比果子多（铺满后孔位向下取整到 3 的倍数才发果），所以按“每块板轮一个”的
        // 顺序发：保证每块板都至少有一个果（否则空板会被剔除，铺满的效果就白做了），果子也摆得均匀
        const holeQueues = plates.map((plate) => {
            const indexes = plate.holes.map((_, holeIndex) => holeIndex).sort(() => Math.random() - 0.5);
            return { plate, indexes };
        }).sort(() => Math.random() - 0.5);

        const holes: { plate: PlateData; holeIndex: number }[] = [];
        let round = 0;
        let picked = true;
        while (picked) {
            picked = false;
            holeQueues.forEach((queue) => {
                if (round >= queue.indexes.length) return;
                holes.push({ plate: queue.plate, holeIndex: queue.indexes[round] });
                picked = true;
            });
            round++;
        }

        let placed = 0;
        fruits.forEach((color) => {
            const target = holes[placed];
            if (!target) return;
            const hole = target.plate.holes[target.holeIndex];
            target.plate.fruits.push({
                id: `s_${startId + placed}`,
                color,
                x: hole.x,
                y: hole.y,
                removed: false
            });
            placed++;
        });

        return placed;
    }

    /**
     * 把某一层启用：这一层由灰转彩（变可点），同时把再下一层建成灰板垫在最底下做预告。
     * 逐层而不是一次全建：所有未启用层的灰板全叠出来，半透明会糊成一坨深灰。
     */
    private loadWave(wave: number) {
        if (wave > this.maxWave || wave <= this.loadedWave) return;
        this.loadedWave = wave;
        if (!this.boardContentNode) return;

        // 这一层之前是作为预告灰板建好的，现在翻成彩色可点
        this.plates
            .filter((plate) => !plate.removed && (plate.wave ?? 0) === wave)
            .forEach((plate) => {
                if (!plate.buried) return;
                plate.buried = false;
                if (this.plateNodes.has(plate.id)) {
                    this.revealPlate(plate);
                }
            });

        // 没建过节点的（比如首批后紧跟的那一层）补建，再把下一层的预告灰板垫上
        this.buildWaveNodes(wave, false);
        this.buildWaveNodes(wave + 1, true);
    }

    /**
     * 把指定层还没建过节点的板子建出来，按 layer 降序建、每块插到最底：
     * 这批埋得最深，得压在已有板子下面。buried 决定彩色还是灰。
     */
    private buildWaveNodes(wave: number, buried: boolean) {
        if (wave > this.maxWave || !this.boardContentNode) return;
        this.plates
            .filter((plate) => !plate.removed && (plate.wave ?? 0) === wave && !this.plateNodes.has(plate.id))
            .sort((a, b) => b.layer - a.layer)
            .forEach((plate) => {
                plate.buried = buried;
                this.createPlateNode(this.boardContentNode!, plate, true);
                const pivotNode = this.plateNodes.get(plate.id);
                if (pivotNode && pivotNode.isValid) {
                    pivotNode.setSiblingIndex(0);
                }
            });
    }

    private getNextCapacityForColor(color: BoxColor, targetBox: BoxData, minCapacity: number = 3): number {
        if (color === 'empty' || color === 'locked') return 3;

        // 孔数完全交给后端权重决定，不按场上剩余数钳制。
        // 篮子没装满也卡不了关：某色果全进篮后 canClearBox 会提前清篮，
        // 且过关只看“板子全掉 + 暂存区清空”（checkWin），没满的篮子不挡路
        const normalizedMinCapacity = Math.max(3, Math.min(6, minCapacity));
        return Math.max(normalizedMinCapacity, this.getBoxCapacity());
    }

    private checkAllBoxesForClear() {
        let changed = false;
        this.boxes.forEach((box) => {
            if (this.canClearBox(box)) {
                if (!box.clearScheduled) {
                    this.scheduleBoxClear(box, 0.2);
                    changed = true;
                }
            }
        });
        return changed;
    }

    private getBoxCapacity(): number {
        const level = this.currentLevel;
        const ranges = this.gameConfig?.boxCapacity;
        // 兜底：无配置时返回 3
        if (!ranges || ranges.length === 0) return 3;

        // 找到当前关卡所在的区间
        const range = ranges.find(r => level <= r.max) || ranges[ranges.length - 1];

        // 根据区间权重随机选出孔数
        const entries: { cap: number; weight: number }[] = [];
        if (range.w3) entries.push({ cap: 3, weight: range.w3 });
        if (range.w4) entries.push({ cap: 4, weight: range.w4 });
        if (range.w5) entries.push({ cap: 5, weight: range.w5 });
        if (range.w6) entries.push({ cap: 6, weight: range.w6 });

        const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
        let r = Math.random() * totalWeight;
        for (const entry of entries) {
            r -= entry.weight;
            if (r <= 0) return entry.cap;
        }
        return entries[0]?.cap || 3;
    }


    private handleFruitClick(plate: PlateData, fruit: FruitData) {
        if (this.gameOver) return;

        // 灰板上的果子不能提前摸。只看 buried 而不能再看 wave：
        // 未启用层里已经露出来、按遮挡提前翻彩的那些板，wave 仍然大于 loadedWave，
        // 拿 wave 拦的话它们看着是彩的却点不动
        if (plate.buried) {
            this.triggerVibration('light');
            return;
        }

        if (this.isFruitBlocked(plate, fruit)) {
            this.triggerVibration('light');
            const plateNode = this.plateNodes.get(plate.id);
            if (plateNode) {
                const origin = plateNode.position.clone();
                tween(plateNode)
                    .stop()
                    .to(0.05, { position: new Vec3(origin.x + 6, origin.y, 0) })
                    .to(0.05, { position: new Vec3(origin.x - 6, origin.y, 0) })
                    .to(0.05, { position: new Vec3(origin.x, origin.y, 0) })
                    .start();
            }
            return;
        }

        this.triggerVibration('heavy');

        // 彩虹果特殊处理：可放入任意有空间的果篮
        const isRainbow = fruit.color === FruitColor.RAINBOW;
        let targetBox: BoxData | undefined;
        
        if (isRainbow) {
            const activeBoxes = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty' && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
            
            if (activeBoxes.length > 0) {
                activeBoxes.sort((a, b) => {
                    const countA = a.fruits.length + (a.incomingCount || 0);
                    const countB = b.fruits.length + (b.incomingCount || 0);
                    const diffA = a.capacity - countA;
                    const diffB = b.capacity - countB;
                    if (diffA !== diffB) {
                        return diffA - diffB;
                    }
                    return countB - countA;
                });
                targetBox = activeBoxes[0];
            }
        } else {
            targetBox = this.boxes.find((box) => box.color === fruit.color && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
        }

        if (!targetBox) {
            if ((this.tempHoles.length + this.incomingTempCount) >= this.maxTempHoles) {
                this.gameOver = true;
                this.renderFailModal();
                return;
            }
        }

        // ===== 捕获水果的世界坐标（在从板子上移除之前） =====
        const pivotNode = this.plateNodes.get(plate.id);
        let startWorldPos = new Vec3(0, 0, 0);
        if (pivotNode && pivotNode.isValid) {
            const visualNode = pivotNode.getChildByName(`PlateVisual_${plate.id}`);
            if (visualNode) {
                const fruitContainer = visualNode.getChildByName(`FruitContainer_${fruit.id}`);
                if (fruitContainer && fruitContainer.isValid) {
                    startWorldPos = fruitContainer.getWorldPosition();
                }
            }
        }

        fruit.removed = true;
        this.removedFruits++;
        // 摘一个少一个：场上剩余果低于阈值就把下一层灰板垫进来
        this.ensureLayerBudget();

        // 从板子上移除水果视觉节点
        if (pivotNode && pivotNode.isValid) {
            const visualNode = pivotNode.getChildByName(`PlateVisual_${plate.id}`);
            if (visualNode) {
                const fruitContainer = visualNode.getChildByName(`FruitContainer_${fruit.id}`);
                if (fruitContainer && fruitContainer.isValid) {
                    fruitContainer.destroy();
                }
            }
        }

        if (!targetBox) {
            // 放入暂存盘：飞向第一个空孔位
            const targetWorldPos = this.getTempTrayWorldPos(this.tempHoles.length + this.incomingTempCount);
            this.incomingTempCount++;
            this.trackFlyingFruit(fruit.color);

            // 板子掉落/旋转与飞行动画同时进行
            this.afterFruitRemoved(plate);

            this.playFruitFlyAnimation(fruit, startWorldPos, targetWorldPos, () => {
                this.incomingTempCount--;
                this.untrackFlyingFruit(fruit.color);
                this.tempHoles.push(fruit.color);
                this.renderTopUI();
                this.autoFillFromTemp();
            });
            return;
        }

        const boxIndex = this.boxes.indexOf(targetBox);
        const slotIndex = targetBox.fruits.length + (targetBox.incomingCount || 0);
        const targetWorldPos = this.getBoxSlotWorldPos(boxIndex, targetBox.capacity, slotIndex);
        
        targetBox.incomingCount = (targetBox.incomingCount || 0) + 1;
        this.trackFlyingFruit(fruit.color);

        // 板子掉落/旋转与飞行动画同时进行
        this.afterFruitRemoved(plate);

        this.playFruitFlyAnimation(fruit, startWorldPos, targetWorldPos, () => {
            targetBox!.incomingCount = Math.max(0, (targetBox!.incomingCount || 0) - 1);
            this.untrackFlyingFruit(fruit.color);

            // 竞态保护：飞行途中果篮可能被清空换色，飞到后需重新校验目标果篮是否仍匹配
            const stillMatches = isRainbow
                ? (targetBox!.color !== 'locked' && targetBox!.color !== 'empty' && (targetBox!.fruits.length + (targetBox!.incomingCount || 0)) < targetBox!.capacity)
                : (targetBox!.color === fruit.color && (targetBox!.fruits.length + (targetBox!.incomingCount || 0)) < targetBox!.capacity);
            if (!stillMatches) {
                // 尝试重新寻找匹配的果篮，找不到则进暂存盘
                const fallback = isRainbow
                    ? this.boxes.find((box) => box.color !== 'locked' && box.color !== 'empty' && (box.fruits.length + (box.incomingCount || 0)) < box.capacity)
                    : this.boxes.find((box) => box.color === fruit.color && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
                if (fallback) {
                    fallback.fruits.push(fruit.color);
                    this.renderTopUI();
                    if (this.canClearBox(fallback)) {
                        this.scheduleBoxClear(fallback, 0.25, true);
                    }
                    this.checkAllBoxesForClear();
                    this.checkWin();
                } else {
                    this.tempHoles.push(fruit.color);
                    this.renderTopUI();
                    this.autoFillFromTemp();
                }
                return;
            }

            targetBox!.fruits.push(fruit.color);

            // ===== 连击判定 =====
            const COMBO_WINDOW = 1500;
            const now = Date.now();
            if (this.lastCollectTime > 0 && (now - this.lastCollectTime) < COMBO_WINDOW) {
                this.comboCount++;
            } else {
                this.comboCount = 1;
            }
            this.lastCollectTime = now;

            if (this.comboCount >= 2) {
                const comboInfo = this.getComboInfo(this.comboCount);
                if (comboInfo.text) {
                    this.showFloatText(comboInfo.text, 0, 10, comboInfo.color, comboInfo.fontSize);
                }
            }

            this.renderTopUI();

            if (this.canClearBox(targetBox!)) {
                this.scheduleBoxClear(targetBox!, 0.25, true);
            }

            // 飞行动画结束后检查所有果篮是否需要消除（替代 afterFruitRemoved 中的 checkAllBoxesForClear）
            this.checkAllBoxesForClear();
        });
    }

    /** 获取暂存盘某个孔位的世界坐标（用于飞行动画终点） */
    private getTempTrayWorldPos(slotIndex: number): Vec3 {
        if (this.tempContainerNode && this.tempContainerNode.isValid && this.tempSlotViews.length > 0) {
            // 孔位布局参数（与 ensureTempSlotViews 一致）
            const slotRadius = 12;
            const spacing = slotRadius * 2 + 5;
            const startX = -spacing * 2;
            const localX = startX + slotIndex * spacing;
            
            // 找到对应孔位节点并转换坐标
            const slotView = this.tempSlotViews[slotIndex];
            if (slotView && slotView.node && slotView.node.isValid) {
                return slotView.node.getWorldPosition();
            }
            
            // 兜底：手动计算
            const worldPos = new Vec3(localX, 0, 0);
            const uiTransform = this.tempContainerNode.getComponent(UITransform);
            if (uiTransform) {
                uiTransform.convertToWorldSpaceAR(worldPos, worldPos);
            }
            return worldPos;
        }
        // 兜底：顶部区域中间
        if (this.topAreaNode && this.topAreaNode.isValid) {
            return this.topAreaNode.getWorldPosition();
        }
        return new Vec3(0, 150, 0);
    }

    /** 获取果篮某个孔位的世界坐标 */
    private getBoxSlotWorldPos(boxIndex: number, capacity: number, slotIndex: number): Vec3 {
        const boxView = this.boxViews[boxIndex];
        if (!boxView || !boxView.node || !boxView.node.isValid) {
            return new Vec3(0, 100, 0);
        }

        const slotPositions = this.getBoxSlotPositions(capacity);
        const slotPos = slotPositions[slotIndex];
        if (!slotPos) {
            return boxView.node.getWorldPosition();
        }

        // slotPos 是相对于 boxView.node 的本地坐标，需转换为世界坐标
        const uiTransform = boxView.node.getComponent(UITransform);
        if (!uiTransform) return boxView.node.getWorldPosition();

        const worldPos = new Vec3(slotPos.x, slotPos.y, 0);
        uiTransform.convertToWorldSpaceAR(worldPos, worldPos);
        return worldPos;
    }

    /** 水果飞行动画：从起始位置飞到目标位置 */
    private playFruitFlyAnimation(
        fruit: FruitData,
        startWorldPos: Vec3,
        targetWorldPos: Vec3,
        onComplete: () => void
    ) {
        if (!this.rootNode || !this.rootNode.isValid) {
            onComplete();
            return;
        }

        const uiTransform = this.rootNode.getComponent(UITransform);
        if (!uiTransform) {
            onComplete();
            return;
        }

        const startLocal = uiTransform.convertToNodeSpaceAR(startWorldPos);
        const targetLocal = uiTransform.convertToNodeSpaceAR(targetWorldPos);

        // 飞行时用稍大的尺寸，更容易看到
        const flySize = 30;
        const flyNode = this.createFruitVisual(this.rootNode, startLocal.x, startLocal.y, flySize, fruit.color, false);
        flyNode.layer = Layers.Enum.UI_2D;
        // 确保在最上层显示，不被其他 UI 遮挡
        flyNode.setSiblingIndex(9999);

        flyNode.setScale(0.8, 0.8, 1);
        tween(flyNode)
            .to(0.1, { scale: new Vec3(1.15, 1.15, 1) })
            .to(0.5, { position: new Vec3(targetLocal.x, targetLocal.y, 0), scale: new Vec3(0.5, 0.5, 1) }, { easing: 'sineIn' })
            .call(() => {
                if (flyNode.isValid) flyNode.destroy();
                onComplete();
            })
            .start();
    }

    /** 水果移除后的板子处理（共用逻辑）：Box2D 接管物理 */
    private afterFruitRemoved(plate: PlateData) {
        const remaining = plate.fruits.filter((item) => !item.removed);
        if (remaining.length === 0) {
            // 果子全摘完 → 板子从 Static 切到 Dynamic，让 Box2D 接管掉落
            this.activatePlatePhysics(plate);
        }
        // 有果子时物理引擎不需要动作（板子保持 Static）
    }

    /** 将板子从静态切为动态，Box2D 接管物理 */
    private activatePlatePhysics(plate: PlateData) {
        const pivotNode = this.plateNodes.get(plate.id);
        if (!pivotNode || !pivotNode.isValid) return;

        const body = pivotNode.getComponent(RigidBody2D);
        if (!body) return;

        plate.state = 'falling';
        plate.gravityOrigin = undefined;
        plate.rotation = 0;

        body.type = ERigidBody2DType.Dynamic;
        body.gravityScale = 1.5;
        // 极小水平速度打破对称（避免完全对称卡死），主要靠重力下落
        body.linearVelocity = new Vec2((Math.random() - 0.5) * 4, 0);
    }

    /**
     * 场景稳定后统一初始化所有板子的物理组件。
     * start() 的 initGame() 中 _physicsReady=false 跳过物理创建，
     * 等 enter() 确认进对局后才调此方法补上，避免 Box2D 在场景切换中注册刚体导致 broadphase 异常。
     */
    private initAllPlatePhysics() {
        this._physicsReady = true;
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            const pivotNode = this.plateNodes.get(plate.id);
            if (!pivotNode || !pivotNode.isValid) return;
            // 已有刚体则跳过（防重）
            if (pivotNode.getComponent(RigidBody2D)) return;

            let offsetX = 0;
            let offsetY = 0;
            if (plate.gravityOrigin) {
                offsetX = plate.gravityOrigin.x - plate.w / 2;
                offsetY = plate.h / 2 - plate.gravityOrigin.y;
            }

            const rigidBody = pivotNode.addComponent(RigidBody2D);
            rigidBody.type = ERigidBody2DType.Static;
            rigidBody.gravityScale = 0;
            rigidBody.linearDamping = 0.5;
            rigidBody.angularDamping = 0.2;

            // 第一个物理组件创建后，物理系统一定就绪，此时设重力
            if (!GameManager._physicsGravitySet) {
                GameManager._physicsGravitySet = true;
                if (PhysicsSystem2D && PhysicsSystem2D.instance) {
                    PhysicsSystem2D.instance.gravity = new Vec2(0, -400);
                }
            }

            // 碰撞矩阵每关重配：同 wave 碰撞、跨 wave 穿透
            if (!GameManager._collisionMatrixConfigured) {
                GameManager._collisionMatrixConfigured = true;
                const ps = PhysicsSystem2D.instance;
                if (ps) {
                    const cm = ps.collisionMatrix as any;
                    for (const k in cm) delete cm[k];
                    const waves = new Set<number>();
                    this.plates.forEach((p) => waves.add((p.wave ?? 0) % 16));
                    waves.forEach((g) => {
                        const cat = 1 << g;
                        cm['' + cat] = cat;
                    });
                }
            }

            const plateGroup = 1 << ((plate.wave ?? 0) % 16);
            const colliders = plate.colliders;
            if (colliders && colliders.length > 0) {
                colliders.forEach((col) => {
                    const px = col.cx - plate.w / 2 - offsetX;
                    const py = plate.h / 2 - col.cy - offsetY;
                    if (col.kind === 'box') {
                        const boxCol = pivotNode.addComponent(BoxCollider2D);
                        boxCol.group = plateGroup;
                        boxCol.offset = new Vec2(px, py);
                        boxCol.size = new Size(col.w, col.h);
                    } else {
                        const circleCol = pivotNode.addComponent(CircleCollider2D);
                        circleCol.group = plateGroup;
                        circleCol.offset = new Vec2(px, py);
                        circleCol.radius = col.r;
                    }
                });
            } else {
                const boxCol = pivotNode.addComponent(BoxCollider2D);
                boxCol.group = plateGroup;
                boxCol.offset = new Vec2(-offsetX, -offsetY);
                boxCol.size = new Size(plate.w, plate.h);
            }
        });
    }

    /** Box2D 每帧同步：读物理位置写回数据模型，检测掉出屏幕的板子 */
    update(_dt: number) {
        this.plates.forEach((plate) => {
            if (plate.removed || plate.state !== 'falling') return;

            const node = this.plateNodes.get(plate.id);
            if (!node || !node.isValid) return;

            const body = node.getComponent(RigidBody2D);
            if (!body || body.type !== ERigidBody2DType.Dynamic) return;

            const pos = node.position;
            plate.x = pos.x;
            plate.y = pos.y;

            // 卡住检测：掉落板被下层板支撑停住（速度持续很小）时标记 stuck，
            // 此时它仍停在画面上遮挡别的果子，这些果子应判为不可点
            const vel = body.linearVelocity;
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
            if (speed < 8) {
                plate.stuckFrames = (plate.stuckFrames || 0) + 1;
                if (plate.stuckFrames > 18) plate.stuck = true;
            } else {
                plate.stuckFrames = 0;
                plate.stuck = false;
            }

            // 板子掉出屏幕 → 标记移除、销毁节点
            if (pos.y < -this.boardHeight * 1.5) {
                this.triggerVibration('success');
                plate.removed = true;
                plate.state = 'removed';
                this.destroyPlateNode(plate.id);
                this.refreshBuriedStates();
                this.ensureLayerBudget();
                this.checkAllBoxesForClear();
                this.renderTopUI();
                this.checkWin();
            }
        });
    }

    /** 获取小太阳图标的世界坐标（取图片左侧太阳图形中心，而非整张图中心） */
    private getSunWorldPos(): Vec3 | null {
        if (!this.sunIconNode || !this.sunIconNode.isValid) return null;
        const uiTransform = this.sunIconNode.getComponent(UITransform);
        if (uiTransform) {
            return uiTransform.convertToWorldSpaceAR(new Vec3(-uiTransform.width * 0.25, 0, 0));
        }
        return this.sunIconNode.getWorldPosition();
    }

    /**
     * 果篮装满时，播放粒子飞向小太阳的动画
     * @param boxIndex 果篮索引
     * @param count 飞行粒子数量（= 果篮孔数）
     */
    private playSunCollectAnimation(boxIndex: number, count: number): Promise<void> {
        return new Promise((resolve) => {
            const boxView = this.boxViews[boxIndex];
            if (!boxView || !boxView.node || !boxView.node.isValid) {
                resolve();
                return;
            }

            const sunWorldPos = this.getSunWorldPos();
            if (!sunWorldPos || !this.rootNode) {
                resolve();
                return;
            }

            const boxWorldPos = boxView.node.getWorldPosition();
            const uiTransform = this.rootNode.getComponent(UITransform);
            if (!uiTransform) {
                resolve();
                return;
            }

            // 转换为 rootNode 本地坐标
            const startLocal = uiTransform.convertToNodeSpaceAR(boxWorldPos);
            const targetLocal = uiTransform.convertToNodeSpaceAR(sunWorldPos);

            let completed = 0;
            const particleSize = 8;
            const goldColor = new Color(255, 220, 50, 255);

            for (let i = 0; i < count; i++) {
                const delay = i * 0.06; // 每个粒子间隔 60ms
                this.scheduleOnce(() => {
                    // 创建金色粒子
                    const particleNode = new Node(`SunParticle_${i}`);
                    const particleGraphic = particleNode.addComponent(Graphics);
                    particleGraphic.fillColor = goldColor;
                    particleGraphic.circle(0, 0, particleSize);
                    particleGraphic.fill();

                    // 添加发光外圈
                    const glowGraphic = particleNode.addComponent(Graphics);
                    glowGraphic.fillColor = new Color(255, 240, 100, 100);
                    glowGraphic.circle(0, 0, particleSize + 4);
                    glowGraphic.fill();

                    particleNode.setPosition(new Vec3(startLocal.x, startLocal.y, 0));
                    particleNode.layer = Layers.Enum.UI_2D;
                    this.rootNode!.addChild(particleNode);
                    particleNode.setSiblingIndex(9999);

                    // 二次贝塞尔曲线飞行：控制点抬高形成明显弧度，同时逐渐缩小
                    const ctrlX = (startLocal.x + targetLocal.x) / 2;
                    const ctrlY = Math.max(startLocal.y, targetLocal.y) + 60 + i * 8; // 弧度顶点（每个粒子略错开）
                    const progress = { t: 0 };

                    tween(progress)
                        .to(0.4, { t: 1 }, {
                            onUpdate: () => {
                                if (!particleNode.isValid) return;
                                const t = progress.t;
                                const inv = 1 - t;
                                const x = inv * inv * startLocal.x + 2 * inv * t * ctrlX + t * t * targetLocal.x;
                                const y = inv * inv * startLocal.y + 2 * inv * t * ctrlY + t * t * targetLocal.y;
                                particleNode.setPosition(new Vec3(x, y, 0));
                                const s = 1.3 - t; // 从 1.3 缩到 0.3
                                particleNode.setScale(new Vec3(s, s, 1));
                            }
                        })
                        .call(() => {
                            if (particleNode.isValid) particleNode.destroy();
                            completed++;
                            if (completed === count) {
                                resolve();
                            }
                        })
                        .start();
                }, delay);
            }
        });
    }

    private clearBoxAndAssignNewColor(targetBox: BoxData) {
        if (!this.canClearBox(targetBox)) {
            targetBox.clearScheduled = false;
            targetBox.isSlidingOut = false;
            this.renderBoxes();
            // 果篮有水果但清理条件暂时不满足，延迟重试防止死盒
            if (targetBox.fruits.length > 0 && targetBox.color !== 'locked' && targetBox.color !== 'empty') {
                this.scheduleBoxClear(targetBox, 0.3, false);
            }
            return;
        }

        targetBox.clearScheduled = false;
        targetBox.isSlidingOut = true;
        this.renderBoxes();

        this.scheduleOnce(() => {
            if (!this.canClearBox(targetBox)) {
                targetBox.isSlidingOut = false;
                this.renderBoxes();
                // 同样延迟重试
                if (targetBox.fruits.length > 0 && targetBox.color !== 'locked' && targetBox.color !== 'empty') {
                    this.scheduleBoxClear(targetBox, 0.3, false);
                }
                return;
            }

            // 小太阳收集动画与果篮刷新并行执行：先启动动画（捕获果篮当前位置），再立即刷新果篮
            const boxIndex = this.boxes.indexOf(targetBox);
            const sunCount = targetBox.fruits.length;
            this.playSunCollectAnimation(boxIndex, sunCount);

            // 果篮立即刷新（不等太阳动画完成）
            this.sunsCollectedThisLevel += sunCount;
            this.totalSuns += sunCount;
            localStorage.setItem('totalSuns', this.totalSuns.toString());
            // 到账后立刻直刷计数，不依赖 renderTopUI 长链条（链条前段异常时也不丢显示）
            if (this.sunCountLabel && this.sunCountLabel.isValid) {
                this.sunCountLabel.string = `${this.totalSuns}`;
            }

            targetBox.fruits = [];
            targetBox.isSlidingOut = false;

            const nextColor = this.pickRefreshColor(targetBox);
            this.updateBoxColor(targetBox, nextColor);
            targetBox.capacity = this.getNextCapacityForColor(nextColor, targetBox);
            targetBox.isNew = nextColor !== 'empty';
            this.renderTopUI();
            this.autoFillFromTemp();
            this.checkWin();
        }, 0.38);
    }

    private autoFillFromTemp() {
        let changed = false;
        for (let i = this.tempHoles.length - 1; i >= 0; i--) {
            const color = this.tempHoles[i];
            const targetBox = color === FruitColor.RAINBOW
                ? this.boxes.find((box) => box.color !== 'locked' && box.color !== 'empty' && (box.fruits.length + (box.incomingCount || 0)) < box.capacity)
                : this.boxes.find((box) => box.color === color && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
                
            if (!targetBox) continue;
            targetBox.fruits.push(color);
            this.tempHoles.splice(i, 1);
            changed = true;

            if (this.canClearBox(targetBox)) {
                this.scheduleBoxClear(targetBox, 0.2);
            }
        }
        if (changed) {
            this.renderTopUI();
            this.checkWin();
        } else {
            // 如果自动填充没有触发任何盒子消除，检查是否有天然死盒
            if (this.checkAllBoxesForClear()) {
                this.renderTopUI();
                this.checkWin();
            }
        }
    }

    /** 已加载层里还在场的普通颜色：果篮换色/补色只认这些，不许刷出深层拿不到的颜色 */
    private getRemainingColors() {
        const colors = new Set<FruitColor>();
        this.plates.forEach((plate) => {
            if (plate.removed || (plate.wave ?? 0) > this.loadedWave) return;
            plate.fruits.forEach((fruit) => {
                if (!fruit.removed && fruit.color !== FruitColor.RAINBOW) {
                    colors.add(fruit.color);
                }
            });
        });
        this.tempHoles.forEach((color) => {
            if (color !== FruitColor.RAINBOW) colors.add(color);
        });
        // 飞行中的水果同样属于剩余水果：飞行窗口期内若不可见，清篮换色会刷出无关颜色
        this.flyingFruitColors.forEach((color) => {
            if (color !== FruitColor.RAINBOW) colors.add(color);
        });
        return Array.from(colors);
    }

    private isValidPrimaryBoxFruitColor(color: BoxColor): color is FruitColor {
        return COLORS.indexOf(color as FruitColor) !== -1;
    }

    /** 记录/移除飞行中的水果颜色（发射时记录、落地时移除，含改道分支统一在回调开头移除） */
    private trackFlyingFruit(color: FruitColor) {
        this.flyingFruitColors.push(color);
    }
    private untrackFlyingFruit(color: FruitColor) {
        const idx = this.flyingFruitColors.indexOf(color);
        if (idx >= 0) this.flyingFruitColors.splice(idx, 1);
    }

    /** 仅剩彩虹果时检查：无普通颜色但存在彩虹果（盘上/暂存区/飞行中） */
    private hasOnlyRainbowRemaining(): boolean {
        if (this.getRemainingColors().length > 0) return false;
        if (this.tempHoles.some((c) => c === FruitColor.RAINBOW)) return true;
        if (this.flyingFruitColors.some((c) => c === FruitColor.RAINBOW)) return true;
        for (const plate of this.plates) {
            if (plate.removed) continue;
            if (plate.fruits.some((fruit) => !fruit.removed && fruit.color === FruitColor.RAINBOW)) return true;
        }
        return false;
    }

    /** 彩虹果保底：随机选一个未被占用的颜色（彩虹果可入任意篮，不能让它无篮可入） */
    private pickRainbowFallbackColor(usedColors: Set<FruitColor>): FruitColor | null {
        const available = COLORS.filter((color) => !usedColors.has(color));
        return available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;
    }

    private getPrimaryBoxFruitFallbackColor(index: number): BoxColor {
        const remaining = this.getRemainingColors();
        // 全局不允许同色果篮：排除其他所有篮子已占用的颜色
        const usedByOthers = new Set(
            this.boxes
                .filter((_, idx) => idx !== index)
                .map((box) => box.color)
                .filter((color): color is FruitColor => this.isValidPrimaryBoxFruitColor(color))
        );
        const candidate = remaining.find((color) => !usedByOthers.has(color));
        if (candidate) return candidate;
        // 例外：仅剩彩虹果时随机分配颜色（彩虹果可入任意篮，否则死局）
        if (this.hasOnlyRainbowRemaining()) {
            const rainbowColor = this.pickRainbowFallbackColor(usedByOthers);
            if (rainbowColor) return rainbowColor;
        }
        return 'empty';
    }

    private updateBoxColor(box: BoxData, color: BoxColor) {
        if (box.color === color) return;
        box.clearScheduled = false;
        box.isSlidingOut = false;
        box.color = color;
        if (color === 'locked' || color === 'empty') {
            box.fruits = [];
            return;
        }
        if (box.fruits.some((fruit) => fruit !== color)) {
            box.fruits = [];
        }
    }

    /** 某颜色“玩家拿得到”的总数：篮内 + 暂存区 + 已加载层的板上。未加载的深层不算，果篮不许傻等它们 */
    private getOutstandingFruitCount(color: FruitColor) {
        let count = 0;
        this.boxes.forEach((box) => {
            count += box.fruits.filter((fruit) => fruit === color).length;
        });
        this.tempHoles.forEach((tempColor) => {
            if (tempColor === color) count++;
        });
        this.plates.forEach((plate) => {
            if (plate.removed || (plate.wave ?? 0) > this.loadedWave) return;
            plate.fruits.forEach((fruit) => {
                if (!fruit.removed && fruit.color === color) {
                    count++;
                }
            });
        });
        return count;
    }

    private getPreferredRefreshColors() {
        const weights = new Map<FruitColor, number>();
        const addWeight = (color: FruitColor, weight: number) => {
            if (color === FruitColor.RAINBOW) return;
            weights.set(color, (weights.get(color) || 0) + weight);
        };

        const config = this.gameConfig;
        const interval = config?.challengeInterval || 5;
        const isChallenge = this.currentLevel % interval === 0;
        const wt = isChallenge ? (config?.challengeWeights) : (config?.normalWeights);
        const tempWeight   = wt?.temp  || 20;
        const clickWeight  = wt?.click || 30;
        const blockWeight  = wt?.block || 60;

        this.tempHoles.forEach((color) => addWeight(color, tempWeight));
        // 飞行中的水果按“即将可分配”给权重：保证清篮换色优先匹配它们的颜色
        this.flyingFruitColors.forEach((color) => addWeight(color, clickWeight));
        this.plates.forEach((plate) => {
            if (plate.removed || (plate.wave ?? 0) > this.loadedWave) return;
            plate.fruits.forEach((fruit) => {
                if (fruit.removed) return;
                addWeight(fruit.color, blockWeight);
                if (!this.isFruitBlocked(plate, fruit)) {
                    addWeight(fruit.color, clickWeight);
                }
            });
        });

        return Array.from(weights.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([color]) => color);
    }

    /** 统计某颜色当前可操作的水果数（可点击 + 暂存区 + 飞行中） */
    private getActionableCount(color: FruitColor): number {
        let count = 0;
        this.tempHoles.forEach((tempColor) => {
            if (tempColor === color) count++;
        });
        this.flyingFruitColors.forEach((flyColor) => {
            if (flyColor === color) count++;
        });
        this.plates.forEach((plate) => {
            if (plate.removed || (plate.wave ?? 0) > this.loadedWave) return;
            plate.fruits.forEach((fruit) => {
                if (fruit.removed || fruit.color !== color) return;
                if (!this.isFruitBlocked(plate, fruit)) count++;
            });
        });
        return count;
    }

    private pickRefreshColor(targetBox: BoxData): BoxColor {
        const currentColors = this.boxes
            .filter((box) => box !== targetBox && box.color !== 'locked' && box.color !== 'empty')
            .map((box) => box.color as FruitColor);

        const preferred = this.getPreferredRefreshColors();
        // 优先：有可点击/暂存/飞行水果的颜色（保证刷出来能填）
        const actionable = preferred.filter((color) =>
            currentColors.indexOf(color) === -1 && this.getActionableCount(color) > 0
        );
        if (actionable.length > 0) {
            return actionable[0];
        }

        // 其次：游戏区剩余且未被占用的颜色
        const remaining = this.getRemainingColors().filter((color) => currentColors.indexOf(color) === -1);
        if (remaining.length > 0) {
            return remaining[0];
        }

        // 无可分配颜色时返回空篮：不允许同色果篮，也不凭空刷出游戏区没有的颜色
        // 例外：仅剩彩虹果时随机分配颜色（彩虹果可入任意篮，否则死局）
        if (this.hasOnlyRainbowRemaining()) {
            const used = new Set(currentColors);
            const rainbowColor = this.pickRainbowFallbackColor(used);
            if (rainbowColor) return rainbowColor;
        }
        return 'empty';
    }

    private getUniqueReplacementColor(exclude: BoxData, duplicateColor: FruitColor): BoxColor {
        const remaining = this.getRemainingColors().filter((color) => color !== duplicateColor);
        const activeColors = this.boxes
            .filter((box) => box !== exclude && box.color !== 'locked' && box.color !== 'empty')
            .map((box) => box.color as FruitColor);

        const available = remaining.filter((color) => activeColors.indexOf(color) === -1);
        if (available.length > 0) {
            return available[0];
        }

        // 游戏区没有未占用的颜色：返回空篮，不同色、不凭空刷色
        // 例外：仅剩彩虹果时随机分配颜色
        if (this.hasOnlyRainbowRemaining()) {
            const used = new Set(activeColors);
            used.add(duplicateColor);
            const rainbowColor = this.pickRainbowFallbackColor(used);
            if (rainbowColor) return rainbowColor;
        }
        return 'empty';
    }

    private normalizeEndgameBoxes() {
        const activeBoxes = this.boxes.filter((box): box is BoxData & { color: FruitColor } => this.isValidPrimaryBoxFruitColor(box.color));
        const processed = new Set<FruitColor>();

        activeBoxes.forEach((box) => {
            const color = box.color;
            if (processed.has(color)) return;
            processed.add(color);

            const sameColorBoxes = this.boxes.filter((item) => item.color === color);
            if (sameColorBoxes.length <= 1) return;

            const outstandingCount = this.getOutstandingFruitCount(color) + this.getOutstandingFruitCount(FruitColor.RAINBOW);
            if (outstandingCount > box.capacity) return;

            sameColorBoxes.sort((a, b) => b.fruits.length - a.fruits.length);
            const primary = sameColorBoxes[0];
            let mergedCount = 0;
            let rainbowCount = 0;
            sameColorBoxes.forEach((item) => {
                mergedCount += item.fruits.filter((fruit) => fruit === color).length;
                rainbowCount += item.fruits.filter((fruit) => fruit === FruitColor.RAINBOW).length;
            });
            
            // 重新分配果子，优先放普通果子，再放彩虹果
            const newFruits = [];
            for (let i = 0; i < Math.min(primary.capacity, mergedCount); i++) newFruits.push(color);
            for (let i = 0; i < Math.min(primary.capacity - newFruits.length, rainbowCount); i++) newFruits.push(FruitColor.RAINBOW);
            primary.fruits = newFruits;

            for (let i = 1; i < sameColorBoxes.length; i++) {
                const extraBox = sameColorBoxes[i];
                extraBox.fruits = [];
                const newColor = this.getUniqueReplacementColor(extraBox, color);
                this.updateBoxColor(extraBox, newColor);
                extraBox.capacity = this.getNextCapacityForColor(newColor, extraBox);
            }

            if (this.canClearBox(primary)) {
                this.scheduleBoxClear(primary, 0.2);
            }
        });
    }

    private canClearBox(box: BoxData) {
        if (!this.isValidPrimaryBoxFruitColor(box.color) || box.fruits.length === 0) return false;
        if (!box.fruits.every((fruit) => fruit === box.color || fruit === FruitColor.RAINBOW)) return false;
        // 有水果正在飞向该果篮时不能清除，否则飞行中的水果会落入换色后的果篮
        if ((box.incomingCount || 0) > 0) return false;

        if (box.fruits.length === box.capacity) return true;

        // 有水果仍在飞行途中时禁止提前清篮：飞行中的水果不计入剩余统计（已从盘子移除、尚未入篮/入暂存区），
        // 尤其是彩虹果会被计入所有果篮的剩余量，飞行窗口期内统计偏小会导致误判提前清篮。
        // 满员清篮（上方判断）不依赖统计，不受影响；飞行落地后的检查会重新触发，不会漏清。
        if (this.hasFlyingFruits()) return false;

        // 如果包含彩虹果，它也可以作为该颜色的一部分被清除。
        // 剩余量只算已加载层：眼前拿得到的都进篮了就立刻清，不傻等埋在深层的果（防死局）
        const outstanding = this.getOutstandingFruitCount(box.color) + this.getOutstandingFruitCount(FruitColor.RAINBOW);
        if (box.fruits.length === outstanding) return true;

        return false;
    }

    /** 是否有水果正在飞行途中（去向果篮或暂存区），飞行中的水果不计入剩余统计 */
    private hasFlyingFruits(): boolean {
        if (this.incomingTempCount > 0) return true;
        return this.boxes.some((box) => (box.incomingCount || 0) > 0);
    }

    private scheduleBoxClear(box: BoxData, delay: number, withSuccessVibration: boolean = false) {
        if (box.clearScheduled || box.isSlidingOut || !this.canClearBox(box)) return;

        box.clearScheduled = true;
        this.scheduleOnce(() => {
            if (withSuccessVibration && this.canClearBox(box)) {
                this.triggerVibration('success');
            }
            this.clearBoxAndAssignNewColor(box);
        }, delay);
    }

    private ensurePrimaryBoxes() {
        const firstTwo = this.boxes.slice(0, 2);
        const active = firstTwo.filter((box) => this.isValidPrimaryBoxFruitColor(box.color));
        const missing = 2 - active.length;
        if (missing <= 0) {
            if (this.boxes[0].color === this.boxes[1].color) {
                this.updateBoxColor(this.boxes[1], this.getPrimaryBoxFruitFallbackColor(1));
                this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
            }
            return;
        }

        const remaining = this.getRemainingColors();

        for (let i = 0; i < 2; i++) {
            const box = this.boxes[i];
            if (this.isValidPrimaryBoxFruitColor(box.color)) continue;
            // 只允许游戏区剩余且未被任何果篮占用的颜色；没有则为空篮：不同色、不凭空刷色
            const usedByOthers = new Set(
                this.boxes
                    .filter((_, idx) => idx !== i)
                    .map((item) => item.color)
                    .filter((color): color is FruitColor => this.isValidPrimaryBoxFruitColor(color))
            );
            const color = remaining.find((item) => !usedByOthers.has(item));
            this.updateBoxColor(box, color || 'empty');
            box.fruits = [];
            box.capacity = this.getNextCapacityForColor(box.color, box);
        }

        if (this.boxes[0].color === this.boxes[1].color) {
            this.updateBoxColor(this.boxes[1], this.getPrimaryBoxFruitFallbackColor(1));
            this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
        }
    }

    private reevaluateBoxColors() {
        const remaining = this.getRemainingColors();
        if (remaining.length === 0) return;

        const activeBoxes = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty');
        const missingColors = remaining.filter((color) => !activeBoxes.some((box) => box.color === color));
        if (missingColors.length === 0) return;

        const emptyActiveBoxes = activeBoxes.filter((box) => box.fruits.length === 0);
        if (emptyActiveBoxes.length > 0) {
            this.updateBoxColor(emptyActiveBoxes[0], missingColors[0]);
            emptyActiveBoxes[0].capacity = this.getNextCapacityForColor(missingColors[0], emptyActiveBoxes[0]);
            this.scheduleOnce(() => this.autoFillFromTemp(), 0.1);
        }
    }

    private handleUnlockBox(targetBox: BoxData) {
        if (this.gameOver || targetBox.color !== 'locked') return;

        // 解锁果篮优先匹配暂存区水果颜色：暂存区有任一水果即可作为候选，解锁后立即自动填入
        const usedColors = new Set(
            this.boxes
                .filter((box) => box !== targetBox)
                .map((box) => box.color)
                .filter((color): color is FruitColor => this.isValidPrimaryBoxFruitColor(color))
        );
        const tempColorCounts = new Map<FruitColor, number>();
        this.tempHoles.forEach((color) => {
            if (color !== FruitColor.RAINBOW && !usedColors.has(color)) {
                tempColorCounts.set(color, (tempColorCounts.get(color) || 0) + 1);
            }
        });
        // 暂存区颜色按数量降序，优先选最多的
        const tempSorted = Array.from(tempColorCounts.entries()).sort((a, b) => b[1] - a[1]);

        const nextColor: BoxColor = tempSorted.length > 0
            ? tempSorted[0][0]
            : this.pickRefreshColor(targetBox);

        this.updateBoxColor(targetBox, nextColor);
        targetBox.capacity = this.getNextCapacityForColor(nextColor, targetBox);
        targetBox.isNew = true;
        this.removeTempFullGuide();
        this.renderTopUI();
        this.autoFillFromTemp();
    }

    private useTool(type: 'add' | 'clear') {
        if (this.gameOver) return;

        if (type === 'add') {
            const lockedBox = this.boxes.find((box) => box.color === 'locked');
            if (!lockedBox) {
                this.renderModal({
                    title: '提示',
                    sub: '无果篮可解锁',
                    button: '知道了',
                    height: 170,
                    onConfirm: () => {}
                });
                return;
            }
            
            this.renderAddBasketModal();
            return;
        }

        // 不校验果盘是否有水果，直接弹窗，让用户可以继续往下操作
        this.renderClearBasketModal();
    }

    public showAdThen(callback: () => void, scene?: string) {
        const adManager = AdManager.getInstance();
        if (!adManager) {
            callback();
            return;
        }
        adManager.showRewardedAd().then(() => {
            if (scene) {
                reportEvent(scene);
            }
            callback();
        }).catch(() => {
            if (scene) {
                reportEvent(scene + '_skip');
            }
        });
    }

    private tryConsumeTool(type: 'add' | 'clear', callback: () => void) {
        if (this.tools[type] > 0) {
            this.tools[type]--;
        }
        callback();
        this.renderTools();
    }


    private checkWin() {
        if (this.gameOver) return;
        if (this.plates.some((plate) => plate.state === 'falling')) return;
        const allRemoved = this.plates.every((plate) => plate.removed);
        if (!allRemoved || this.tempHoles.length > 0) return;

        this.gameOver = true;
        // 延迟 1 秒弹出过关弹窗：等待最后一次小太阳收集动画完成并累加，保证弹窗数量取值正确
        this.showSuccessModalAfterSettle(1.0);
    }

    /** 延迟弹出过关弹窗；若仍有果篮在滑出/待清除（小太阳未累加完），继续等待 */
    private showSuccessModalAfterSettle(delay: number) {
        this.scheduleOnce(() => {
            // 玩家可能在等弹窗的这一秒里退回了首页，那就别把过关弹窗画过去了。
            // 这里不用回滚任何标志：gameOver 已经置上，关卡结算本身不靠这个弹窗
            if (!this.isGameViewAlive()) return;
            const settling = this.boxes.some((box) => box.isSlidingOut || box.clearScheduled);
            if (settling) {
                this.showSuccessModalAfterSettle(0.3);
            } else {
                this.renderSuccessModal();
            }
        }, delay);
    }

    private renderSuccessModal() {
        if (!this.modalLayerNode) return;

        // 小太阳已在果篮清除时实时累加，这里无需重复
        // 过关锁定：本关已通关，本局太阳就算落实，后续任何重开/返回主页都不得再回滚
        this.sunsCollectedThisLevel = 0;

        this.modalLayerNode.removeAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 成功弹窗：使用图片 panel_success.png
        // 按照原图内容比例 (440 x 625) 设置宽高，避免拉伸变形
        const panelW = 320;
        const panelH = 454;
        const panelNode = this.createNode('SuccessPanel', this.modalLayerNode, 0, 0, panelW, panelH);
        
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_success/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 动态填充 第几关
        // 动态生成完整的"第 X 关"文字，在灰色背景框居中显示
        this.createLabel(panelNode, `第 ${this.currentLevel} 关`, 0, 32, 40, new Color(0, 0, 0, 255), true);

        // 动态填充小太阳数量，黑色字体
        // 改为左对齐，防止数字过大向左挤压
        const successSunsLabel = this.createLabel(panelNode, `x ${this.totalSuns}`, 0, -73, 40, new Color(0, 0, 0, 255), true);
        const successSunsTransform = successSunsLabel.node.getComponent(UITransform);
        if (successSunsTransform) successSunsTransform.setAnchorPoint(0, 0.5);
        successSunsLabel.horizontalAlign = 0; // LEFT

        // 下一关点击区域（隐形按钮）
        // 调整坐标和大小，使其覆盖底部的按钮区域
        const btnNextLevel = this.createNode('BtnNextLevel', panelNode, 0, -150, 220, 70);
        btnNextLevel.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode?.removeAllChildren();
            this.currentLevel++;
            saveProgress(this.currentLevel);
            this.initGame();
        }, this);
    }

    private readonly FRUIT_BLOCK_COVERAGE = 0.3;

    private isFruitBlocked(plate: PlateData, fruit: FruitData) {
        const fruitLocalX = fruit.x - plate.w / 2;
        const fruitLocalY = plate.h / 2 - fruit.y;
        const fruitWorld = this.plateLocalToWorld(plate, fruitLocalX, fruitLocalY);

        // 采样圈跟果子的视觉半径对齐（fruitVisualSize / 2）：圈画大了会伸到隔壁板底下，
        // 果子明明露着却被当成遮挡变成不可点，白白造出死局
        const fruitRadius = 10;
        const sampleStep = 3;
        const samplePoints: { x: number; y: number }[] = [];

        for (let sx = -fruitRadius; sx <= fruitRadius; sx += sampleStep) {
            for (let sy = -fruitRadius; sy <= fruitRadius; sy += sampleStep) {
                if (sx * sx + sy * sy <= fruitRadius * fruitRadius) {
                    samplePoints.push({ x: fruitWorld.x + sx, y: fruitWorld.y + sy });
                }
            }
        }

        const totalSamples = samplePoints.length;

        for (const other of this.plates) {
            // 卡住不动的掉落板（stuck）无视层级：它物理停在上层板子上，遮住的果子不可点
            const stuckCover = other.state === 'falling' && other.stuck;
            if (other.id === plate.id || other.removed) continue;
            if (!stuckCover && (other.state === 'falling' || other.layer <= plate.layer)) continue;

            let coveredCount = 0;
            for (const point of samplePoints) {
                if (this.isPointInsidePlate(other, point.x, point.y)) {
                    coveredCount++;
                }
            }

            if (coveredCount / totalSamples >= this.FRUIT_BLOCK_COVERAGE) {
                return true;
            }
        }

        return false;
    }

    private isPointInsidePlate(plate: PlateData, x: number, y: number) {
        const local = this.worldToPlateLocal(plate, x, y);
        // 先用外接盒粗筛：绝大多数采样点一次比较就排除了，精判只在真落到板上才跑
        if (Math.abs(local.x) > plate.w / 2 + 1 || Math.abs(local.y) > plate.h / 2 + 1) return false;

        if (plate.colliders && plate.colliders.length > 0) {
            // 碰撞体口径是原点左上、y 向下，换算到跟 local 一致的原点中心、y 向上
            return plate.colliders.some((collider) => {
                const ccx = collider.cx - plate.w / 2;
                const ccy = plate.h / 2 - collider.cy;
                if (collider.kind === 'circle') {
                    const dx = local.x - ccx;
                    const dy = local.y - ccy;
                    return dx * dx + dy * dy <= collider.r * collider.r + 1;
                }
                return Math.abs(local.x - ccx) <= collider.w / 2 + 1
                    && Math.abs(local.y - ccy) <= collider.h / 2 + 1;
            });
        }

        if (plate.type === 'circle') {
            const radius = Math.min(plate.w, plate.h) / 2;
            return local.x * local.x + local.y * local.y <= radius * radius + 1;
        }
        return local.x >= -plate.w / 2 && local.x <= plate.w / 2
            && local.y >= -plate.h / 2 && local.y <= plate.h / 2;
    }

    /**
     * 板面被上层板子盖住的比例：在板内撒网格点，统计有多少点落在 layer 更高的板子里。
     * 与 isFruitBlocked 共用一套坐标换算；正在掉落的板子不算遮挡，它马上就走了。
     */
    private getPlateCoverRatio(plate: PlateData) {
        const uppers = this.plates.filter((other) => {
            if (other.id === plate.id || other.removed) return false;
            // 卡住不动的掉落板（stuck）无视层级：物理停在上层板子上也算遮挡
            if (other.state === 'falling') return !!other.stuck;
            return other.layer > plate.layer;
        });
        if (uppers.length === 0) return 0;

        const step = PLATE_COVER_SAMPLE_GRID - 1;
        const radius = Math.min(plate.w, plate.h) / 2;
        let total = 0;
        let covered = 0;

        for (let i = 0; i <= step; i++) {
            for (let j = 0; j <= step; j++) {
                const localX = -plate.w / 2 + plate.w * (i / step);
                const localY = -plate.h / 2 + plate.h * (j / step);
                // 圆板要先剔掉外接方框的四个角，否则覆盖率会被稀释
                if (plate.type === 'circle' && localX * localX + localY * localY > radius * radius) continue;

                total++;
                const world = this.plateLocalToWorld(plate, localX, localY);
                if (uppers.some((other) => this.isPointInsidePlate(other, world.x, world.y))) {
                    covered++;
                }
            }
        }

        return total > 0 ? covered / total : 0;
    }

    /**
     * 置灰表示“现在还轮不到你”：灰板不显示果子、也点不了。
     * 两条放行通道：层被启用（果子数跌破补层阈值，整层一起亮），
     * 或者自己已经没被压住了（遮挡跌到 PLATE_UNBURY_COVER_RATIO 以下，单块翻彩）。
     */
    private isPlateBuried(plate: PlateData) {
        if (plate.removed || plate.state === 'falling') return false;
        if ((plate.wave ?? 0) <= this.loadedWave) return false;
        return this.getPlateCoverRatio(plate) >= PLATE_UNBURY_COVER_RATIO;
    }

    /**
     * 重算置灰状态：先推进数量驱动的整层补层，再走遮挡驱动的单块翻彩。
     * 两者都只会把灰板变彩，不会反方向把彩板变灰。
     */
    private refreshBuriedStates() {
        this.ensureLayerBudget();
        this.revealUncoveredPlates();
    }

    /**
     * 灰板的第二条解锁通道：自己已经没被压住就直接翻彩，不用等果子数跌破补层阈值。
     *
     * 只看当前还是灰的板子，翻过彩的不再回头 —— 单向不可逆。否则上面再掉块板下来
     * 把遮挡又推回阈值之上，果子会一会儿出现一会儿消失。
     * 还没建节点的更深层不管，等它被垫成预告灰板时自然会轮到。
     */
    private revealUncoveredPlates() {
        this.plates.forEach((plate) => {
            if (!plate.buried || plate.removed || plate.state === 'falling') return;
            if (!this.plateNodes.has(plate.id)) return;
            if (this.getPlateCoverRatio(plate) >= PLATE_UNBURY_COVER_RATIO) return;
            plate.buried = false;
            this.revealPlate(plate);
        });
    }
    
    /**
     * 计数驱动的补层：剩余果子一跌破“首批总果量 × 70%”，就把下一层启用（灰→彩），
     * 同时把再下一层垫成灰板预告；启用完果数就回到阀值之上，所以一次只会启用一层。
     */
    private ensureLayerBudget() {
        let guard = 0;
        while (this.loadedWave < this.maxWave && guard++ <= LAYER_MAX_COUNT) {
            if (this.getBoardFruitCount() >= this.refillThreshold) return;
            this.loadWave(this.loadedWave + 1);
        }
    }

    /**
     * 场上还能摘的果子数，补层阈值的统计口径。
     * 看 buried 而不看 wave：按遮挡提前翻彩的板子果子已经可摘，就得算进来，
     * 否则玩家摘了它们计数却不动，会把补层时机提前。
     * 同时要求节点已经建出来：更深的层还没建节点，客观上摘不到，
     * 算进来会把计数撞高、把补层无限推后，最后玩家没果子可摘。
     */
    private getBoardFruitCount(): number {
        let count = 0;
        this.plates.forEach((plate) => {
            if (plate.removed || plate.buried || !this.plateNodes.has(plate.id)) return;
            plate.fruits.forEach((fruit) => {
                if (!fruit.removed) count++;
            });
        });
        return count;
    }

    /** 单块板子的翻面表现：底色灰→彩，水果激活并淡入 */
    private revealPlate(plate: PlateData) {
        const pivotNode = this.plateNodes.get(plate.id);
        if (!pivotNode || !pivotNode.isValid) return;
        const plateNode = pivotNode.getChildByName(`PlateVisual_${plate.id}`);
        if (!plateNode || !plateNode.isValid) return;

        const tint = plate.tint || { r: 150, g: 210, b: 235 };
        const bgSprite = plateNode.getComponent(Sprite);
        if (bgSprite && plate.baked && plate.texture) {
            // 预烘图的颜色画死在图里，翻彩只能换图，没法像刷 tint 那样插值。
            // 配一段透明度淡入掩一下硬切；只动 Sprite.color 的 alpha 而不挂 UIOpacity，
            // 是因为 UIOpacity 挂在 plateNode 上会连着子节点的水果一起变淡
            this.applyBakedPlateTexture(bgSprite, plate.texture, plate.bakedColor || BAKED_PLATE_COLORS[0]);
            const progress = { t: 0 };
            tween(progress)
                .to(PLATE_REVEAL_DURATION, { t: 1 }, {
                    onUpdate: (_target, ratio) => {
                        if (!bgSprite.isValid) return;
                        bgSprite.color = new Color(255, 255, 255, 120 + (230 - 120) * (ratio ?? 0));
                    },
                })
                .start();
        } else if (bgSprite) {
            // 手动插值而不直接 tween Sprite.color：color 的 getter 返回的是内部引用，
            // 交给 tween 取起始值会被后续赋值污染，过渡到一半就可能崩掉
            const from = PLATE_BURIED_COLOR;
            const to = new Color(tint.r, tint.g, tint.b, 230);
            const progress = { t: 0 };
            tween(progress)
                .to(PLATE_REVEAL_DURATION, { t: 1 }, {
                    onUpdate: (_target, ratio) => {
                        if (!bgSprite.isValid) return;
                        const k = ratio ?? 0;
                        bgSprite.color = new Color(
                            from.r + (to.r - from.r) * k,
                            from.g + (to.g - from.g) * k,
                            from.b + (to.b - from.b) * k,
                            to.a,
                        );
                    },
                })
                .start();
        }

        plate.fruits.filter((fruit) => !fruit.removed).forEach((fruit) => {
            const fruitContainer = plateNode.getChildByName(`FruitContainer_${fruit.id}`);
            if (!fruitContainer || !fruitContainer.isValid) return;
            fruitContainer.active = true;
            const opacity = fruitContainer.getComponent(UIOpacity) || fruitContainer.addComponent(UIOpacity);
            opacity.opacity = 0;
            tween(opacity).to(PLATE_REVEAL_DURATION, { opacity: 255 }).start();
        });
    }

    private hasRemainingFruits(plate: PlateData) {
        return plate.fruits.some((fruit) => !fruit.removed);
    }

    private getPlatePivotOffset(plate: PlateData) {
        return {
            x: (plate.gravityOrigin?.x ?? plate.w / 2) - plate.w / 2,
            y: plate.h / 2 - (plate.gravityOrigin?.y ?? plate.h / 2)
        };
    }

    private getPlateNodePosition(plate: PlateData, centerY: number = plate.y) {
        const offset = this.getPlatePivotOffset(plate);
        return new Vec3(plate.x + offset.x, centerY + offset.y, 0);
    }

    private plateLocalToWorld(plate: PlateData, localX: number, localY: number) {
        const offset = this.getPlatePivotOffset(plate);
        const pivotX = plate.x + offset.x;
        const pivotY = plate.y + offset.y;
        const rad = (plate.rotation || 0) * Math.PI / 180;
        const dx = localX - offset.x;
        const dy = localY - offset.y;
        return {
            x: pivotX + dx * Math.cos(rad) - dy * Math.sin(rad),
            y: pivotY + dx * Math.sin(rad) + dy * Math.cos(rad)
        };
    }

    private worldToPlateLocal(plate: PlateData, x: number, y: number) {
        const offset = this.getPlatePivotOffset(plate);
        const pivotX = plate.x + offset.x;
        const pivotY = plate.y + offset.y;
        const rad = -(plate.rotation || 0) * Math.PI / 180;
        const dx = x - pivotX;
        const dy = y - pivotY;
        return {
            x: offset.x + dx * Math.cos(rad) - dy * Math.sin(rad),
            y: offset.y + dx * Math.sin(rad) + dy * Math.cos(rad)
        };
    }

    private getPlateWorldBounds(plate: PlateData) {
        if (plate.type === 'circle') {
            const center = this.plateLocalToWorld(plate, 0, 0);
            const radius = Math.min(plate.w, plate.h) / 2;
            return {
                minX: center.x - radius,
                maxX: center.x + radius,
                minY: center.y - radius,
                maxY: center.y + radius
            };
        }

        const corners = [
            this.plateLocalToWorld(plate, -plate.w / 2, -plate.h / 2),
            this.plateLocalToWorld(plate, plate.w / 2, -plate.h / 2),
            this.plateLocalToWorld(plate, plate.w / 2, plate.h / 2),
            this.plateLocalToWorld(plate, -plate.w / 2, plate.h / 2)
        ];

        return {
            minX: Math.min(...corners.map((point) => point.x)),
            maxX: Math.max(...corners.map((point) => point.x)),
            minY: Math.min(...corners.map((point) => point.y)),
            maxY: Math.max(...corners.map((point) => point.y))
        };
    }

    private getPlateTopSurfaceYAtX(plate: PlateData, worldX: number) {
        // 由 Box2D 物理引擎接管，不再使用自定义表面扫描
        const bounds = this.getPlateWorldBounds(plate);
        if (worldX < bounds.minX - 1 || worldX > bounds.maxX + 1) return null;
        return bounds.maxY;
    }

    public createNode(name: string, parent: Node, x: number, y: number, width: number, height: number) {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);
        node.setPosition(new Vec3(x, y, 0));
        parent.addChild(node);
        return node;
    }

    /** 给板子 Sprite 挂造型贴图，缓存命中直接用，否则异步加载完再回填 */
    private applyPlateTexture(sprite: Sprite, textureName: string) {
        const cached = this.plateTextureFrames.get(textureName);
        if (cached) {
            sprite.spriteFrame = cached;
            return;
        }
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${textureName}/spriteFrame`, SpriteFrame).then((sf) => {
            if (!sf) return;
            this.plateTextureFrames.set(textureName, sf);
            if (sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
            }
        }).catch(() => {});
    }

    /**
     * 挂预烘图：白边和颜色已经画在图里，一形状一色一张。
     * 缓存 key 用完整路径，不能只用 texture 名 —— 同一个形状有七张不同颜色的图。
     */
    private applyBakedPlateTexture(sprite: Sprite, textureName: string, colorName: string) {
        const path = `${BAKED_PLATE_DIR}/${textureName}_${colorName}`;
        const cached = this.plateTextureFrames.get(path);
        if (cached) {
            sprite.spriteFrame = cached;
            return;
        }
        BundleManager.getInstance().loadAsset<SpriteFrame>(`${path}/spriteFrame`, SpriteFrame).then((sf) => {
            if (!sf) return;
            this.plateTextureFrames.set(path, sf);
            if (sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
            }
        }).catch(() => {});
    }

    private createPlateNode(parent: Node, plate: PlateData, interactive: boolean, angleOverride?: number) {
        let pivotX = plate.x;
        let pivotY = plate.y;
        let offsetX = 0;
        let offsetY = 0;

        if (plate.gravityOrigin) {
            offsetX = plate.gravityOrigin.x - plate.w / 2;
            offsetY = plate.h / 2 - plate.gravityOrigin.y;
            pivotX = plate.x + offsetX;
            pivotY = plate.y + offsetY;
        }

        const pivotNode = this.createNode(`Pivot_${plate.id}`, parent, pivotX, pivotY, 0, 0);
        pivotNode.angle = angleOverride ?? (plate.rotation || 0);
        if (interactive) {
            this.plateNodes.set(plate.id, pivotNode);
            pivotNode.setSiblingIndex(Math.max(0, this.getPlateSiblingIndex(plate.id)));
        }

        const plateNode = this.createNode(`PlateVisual_${plate.id}`, pivotNode, -offsetX, -offsetY, plate.w, plate.h);

        // 使用 Sprite 显示板子底图：不规则形状用专属整图缩放，常规板子九宫格拉伸
        const bgSprite = plateNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        bgSprite.type = plate.texture ? Sprite.Type.SIMPLE : Sprite.Type.SLICED;

        // 板子颜色在生成时就从糖果调色盘定好，这里只负责上色
        const tint = plate.tint || { r: 150, g: 210, b: 235 };
        // 掉落中的副本（interactive=false）不参与置灰：能掉就说明它早已翻出来了
        const buried = interactive && !!plate.buried;

        if (plate.baked && plate.texture) {
            // 预烘图自带颜色和白边，只能刷纯白：再刷一遍 tint 会把彩图乘暗发脏，
            // 白边也会跟着被染成同色系。alpha 还是 230，半透明口径不变
            bgSprite.color = new Color(255, 255, 255, 230);
            this.applyBakedPlateTexture(
                bgSprite,
                plate.texture,
                buried ? BAKED_PLATE_GRAY : (plate.bakedColor || BAKED_PLATE_COLORS[0])
            );
        } else {
            bgSprite.color = buried
                ? PLATE_BURIED_COLOR.clone()
                : new Color(tint.r, tint.g, tint.b, 230); // 230 为半透明 (约 90% 不透明度)

            if (plate.texture) {
                this.applyPlateTexture(bgSprite, plate.texture);
            } else if (this.plateSpriteFrame) {
                bgSprite.spriteFrame = this.plateSpriteFrame;
            } else {
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/plate/spriteFrame', SpriteFrame).then((sf) => {
                    if (sf && bgSprite && bgSprite.isValid) {
                        bgSprite.spriteFrame = sf;
                    }
                }).catch(() => {});
            }
        }

        // 保留这两个变量名以防后续逻辑引用，但不绘制任何东西
        const shadow = this.createGraphicsNode('Shadow', plateNode, plate.w, plate.h, 0, 0);
        shadow.active = false;
        const face = this.createGraphicsNode('Face', plateNode, plate.w, plate.h, 0, 0);
        face.active = false;

        plate.fruits.filter((fruit) => !fruit.removed).forEach((fruit) => {
            // 板子上的水果视觉尺寸
            const fruitVisualSize = 20;
            // 点击热区：造型板里孔位最密的是圆盘，两孔中心隔 32 × PLATE_SCALE = 32px。
            // 热区再放大就会跟隔壁果子的热区叠上，点击落在重叠带里会命中错的那颗
            const fruitTouchSize = 30;
            const localX = -plate.w / 2 + fruit.x;
            const localY = plate.h / 2 - fruit.y;

            const fruitContainer = this.createNode(`FruitContainer_${fruit.id}`, plateNode, localX, localY, fruitTouchSize, fruitTouchSize);

            const fruitNode = this.createFruitVisual(fruitContainer, 0, 0, fruitVisualSize, fruit.color, true);
            if (interactive) {
                fruitContainer.on(Node.EventType.TOUCH_END, (e) => {
                    e.propagationStopped = true;
                    this.handleFruitClick(plate, fruit);
                }, this);
            }

            // 被埋板子的水果直接关掉：未激活节点天然不吃触摸，
            // 与原来 isFruitBlocked 拦下点击的行为一致，翻出来时再打开并淡入
            if (buried) {
                fruitContainer.active = false;
            }
        });

        // === Box2D 物理组件：挂在 pivotNode 上 ===
        // _physicsReady=false 时（initGame 场景切换中）跳过，等场景稳定后由 initAllPlatePhysics 统一补上，
        // 避免 Box2D 在场景未稳定时注册刚体导致 broadphase 状态异常
        if (interactive && this._physicsReady) {
            const rigidBody = pivotNode.addComponent(RigidBody2D);
            rigidBody.type = ERigidBody2DType.Static;
            rigidBody.gravityScale = 0;
            rigidBody.linearDamping = 0.5;
            // 角阻尼取较小值：板子被角支撑时，重力力矩能明显推动板子旋转倾覆，呈真实物理感
            rigidBody.angularDamping = 0.2;

            // 第一个物理组件创建后，物理系统一定就绪，此时设重力
            if (!GameManager._physicsGravitySet) {
                GameManager._physicsGravitySet = true;
                if (PhysicsSystem2D && PhysicsSystem2D.instance) {
                    PhysicsSystem2D.instance.gravity = new Vec2(0, -400);
                }
            }

            // 碰撞矩阵每关重配：同 wave 碰撞、跨 wave 穿透（同层XY真实物理，跨Z层隔离）。
            // collisionMatrix 是可变字典，key=categoryBits 字符串(1<<groupIndex)，value=maskBits；
            // collider.group 直接当 categoryBits，创建时 maskBits=collisionMatrix[group]（查不到则全碰）。
            if (!GameManager._collisionMatrixConfigured) {
                GameManager._collisionMatrixConfigured = true;
                const ps = PhysicsSystem2D.instance;
                if (ps) {
                    const cm = ps.collisionMatrix as any;
                    for (const k in cm) delete cm[k]; // 清空旧配置，按当前关卡重配
                    const waves = new Set<number>();
                    this.plates.forEach((p) => waves.add((p.wave ?? 0) % 16));
                    waves.forEach((g) => {
                        const cat = 1 << g;
                        cm['' + cat] = cat; // mask 只含自己：同 wave 碰撞、跨 wave 穿透
                    });
                }
            }

            // 碰撞分组：group=categoryBits(1<<(wave%16))，与 collisionMatrix 配套
            const plateGroup = 1 << ((plate.wave ?? 0) % 16);
            const colliders = plate.colliders;
            if (colliders && colliders.length > 0) {
                colliders.forEach((col) => {
                    const px = col.cx - plate.w / 2 - offsetX;
                    const py = plate.h / 2 - col.cy - offsetY;
                    if (col.kind === 'box') {
                        const boxCol = pivotNode.addComponent(BoxCollider2D);
                        boxCol.group = plateGroup;
                        boxCol.offset = new Vec2(px, py);
                        boxCol.size = new Size(col.w, col.h);
                    } else {
                        const circleCol = pivotNode.addComponent(CircleCollider2D);
                        circleCol.group = plateGroup;
                        circleCol.offset = new Vec2(px, py);
                        circleCol.radius = col.r;
                    }
                });
            } else {
                const boxCol = pivotNode.addComponent(BoxCollider2D);
                boxCol.group = plateGroup;
                boxCol.offset = new Vec2(-offsetX, -offsetY);
                boxCol.size = new Size(plate.w, plate.h);
            }
        }

        return pivotNode;
    }

    private refreshPlateNode(plate: PlateData, angleOverride?: number) {
        if (!this.boardContentNode || plate.removed) return null;
        
        const pivotNode = this.plateNodes.get(plate.id);
        if (pivotNode && pivotNode.isValid) {
            pivotNode.angle = angleOverride ?? (plate.rotation || 0);
            const plateNode = pivotNode.getChildByName(`PlateVisual_${plate.id}`);
            if (plateNode) {
                // 移除已经被消去的水果节点，避免整个板子重新生成导致的闪烁
                plate.fruits.forEach((fruit) => {
                    if (fruit.removed) {
                        const fruitContainer = plateNode.getChildByName(`FruitContainer_${fruit.id}`);
                        if (fruitContainer && fruitContainer.isValid) {
                            fruitContainer.destroy();
                        }
                    }
                });
            }
            return pivotNode;
        }

        // 降级：如果找不到现有的节点，则重新创建
        this.destroyPlateNode(plate.id);
        return this.createPlateNode(this.boardContentNode, plate, true, angleOverride);
    }

    private destroyPlateNode(plateId: string) {
        const node = this.plateNodes.get(plateId);
        if (node && node.isValid) {
            node.destroy();
        }
        this.plateNodes.delete(plateId);
    }

    private getPlateSiblingIndex(plateId: string) {
        return this.plates
            .filter((plate) => !plate.removed)
            .sort((a, b) => a.layer - b.layer)
            .findIndex((plate) => plate.id === plateId);
    }

    private updateFruitHost(host: Node, diameter: number, color?: FruitColor) {
        const existing = host.children[0];
        const expectedName = color ? `Fruit_${color}` : '';
        if (!color) {
            if (existing) {
                host.removeAllChildren();
            }
            return;
        }

        if (existing && existing.name === expectedName) {
            return;
        }

        host.removeAllChildren();
        this.createFruitVisual(host, 0, 0, diameter, color, false);
    }

    private getBoxSlotPositions(capacity: number) {
        // 由于使用了带提手和标签底板的新图，果篮内部有效区域整体偏上
        // boxHeight 约为 120，中心点 0 是整个果篮（含提手）的中心
        // 有效盛放区域的中心大概在 Y = +5 左右
        if (capacity === 4) {
            // 4孔上下分散
            return [
                { x: -18, y: 24 },
                { x: 18, y: 24 },
                { x: -18, y: -10 },
                { x: 18, y: -10 }
            ];
        }
        if (capacity === 5) {
            return [
                { x: -22, y: 28 },
                { x: 22, y: 28 },
                { x: 0, y: 6 },
                { x: -18, y: -16 },
                { x: 18, y: -16 }
            ];
        }
        if (capacity === 6) {
            // 两个两个竖着排列，3行2列，适当留出间隔
            return [
                { x: -16, y: 32 },
                { x: 16, y: 32 },
                { x: -16, y: 8 },
                { x: 16, y: 8 },
                { x: -16, y: -16 },
                { x: 16, y: -16 }
            ];
        }
        return [
            { x: -18, y: 14 },
            { x: 18, y: 14 },
            { x: 0, y: -12 }
        ];
    }

    private ensureBoxViews() {
        if (!this.boxesContainerNode || this.boxViews.length === this.boxes.length) return;

        // 放大果篮宽度
        const boxWidth = Math.min(90, this.screenWidth * 0.22);
        const boxHeight = boxWidth * 1.33; // 保持 3:4 左右的原始比例
        const gap = (this.screenWidth - 30 - boxWidth * 4) / 3;
        const startX = -((boxWidth * 4 + gap * 3) / 2) + boxWidth / 2;
        const maxSlots = 6;
        const allSlotPositions = this.getBoxSlotPositions(maxSlots);

        while (this.boxViews.length < this.boxes.length) {
            const index = this.boxViews.length;
            const x = startX + index * (boxWidth + gap);
            const boxNode = this.createNode(`Box_${index}`, this.boxesContainerNode, x, 0, boxWidth, boxHeight);

            // 果篮本体：使用灰度底图 Sprite，通过 color 动态染色
            const bodyNode = this.createNode('Body', boxNode, 0, 0, boxWidth, boxHeight);
            const bodySprite = bodyNode.addComponent(Sprite);
            bodySprite.sizeMode = Sprite.SizeMode.CUSTOM;

            // 锁状态的覆盖层 (不再画 X)
            const lockOverlayNode = this.createGraphicsNode('LockOverlay', boxNode, boxWidth, boxHeight, 0, 0);
            const lockOverlay = lockOverlayNode.getComponent(Graphics)!;
            lockOverlayNode.active = false;

            // 中心水果图标 (半透明) - 用户要求去掉，隐藏
            const iconNode = this.createNode('FruitIcon', boxNode, 0, boxHeight * 0.08, 48, 48);
            const fruitIcon = iconNode.addComponent(Sprite);
            fruitIcon.sizeMode = Sprite.SizeMode.CUSTOM;
            fruitIcon.color = new Color(255, 255, 255, 70);
            iconNode.active = false;
            
            // 底部中文标签 (白色，字号变小)
            const nameLabel = this.createLabel(boxNode, '', 0, -boxHeight / 2 + boxHeight * 0.15, 12, new Color(255, 255, 255, 255), true);

            // 解锁文字：图二样式 "解锁果篮"
            const lockLabel = this.createLabel(boxNode, '解 锁\n果 篮', 0, 0, 18, new Color(255, 255, 255, 255), true);
            const lockOutline = lockLabel.node.addComponent(LabelOutline);
            if (lockOutline) {
                lockOutline.color = new Color(30, 100, 30, 255); // 深绿色描边
                lockOutline.width = 2;
            }
            lockLabel.lineHeight = 28; // 增加行间距使其上下更分散
            lockLabel.node.active = false;

            const slots: BoxSlotView[] = allSlotPositions.map((pos, slotIndex) => {
                const slotNode = this.createNode(`SlotWrap_${slotIndex}`, boxNode, pos.x, pos.y, 24, 24);
                
                // 给果篮的孔位也加上 Sprite 结构
                const holeNode = this.createNode(`Slot_${slotIndex}`, slotNode, 0, 0, 26.4, 26.4); // 24 * 1.1 = 26.4
                const holeSprite = holeNode.addComponent(Sprite);
                holeSprite.sizeMode = Sprite.SizeMode.CUSTOM;
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hole/spriteFrame', SpriteFrame).then((sf) => {
                    if (sf && holeSprite && holeSprite.isValid) {
                        holeSprite.spriteFrame = sf;
                    }
                }).catch(() => {});
                // 暂时保留 Graphics，以防其他地方报错，但不画东西
                const holeGraphics = holeNode.addComponent(Graphics);
                
                const fruitHost = this.createNode(`FruitHost_${slotIndex}`, slotNode, 0, 0, 24, 24);
                return { node: slotNode, hole: holeGraphics, fruitHost };
            });

            boxNode.on(Node.EventType.TOUCH_END, () => {
                // 锁定果篮可点：弹现有的“加果篮”弹窗（看广告 / 花太阳）。
                // 按 index 读当前 box 状态，只有 locked 才响应；非锁定果篮不做事
                const curBox = this.boxes[index];
                if (curBox && curBox.color === 'locked' && !this.gameOver) {
                    this.renderAddBasketModal();
                }
            }, this);

            this.boxViews.push({
                node: boxNode,
                bodySprite,
                lockOverlay,
                fruitIcon,
                nameLabel,
                lockLabel,
                slots,
                lastBodyColor: ''
            });
        }
    }

    private ensureTempSlotViews() {
        if (!this.tempContainerNode) return;

        if (this.tempSlotViews.length === this.maxTempHoles) return;

        const slotRadius = 12;
        const spacing = slotRadius * 2 + 5;
        const startX = -spacing * 2; // 5 个孔整体居中（span 为 spacing*4，起点 = -spacing*2）

        // 小太阳图标 + 数量（在暂存区孔位右侧）
        if (!this.sunCountLabel) {
            const sunX = startX + this.maxTempHoles * spacing + 55; // 小太阳右移，与孔位拉开间距
            // 新图 250x100（2.5:1），左侧太阳、右侧加宽的数字底框
            const iconH = 36; // 图标放大
            const iconW = iconH * 2.5;

            // 设置按钮（btn_gear.png，分包）：放到屏幕左上角（挂 topAreaNode，关卡号徽章在正中 x=0，左上角空着）。
            // 排行榜入口已移到首页，游戏内不再放排行榜按钮；功能（点开设置弹窗）不变
            const gearBtnNode = this.createNode('SettingsBtn', this.topAreaNode!, -this.screenWidth / 2 + 28, this.topHeight / 2 - 30, iconH, iconH);
            const gearSprite = gearBtnNode.addComponent(Sprite);
            gearSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>('ui/btn_gear/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && gearSprite.isValid) {
                    gearSprite.spriteFrame = sf;
                }
            }).catch(() => {});
            gearBtnNode.on(Node.EventType.TOUCH_END, () => {
                this.renderSettingsModal(true);
            }, this);

            const sunNode = this.createNode('SunIcon', this.tempContainerNode, sunX, 0, iconW, iconH);
            this.sunIconNode = sunNode;
            const sunSprite = sunNode.addComponent(Sprite);
            sunSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>('ui/sun/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && sunSprite && sunSprite.isValid) {
                    sunSprite.spriteFrame = sf;
                }
            }).catch(() => {});

            // 数字靠左显示在底框内部（内部左缘实测在图宽 42% 处），左锚点+不缩放，数字变大时向右撑
            const boxLeftOffsetX = (0.42 - 0.5) * iconW + 6; // 内部左缘再留 6px 内边距
            const labelNode = this.createNode('SunCount', this.tempContainerNode, sunX + boxLeftOffsetX, 0, iconW * 0.5, iconH);
            this.sunCountLabel = labelNode.addComponent(Label);
            this.sunCountLabel.fontSize = 17;
            this.sunCountLabel.lineHeight = iconH;
            this.sunCountLabel.color = new Color(46, 110, 30, 255);
            this.sunCountLabel.string = `${this.totalSuns}`;
            const labelTransform = labelNode.getComponent(UITransform);
            if (labelTransform) labelTransform.setAnchorPoint(0, 0.5);
            this.sunCountLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
            this.sunCountLabel.verticalAlign = Label.VerticalAlign.CENTER;
            this.sunCountLabel.overflow = Label.Overflow.NONE;
        }
        while (this.tempSlotViews.length < this.maxTempHoles) {
            const index = this.tempSlotViews.length;
            const slotNode = this.createNode(`TempSlotWrap_${index}`, this.tempContainerNode, startX + index * spacing, 0, slotRadius * 2, slotRadius * 2);
            
            // 使用 Sprite 显示 hole 图
            const holeNode = this.createNode(`TempSlot_${index}`, slotNode, 0, 0, slotRadius * 2.2, slotRadius * 2.2);
            const holeSprite = holeNode.addComponent(Sprite);
            holeSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hole/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && holeSprite && holeSprite.isValid) {
                    holeSprite.spriteFrame = sf;
                }
            }).catch(() => {});
            const hole = holeNode.addComponent(Graphics); // 保留 component 引用以兼容旧代码结构，但不绘制
            
            const fruitHost = this.createNode(`TempFruitHost_${index}`, slotNode, 0, 0, slotRadius * 2, slotRadius * 2);
            this.tempSlotViews.push({ node: slotNode, hole, fruitHost });
        }
    }

    private ensureToolViews() {
        if (!this.toolContainerNode || this.toolViews.length > 0) return;

        const toolList = [
            { key: 'add' as const, label: '加果篮', icon: '🧺' },
            { key: 'clear' as const, label: '清空果盘', icon: '🧹' }
        ];
        const buttonWidth = 74;
        const buttonHeight = 82;
        const gap = (this.screenWidth - 40 - buttonWidth * 2) / 2;
        const startX = -((buttonWidth * 2 + gap) / 2) + buttonWidth / 2;
        const badgeX = buttonWidth / 2 - 6;
        const badgeY = buttonHeight / 2 - 6;

        toolList.forEach((tool, index) => {
            const x = startX + index * (buttonWidth + gap);
            const btnNode = this.createNode(`ToolBtn_${tool.key}`, this.toolContainerNode!, x, 0, buttonWidth, buttonHeight);

            // 使用 Sprite 显示按钮背景
            const btnSprite = btnNode.addComponent(Sprite);
            btnSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            btnSprite.type = Sprite.Type.SLICED;
            const imageName = tool.key === 'add' ? 'btn_add_basket' : 'btn_clear_tray';
            BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${imageName}/spriteFrame`, SpriteFrame).then((sf) => {
                if (sf && btnSprite && btnSprite.isValid) {
                    btnSprite.spriteFrame = sf;
                }
            }).catch(() => {});

            // 恢复图标和文字显示
            const iconLabel = this.createLabel(btnNode, tool.icon, 0, 10, 28, new Color(255, 255, 255, 255), false, 32);
            
            // 底部文字
            const textLabel = this.createLabel(btnNode, tool.label, 0, -22, 14, new Color(255, 255, 255, 255), true);
            const outline = textLabel.node.addComponent(LabelOutline);
            if (outline) {
                outline.color = new Color(50, 100, 150, 255); // 深蓝色描边
                outline.width = 1.5;
            }

            // 右上角的加号角标 (暂时隐藏，根据用户需求去掉)
            const badgeNode = this.createGraphicsNode('Badge', btnNode, 26, 26, badgeX, badgeY);
            badgeNode.active = false;
            const badge = badgeNode.getComponent(Graphics)!;
            const badgeLabel = this.createLabel(btnNode, '+', badgeX, badgeY, 18, new Color(255, 255, 255, 255), true);
            badgeLabel.node.active = false;

            btnNode.on(Node.EventType.TOUCH_END, () => {
                this.useTool(tool.key);
            }, this);

            this.toolViews.push({
                key: tool.key,
                node: btnNode,
                iconLabel,
                badge,
                badgeLabel
            });
        });
    }

    public createGraphicsNode(name: string, parent: Node, width: number, height: number, x: number, y: number) {
        const node = this.createNode(name, parent, x, y, width, height);
        node.addComponent(Graphics);
        return node;
    }

    public createLabel(parent: Node, text: string, x: number, y: number, fontSize: number, color: Color, bold = false, lineHeight?: number) {
        const node = this.createNode('Label', parent, x, y, 200, 60);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = lineHeight || fontSize + 6;
        label.color = color;
        label.horizontalAlign = 1;
        label.verticalAlign = 1;
        label.isBold = bold;
        return label;
    }

    /** 飘字特效：文字从指定位置向上飘升并淡出（position 为 rootNode 本地坐标） */
    private showFloatText(text: string, localX: number, localY: number, color: Color, fontSize: number = 28) {
        if (!this.rootNode) return;
        const parent = this.rootNode;

        const labelNode = new Node('FloatText');
        labelNode.layer = Layers.Enum.UI_2D;
        labelNode.setPosition(localX, localY, 0);
        const uiTransform = labelNode.addComponent(UITransform);
        uiTransform.setContentSize(260, 50);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.color = color;
        label.horizontalAlign = 1;
        label.verticalAlign = 1;
        label.isBold = true;
        label.enableOutline = true;
        label.outlineColor = new Color(0, 0, 0, 120);
        label.outlineWidth = 3;
        parent.addChild(labelNode);

        // 弹入动画：从 0.5 放大到 1.0
        labelNode.setScale(0.5, 0.5, 1);
        tween(labelNode)
            .to(0.15, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            .to(0.1, { scale: new Vec3(1.0, 1.0, 1) })
            .to(0.8, { position: new Vec3(localX, localY + 80, 0) }, { easing: 'sineOut' })
            .delay(0.15)
            .call(() => {
                if (labelNode.isValid) labelNode.destroy();
            })
            .start();

        // 透明度渐隐
        tween(label)
            .delay(0.5)
            .to(0.35, { color: new Color(color.r, color.g, color.b, 0) })
            .start();
    }

    /** 根据连击次数获取飘字文案和颜色 */
    private getComboInfo(count: number): { text: string; color: Color; fontSize: number } {
        if (count >= 7) return { text: '完美！', color: new Color(255, 215, 0, 255), fontSize: 36 };
        if (count >= 5) return { text: `连击 x${count}！`, color: new Color(255, 140, 0, 255), fontSize: 34 };
        if (count >= 3) return { text: `连击 x${count}！`, color: new Color(255, 100, 180, 255), fontSize: 32 };
        if (count >= 2) return { text: '不错！', color: new Color(100, 220, 255, 255), fontSize: 28 };
        return { text: '', color: Color.WHITE, fontSize: 28 };
    }

    /** 重置连击（新关卡/连击超时调用） */
    private resetCombo() {
        this.lastCollectTime = 0;
        this.comboCount = 0;
    }

    private createIconButton(parent: Node, x: number, y: number, width: number, height: number, text: string, fontSize: number) {
        const node = this.createNode('IconButton', parent, x, y, width, height);
        const bg = this.createGraphicsNode('Bg', node, width, height, 0, 0);
        this.drawRoundedRect(bg.getComponent(Graphics)!, width, height, new Color(255, 255, 255, 255), 14);
        this.createLabel(node, text, 0, 0, fontSize, new Color(31, 35, 42, 255), true);
        return node;
    }

    public triggerVibration(type: 'light' | 'heavy' | 'success' = 'light') {
        if (!this.vibrationEnabled) return;
        const platformApi = (globalThis as any).wx || (globalThis as any).tt;
        if (platformApi && typeof platformApi.vibrateShort === 'function') {
            try {
                if (type === 'success') {
                    platformApi.vibrateShort({});
                    setTimeout(() => platformApi.vibrateShort({}), 70);
                } else if (type === 'heavy') {
                    platformApi.vibrateShort({ type: 'heavy' });
                } else {
                    platformApi.vibrateShort({});
                }
                return;
            } catch (_) {
            }
        }

        const nav = (globalThis as any).navigator;
        if (nav && typeof nav.vibrate === 'function') {
            if (type === 'success') {
                nav.vibrate([35, 40, 35]);
            } else if (type === 'heavy') {
                nav.vibrate(45);
            } else {
                nav.vibrate(20);
            }
        }
    }

    private createSettingsButton(parent: Node, x: number, y: number, width: number, height: number) {
        const node = this.createNode('SettingsButton', parent, x, y, width, height);
        const bg = this.createGraphicsNode('Bg', node, width, height, 0, 0);
        this.drawRoundedRect(bg.getComponent(Graphics)!, width, height, new Color(255, 255, 255, 255), 20, 2, new Color(214, 219, 226, 255));
        [-18, 0, 18].forEach((dotX) => {
            const dot = this.createGraphicsNode('Dot', node, 8, 8, dotX, 0);
            this.drawCircle(dot.getComponent(Graphics)!, 4, new Color(21, 25, 31, 255), 0);
        });
        const ring = this.createGraphicsNode('Ring', node, 18, 18, 28, 0);
        const ringGraphics = ring.getComponent(Graphics)!;
        ringGraphics.clear();
        ringGraphics.lineWidth = 4;
        ringGraphics.strokeColor = new Color(21, 25, 31, 255);
        ringGraphics.circle(0, 0, 7);
        ringGraphics.stroke();
        return node;
    }

    private createFruitVisual(parent: Node, x: number, y: number, diameter: number, color: FruitColor, addShadow: boolean = true): Node {
        const fruitNode = this.createNode(`Fruit_${color}`, parent, x, y, diameter, diameter);

        if (addShadow) {
            const shadow = this.createGraphicsNode('Shadow', fruitNode, diameter * 0.85, diameter * 0.3, 0, -diameter * 0.15);
            const sg = shadow.getComponent(Graphics)!;
            sg.fillColor = new Color(0, 0, 0, 40);
            sg.ellipse(0, 0, diameter * 0.42, diameter * 0.12);
            sg.fill();
        }

        // 尝试用水果图片替代绘制
        const spriteFrame = this.getFruitSprite(color);
        if (spriteFrame) {
            const imgNode = this.createNode('FruitImg', fruitNode, 0, 2, diameter * 1.1, diameter * 1.1);
            const sprite = imgNode.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.RAW;
            sprite.spriteFrame = spriteFrame;
            
            const origW = spriteFrame.width;
            const origH = spriteFrame.height;
            const maxSize = diameter * 1.35; // 之前是 1.1，调大到 1.35
            const scale = Math.min(maxSize / origW, maxSize / origH);
            imgNode.scale = new Vec3(scale, scale, 1);
        } else {
            // 回退：绘制彩色圆圈 + 茎
            const bodyColor = BOX_COLORS[color];
            const darkColor = FRUIT_FACE_COLORS[color];
            const r = (diameter - 2) / 2;

            const body = this.createGraphicsNode('Body', fruitNode, diameter, diameter, 0, 0);
            const bg = body.getComponent(Graphics)!;

            bg.fillColor = bodyColor;
            bg.circle(-1, 1, r);
            bg.fill();
            bg.lineWidth = 2;
            bg.strokeColor = darkColor;
            bg.circle(-1, 1, r);
            bg.stroke();
            bg.fillColor = new Color(255, 255, 255, 50);
            bg.circle(-r * 0.3, r * 0.3, r * 0.3);
            bg.fill();

            const stemG = this.createGraphicsNode('Stem', fruitNode, diameter * 0.35, diameter * 0.22, diameter * 0.08, diameter * 0.32);
            const sg2 = stemG.getComponent(Graphics)!;
            sg2.fillColor = new Color(90, 150, 65, 220);
            sg2.rect(-1.5, 0, 3, diameter * 0.18);
            sg2.fill();
            sg2.fillColor = new Color(115, 180, 80, 200);
            sg2.ellipse(diameter * 0.06, diameter * 0.06, diameter * 0.06, diameter * 0.04);
            sg2.fill();
        }

        return fruitNode;
    }

    public drawRoundedRect(graphics: Graphics, width: number, height: number, fill: Color, radius: number, lineWidth = 0, stroke?: Color) {
        graphics.clear();
        graphics.fillColor = fill;
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
        graphics.fill();
        if (lineWidth > 0 && stroke) {
            graphics.lineWidth = lineWidth;
            graphics.strokeColor = stroke;
            graphics.roundRect(-width / 2, -height / 2, width, height, radius);
            graphics.stroke();
        }
    }

    public drawCircle(graphics: Graphics, radius: number, fill: Color, lineWidth = 0, stroke?: Color) {
        graphics.clear();
        graphics.fillColor = fill;
        graphics.circle(0, 0, radius);
        graphics.fill();
        if (lineWidth > 0 && stroke) {
            graphics.lineWidth = lineWidth;
            graphics.strokeColor = stroke;
            graphics.circle(0, 0, radius);
            graphics.stroke();
        }
    }

    /** 绘制五角星 */
    private drawStar(graphics: Graphics, size: number, fill: Color) {
        graphics.clear();
        graphics.fillColor = fill;
        const spikes = 5;
        const outerRadius = size / 2;
        const innerRadius = size / 4;
        graphics.moveTo(0, -outerRadius);
        for (let i = 0; i < spikes * 2; i++) {
            const radius = i % 2 === 0 ? innerRadius : outerRadius;
            const angle = (i * Math.PI) / spikes - Math.PI / 2;
            graphics.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
        }
        graphics.close();
        graphics.fill();
    }

    /** 绘制小太阳（圆心 + 光芒） */
    private drawSun(graphics: Graphics, radius: number, color: Color) {
        graphics.clear();
        graphics.fillColor = color;
        graphics.strokeColor = color;
        // 中心圆
        graphics.circle(0, 0, radius);
        graphics.fill();
        // 8 条光芒
        graphics.lineWidth = 1.5;
        const rayInner = radius * 1.3;
        const rayOuter = radius * 1.9;
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            graphics.moveTo(Math.cos(angle) * rayInner, Math.sin(angle) * rayInner);
            graphics.lineTo(Math.cos(angle) * rayOuter, Math.sin(angle) * rayOuter);
            graphics.stroke();
        }
    }

    private drawPlateShape(graphics: Graphics, type: 'circle' | 'rect', width: number, height: number, fill: Color, radius: number, lineWidth: number, stroke?: Color) {
        graphics.clear();
        if (type === 'circle') {
            this.drawCircle(graphics, Math.min(width, height) / 2, fill, lineWidth, stroke);
            return;
        }
        this.drawRoundedRect(graphics, width, height, fill, radius, lineWidth, stroke);
    }

    private getBoxColor(color: BoxColor): Color {
        return BOX_COLORS[color] || new Color(200, 200, 200, 255);
    }

    /** FruitColor → 水果图片文件名映射 */
    private FRUIT_MAP: Record<string, string> = {
        'red': 'Red Apple',
        'blue': 'Сorn',       // 玉米
        'yellow': 'Lemon',
        'pink': 'Peach',
        'orange': 'Orange',
        'green': 'Pear',
        'purple': 'Eggplant',
        'cyan': 'Carrot',     // 胡萝卜
        'rainbow': 'Rainbow Fruit', // 彩虹果
    };

    /** FruitColor → 水果中文名映射 */
    private FRUIT_NAME_MAP: Record<string, string> = {
        'red': '苹果',
        'blue': '玉米',
        'yellow': '柠檬',
        'pink': '桃子',
        'orange': '橘子',
        'green': '鸭梨',
        'purple': '茄子',
        'cyan': '胡萝卜',
        'rainbow': '彩虹果',
    };

    private async loadFruitSprites(): Promise<void> {
        if (this.fruitsLoaded) return;
        return new Promise((resolve) => {
            // 普通水果从 resources 主包加载，彩虹果从分包加载
            const regularFruits = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot'];
            const totalCount = regularFruits.length + 1;
            let loaded = 0;

            const tryResolve = () => {
                if (loaded === totalCount) {
                    this.fruitsLoaded = true;
                    console.log(`[Fruit] loaded ${this.fruitSprites.size}/${totalCount} fruit sprites`);
                    resolve();
                }
            };

            regularFruits.forEach((name) => {
                resources.load(`fruits/${name}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
                    loaded++;
                    if (!err && spriteFrame) {
                        this.fruitSprites.set(name, spriteFrame);
                    } else {
                        console.warn(`[Fruit] failed to load ${name}:`, err);
                    }
                    tryResolve();
                });
            });

            // 彩虹果（222K 大图）已挪到分包，分包启动时已后台预载
            BundleManager.getInstance().loadAsset<SpriteFrame>('fruits/Rainbow Fruit/spriteFrame', SpriteFrame).then((spriteFrame) => {
                loaded++;
                if (spriteFrame) {
                    this.fruitSprites.set('Rainbow Fruit', spriteFrame);
                }
                tryResolve();
            }).catch((err) => {
                loaded++;
                console.warn('[Fruit] failed to load Rainbow Fruit:', err);
                tryResolve();
            });
        });
    }

    /** 加载灰度果篮底图和板子底图（用于运行时动态染色） */
    private async loadBasketBase(): Promise<void> {
        return new Promise((resolve) => {
            let loaded = 0;
            const checkDone = () => {
                loaded++;
                if (loaded === 2) resolve();
            };
            
            if (!this.basketSpriteFrame) {
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/basket/spriteFrame', SpriteFrame).then((spriteFrame) => {
                    if (spriteFrame) {
                        this.basketSpriteFrame = spriteFrame;
                    }
                    checkDone();
                }).catch(() => checkDone());
            } else {
                checkDone();
            }

            if (!this.plateSpriteFrame) {
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/plate/spriteFrame', SpriteFrame).then((spriteFrame) => {
                    if (spriteFrame) {
                        this.plateSpriteFrame = spriteFrame;
                    }
                    checkDone();
                }).catch(() => checkDone());
            } else {
                checkDone();
            }
        });
    }

    /** 预加载分享卡片图片（转换为本地可访问路径） */
    private preloadShareImages() {
        if (typeof wx === 'undefined') return;
        // 所有分享场景统一用摘呀摘呀摘这张图（从分包加载）
        BundleManager.getInstance().loadAsset<ImageAsset>('share/摘呀摘呀摘', ImageAsset).then((asset) => {
            const url = asset.nativeUrl;
            this.shareImageUrls['unlock'] = url;
            this.shareImageUrls['revive'] = url;
            this.shareImageUrls['win'] = url;
            this.shareImageUrls['clear'] = url;
        }).catch(() => {});

        // 开启右上角三个点的分享菜单
        wx.showShareMenu({
            withShareTicket: false,
            menus: ['shareAppMessage', 'shareTimeline']
        });
        // 右上角三个点分享时提供内容
        wx.onShareAppMessage(() => ({
            title: `摘呀摘呀摘！我已闯到第 ${this.currentLevel} 关，快来PK吧～`,
            imageUrl: this.shareImageUrls['unlock'] || ''
        }));

        // 监听小程序切后台 → 返回时触发分享奖励逻辑
        wx.onShow(() => {
            if (this.pendingShareCallback) {
                const cb = this.pendingShareCallback;
                this.pendingShareCallback = null;
                
                // 1. 前端拦截：分享停留时间校验 (小于 2 秒判定为假分享)
                const stayTime = Date.now() - this.shareStartTime;
                if (stayTime < 2000) {
                    wx.showToast({
                        title: '分享失败，请分享到不同的群聊试试～',
                        icon: 'none',
                        duration: 2000
                    });
                    return;
                }

                // 2. 后端拦截：请求消耗当日分享奖励次数
                wx.showLoading({ title: '获取奖励中...', mask: true });
                consumeShareCount().then(res => {
                    wx.hideLoading();
                    if (res.success) {
                        if (res.isLimit) {
                            this.setShareLimitReached();
                        }
                        cb(); // 成功消耗，执行奖励逻辑
                    } else {
                        if (res.isLimit) {
                            this.setShareLimitReached();
                        }
                        // 次数超限或网络异常
                        this.renderModal({
                            title: '提示',
                            sub: res.isLimit ? '今日求助次数已达上限' : '求助失败，请重试',
                            button: '知道了',
                            height: 200,
                            onConfirm: () => {}
                        });
                    }
                }).catch(() => {
                    wx.hideLoading();
                    wx.showToast({ title: '网络异常，请重试', icon: 'none' });
                });
            }
        });
    }

    /** 分享并发放奖励 */
    private doShareForReward(scene: 'unlock' | 'revive' | 'clear', callback: () => void) {
        const btnState = this.getHelpButtonState();
        if (btnState.disabled) {
            return;
        }

        const cfg: Record<string, { title: string; imgKey: string }> = {
            unlock: { title: `我已闯到第 ${this.currentLevel} 关！🍎 快来《摘呀摘呀摘》P K我吧～`, imgKey: 'unlock' },
            revive: { title: `救救我！卡在第 ${this.currentLevel} 关了 😭 谁来《摘呀摘呀摘》帮帮我？`, imgKey: 'revive' },
            clear: { title: `果盘满了装不下啦 😭 谁来《摘呀摘呀摘》帮我清空？`, imgKey: 'clear' },
        };
        const { title, imgKey } = cfg[scene] || cfg.unlock;
        const shareParams: any = { title };
        const imgUrl = this.shareImageUrls[imgKey];
        if (imgUrl) shareParams.imageUrl = imgUrl;

        if (typeof wx !== 'undefined' && wx.shareAppMessage) {
            this.pendingShareCallback = callback;
            this.shareStartTime = Date.now();
            wx.shareAppMessage(shareParams);
        } else {
            // 浏览器环境模拟
            setTimeout(async () => {
                const res = await consumeShareCount();
                if (res.success) {
                    callback();
                }
                if (res.isLimit) {
                    this.setShareLimitReached();
                }
            }, 1000);
        }
    }

    private getFruitSprite(color: FruitColor): SpriteFrame | null {
        const fruitName = this.FRUIT_MAP[color];
        if (!fruitName) return null;
        return this.fruitSprites.get(fruitName) || null;
    }

    /** 从排行榜返回游戏：只重建视图，继续当前局面（局面数据与小太阳都不动） */
    public goBackToGame() {
        this.rebuildGameView();
        this.renderAll();
    }

    /**
     * 从首页进入无限模式：重开一局全新局面（关卡号保持不变）。
     * 与 goBackToGame 的区别是要走 initGame 重新生成关卡，并先回滚本局已入账的小太阳。
     */
    public startGameFromHome() {
        this.discardCurrentLevelSuns();
        this.rebuildGameView();
        this.initGame();
    }

    /** 重建游戏视图骨架（不碰局面数据），goBackToGame 与 startGameFromHome 共用 */
    private rebuildGameView() {
        this.rankPage.close();
        if (this.rootNode) {
            this.rootNode.removeAllChildren();
        }
        this.gameOver = false;
        this.plateNodes.clear();
        this.fallingPlateNodes.clear();
        this.boxViews = [];
        this.tempSlotViews = [];
        this.toolViews = [];
        this.setupLayout();
    }

    /**
     * 放弃本局时回滚本局清果篮拿到的小太阳，堵住"攒太阳→重开局面→太阳留着"的无限刷。
     * 只扣本局那笔增量（不是还原快照），这样中途回首页领的签到/免费太阳不会被一起抹掉；
     * 局中已花掉的太阳不退——道具效果只在本局生效，不退是无法反向套利的保守选择。
     */
    private discardCurrentLevelSuns() {
        if (this.sunsCollectedThisLevel <= 0) return;
        this.totalSuns = Math.max(0, this.totalSuns - this.sunsCollectedThisLevel);
        this.sunsCollectedThisLevel = 0;
        localStorage.setItem('totalSuns', this.totalSuns.toString());
        if (this.sunCountLabel && this.sunCountLabel.isValid) {
            this.sunCountLabel.string = `${this.totalSuns}`;
        }
    }

    /** 确保游戏界面存在：从首页打开设置弹窗点重开时，需先重建游戏布局再 initGame */
    private ensureGameUI() {
        if (this.boardAreaNode && this.boardAreaNode.isValid) return;
        this.homePage.close();
        this.rankPage.close();
        if (this.rootNode) {
            this.rootNode.removeAllChildren();
        }
        this.plateNodes.clear();
        this.fallingPlateNodes.clear();
        this.boxViews = [];
        this.tempSlotViews = [];
        this.toolViews = [];
        this.setupLayout();
    }

    /** 整页（排行榜/首页）切换前：隐藏并置空游戏主界面引用，返回游戏时由 goBackToGame 重建 */
    public teardownGameView() {
        if (this.topAreaNode) this.topAreaNode.active = false;
        if (this.boardAreaNode) this.boardAreaNode.active = false;
        if (this.bottomAreaNode) this.bottomAreaNode.active = false;

        this.boardAreaNode = this.topAreaNode = this.bottomAreaNode = null;
        this.boxesContainerNode = null;
        this.tempContainerNode = null;
        this.toolContainerNode = null;
        this.plateNodes.clear();
        this.fallingPlateNodes.clear();
        this.boxViews = [];
        this.tempSlotViews = [];
        this.toolViews = [];
        // 太阳/设置排行榜按钮随主界面销毁，置空以便返回游戏时重建
        this.sunCountLabel = null;
        this.sunIconNode = null;
    }

    /** 新手引导：首次进入无限模式时触发，仅一次（新人礼/每日登录奖励已移到首页弹出） */
    public showWelcomeFlowIfNeeded() {
        if (this.welcomeFlowShown) return;
        this.welcomeFlowShown = true;
        this.scheduleOnce(() => {
            // 同样要防延迟期间退回首页，标志跟着回滚才不会把引导永久弄丢
            if (!this.isGameViewAlive()) {
                this.welcomeFlowShown = false;
                return;
            }
            this.showTutorialIfNeeded();
        }, 0.35);
    }
}
