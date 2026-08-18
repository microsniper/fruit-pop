import { _decorator, Component, Node, Vec2, Vec3, Size, UITransform, Label, Color, tween, Graphics, director, Canvas, Widget, Mask, screen, view, Layers, Sprite, SpriteFrame, resources, ImageAsset, LabelOutline, UIOpacity, RigidBody2D, BoxCollider2D, CircleCollider2D, ERigidBody2DType, PhysicsSystem2D, assetManager, Texture2D } from 'cc';
import { consumeShareCount, reportEvent, fetchGameConfig, GameConfig, getDailyHelpStatus, getGameConfig, hasUserProfile, updateProfile, useDailyHelp, fetchResources, fetchCollectByIds, fetchCollectByCodes, fetchStarterGift, ResourceCodeTypeEnum, getDailyStatus, DailyHelpResponse, RewardItem, ItemTypeEnum, CollectItem } from './api';
import { CollectStore } from './CollectStore';
import { SoundManager } from './SoundManager';
import { AdManager } from './AdManager';
import { BundleManager } from './BundleManager';
import { LoadingPage, LoadingTarget } from './LoadingPage';
import { ModeDriver, ToolType, ToolButtonSpec, LayerRules, DEFAULT_LAYER_RULES } from './ModeDriver';
import { EndlessDriver } from './EndlessDriver';
import { DailyDriver } from './DailyDriver';
import { HomePage } from './HomePage';
import { RankPage } from './RankPage';
import { StoragePage } from './StoragePage';
import { ShopPage } from './ShopPage';
import { PropStore } from './PropStore';

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
    CRIMSON = 'crimson',   // 石榴
    BROWN = 'brown',       // 土豆
    GRAPE = 'grape',       // 葡萄
    BANANA = 'banana',     // 香蕉
    MELON = 'melon',       // 西瓜
    CHERRY = 'cherry',     // 樱桃
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
    /** 上一帧的下落速度，用来判断"本帧速度是否比上一帧小"——自由下落靠重力驱动只会逐帧递增，
     * 真实落地碰撞会在一帧内把速度打下来，用这个特征区分"真落地"和"还在下落"，不受板间距大小影响 */
    prevFallSpeed?: number;
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
    /** 该果篮已刷新次数（每日挑战第二关按此递增孔数 3→4→5→6） */
    refreshCount?: number;
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
    /** 锁定态视频图标（摄像机样式，Graphics 绘制） */
    playIcon: Node;
    slots: BoxSlotView[];
    lastBodyColor: string;
    /** 上一帧的 isSlidingOut，用于检测「刚变为满」的跳变沿，只在跳变时触发一次飞出动画 */
    lastSlidingOut: boolean;
}

interface TempSlotView {
    node: Node;
    hole: Graphics;
    fruitHost: Node;
    /** 锁定图标（右侧孔位默认带锁，加果盘解锁后隐藏） */
    lock?: Node;
}

interface ToolView {
    key: 'addTray' | 'clear';
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
    FruitColor.CYAN,
    FruitColor.CRIMSON,
    FruitColor.BROWN,
    FruitColor.GRAPE,
    FruitColor.BANANA,
    FruitColor.MELON,
    FruitColor.CHERRY
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
/** 长条形大板：宽扁横条（高仅容一个水果），横向一排 5 孔；只经 stripFirst 保底出现，不进随机模板池 */
const STRIP_PLATE_TEMPLATE: PlateTemplate = {
    type: 'rect', w: 240, h: 56, texture: 'plate_bar', baked: true,
    holes: [{ x: 0.167, y: 0.5 }, { x: 0.333, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.667, y: 0.5 }, { x: 0.833, y: 0.5 }]
};

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
    [FruitColor.CRIMSON]: new Color(200, 60, 55),  // 石榴深红
    [FruitColor.BROWN]: new Color(180, 130, 85),   // 土豆棕褐
    [FruitColor.GRAPE]: new Color(120, 85, 170),   // 葡萄紫蓝
    [FruitColor.BANANA]: new Color(235, 185, 40),  // 香蕉金黄
    [FruitColor.MELON]: new Color(85, 155, 75),    // 西瓜绿
    [FruitColor.CHERRY]: new Color(195, 45, 55),   // 樱桃深红
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
    crimson: new Color(170, 50, 45, 255), // 石榴暗色
    brown: new Color(150, 105, 65, 255),  // 土豆暗色
    grape: new Color(95, 65, 140, 255),   // 葡萄暗色
    banana: new Color(200, 150, 25, 255), // 香蕉暗色
    melon: new Color(60, 120, 55, 255),   // 西瓜暗色
    cherry: new Color(160, 30, 40, 255),  // 樱桃暗色
    rainbow: new Color(180, 180, 180)     // 彩虹果暗色
};

const PAGE_CONTENT_SCALE = 0.9;
const TOP_CONTENT_OFFSET = 24;
/** 猫咪进度图标（游戏区右上角）边长 */
const CAT_ICON_SIZE = 90;
/** 未启用层（垫在最底下作预告的下一层）的统一灰，与底图叠乘后只剩形状 */
const PLATE_BURIED_COLOR = new Color(120, 126, 132, 230);
/** 覆盖率采样网格边长：单块板子最多 9x9 个采样点 */
const PLATE_COVER_SAMPLE_GRID = 9;
/** 彩板透明度（预烘图与普通彩板共用，含翻彩动画终点）；灰板不走这里，保持 PLATE_BURIED_COLOR 自己的 alpha */
const PLATE_ALPHA = 200;
/** 层被启用时，这一层板子灰→彩的过渡时长 */
const PLATE_REVEAL_DURATION = 0.35;
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
const PACK_SCAN_STEP = 4;
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
    /** 本局已解锁的果盘数（0~1）：暂存区共 5 孔，右侧 1 孔默认带锁，用「加果盘」解开 */
    private traysUnlockedThisLevel = 0;
    /** 当前可用暂存容量：4 个常开孔 + 已解锁孔 */
    private getTempCapacity(): number {
        return 4 + this.traysUnlockedThisLevel;
    }
    /** 飞行中的水果颜色：让选色统计池在飞行窗口期也能看见未落地水果，避免清篮换色刷出无关颜色导致死局 */
    private flyingFruitColors: FruitColor[] = [];
    private totalFruits = 0;
    private removedFruits = 0;
    public totalCoins = 0;
    /** 金币不足提示横幅节点：用于幂等控制，显示期间忽略重复触发 */
    private coinShortageTipNode: Node | null = null;
    /** 暂存区满 4 时指向解锁果篮的引导小手节点 */
    private tempFullGuideNode: Node | null = null;
    /** 引导“已武装”：每关开始武装一次，弹出后解除，本关内不再重复弹（initGame 重置） */
    private tempGuideArmed = true;
    /** 砸板子呼吸动效进行中、等待掉落的板子 id：防止呼吸窗口内重复选板（initGame 重置） */
    private smashingPlateId: string | null = null;
    // 道具每关已用次数与上限由 this.driver 维护（见 ModeDriver）：
    // 每日挑战 = 加果篮2/砸板子1/清空果盘1；无限模式 = 全部不限次。
    /** 模式驱动：玩法之外的进度读写/结算差异（当前仅无限模式 EndlessDriver；每日挑战经 LoadingPage.target='daily' 接入时切换 DailyDriver） */
    private driver: ModeDriver = new EndlessDriver();
    private gameOver = false;
    private gameConfig: GameConfig | null = null;
    private loadingNode: Node | null = null;
        /** 切关加载遮罩（Loading 页同款进度条版）：进度与 initGameStaged 真实进度绑定 */
        private levelLoadNode: Node | null = null;
        private levelLoadFill: Node | null = null;
        private levelLoadApple: Node | null = null;
        private levelLoadBarWidth = 0;

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
    /** 首页金币余额展示引用（游戏内不再展示金币 HUD，仅首页使用） */
    public coinCountLabel: Label | null = null;
    public coinIconNode: Node | null = null;
    /** 游戏内设置按钮节点：置空触发 ensureTempSlotViews 重建 */
    private settingsBtnNode: Node | null = null;
    /** 猫咪进度图标（游戏区右上角，暂存区下方）：灰色底图 + 彩色遮罩（按本关摘果进度从下往上露出）+ 百分比文字 */
    private catIconNode: Node | null = null;
    private catColorMaskNode: Node | null = null;
    private catPercentLabel: Label | null = null;
    private toolContainerNode: Node | null = null;
    /** loadRemoteImage 按 URL 缓存 SpriteFrame：同一张远程图（商城/仓库来回切 tab、奖励弹窗重复出现）不重复下载。
     *  LRU 上限：超限淘汰最久未用的并释放 Texture2D/ImageAsset，避免水果图标/商城/签到等远程图
     *  跨场景只增不减常驻内存，低端机告内存不足 */
    private static readonly REMOTE_IMAGE_CACHE_MAX = 40;
    private remoteImageCache = new Map<string, { frame: SpriteFrame; asset: ImageAsset | null }>();
    /** 收集品按 code 增量缓存：奖励弹窗按 collectCode 反查名称/id 用，按需查询填充，不整表拉取 */
    private collectCodeCache: Map<string, CollectItem> = new Map();
    public modalLayerNode: Node | null = null;
    /** 首页与排行榜页：逻辑已拆到独立文件，通过 gm 引用协作 */
    public readonly homePage = new HomePage(this);
    public readonly rankPage = new RankPage(this);
    public readonly storagePage = new StoragePage(this);
    public readonly shopPage = new ShopPage(this);

    // ===== 微信授权头像通用叠层（排行榜/签到等入口共用） =====
    /** 按 key 管理的微信原生授权按钮实例，支持多个入口共存 */
    private authBtnMap: Record<string, any> = {};

    /**
     * 在目标节点上叠加微信原生授权按钮（createUserInfoButton）。
     * 点击触发微信「隐私弹窗→授权弹窗」，授权成功后自动保存头像昵称到后端，再执行 onAuthed 回调。
     * 已授权（hasUserProfile）则不创建。弹窗打开期间需 setAuthOverlayVisible 隐藏防误拦截。
     * 坐标换算：节点世界包围盒 → view 缩放/视口偏移 → 屏幕逻辑像素，全设备通用。
     */
    public setupAuthOverlay(key: string, targetNode: Node, onAuthed: () => void): void {
        if (typeof wx === 'undefined' || typeof wx.createUserInfoButton !== 'function') return;
        if (hasUserProfile()) return;
        this.destroyAuthOverlay(key);

        // 延迟一帧：等待节点世界变换更新后再取包围盒，否则可能拿到零值
        this.scheduleOnce(() => {
            if (!targetNode || !targetNode.isValid) return;
            const uiTf = targetNode.getComponent(UITransform);
            if (!uiTf) return;

            const box = uiTf.getBoundingBoxToWorld();
            const vpRect = view.getViewportRect();
            const sx = view.getScaleX();
            const sy = view.getScaleY();
            const dpr = screen.devicePixelRatio || 1;
            const sysInfo = wx.getSystemInfoSync();

            const pad = 4; // 略微扩大点击热区
            const left = (box.xMin * sx + vpRect.x) / dpr - pad;
            const top = sysInfo.windowHeight - (box.yMax * sy + vpRect.y) / dpr - pad;
            const btnW = (box.width * sx) / dpr + pad * 2;
            const btnH = (box.height * sy) / dpr + pad * 2;
            console.log(`[Auth] ${key}AuthBtn rect:`, JSON.stringify({ left, top, width: btnW, height: btnH }));

            try {
                const button = wx.createUserInfoButton({
                    type: 'text',
                    text: '',
                    style: { left, top, width: btnW, height: btnH, backgroundColor: 'transparent', color: 'transparent', textAlign: 'center', fontSize: 0 }
                });
                button.onTap((res: any) => {
                    if (res && res.userInfo && res.userInfo.nickName && res.userInfo.nickName !== '微信用户') {
                        // 授权成功：销毁原生按钮，保存头像昵称，再执行业务回调
                        this.destroyAuthOverlay(key);
                        this.saveProfileAndContinue(res.userInfo, onAuthed);
                    } else {
                        // 取消：按钮保留供下次点击
                        console.log(`[Auth] ${key} cancelled or anonymous:`, res && res.errMsg);
                        if (typeof wx.showToast === 'function') {
                            wx.showToast({ title: '授权后才能继续', icon: 'none' });
                        }
                    }
                });
                this.authBtnMap[key] = button;
            } catch (e) {
                console.warn(`[Auth] ${key} createUserInfoButton failed:`, e);
            }
        }, 0);
    }

    /** 销毁指定 key 的授权按钮（离开页面或授权成功时调用） */
    public destroyAuthOverlay(key: string): void {
        const btn = this.authBtnMap[key];
        if (btn) {
            try { btn.destroy(); } catch { }
            delete this.authBtnMap[key];
        }
    }

    /** 显示/隐藏授权按钮（弹窗打开期间隐藏，防止透明按钮误拦截点击） */
    public setAuthOverlayVisible(key: string, visible: boolean): void {
        const btn = this.authBtnMap[key];
        if (!btn) return;
        try {
            if (visible) btn.show(); else btn.hide();
        } catch { }
    }

    /** 授权成功后保存头像昵称到后端，再执行业务回调 */
    private async saveProfileAndContinue(userInfo: any, onAuthed: () => void): Promise<void> {
        const nickname = ((userInfo.nickName || '') as string).trim() || '微信玩家';
        const avatarUrl = ((userInfo.avatarUrl || '') as string).trim();
        const result = await updateProfile(nickname, avatarUrl);
        if (!result.success) {
            console.warn('保存微信头像昵称失败:', result.message);
            if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
                wx.showToast({ title: result.message || '保存失败，请重试', icon: 'none' });
            }
        }
        onAuthed();
    }

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

    /**
     * 获取求助按钮状态：是否可用，以及CD倒计时。
     * 【死代码，未接线】全项目搜索确认无调用方，只服务于已废弃的 doShareForReward 链路。
     * 真正在用的求助次数判断在 tryDailyHelp（数据库 game_config.help_max 驱动），不是本方法。
     */
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

    /** 【死代码，未接线】只服务于已废弃的 doShareForReward 链路，见该方法上的说明。 */
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

    /** 【死代码，未接线】只服务于已废弃的 doShareForReward 链路，见该方法上的说明。 */
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
    /** 特殊果按钮角标（彩虹果+炸弹果总数），随签到领取/使用刷新 */
    private specialFruitBadge: Graphics | null = null;
    private specialFruitBadgeLabel: Label | null = null;
    /** 特殊果按钮节点：使用特殊果时飞行动画的起点 */
    private specialFruitBtnNode: Node | null = null;

    public screenWidth = 0;
    public screenHeight = 0;
    private topHeight = 0;
    private boardHeight = 0;
    private bottomHeight = 0;
        private boardWidth = 0;
    /** 这一关一共几批，开局就定好 */
    private maxWave = 0;
    /** 剩余果子跌到这个数以下就启用下一层（= 首批总果量 × layerRules.refillRatio） */
    private refillThreshold = 0;
    /** 当前关的层流规则（generateLevel 时从 driver 取，含层数/开局层数/补层与翻彩阈值/板数上限） */
    private layerRules: LayerRules = DEFAULT_LAYER_RULES;
    /** 已经建过节点的最深批次，再深的批次等玩家挖到了才加载 */
    private loadedWave = 0;
    /** 每日挑战批次信息（generateLevel 写入）：逐层颜色数与层→批归属，供刷色池跨批扩池 */
    private dailyLayerColors: number[] | null = null;
    private dailyLayerBatchIndex: number[] | null = null;
    /**
     * 本局打乱顺序后的颜色池：generateLevel 开局洗一次牌，整局内所有「取前 N 种颜色」的地方
     * 都从这份洗好的数组切片，而不是固定顺序的 COLORS。这样批次间「颜色集合递增包含」的约束
     * 依然满足（都是同一份打乱结果的前缀），但具体是哪几种颜色，每局都会不同——
     * 排在 COLORS 数组末尾的西瓜/樱桃等色，只要没配到很高的颜色数就永远不会出现，
     * 洗牌后才有机会被排到前面，在低难度批次也能出现。
     */
    private shuffledColors: FruitColor[] = COLORS;

    async start() {
        this.setupLayout();

        // 注意：不要注册 wx.onNeedPrivacyAuthorization 自动同意，
        // 否则微信官方隐私弹窗不会出现，且违反微信隐私规范。
        // 由 wx.requirePrivacyAuthorize 触发微信官方的隐私弹窗。

        // 恢复金币余额（永久结余，不清零）
        const storedCoins = localStorage.getItem('totalCoins');
        if (storedCoins) {
            this.totalCoins = parseInt(storedCoins, 10) || 0;
        }

        const storedSound = localStorage.getItem('soundEnabled');
        this.soundEnabled = storedSound !== 'false';
        const storedVibration = localStorage.getItem('vibrationEnabled');
        this.vibrationEnabled = storedVibration !== 'false';

        this.initSound();
        this.initAd();
        // 经由 Loading 场景进入时：资源/登录已在加载页完成，跳过旧转圈的“2 秒等待”逻辑；
        // 但建板子/水果节点、加物理刚体、配碰撞矩阵仍是真实的同步 CPU 计算，与资源/网络加载无关，
        // Loading 页进度条覆盖不到这段——所以这里展示切关同款的“续接进度条”遮罩盖住这段构建过程，
        // 并把构建过程分帧执行、汇报真实进度，而不是用转圈动画硬等一段不透明的黑箱时间
        LoadingPage.consumeLaunched();
        const warmup = LoadingPage.consumeWarmup();
        this.showLevelLoading();
        // 让出一帧把遮罩渲染上屏：下面几步在 warmup 数据已预热时几乎瞬间 resolve，
        // 不这样显式让一帧的话，遮罩节点建出来了但可能来不及画上屏就被后面的同步计算冻住
        await new Promise<void>((resolve) => this.scheduleOnce(resolve, 0.05));
        this.setLevelLoadProgress(0.05);
        // 按 Loading 目标实例化模式驱动：每日挑战走 DailyDriver，其余默认无限模式 EndlessDriver
        if (LoadingPage.target === 'daily') {
            this.driver = new DailyDriver();
        }
        this.currentLevel = await this.driver.getStartLevel(warmup ? warmup.login : undefined);
        this.gameConfig = warmup ? await warmup.config : await fetchGameConfig();
        await this.fetchDailyHelpStatus(warmup ? warmup.help : undefined);
        this.setLevelLoadProgress(0.1);

        BundleManager.getInstance().preload();  // 后台预加载分包
        await this.loadFruitSprites();  // 确保水果图片加载完成后再初始化游戏
        await this.loadBasketBase(warmup ? warmup.basket : undefined);  // 加载灰度果篮底图
        this.preloadShareImages();      // 预加载分享图片
        this.setLevelLoadProgress(0.15);
        // 物理延迟激活：场景切换中创建刚体可能导致 Box2D broadphase 状态异常，先跳过物理，分帧建完板子后统一初始化
        this._physicsReady = false;
        const enterTarget = LoadingPage.consumeTarget();
        this.initGameStagedFirstEnter(enterTarget);
    }

    /**
     * 首次进入（冷启动/首页选模式）的分帧初始化：建板子逐帧 → （非首页）物理逐帧 → 收尾。
     * 与切关用的 initGameStaged 同一套分帧手法，区别是首次进入还需要做物理初始化，
     * 且收尾要分流到「进对局」或「进首页」。
     */
    private initGameStagedFirstEnter(enterTarget: LoadingTarget) {
        this.initGamePrepare();
        this.setLevelLoadProgress(0.2);

        const finalize = () => {
            this.scheduleLevelEntryTips();
            this.setLevelLoadProgress(1);
            this.hideLevelLoading();
            if (enterTarget === 'endless' || enterTarget === 'daily') {
                // 新手欢迎/教程仅无限模式首次进入弹，每日挑战不弹
                if (enterTarget === 'endless') {
                    this.showWelcomeFlowIfNeeded();
                }
            } else {
                // 先进首页选择模式：render() 会清掉刚建好的板子节点，物理刚体不需要，直接标记就位
                this._physicsReady = true;
                this.homePage.render();
            }
        };

        if (!this.boardContentNode) {
            // 容器异常缺失时按原流程同步完成，不卡加载页
            this.renderAll();
            finalize();
            return;
        }

        this.boardContentNode.destroyAllChildren();
        this.plateNodes.clear();
        const visiblePlates = this.plates
            .filter((plate) => !plate.removed && (plate.wave ?? 0) <= this.loadedWave + 1)
            .sort((a, b) => a.layer - b.layer);
        visiblePlates.forEach((plate) => {
            plate.buried = this.isPlateBuried(plate);
        });

        const total = visiblePlates.length;
        const CHUNK = 4; // 每帧建 4 块，重活分摊到多帧，进度条保持流畅
        let index = 0;
        const needsPhysics = enterTarget === 'endless' || enterTarget === 'daily';
        // 建板子：0.2~0.6；物理初始化（仅进对局才需要）：0.6~0.95；跳过物理时建板子占到 0.2~0.95
        const buildEnd = needsPhysics ? 0.6 : 0.95;
        const buildStep = () => {
            if (!this.boardContentNode) {
                this.unschedule(buildStep);
                this.hideLevelLoading();
                return;
            }
            const end = Math.min(index + CHUNK, total);
            for (; index < end; index++) {
                try {
                    this.createPlateNode(this.boardContentNode, visiblePlates[index], true);
                } catch (e) {
                    console.error('[FirstEnter] createPlateNode failed:', visiblePlates[index].id, e);
                }
            }
            this.setLevelLoadProgress(0.2 + (buildEnd - 0.2) * (total === 0 ? 1 : index / total));
            if (index < total) return;

            this.unschedule(buildStep);
            try {
                this.ensureLayerBudget();
                this.renderTopUI();
                this.renderTools();
                this.renderModal(null);
            } catch (e) {
                console.error('[FirstEnter] renderTopUI/renderTools failed:', e);
            }

            if (!needsPhysics) {
                finalize();
                return;
            }
            this.initAllPlatePhysicsStaged(finalize);
        };
        this.schedule(buildStep, 0);
    }

    /**
     * 分帧版物理初始化：initAllPlatePhysics 同一套逻辑，按板子逐帧加刚体/碰撞体，
     * 避免板子数量多时一次性同步计算卡住主线程。进度条区间 0.6~0.95，完成后回调 onDone。
     */
    private initAllPlatePhysicsStaged(onDone: () => void) {
        this._physicsReady = true;
        const targets = this.plates.filter((plate) => !plate.removed);
        const total = targets.length;
        const CHUNK = 4;
        let index = 0;
        const step = () => {
            const end = Math.min(index + CHUNK, total);
            for (; index < end; index++) {
                try {
                    this.applyPlatePhysics(targets[index]);
                } catch (e) {
                    console.error('[FirstEnter] applyPlatePhysics failed:', targets[index].id, e);
                }
            }
            this.setLevelLoadProgress(0.6 + 0.35 * (total === 0 ? 1 : index / total));
            if (index < total) return;
            this.unschedule(step);
            onDone();
        };
        this.schedule(step, 0);
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

    /**
     * 每日奖励领取成功动画：多个金色金币粒子从宝箱中心沿贝塞尔弧线飞向顶部金币图标，
     * 逐个到达时计数从 startCoins 滚动增加到 startCoins+amount，金币图标同步 punch 缩放。
     * 全部到达后回调 onComplete（关闭弹窗）。
     */
    public playDailyRewardCoinFly(startWorldPos: Vec3, startCoins: number, amount: number, onComplete: () => void) {
        const layer = this.modalLayerNode;
        const coinWorldPos = this.getCoinWorldPos();
        const layerTransform = layer?.getComponent(UITransform);
        if (!layer || !coinWorldPos || !layerTransform) {
            // 顶部金币图标不可用时直接更新数字并结束
            if (this.coinCountLabel && this.coinCountLabel.isValid) {
                this.coinCountLabel.string = `${startCoins + amount}`;
            }
            onComplete();
            return;
        }

        const startLocal = layerTransform.convertToNodeSpaceAR(startWorldPos);
        const targetLocal = layerTransform.convertToNodeSpaceAR(coinWorldPos);

        const count = 10;
        const particleSize = 9;
        const goldColor = new Color(255, 220, 50, 255);
        let arrived = 0;

        for (let i = 0; i < count; i++) {
            const delay = i * 0.06;
            this.scheduleOnce(() => {
                if (!layer.isValid) return;
                // 金色金币粒子（圆点+发光外圈，与果篮收集动画同款）
                const particleNode = new Node(`RewardCoin_${i}`);
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
                        if (this.coinCountLabel && this.coinCountLabel.isValid) {
                            this.coinCountLabel.string = `${startCoins + Math.round(amount * arrived / count)}`;
                        }
                        // 金币图标 punch 缩放
                        if (this.coinIconNode && this.coinIconNode.isValid) {
                            this.coinIconNode.setScale(new Vec3(1, 1, 1));
                            tween(this.coinIconNode)
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
     * 图片放大预览：纯图不带文字/按钮，遮罩或图片本身点击即关闭。
     * 商城/仓库的收集品图标点开看大图用，imageUrl 空则不弹（调用方兜底判断）。
     */
    public renderImagePreview(imageUrl: string) {
        if (!this.modalLayerNode || !imageUrl) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 200), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        // 大图：正方形安全尺寸（屏宽的 78%），加载后按实际比例校正，避免拉伸变形
        const size = Math.min(this.screenWidth, this.screenHeight) * 0.78;
        const imgNode = this.createNode('PreviewImg', this.modalLayerNode, 0, 0, size, size);
        const imgTransform = imgNode.getComponent(UITransform)!;
        const sprite = imgNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.loadRemoteImage(imageUrl, sprite, () => {
            // 加载失败：关掉这个空壳弹窗，不留一张打不开的黑框
            if (this.modalLayerNode) this.modalLayerNode.destroyAllChildren();
        });
        imgNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        imgNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(imgNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 收集品详情弹窗：大图 + 名字 + 「应用于游戏」按钮。仓库页收集格子整块点击打开，
     * 点按钮把这个收集品设为当前展示（回调交给调用方处理，这里不关心 CollectStore）。
     */
    public renderCollectDetail(name: string, imageUrl: string, onApply: () => void) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 200), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        const panelW = Math.min(300, this.screenWidth * 0.82);
        const panelH = panelW * 1.25;
        const panelNode = this.createNode('CollectDetailPanel', this.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(250, 248, 240, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 大图：正方形，占面板上半部分
        const imgSize = panelW * 0.72;
        const imgY = panelH / 2 - imgSize / 2 - 24;
        const imgNode = this.createNode('DetailImg', panelNode, 0, imgY, imgSize, imgSize);
        const sprite = imgNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        if (imageUrl) {
            this.loadRemoteImage(imageUrl, sprite, () => {
                if (!imgNode.isValid) return;
                const ph = imgNode.addComponent(Graphics);
                ph.fillColor = new Color(220, 214, 198, 255);
                ph.circle(0, 0, imgSize / 2 - 4);
                ph.fill();
            });
        }

        // 名字：图下方
        this.createLabel(panelNode, name, 0, imgY - imgSize / 2 - 30, 22, new Color(96, 64, 32, 255), true);

        // 应用于游戏按钮
        const btnY = -panelH / 2 + 46;
        const btnNode = this.createNode('BtnApply', panelNode, 0, btnY, panelW * 0.64, 48);
        const btnBg = this.createGraphicsNode('BtnBg', btnNode, panelW * 0.64, 48, 0, 0);
        this.drawRoundedRect(btnBg.getComponent(Graphics)!, panelW * 0.64, 48, new Color(255, 150, 60, 255), 24);
        this.createLabel(btnNode, '应用于游戏', 0, 0, 18, new Color(255, 255, 255, 255), true);
        btnNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            SoundManager.getInstance()?.playSystemClick();
            onApply();
            if (this.modalLayerNode) this.modalLayerNode.destroyAllChildren();
        }, this);

        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 通用提示弹窗：panel_common_tip.png（标题“提示”与“知道了”按钮已画在图里）
     * 内容文案写在白色面板区域，点“知道了”关闭。新手/彩虹果/挑战关提示共用。
     */
    public renderCommonTip(title: string, content: string, onConfirm?: () => void) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

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
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
            if (onConfirm) onConfirm();
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 二次确认弹窗：panel_confirm_home.png（图内没有任何文字，标题/正文/两颗按钮文案全部 Label 叠加）。
     * 左绿钮=取消，右橙钮=确认。不可逆操作（丢弃本局进度/金币）才用它，单纯告知走 renderCommonTip。
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
        this.modalLayerNode.destroyAllChildren();

        // 遮罩：点空白处等同于取消，不做静默关闭
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode!.destroyAllChildren();
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
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
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
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
            onConfirm();
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 挑战失败弹窗：暂存区满时弹出。每日挑战走新弹窗（复活机制），无限模式用 panel_fail 旧弹窗 */
    private renderFailModal() {
        if (!this.modalLayerNode) return;
        this.removeTempFullGuide();
        this.modalLayerNode.destroyAllChildren();

        // 每日挑战：分离式新弹窗 + 一局一次复活
        if (this.driver.supportsRevive()) {
            this.renderDailyFailModal();
            return;
        }

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

            // 顶部金币数量：金币右侧留白条内，浅色底用深棕字，左对齐
            const coinsLabel = this.createLabel(panelNode, `${this.totalCoins}`, px(0.36), py(0.247), 24, new Color(110, 75, 45, 255), true);
            const coinsTransform = coinsLabel.node.getComponent(UITransform);
            if (coinsTransform) coinsTransform.setAnchorPoint(0, 0.5);
            coinsLabel.horizontalAlign = 0; // LEFT

            // “历史最好成绩”下方白色留白块：第 X 关（X 为当前关数）
            this.createLabel(panelNode, `第 ${this.currentLevel} 关`, 0, py(0.511), 26, new Color(50, 50, 50, 255), true);

            // 重新挑战（橙黄按钮热区）：挑战失败，重开当前关卡（金币不再清零）
            const btnRetry = this.createNode('BtnRetry', panelNode, 0, py(0.694), pw * 0.60, ph * 0.10);
            btnRetry.on(Node.EventType.TOUCH_END, () => {
                SoundManager.getInstance()?.playSystemClick();
                this.gameOver = false;
                this.modalLayerNode!.destroyAllChildren();
                // 进度条加载页 + 分帧初始化
                this.transitionToNewLevel();
            }, this);

            // 继续游戏（蓝按钮热区）：唤起广告，看完后清空暂存区
            const btnContinue = this.createNode('BtnContinue', panelNode, 0, py(0.853), pw * 0.60, ph * 0.10);
            btnContinue.on(Node.EventType.TOUCH_END, () => {
                SoundManager.getInstance()?.playSystemClick();
                this.showAdThen(() => {
                    this.gameOver = false;
                    this.tempHoles = [];
                    this.renderTopUI();
                    this.modalLayerNode!.destroyAllChildren();
                }, 'revive');
            }, this);
        }).catch(() => {});
    }

    /**
     * 每日挑战失败弹窗：panel_daily_fail 分离式布局（底图 640x684 → 320x342）。
     * 成绩条烘焙标签擦掉重画：标签左 + 今日最快时间右（/daily/status 异步回填，无成绩显示「暂无」）。
     * 按钮按复活状态：第一次失败「立即复活」（看视频，看完清空暂存区原地继续）；复活已用「返回主页」。
     */
    private renderDailyFailModal() {
        if (!this.modalLayerNode) return;

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        const panelW = 320, panelH = 342;
        const panelNode = this.createNode('DailyFailPanel', this.modalLayerNode, 0, 40, panelW, panelH);
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${this.driver.getFailPanelAsset()}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 新图不带关闭按钮，弹窗只能走复活/返回主页流程关闭

        // 成绩条：新图（2026-08-06 重出）已留好空白圆角卡片，实测中心(0,-59)，宽222高31；整体下移2px对齐观感
        const wipe = this.createGraphicsNode('BarWipe', panelNode, 222, 31, 0, -61);
        const wg = wipe.getComponent(Graphics)!;
        wg.fillColor = new Color(255, 255, 255, 255);
        wg.roundRect(-111, -15.5, 222, 31, 10);
        wg.fill();
        this.createLabel(panelNode, '今日最好成绩', -58, -62, 15, new Color(93, 64, 55, 255), true);
        const bestLabel = this.createLabel(panelNode, '--', 58, -62, 18, new Color(199, 39, 30, 255), true);
        getDailyStatus().then((res) => {
            if (!bestLabel || !bestLabel.isValid) return;
            bestLabel.string = res && res.bestSeconds != null ? this.formatDuration(res.bestSeconds) : '暂无';
        }).catch(() => {});

        // 竖排按钮：第一次失败→上「立即复活」（橙，看广告）+ 下「重新挑战」（浅蓝，本局重开）；
        // 复活已用→上「重新挑战」（浅蓝）+ 下「返回主页」（浅蓝）
        const canRevive = this.driver.canRevive();
        const goHome = () => {
            this.modalLayerNode?.destroyAllChildren();
            this.homePage.render();
        };
        // 重新挑战：本局重新开始（回第 1 关、复活机会重置、重新计时），走标准切关流程重铺板
        const restartRun = async () => {
            this.modalLayerNode?.destroyAllChildren();
            this.currentLevel = await this.driver.getStartLevel();
            this.transitionToNewLevel();
        };

        if (canRevive) {
            const reviveBtn = this.createSeparatedActionButton(
                panelNode, panelH, { text: '立即复活', pay: 'ad' }, false,
                { asset: 'btn_action', name: 'BtnRevive' }
            );
            reviveBtn.on(Node.EventType.TOUCH_END, () => {
                // 复活 = 看广告看到底 → 清空暂存区原地继续（广告中途退出不消耗复活机会）
                this.showAdThen(() => {
                    this.driver.useRevive();
                    this.gameOver = false;
                    this.tempHoles = [];
                    this.modalLayerNode!.destroyAllChildren();
                    this.renderTopUI();
                }, 'revive');
            }, this);

            const restartBtn = this.createSeparatedActionButton(
                panelNode, panelH, { text: '重新挑战', pay: 'free' }, false,
                { asset: 'btn_action_blue', yOffset: 71, name: 'BtnRestart' }
            );
            restartBtn.on(Node.EventType.TOUCH_END, restartRun, this);
        } else {
            const restartBtn = this.createSeparatedActionButton(
                panelNode, panelH, { text: '重新挑战', pay: 'free' }, false,
                { asset: 'btn_action_blue', name: 'BtnRestart' }
            );
            restartBtn.on(Node.EventType.TOUCH_END, restartRun, this);

            const homeBtn = this.createSeparatedActionButton(
                panelNode, panelH, { text: '返回主页', pay: 'free' }, false,
                { asset: 'btn_action_blue', yOffset: 71, name: 'BtnHome' }
            );
            homeBtn.on(Node.EventType.TOUCH_END, goHome, this);
        }
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

    /** 切关过渡：Loading 页同款进度条遮罩 + initGame 分帧并行，进度条走完即关卡就绪 */
    private transitionToNewLevel() {
        this.showLevelLoading();
        // 让出一帧把遮罩渲染上屏，再开始分帧初始化
        this.scheduleOnce(() => this.initGameStaged(), 0.05);
    }

    /** 切关分帧初始化：准备段同步 → 板子逐帧创建（进度条同步推进）→ 收尾渲染，全程加载页动画保持流畅 */
    private initGameStaged() {
        this.initGamePrepare();
        this.setLevelLoadProgress(0.3);

        if (!this.boardContentNode) {
            // 容器异常缺失时按原流程同步完成并收起，不卡加载页
            this.renderAll();
            this.scheduleLevelEntryTips();
            this.setLevelLoadProgress(1);
            this.hideLevelLoading();
            return;
        }

        // 与 renderBoard 同口径：清旧 → 可见板筛选排序 → 先整体算置灰（createPlateNode 直接读 plate.buried）
        this.boardContentNode.destroyAllChildren();
        this.plateNodes.clear();
        const visiblePlates = this.plates
            .filter((plate) => !plate.removed && (plate.wave ?? 0) <= this.loadedWave + 1)
            .sort((a, b) => a.layer - b.layer);
        visiblePlates.forEach((plate) => {
            plate.buried = this.isPlateBuried(plate);
        });

        const total = visiblePlates.length;
        const CHUNK = 4; // 每帧建 4 块，重活分摊到多帧，进度条保持流畅
        let index = 0;
        // 分帧驱动用 schedule(interval=0) 每帧执行，不用 scheduleOnce 递归——
        // 同 target 同 callback 在 trigger 内重注册会被调度器查重吞掉（旧 timer 随即 cancel），链断即卡死
        const step = () => {
            if (!this.boardContentNode) {
                // 分帧中途离开对局（如返回首页）：停调度并收遮罩
                this.unschedule(step);
                this.hideLevelLoading();
                return;
            }
            const end = Math.min(index + CHUNK, total);
            for (; index < end; index++) {
                try {
                    this.createPlateNode(this.boardContentNode, visiblePlates[index], true);
                } catch (e) {
                    // 单板异常跳过不中断：进度条与调度链保活，错误打到日志
                    console.error('[LevelLoad] createPlateNode failed:', visiblePlates[index].id, e);
                }
            }
            this.setLevelLoadProgress(0.3 + 0.6 * (total === 0 ? 1 : index / total));
            if (index < total) return; // 未完：schedule 每帧驱动，下一帧继续

            this.unschedule(step);
            // 收尾段：补层 + 果篮/暂存区/道具（对应 renderAll 中除 renderBoard 外的部分）
            try {
                this.ensureLayerBudget();
                this.renderTopUI();
                this.renderTools();
                this.renderModal(null);
                this.scheduleLevelEntryTips();
            } catch (e) {
                console.error('[LevelLoad] finalize failed:', e);
            }
            this.setLevelLoadProgress(1);
            this.hideLevelLoading();
        };
        this.schedule(step, 0);
    }

    /** 切关加载遮罩：Loading 页同款（背景图 + 加载中文案 + 白底胶囊进度条 + 苹果骑前端） */
    private showLevelLoading() {
        if (!this.rootNode) return;
        if (this.levelLoadNode && this.levelLoadNode.isValid) return;

        const node = this.createNode('LevelLoadOverlay', this.rootNode, 0, 0, this.screenWidth, this.screenHeight);
        node.setSiblingIndex(998);
        this.levelLoadNode = node;

        // 兜底纯色背景（与 Loading 页同色）
        const bgColor = this.createGraphicsNode('BgColor', node, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(bgColor.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(232, 237, 220, 255), 0);

        // 背景图 cover-fit（与 Loading 页同款，已缓存即时贴出）
        const bgClip = this.createNode('BgClip', node, 0, 0, this.screenWidth, this.screenHeight);
        bgClip.addComponent(Mask);
        const bgNode = this.createNode('Bg', bgClip, 0, 0, this.screenWidth, this.screenHeight);
        const bgSprite = bgNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('ui/home_welcome_bg/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && bgSprite && bgSprite.isValid) {
                bgSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scale = Math.max(this.screenWidth / rect.width, this.screenHeight / rect.height);
                    bgNode.getComponent(UITransform)!.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        });

        // 「加载中...」
        this.createLabel(node, '加载中...', 0, -56, 22, new Color(80, 60, 35, 255), true);

        // 进度条：白底胶囊 + 深棕描边（与 Loading 页同款）
        const barW = this.screenWidth * 0.78;
        const barH = 22;
        this.levelLoadBarWidth = barW;
        const barNode = this.createNode('ProgressBar', node, 0, -96, barW, barH);
        const barBg = this.createGraphicsNode('BarBg', barNode, barW, barH, 0, 0);
        this.drawRoundedRect(barBg.getComponent(Graphics)!, barW, barH, new Color(255, 255, 255, 255), barH / 2, 3, new Color(122, 84, 48, 255));
        const fillNode = this.createGraphicsNode('BarFill', barNode, 0, 0, 0, 0);
        this.levelLoadFill = fillNode;
        const appleNode = this.createNode('BarApple', barNode, -barW / 2, 16, 36, 36);
        this.levelLoadApple = appleNode;
        const appleSprite = appleNode.addComponent(Sprite);
        appleSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('fruits/Red Apple/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && appleSprite && appleSprite.isValid && this.levelLoadApple === appleNode) {
                appleSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.height > 0) {
                    appleNode.getComponent(UITransform)!.setContentSize(36 * (rect.width / rect.height), 36);
                }
            }
        });
    }

    /** 切关进度刷新：橙黄填充 + 上半高光（Loading 页 renderProgress 同款绘制），苹果骑在填充前端 */
    private setLevelLoadProgress(p: number) {
        if (!this.levelLoadNode || !this.levelLoadNode.isValid || !this.levelLoadFill) return;
        const innerW = this.levelLoadBarWidth - 8;
        const fillW = p <= 0 ? 0 : Math.max(14, innerW * Math.min(1, p));
        const g = this.levelLoadFill.getComponent(Graphics)!;
        g.clear();
        if (fillW > 0) {
            const h = 14;
            g.fillColor = new Color(250, 172, 40, 255);
            g.roundRect(-fillW / 2, -h / 2, fillW, h, h / 2);
            g.fill();
            g.fillColor = new Color(255, 206, 90, 255);
            g.roundRect(-fillW / 2 + 2, 0, Math.max(0, fillW - 4), h / 2 - 1, h / 4);
            g.fill();
        }
        this.levelLoadFill.setPosition(new Vec3(-innerW / 2 + fillW / 2, 0, 0));
        if (this.levelLoadApple && this.levelLoadApple.isValid) {
            this.levelLoadApple.setPosition(new Vec3(-innerW / 2 + fillW, 16, 0));
        }
    }

    /** 收起切关加载遮罩（缩小淡出，与 hideLoadingOverlay 同款） */
    private hideLevelLoading() {
        const node = this.levelLoadNode;
        if (!node || !node.isValid) return;
        this.levelLoadNode = null;
        this.levelLoadFill = null;
        this.levelLoadApple = null;
        tween(node)
            .to(0.25, { scale: new Vec3(0.9, 0.9, 1) })
            .call(() => {
                if (node.isValid) node.destroy();
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
        // 重建布局时设置按钮的旧节点已销毁，置空引用触发重建
        this.settingsBtnNode = null;

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
        this.buildCatProgressIcon();
    }

    /**
     * 猫咪进度图标：游戏区域右上角，暂存区正下方。灰色底图常驻，彩色版盖在上面用 Mask 做竖向裁切，
     * 裁切高度按本关摘果进度（removedFruits/totalFruits）从下往上增长，视觉上就是猫咪逐渐被点亮染色。
     * 图标下方配百分比文字。数值由 updateCatProgress 驱动，这里只建节点结构。
     */
    private buildCatProgressIcon() {
        if (!this.rootNode || !this.boardAreaNode) return;
        const iconSize = CAT_ICON_SIZE;
        // 挂在 rootNode（topArea/boardArea 的共同上级），跨在两块区域的分界线上（果篮下方），
        // 不受任一区域自身的 Mask 裁切；sibling index 紧跟 boardAreaNode 之后，
        // 渲染顺序压在两块背景之上，才能实现「浮于上中之间」而不被背景盖住
        // 暂存孔位（tempContainerNode 内 5 孔居中布局）最右侧边缘约在 x=70（slotRadius*2*(5-1)/2+slotRadius*1.1）；
        // 挪到暂存孔位右侧附近，留一点间隙
        const x = 145;
        const y = this.screenHeight / 2 - this.topHeight;

        const container = this.createNode('CatProgressIcon', this.rootNode, x, y, iconSize, iconSize);
        container.setSiblingIndex(this.boardAreaNode.getSiblingIndex() + 1);
        this.catIconNode = container;

        // 灰色底图：常驻显示，代表「未点亮」部分
        const grayNode = this.createNode('CatGray', container, 0, 0, iconSize, iconSize);
        const graySprite = grayNode.addComponent(Sprite);
        graySprite.sizeMode = Sprite.SizeMode.CUSTOM;

        // 彩色遮罩：Mask 节点锚点设为底边中心（0.5,0），固定在容器底部，
        // 之后只改高度（setContentSize）就能让裁切区域从底边往上长，不用每次都重算位置。
        // 内部彩色图整体大小不变，只是被 Mask 裁掉上半部分——效果是从下往上逐渐显现
        const maskNode = this.createNode('CatColorMask', container, 0, -iconSize / 2, iconSize, 0);
        maskNode.getComponent(UITransform)!.setAnchorPoint(0.5, 0);
        maskNode.addComponent(Mask);
        this.catColorMaskNode = maskNode;
        const colorNode = this.createNode('CatColor', maskNode, 0, 0, iconSize, iconSize);
        colorNode.getComponent(UITransform)!.setAnchorPoint(0.5, 0);
        const colorSprite = colorNode.addComponent(Sprite);
        colorSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        // 遮罩宽度先按满宽算好，彩色图不管走本地图（换算实际比例）还是远程图（固定方形）都不用额外改宽度
        maskNode.getComponent(UITransform)!.width = iconSize;

        // 图片本身不是正方形（Creator 自动 trim 掉透明边后实际内容是瘦高的猫咪轮廓），
        // 固定显示高度=iconSize，宽度按 sf.rect 实际比例换算，避免 CUSTOM 模式强行拉伸变形
        const loadLocalFallback = () => {
            BundleManager.getInstance().loadAsset<SpriteFrame>('gift/icon_cat_gray/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && graySprite && graySprite.isValid) {
                    graySprite.spriteFrame = sf;
                    const rect = sf.rect;
                    if (rect && rect.height > 0) {
                        grayNode.getComponent(UITransform)!.setContentSize(iconSize * (rect.width / rect.height), iconSize);
                    }
                }
            }).catch(() => {});
            BundleManager.getInstance().loadAsset<SpriteFrame>('gift/icon_cat_color/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && colorSprite && colorSprite.isValid) {
                    colorSprite.spriteFrame = sf;
                    const rect = sf.rect;
                    if (rect && rect.height > 0) {
                        const w = iconSize * (rect.width / rect.height);
                        colorNode.getComponent(UITransform)!.setContentSize(w, iconSize);
                        if (maskNode.isValid) {
                            maskNode.getComponent(UITransform)!.width = w;
                        }
                    }
                }
            }).catch(() => {});
        };

        // 收集品仓库接管：新用户补领默认玩偶后取当前展示项的远程图；本地无拥有记录/目录未配置/加载失败
        // 均退回本地写死的猫图（老用户、后端未配置 game_collect 灰彩图字段时不受影响）。
        // 按需查询（starter-gift / by-ids 各最多 1 条），不再整表拉 game_collect。
        CollectStore.ensureLoaded().then(() => {
            const targetId = CollectStore.getCurrentTargetId();
            if (targetId != null) {
                return fetchCollectByIds([targetId]).then((items) => items[0] || null);
            }
            // 本地还没有任何拥有记录：查一下 starter 配置，补领后就是新的当前展示项
            return fetchStarterGift().then((starter) => {
                CollectStore.grantIfEmpty(starter);
                return starter;
            });
        }).then((current) => {
            if (!current || !current.grayUrl || !current.colorUrl) {
                loadLocalFallback();
                return;
            }
            this.loadRemoteImage(current.grayUrl, graySprite, loadLocalFallback);
            this.loadRemoteImage(current.colorUrl, colorSprite, loadLocalFallback);
        }).catch(() => {
            loadLocalFallback();
        });

        this.catPercentLabel = this.createLabel(container, '进度0%', 0, -iconSize / 2 - 14, 14, new Color(80, 60, 35, 255), true);
        this.updateCatProgress();
    }

    /** 按本关摘果进度刷新猫咪彩色遮罩高度与百分比文字；总数未知（0）时视为 0%，不报错 */
    private updateCatProgress() {
        if (!this.catColorMaskNode || !this.catPercentLabel) return;
        const ratio = this.totalFruits > 0 ? Math.min(1, this.removedFruits / this.totalFruits) : 0;
        const maskTransform = this.catColorMaskNode.getComponent(UITransform);
        if (maskTransform) {
            // 宽度维持当前值（彩色图加载完成后已按实际比例设好），只更新高度
            maskTransform.setContentSize(maskTransform.width, CAT_ICON_SIZE * ratio);
        }
        this.catPercentLabel.string = `进度${Math.floor(ratio * 100)}%`;
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

        // 设置+排行榜按钮已移至暂存区左侧（ensureTempSlotViews），与金币对称

        this.progressLabel = null;
    }

    private initGame() {
        this.initGamePrepare();
        this.renderAll();
        this.scheduleLevelEntryTips();
    }

    /** initGame 准备段：状态重置 + 销毁旧节点 + 生成关卡数据（启动与切关分帧共用） */
    private initGamePrepare() {
        this.gameOver = false;
        // 碰撞矩阵按当前关卡 wave 重配（每关 wave 不同，重置配置标志）
        GameManager._collisionMatrixConfigured = false;
        this.plates = [];
        this.tempHoles = [];
        this.traysUnlockedThisLevel = 0; // 新一局果盘重新上锁（右侧 1 孔）
        this.tempGuideArmed = true;
        this.smashingPlateId = null;
        this.driver.resetPerLevel();
        this.removeTempFullGuide();
        this.flyingFruitColors = [];
        this.removedFruits = 0;
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
            this.boardContentNode.destroyAllChildren();
        }
        if (this.boardEffectNode) {
            this.boardEffectNode.destroyAllChildren();
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
    }

    /** 进关后的延迟提示：挑战关间隔关（原 initGame 尾部逻辑） */
    private scheduleLevelEntryTips() {
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
            this.levelBadgeLabel.string = this.driver.mode === 'daily' ? '每日挑战' : `第 ${this.currentLevel} 关`;
        }
        this.renderBoxes();
        this.renderTempSlots();
        this.updateCatProgress();
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
            boxNode.active = true;

            // 果篮满了变 isSlidingOut=true 那一刻（跳变沿）：从当前位置飞出屏幕右侧，飞行途中不用固定坐标覆盖它
            // 清空完成变回 isSlidingOut=false 那一刻：先挪到屏幕左侧外，再飞回目标位置——新果篮从左边飞入
            const flyOffset = this.screenWidth * 0.9;
            if (box.isSlidingOut) {
                if (!view.lastSlidingOut) {
                    boxNode.setPosition(new Vec3(x, 0, 0));
                    tween(boxNode).to(0.3, { position: new Vec3(x + flyOffset, 0, 0) }, { easing: 'quadIn' }).start();
                    SoundManager.getInstance()?.playBoxClear();
                    view.lastSlidingOut = true;
                }
            } else if (view.lastSlidingOut) {
                boxNode.setPosition(new Vec3(x - flyOffset, 0, 0));
                tween(boxNode).to(0.32, { position: new Vec3(x, 0, 0) }, { easing: 'backOut' }).start();
                view.lastSlidingOut = false;
            } else {
                boxNode.setPosition(new Vec3(x, 0, 0));
            }
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
            view.playIcon.active = isLocked;
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
            // 锁状态：index >= 4 + 已解锁数 的孔位显示锁
            if (slotView.lock) {
                slotView.lock.active = index >= 4 + this.traysUnlockedThisLevel;
            }
        });

        // 暂存区满 4 引导（每次 renderTopUI 都会跑，能盖住放果/自动填充/清篮等所有暂存变化）
        this.updateTempFullGuide();
    }

    /**
     * 暂存区数量变化后判定要不要弹引导小手：
     * 达 (当前容量-1)+ 且已武装且场上有锁定果篮才弹；每关只弹一次（弹完解除武装，initGame 重新武装）。
     */
    private updateTempFullGuide() {
        if (this.tempHoles.length < this.getTempCapacity() - 1) {
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

    /** 移除引导小手（解锁果篮/切关/gameOver/10秒到时都会调） */
    private removeTempFullGuide() {
        if (this.tempFullGuideNode && this.tempFullGuideNode.isValid) {
            this.tempFullGuideNode.destroy();
        }
        this.tempFullGuideNode = null;
    }

    renderTools() {
        if (!this.toolContainerNode) return;
        this.ensureToolViews();

        const toolList = [
            { key: 'addTray' as const, label: '加果盘', icon: '🍽️', count: PropStore.getToolCount('addTray') },
            { key: 'clear' as const, label: '清空果盘', icon: '🧹', count: PropStore.getToolCount('clear') }
        ];
        toolList.forEach((tool, index) => {
            const view = this.toolViews[index];
            view.iconLabel.string = '';
            view.iconLabel.node.active = false;
            // 右上角角标：免费道具数量>0 显示红圈白字，=0 隐藏
            if (tool.count > 0) {
                view.badge.node.active = true;
                view.badgeLabel.node.active = true;
                this.drawCircle(view.badge, 13, new Color(235, 60, 50, 255), 3, new Color(255, 255, 255, 255));
                view.badgeLabel.string = String(tool.count);
            } else {
                view.badge.node.active = false;
                view.badgeLabel.node.active = false;
            }
        });

        // 特殊果按钮角标：彩虹果+炸弹果总数，>0 显示红圈白字，=0 隐藏
        if (this.specialFruitBadge && this.specialFruitBadgeLabel) {
            const sfCount = PropStore.getFruitCount('rainbow') + PropStore.getFruitCount('bomb');
            if (sfCount > 0) {
                this.specialFruitBadge.node.active = true;
                this.specialFruitBadgeLabel.node.active = true;
                this.drawCircle(this.specialFruitBadge, 13, new Color(235, 60, 50, 255), 3, new Color(255, 255, 255, 255));
                this.specialFruitBadgeLabel.string = String(sfCount);
            } else {
                this.specialFruitBadge.node.active = false;
                this.specialFruitBadgeLabel.node.active = false;
            }
        }
    }

    private renderBoard() {
        if (!this.boardContentNode) return;
        this.boardContentNode.destroyAllChildren();
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

    /** 每日挑战求助后待执行的操作（用户分享后回到游戏时执行） */
    private pendingDailyAction: (() => void) | null = null;

    /** 求助好友校验：未超限则乐观+1并返回true，超限提示；接口异步同步服务端。已用次数存 driver */
    private tryDailyHelp(): boolean {
        if (!this.driver.canHelp()) {
            this.showCoinShortageTip('今日求助次数已用完');
            return false;
        }
        const before = this.driver.getHelpUsed();
        this.driver.useHelp();
        useDailyHelp(this.driver.getHelpMode()).then((res) => {
            if (res) {
                this.driver.setHelpUsed(res.used);
            } else {
                this.driver.setHelpUsed(before);
            }
        });
        // 弹出微信分享面板（求助好友）
        if (typeof wx !== 'undefined' && wx.shareAppMessage) {
            wx.shareAppMessage({
                title: '帮我摘水果吧！',
            });
        }
        return true;
    }

    /** 注册 wx.onShow：用户分享后回到游戏时执行待操作（非微信环境延迟1秒执行） */
    private scheduleDailyActionOnShow() {
        if (typeof wx === 'undefined' || typeof wx.onShow !== 'function') {
            this.scheduleOnce(() => {
                if (this.pendingDailyAction) {
                    const action = this.pendingDailyAction;
                    this.pendingDailyAction = null;
                    action();
                }
            }, 1);
            return;
        }
        const cb = () => {
            if (this.pendingDailyAction) {
                const action = this.pendingDailyAction;
                this.pendingDailyAction = null;
                wx.offShow?.(cb);
                action();
            }
        };
        wx.onShow(cb);
    }

    /** 进游戏时拉取本模式今日求助次数（无求助机制的模式无额度，直接跳过） */
    /** warmed 传入时直接复用 Loading 页已发起的同款请求结果，不重新打一次接口 */
    private async fetchDailyHelpStatus(warmed?: Promise<DailyHelpResponse | null> | null) {
        if (!this.driver.hasHelpMechanism()) return;
        const res = warmed !== undefined ? await warmed : await getDailyHelpStatus(this.driver.getHelpMode());
        if (res) this.driver.setHelpUsed(res.used);
    }

    /**
     * 特殊果弹窗：panel_special_fruit 底图 + 两个格子（彩虹果/炸弹果）。
     * 水果图从后端资源表下发（fetchResources，按 resourceCode 取）；xN 数量读 PropStore；
     * 数量为 0 置灰，点击横幅提示；数量 >0 点击关弹窗（飞行+生效逻辑下一步接）。
     */
    private renderSpecialFruitModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode?.destroyAllChildren();
        }, this);

        // 底图 640x608，按宽 320 缩放 → 320x304
        const panelW = 320, panelH = 304;
        const panelNode = this.createNode('SpecialFruitPanel', this.modalLayerNode, 0, 0, panelW, panelH);
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_special_fruit/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 关闭按钮：新图红 X 中心实测 (141, 132)
        const closeBtn = this.createNode('CloseBtn', panelNode, 141, 132, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        // 有限次的模式（每日挑战）：盖掉烘焙文案「点击水果即可使用哦」，换成本局规则提示（两行，整体上移防出界）
        // 这条规则说明是每日挑战特有的（本局只能用一个），无限模式没有这条限制，不跟着显示
        const sfLimit = this.driver.getSpecialFruitLimit();
        if (Number.isFinite(sfLimit)) {
            const wipe = this.createGraphicsNode('HintWipe', panelNode, 280, 58, 0, -122);
            const wg = wipe.getComponent(Graphics)!;
            wg.fillColor = new Color(251, 243, 219, 255);
            wg.roundRect(-140, -29, 280, 58, 10);
            wg.fill();
            this.createLabel(panelNode, '本局只能使用其中一个特殊果', 0, -110, 16, new Color(199, 39, 30, 255), true);
            this.createLabel(panelNode, '可通过签到和无限模式获得', 0, -133, 13, new Color(199, 39, 30, 255), true);
        }

        // 获取道具按钮：橙钮+右上角视频图标，点击先关弹窗，看完广告发彩虹果x1+炸弹果x1。
        // 两种模式都显示，不看库存也不看本局限次——无限模式下这是玩家补充特殊果库存的唯一入口。
        const getPropBtn = this.createSeparatedActionButton(
            panelNode, panelH, { text: '获取道具', pay: 'ad' }, false,
            { asset: 'btn_action', name: 'BtnGetProp' }
        );
        getPropBtn.on(Node.EventType.TOUCH_END, () => {
            this.modalLayerNode?.destroyAllChildren();
            this.showAdThen(() => {
                this.renderSpecialFruitChoiceModal();
            }, 'get_special_fruit');
        }, this);

        // 两个格子：左彩虹果 / 右炸弹果（中心与格子尺寸为底图像素实测）
        const slots = [
            { fruit: 'rainbow' as const, code: ResourceCodeTypeEnum.RAINBOW, x: -75, emptyTip: '可通过签到和无限模式获得' },
            { fruit: 'bomb' as const, code: ResourceCodeTypeEnum.BOMB, x: 68, emptyTip: '可通过签到和无限模式获得' }
        ];
        // 本局特殊果已用完（限次模式）：两格都置灰不可点
        const sfExhausted = Number.isFinite(sfLimit) && !this.driver.canUseSpecialFruit();
        const slotY = -10;
        fetchResources().then((resources) => {
            if (!panelNode.isValid) return;
            slots.forEach((slot) => {
                const count = PropStore.getFruitCount(slot.fruit);
                // 格子热区（覆盖整个凹槽，点击即使用/提示）
                const slotNode = this.createNode(`Slot_${slot.fruit}`, panelNode, slot.x, slotY, 115, 149);

                // 水果图：资源表下发的 OSS 图，加载失败画占位圆
                const imgNode = this.createNode('FruitImg', slotNode, 0, 8, 96, 96);
                const imgSprite = imgNode.addComponent(Sprite);
                imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
                const url = resources[slot.code]?.url || '';
                this.loadRemoteImage(url, imgSprite, () => {
                    if (!imgNode.isValid) return;
                    const ph = imgNode.addComponent(Graphics);
                    ph.fillColor = new Color(220, 214, 198, 255);
                    ph.circle(0, 0, 44);
                    ph.fill();
                });

                // xN 数量：格子右下角，白字深棕描边
                const countLabel = this.createLabel(slotNode, `x${count}`, 36, -56, 20, new Color(255, 255, 255, 255), true);
                const countOutline = countLabel.node.addComponent(LabelOutline);
                if (countOutline) {
                    countOutline.color = new Color(122, 74, 20, 255);
                    countOutline.width = 2;
                }

                // 使用说明：图标上方居中小字（原放图标下方被 xN 数量挡住），红色+透明度呼吸提醒（呼吸写法同 ShopPage 掉落提示）
                const usageTip = slot.fruit === 'rainbow' ? '可任意匹配果篮' : '可炸掉板子';
                const usageLabel = this.createLabel(slotNode, usageTip, 0, 64, 11, new Color(199, 39, 30, 255), true);
                const usageOpacity = usageLabel.node.addComponent(UIOpacity);
                tween(usageOpacity)
                    .to(0.9, { opacity: 100 }, { easing: 'sineInOut' })
                    .to(0.9, { opacity: 255 }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever()
                    .start();

                if (sfExhausted) {
                    // 本局已用过特殊果：两格都置灰，点击提示
                    imgSprite.grayscale = true;
                    slotNode.on(Node.EventType.TOUCH_END, () => {
                        this.showCoinShortageTip('本局已使用过特殊果');
                    }, this);
                } else if (count <= 0) {
                    // 没有库存：置灰，点击横幅提示
                    imgSprite.grayscale = true;
                    slotNode.on(Node.EventType.TOUCH_END, () => {
                        this.showCoinShortageTip(slot.emptyTip);
                    }, this);
                } else {
                    slotNode.on(Node.EventType.TOUCH_END, () => {
                        this.useSpecialFruit(slot.fruit);
                    }, this);
                }
            });
        });
    }

    /**
     * 广告后的二选一弹窗：彩虹果/炸弹果各一个格子，点哪个该果子 +1（另一个不发）。
     * 复用 renderSpecialFruitModal 的水果图加载逻辑，UI 走通用遮罩+圆角面板风格。
     */
    private renderSpecialFruitChoiceModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        const panelW = 280, panelH = 220;
        const panelNode = this.createNode('SpecialFruitChoicePanel', this.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(252, 250, 242, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        this.createLabel(panelNode, '恭喜！请选择获得一个特殊果', 0, panelH / 2 - 30, 17, new Color(122, 74, 20, 255), true);

        const choices = [
            { fruit: 'rainbow' as const, code: ResourceCodeTypeEnum.RAINBOW, x: -65, name: '彩虹果' },
            { fruit: 'bomb' as const, code: ResourceCodeTypeEnum.BOMB, x: 65, name: '炸弹果' }
        ];
        fetchResources().then((resources) => {
            if (!panelNode.isValid) return;
            choices.forEach((choice) => {
                const slotNode = this.createNode(`Choice_${choice.fruit}`, panelNode, choice.x, -10, 110, 130);
                const imgNode = this.createNode('FruitImg', slotNode, 0, 14, 88, 88);
                const imgSprite = imgNode.addComponent(Sprite);
                imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
                const url = resources[choice.code]?.url || '';
                this.loadRemoteImage(url, imgSprite, () => {
                    if (!imgNode.isValid) return;
                    const ph = imgNode.addComponent(Graphics);
                    ph.fillColor = new Color(220, 214, 198, 255);
                    ph.circle(0, 0, 40);
                    ph.fill();
                });
                this.createLabel(slotNode, choice.name, 0, -50, 15, new Color(122, 74, 20, 255), true);

                slotNode.on(Node.EventType.TOUCH_END, () => {
                    PropStore.addFruits(choice.fruit, 1);
                    this.modalLayerNode?.destroyAllChildren();
                    this.renderTools();
                    this.showCoinShortageTip(`恭喜获取${choice.name}x1`);
                }, this);
            });
        });
    }

    /** 远程图加载：OSS CDN 地址 -> SpriteFrame；失败走 fallback（与 SignInPage 同实现） */
    loadRemoteImage(url: string, sprite: Sprite, onFail: () => void) {
        const trimmed = (url || '').trim();
        if (!trimmed.startsWith('http')) {
            onFail();
            return;
        }
        // 同一张远程图命中缓存直接用，不重复发请求（商城/仓库来回切 tab、奖励弹窗重复出现的常见场景）；命中即移到 LRU 队尾
        const cached = this.remoteImageCache.get(trimmed);
        if (cached) {
            this.remoteImageCache.delete(trimmed);
            this.remoteImageCache.set(trimmed, cached);
            sprite.spriteFrame = cached.frame;
            return;
        }
        // 只在最后一段路径（去掉 query/hash、且在最后一个 / 之后）里找 . 才算真扩展名，
        // 避免把域名里的点（如 qlogo.cn）或查询参数误当成后缀
        const noQuery = trimmed.split('?')[0].split('#')[0];
        const lastSlashIdx = noQuery.lastIndexOf('/');
        const lastSegment = noQuery.substring(lastSlashIdx + 1);
        const dotIdx = lastSegment.lastIndexOf('.');
        const urlExt = dotIdx > 0 ? lastSegment.substring(dotIdx) : '';
        // 微信头像等 CDN 地址常常不带扩展名（如 thirdwx.qlogo.cn/mmopen/vi_32/xxx/132），
        // 猜错了 assetManager 会解码失败；带明确后缀时直接用，否则依次试 jpg/png/webp，全部失败才 onFail
        const extsToTry = urlExt ? [urlExt] : ['.jpg', '.png', '.webp'];
        const tryLoad = (i: number) => {
            if (i >= extsToTry.length) {
                if (sprite.isValid) onFail();
                return;
            }
            assetManager.loadRemote<ImageAsset>(trimmed, { ext: extsToTry[i] }, (err, imageAsset) => {
                if (!sprite.isValid) return;
                if (!err && imageAsset) {
                    const texture = new Texture2D();
                    texture.image = imageAsset;
                    const frame = new SpriteFrame();
                    frame.texture = texture;
                    this.remoteImageCache.set(trimmed, { frame, asset: imageAsset });
                    this.evictRemoteImageCache();
                    sprite.spriteFrame = frame;
                } else {
                    tryLoad(i + 1);
                }
            });
        };
        tryLoad(0);
    }

    /** LRU 淘汰：缓存超上限时从最久未用开始释放（销毁 Texture2D + SpriteFrame、归还 ImageAsset），
     *  被淘汰的 URL 下次用到会自动重新下载，只是首帧慢一点，不影响功能 */
    private evictRemoteImageCache() {
        while (this.remoteImageCache.size > GameManager.REMOTE_IMAGE_CACHE_MAX) {
            const oldestUrl = this.remoteImageCache.keys().next().value;
            if (oldestUrl == null) break;
            const entry = this.remoteImageCache.get(oldestUrl);
            this.remoteImageCache.delete(oldestUrl);
            if (!entry) continue;
            if (entry.frame.texture && entry.frame.texture.isValid) entry.frame.texture.destroy();
            if (entry.frame.isValid) entry.frame.destroy();
            if (entry.asset && entry.asset.isValid) assetManager.releaseAsset(entry.asset);
        }
    }

    /** 特殊果按钮的世界坐标（飞行动画起点） */
    private getSpecialFruitBtnWorldPos(): Vec3 {
        if (this.specialFruitBtnNode && this.specialFruitBtnNode.isValid) {
            return this.specialFruitBtnNode.getWorldPosition();
        }
        return new Vec3(0, -200, 0);
    }

    /** 炸弹爆炸特效（rootNode 本地坐标）：中心白黄闪光扩散淡出 + 八向放射火花 */
    private playBombExplosion(localX: number, localY: number) {
        if (!this.rootNode || !this.rootNode.isValid) return;

        // 中心闪光：白心橙边圆
        const flashNode = this.createGraphicsNode('BombFlash', this.rootNode, 80, 80, localX, localY);
        flashNode.layer = Layers.Enum.UI_2D;
        flashNode.setSiblingIndex(9999);
        const fg = flashNode.getComponent(Graphics)!;
        fg.fillColor = new Color(255, 240, 180, 255);
        fg.circle(0, 0, 30);
        fg.fill();
        fg.fillColor = new Color(255, 170, 60, 200);
        fg.circle(0, 0, 38);
        fg.fill();
        const flashOpacity = flashNode.addComponent(UIOpacity);
        flashNode.setScale(0.4, 0.4, 1);
        tween(flashNode).to(0.3, { scale: new Vec3(1.5, 1.5, 1) }).start();
        tween(flashOpacity)
            .delay(0.12)
            .to(0.2, { opacity: 0 })
            .call(() => {
                if (flashNode.isValid) flashNode.destroy();
            })
            .start();

        // 放射火花：八条橙黄射线
        const sparkNode = this.createGraphicsNode('BombSparks', this.rootNode, 100, 100, localX, localY);
        sparkNode.layer = Layers.Enum.UI_2D;
        sparkNode.setSiblingIndex(9998);
        const sg = sparkNode.getComponent(Graphics)!;
        sg.lineWidth = 4;
        sg.strokeColor = new Color(255, 190, 70, 255);
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4 + Math.PI / 8;
            sg.moveTo(Math.cos(angle) * 16, Math.sin(angle) * 16);
            sg.lineTo(Math.cos(angle) * 34, Math.sin(angle) * 34);
        }
        sg.stroke();
        const sparkOpacity = sparkNode.addComponent(UIOpacity);
        sparkNode.setScale(0.3, 0.3, 1);
        tween(sparkNode).to(0.35, { scale: new Vec3(1.4, 1.4, 1) }, { easing: 'sineOut' }).start();
        tween(sparkOpacity)
            .delay(0.15)
            .to(0.22, { opacity: 0 })
            .call(() => {
                if (sparkNode.isValid) sparkNode.destroy();
            })
            .start();
    }

    /**
     * 使用特殊果：校验 → 扣背包 → 关弹窗 → 从特殊果按钮飞向棋盘生效。
     * 彩虹果：任意有空间的果篮，优先即将满的（与点击彩虹果同口径）；
     * 炸弹果：炸最上层（wave 最小）最靠下的一块板（与砸板子同选板口径），板转物理坠落。
     */
    private useSpecialFruit(kind: 'rainbow' | 'bomb') {
        if (this.gameOver) return;
        // 本局限次（每日挑战彩虹/炸弹二选一；无限模式不限）
        if (!this.driver.canUseSpecialFruit()) {
            this.showCoinShortageTip('本局已使用过特殊果');
            return;
        }

        if (kind === 'rainbow') {
            // 先找篮再扣库存：优先即将满的果篮（剩余空间最少者排前）
            const activeBoxes = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty' && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
            if (activeBoxes.length === 0) {
                this.showCoinShortageTip('没有可放彩虹果的果篮');
                return;
            }
            if (!PropStore.consumeFruit('rainbow')) return;
            this.driver.useSpecialFruit();
            this.modalLayerNode?.destroyAllChildren();
            this.renderTools();

            activeBoxes.sort((a, b) => {
                const countA = a.fruits.length + (a.incomingCount || 0);
                const countB = b.fruits.length + (b.incomingCount || 0);
                const diffA = a.capacity - countA;
                const diffB = b.capacity - countB;
                if (diffA !== diffB) return diffA - diffB;
                return countB - countA;
            });
            const targetBox = activeBoxes[0];
            const boxIndex = this.boxes.indexOf(targetBox);
            const slotIndex = targetBox.fruits.length + (targetBox.incomingCount || 0);
            const targetWorldPos = this.getBoxSlotWorldPos(boxIndex, targetBox.capacity, slotIndex);

            const fruit: FruitData = { id: `special_rainbow_${Date.now()}`, color: FruitColor.RAINBOW, x: 0, y: 0, removed: false };
            targetBox.incomingCount = (targetBox.incomingCount || 0) + 1;
            this.trackFlyingFruit(fruit.color);
            this.playFruitFlyAnimation(fruit, this.getSpecialFruitBtnWorldPos(), targetWorldPos, () => {
                targetBox.incomingCount = Math.max(0, (targetBox.incomingCount || 0) - 1);
                this.untrackFlyingFruit(fruit.color);
                // 竞态保护：飞行途中果篮可能被清空换色；彩虹果可进任意有空间的篮
                const stillValid = targetBox.color !== 'locked' && targetBox.color !== 'empty'
                    && (targetBox.fruits.length + (targetBox.incomingCount || 0)) < targetBox.capacity;
                const finalBox = stillValid
                    ? targetBox
                    : this.boxes.find((box) => box.color !== 'locked' && box.color !== 'empty' && (box.fruits.length + (box.incomingCount || 0)) < box.capacity);
                if (finalBox) {
                    finalBox.fruits.push(FruitColor.RAINBOW);
                    this.renderTopUI();
                    if (this.canClearBox(finalBox)) {
                        this.scheduleBoxClear(finalBox, 0.25, true);
                    }
                    this.checkAllBoxesForClear();
                    this.checkWin();
                } else {
                    // 极端情况全篮无空位：进暂存盘兜底（与普通果子同口径）
                    // 先判满再入盘：溢出的果子不进暂存区，避免渲染到锁住的孔位上
                    if (this.tempHoles.length + 1 > this.getTempCapacity()) {
                        this.gameOver = true;
                        this.renderTopUI();
                        this.renderFailModal();
                        return;
                    }
                    this.tempHoles.push(FruitColor.RAINBOW);
                    this.renderTopUI();
                    this.autoFillFromTemp();
                }
            });
            return;
        }

        // ===== 炸弹果 =====
        const plate = this.findSmashTargetPlate();
        if (!plate) {
            this.showCoinShortageTip('当前没有可炸的板子哦');
            return;
        }
        if (!PropStore.consumeFruit('bomb')) return;
        this.driver.useSpecialFruit();
        this.modalLayerNode?.destroyAllChildren();
        this.renderTools();

        // 炸弹视觉：大一号黑色球体（多层高光做立体感）+ 引信火花
        const drawBomb = (g: Graphics) => {
            // 球体：底色暗灰 → 受光面亮灰偏左上 → 双层高光
            g.fillColor = new Color(52, 52, 58, 255);
            g.circle(0, -3, 21);
            g.fill();
            g.fillColor = new Color(86, 86, 96, 255);
            g.circle(-4, -7, 15);
            g.fill();
            g.fillColor = new Color(255, 255, 255, 235);
            g.circle(-9, -12, 5);
            g.fill();
            g.fillColor = new Color(255, 255, 255, 130);
            g.circle(-2, -5, 2.5);
            g.fill();
            // 引信 + 火花
            g.strokeColor = new Color(120, 80, 40, 255);
            g.lineWidth = 3;
            g.moveTo(7, 14);
            g.lineTo(15, 24);
            g.stroke();
            g.fillColor = new Color(255, 180, 40, 255);
            g.circle(16, 25, 4.5);
            g.fill();
        };

        // 投掷：特殊果按钮先呼吸一下，炸弹果从按钮处飞出，慢速砸向目标板
        const launch = () => {
            const pivotNode = this.plateNodes.get(plate.id);
            const plateWorldPos = pivotNode && pivotNode.isValid
                ? pivotNode.getWorldPosition()
                : new Vec3(0, 0, 0);
            const uiTransform = this.rootNode?.getComponent(UITransform);
            if (!this.rootNode || !this.rootNode.isValid || !uiTransform) {
                // 画不了动画直接生效兜底
                this.activatePlatePhysics(plate);
                return;
            }
            const startLocal = uiTransform.convertToNodeSpaceAR(this.getSpecialFruitBtnWorldPos());
            const targetLocal = uiTransform.convertToNodeSpaceAR(plateWorldPos);
            const bombNode = this.createGraphicsNode('BombFly', this.rootNode, 60, 60, startLocal.x, startLocal.y);
            bombNode.layer = Layers.Enum.UI_2D;
            bombNode.setSiblingIndex(9999);
            drawBomb(bombNode.getComponent(Graphics)!);

            bombNode.setScale(0.4, 0.4, 1);
            tween(bombNode)
                // 从按钮处弹出（小一号）
                .to(0.15, { scale: new Vec3(0.85, 0.85, 1) }, { easing: 'backOut' })
                // 慢速飞向目标板，途中保持偏小
                .to(0.9, { position: new Vec3(targetLocal.x, targetLocal.y, 0), scale: new Vec3(0.75, 0.75, 1) }, { easing: 'sineIn' })
                // 砸中：瞬间放大凸显立体感，再压扁消失
                .to(0.07, { scale: new Vec3(1.2, 1.2, 1) })
                .to(0.06, { scale: new Vec3(1.35, 0.5, 1) })
                .call(() => {
                    if (bombNode.isValid) bombNode.destroy();
                    this.triggerVibration('heavy');
                    // 爆炸特效：中心闪光 + 放射火花
                    this.playBombExplosion(targetLocal.x, targetLocal.y);
                    // 命中即炸：板子切 Dynamic 物理坠落（连带板上未摘水果），无呼吸等待
                    if (!plate.removed && plate.state !== 'falling') {
                        this.activatePlatePhysics(plate);
                    }
                })
                .start();
        };

        const btn = this.specialFruitBtnNode;
        if (btn && btn.isValid) {
            // 特殊果按钮呼吸一下，再放出炸弹果
            tween(btn)
                .to(0.25, { scale: new Vec3(1.12, 1.12, 1) }, { easing: 'backOut' })
                .to(0.25, { scale: new Vec3(1, 1, 1) })
                .call(() => {
                    if (btn.isValid) btn.setScale(1, 1, 1);
                    launch();
                })
                .start();
        } else {
            launch();
        }
    }

    /**
     * 分离式布局的操作按钮：面板正下方独立按钮，btn_action 底图 + 动态文案。
     * pay==='ad' 时右上角叠加视频小图标（Graphics 绘制）。
     * exhausted=true（本局该道具次数已用完）时置灰并显示「本局已用完」；整个按钮为一个热区。
     * 返回按钮节点，由调用方挂点击（免费→求助→看广告链路）。
     */
    public createSeparatedActionButton(
        panelNode: Node, panelH: number, spec: ToolButtonSpec, exhausted = false,
        opts?: { asset?: string; x?: number; yOffset?: number; width?: number; name?: string; outlineColor?: Color }
    ): Node {
        const btnW = opts?.width ?? 140, btnH = 61;
        const btnY = -(panelH / 2 + 10 + btnH / 2) - (opts?.yOffset ?? 0);
        const btnNode = this.createNode(opts?.name ?? 'BtnAction', panelNode, opts?.x ?? 0, btnY, btnW, btnH);
        // 系统音效：工厂统一建钮，这里挂只管播声的监听（业务回调仍由调用方各自挂，互不影响）
        btnNode.on(Node.EventType.TOUCH_END, () => SoundManager.getInstance()?.playSystemClick(), this);
        const sprite = btnNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${opts?.asset ?? 'btn_action'}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && sprite && btnNode.isValid) {
                sprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 文案：白色粗体 + 深棕描边（对齐 btn_daily/btn_endless 的家族风格）；已用完态固定显示「本局已用完」
        const buttonText = exhausted ? '本局已用完' : spec.text;
        const label = this.createLabel(btnNode, buttonText, 0, 0, 19, new Color(255, 255, 255, 255), true);
        const outline = label.node.addComponent(LabelOutline);
        if (outline) {
            outline.color = opts?.outlineColor ?? new Color(122, 74, 20, 255);
            outline.width = 2;
        }

        // 看广告兜底态：右上角视频小图标角标（随按钮整体缩小）
        if (!exhausted && spec.pay === 'ad') {
            const iconNode = this.createGraphicsNode('VideoIcon', btnNode, 34, 24, btnW / 2 - 16, btnH / 2 - 10);
            iconNode.setScale(new Vec3(0.7, 0.7, 1));
            this.drawVideoIcon(iconNode.getComponent(Graphics)!, new Color(122, 74, 20, 255));
        }

        // 已用完态：整体置灰（点击仍提示「本局XX次数已用完」）
        if (exhausted) {
            const gray = btnNode.addComponent(UIOpacity);
            gray.opacity = 120;
        }
        return btnNode;
    }

    private renderAddBasketModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 底图宽 640，按宽度 320 缩放；高度按底图比例，由 driver 提供
        const panelW = 320;
        const panelH = this.driver.getPanelHeight('addBasket');
        // 分离式布局：面板+按钮组合的视觉中心偏下，整体上移 50 居中
        const panelNode = this.createNode('AddBasketPanel', this.modalLayerNode, 0, 50, panelW, panelH);
        
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${this.driver.getPanelAsset('addBasket')}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮：新图红 X 中心实测 (136, 128)
        const closeBtn = this.createNode('CloseBtn', panelNode, 136, 128, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        // 2. 分离式布局：面板下方唯一按钮，文案优先级 免费使用 > 求助好友 > 看广告
        const spec = this.driver.getActionButton('addBasket');
        const btnAction = this.createSeparatedActionButton(panelNode, panelH, spec, this.driver.isToolExhausted('addBasket'));
        btnAction.on(Node.EventType.TOUCH_END, () => {
            const lockedBox = this.boxes.find((box) => box.color === 'locked');
            if (!lockedBox) {
                if (typeof wx !== 'undefined' && wx.showToast) {
                    wx.showToast({ title: '无果篮可解锁', icon: 'none' });
                }
                return;
            }
            if (!this.driver.canUseTool('addBasket')) {
                this.showCoinShortageTip('本局加果篮次数已用完');
                return;
            }
            // 免费道具优先（spec.pay==='free' 时必然命中）
            if (PropStore.consumeTool('addBasket')) {
                this.driver.useTool('addBasket');
                this.modalLayerNode!.destroyAllChildren();
                this.handleUnlockBox(lockedBox);
                this.renderBasketUnlockModal();
                this.renderTools();
                return;
            }
            if (spec.pay === 'help') {
                // 求助好友（当日独立额度）
                if (!this.tryDailyHelp()) return;
                this.modalLayerNode!.destroyAllChildren();
                this.pendingDailyAction = () => {
                    this.driver.useTool('addBasket');
                    this.handleUnlockBox(lockedBox);
                    this.renderBasketUnlockModal();
                };
                this.scheduleDailyActionOnShow();
            } else {
                // 兜底：看广告
                this.showAdThen(() => {
                    this.driver.useTool('addBasket');
                    this.handleUnlockBox(lockedBox);
                    this.renderBasketUnlockModal();
                }, 'unlock_basket');
            }
        }, this);
    }

    /** 砸板子弹窗：使用 panel_smash_plate.png（与加果篮面板同尺寸同布局，底图已含全部按钮与文案） */
    private renderSmashPlateModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 底图宽 640，按宽度 320 缩放；高度按底图比例，由 driver 提供
        const panelW = 320;
        const panelH = this.driver.getPanelHeight('smash');
        // 分离式布局：面板+按钮组合的视觉中心偏下，整体上移 50 居中
        const panelNode = this.createNode('SmashPlatePanel', this.modalLayerNode, 0, 50, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${this.driver.getPanelAsset('smash')}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮：新图红 X 中心实测 (142, 122)
        const closeBtn = this.createNode('CloseBtn', panelNode, 142, 122, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        // 2. 分离式布局：面板下方唯一按钮，文案优先级 免费使用 > 求助好友 > 看广告
        const spec = this.driver.getActionButton('smash');
        const btnAction = this.createSeparatedActionButton(panelNode, panelH, spec, this.driver.isToolExhausted('smash'));
        btnAction.on(Node.EventType.TOUCH_END, () => {
            if (!this.driver.canUseTool('smash')) {
                this.showCoinShortageTip('本局砸板子次数已用完');
                return;
            }
            // 先校验场上有可砸的板（没有则不消耗）
            if (!this.findSmashTargetPlate()) {
                this.renderCommonTip('砸板子', '当前没有可砸的板子哦');
                return;
            }
            // 免费道具优先（spec.pay==='free' 时必然命中）
            if (PropStore.consumeTool('smash')) {
                this.modalLayerNode!.destroyAllChildren();
                this.smashTopBottomPlate();
                this.renderTools();
                return;
            }
            if (spec.pay === 'help') {
                // 求助好友（当日独立额度）
                if (!this.tryDailyHelp()) return;
                this.modalLayerNode!.destroyAllChildren();
                this.pendingDailyAction = () => {
                    // 计数在 smashTopBottomPlate 内自增，此处不重复
                    this.smashTopBottomPlate();
                };
                this.scheduleDailyActionOnShow();
            } else {
                // 兜底：看广告
                this.showAdThen(() => {
                    this.modalLayerNode!.destroyAllChildren();
                    // 目标板呼吸 3 秒后坠落
                    this.smashTopBottomPlate();
                }, 'smash_plate');
            }
        }, this);
    }

    /** 通用提示横条（panel_tip_common 深色横幅）：从屏幕底部升至中间，停顿 2 秒后向上飞出屏幕（不关闭当前弹窗）；public 供签到弹窗等外部调用 */
    public showCoinShortageTip(text: string = '金币数量不足') {
        if (!this.modalLayerNode) return;
        // 幂等：横幅还在显示中（未飞出销毁）时忽略重复触发，防止连点叠加多个横幅
        if (this.coinShortageTipNode && this.coinShortageTipNode.isValid) return;

        // 图片宽占满屏幕，高按原图 1000x200（5:1）等比缩放
        const tipW = this.screenWidth;
        const tipH = tipW * 0.2;
        const startY = -this.screenHeight / 2 - tipH;
        const endY = this.screenHeight / 2 + tipH;
        const tipNode = this.createNode('CoinShortageTip', this.modalLayerNode, 0, startY, tipW, tipH);
        tipNode.setSiblingIndex(9999);
        this.coinShortageTipNode = tipNode;

        const sprite = tipNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_tip_common/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 文案（白色字体，配深色底图）
        this.createLabel(tipNode, text, 0, 0, 24, new Color(255, 255, 255, 255), true);

        // 底部升起（带回弹）→ 停顿 2 秒 → 加速向上飞出屏幕 → 销毁
        tween(tipNode)
            .to(0.35, { position: new Vec3(0, 0, 0) }, { easing: 'backOut' })
            .delay(2.0)
            .to(0.35, { position: new Vec3(0, endY, 0) }, { easing: 'sineIn' })
            .call(() => {
                if (tipNode.isValid) tipNode.destroy();
                if (this.coinShortageTipNode === tipNode) this.coinShortageTipNode = null;
            })
            .start();
    }

    /** 清空果盘确认弹窗：使用 panel_clear_basket.png（与加果篮面板同尺寸、同布局） */
    private renderClearBasketModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 底图宽 640，按宽度 320 缩放；高度按底图比例，由 driver 提供
        const panelW = 320;
        const panelH = this.driver.getPanelHeight('clear');
        // 分离式布局：面板+按钮组合的视觉中心偏下，整体上移 50 居中
        const panelNode = this.createNode('ClearBasketPanel', this.modalLayerNode, 0, 50, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${this.driver.getPanelAsset('clear')}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮：新图红 X 中心实测 (134, 136)
        const closeBtn = this.createNode('CloseBtn', panelNode, 134, 136, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        const doClearTray = () => {
            this.tryConsumeTool('clear', () => {
                this.tempHoles = [];
                this.renderTopUI();
                // 若清空后正好达成过关条件，过关弹窗优先，不再弹出清空成功图
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

        // 2. 分离式布局：面板下方唯一按钮，文案优先级 免费使用 > 求助好友 > 看广告
        const spec = this.driver.getActionButton('clear');
        const btnAction = this.createSeparatedActionButton(panelNode, panelH, spec, this.driver.isToolExhausted('clear'));
        btnAction.on(Node.EventType.TOUCH_END, () => {
            if (!this.driver.canUseTool('clear')) {
                this.showCoinShortageTip('本局清空果盘次数已用完');
                return;
            }
            // 免费道具优先（spec.pay==='free' 时必然命中）
            if (PropStore.consumeTool('clear')) {
                this.driver.useTool('clear');
                this.modalLayerNode!.destroyAllChildren();
                doClearTray();
                this.renderTools();
                return;
            }
            if (spec.pay === 'help') {
                // 求助好友（当日独立额度）
                if (!this.tryDailyHelp()) return;
                this.modalLayerNode!.destroyAllChildren();
                this.pendingDailyAction = () => {
                    this.driver.useTool('clear');
                    doClearTray();
                };
                this.scheduleDailyActionOnShow();
            } else {
                // 兜底：看广告
                this.showAdThen(() => {
                    this.driver.useTool('clear');
                    this.modalLayerNode!.destroyAllChildren();
                    doClearTray();
                }, 'clear_tray');
            }
        }, this);
    }

    /** 清空果盘成功弹窗：使用 panel_clear_tray.png，动效与加果篮成功弹窗一致 */
    private renderClearTraySuccessModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

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
            if (this.modalLayerNode) this.modalLayerNode.destroyAllChildren();
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
        this.modalLayerNode.destroyAllChildren();

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
            this.modalLayerNode!.destroyAllChildren();
        }, this);
    }

    private renderSettingsModal(show: boolean) {
        if (!this.modalLayerNode) return;
        if (!show) {
            this.modalLayerNode.destroyAllChildren();
            return;
        }

        this.modalLayerNode.destroyAllChildren();
        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 背景关闭
        mask.on(Node.EventType.TOUCH_END, () => {
            this.renderSettingsModal(false);
        }, this);

        // 每日挑战：panel_home_settings 面板 + 底部唯一「返回主页」按钮（无重新挑战/回第一关）
        if (this.driver.mode === 'daily') {
            this.renderDailySettingsPanel();
            return;
        }

        // 无限模式：与每日挑战同款 panel_home_settings 面板（下方竖排两按钮，整体上移 70 居中）
        const panelNode = this.renderSettingsPanelBase(70);
        if (!panelNode) return;
        const panelH = 300 * 674 / 640;

        // 重新挑战：面板下方独立按钮 btn_action（二次确认后放弃本局重开）
        const btnRestart = this.createSeparatedActionButton(
            panelNode, panelH, { text: '重新挑战', pay: 'free' }, false,
            { width: 160, name: 'BtnRestart' },
        );
        btnRestart.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '重新挑战',
                '本局进度将被放弃，\n重新开始一局新关卡。\n确定要重新挑战吗？',
                '继续游戏',
                '重新挑战',
                () => {
                    this.ensureGameUI();
                    this.initGame();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);

        // 返回主页：btn_action_blue 蓝钮，竖排在重新挑战下方
        const btnContinue = this.createSeparatedActionButton(
            panelNode, panelH, { text: '返回主页', pay: 'free' }, false,
            { asset: 'btn_action_blue', width: 160, name: 'BtnHome', yOffset: 71 },
        );
        btnContinue.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '返回主页',
                '本局进度将被放弃，\n重新开始一局新关卡。\n确定要返回主页吗？',
                '继续游戏',
                '返回主页',
                () => {
                    this.homePage.render();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);
    }

    /**
     * 设置面板公共主体：panel_home_settings.png（640x674，与首页设置弹窗同图；三行版：音乐/音效/震动），
     * 图内相对坐标复用首页实测值（关闭 0.930/0.073、音乐 0.325、音效 0.552、震动 0.779）。
     * 遮罩已由 renderSettingsModal 铺好；这里只画面板主体，面板下方按钮由各模式自挂。
     */
    private renderSettingsPanelBase(panelY: number): Node | null {
        if (!this.modalLayerNode) return null;

        const panelW = 300;
        const panelH = panelW * 674 / 640;
        const panelNode = this.createNode('SettingsPanel', this.modalLayerNode, 0, panelY, panelW, panelH);
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_home_settings/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 图内相对定位（与首页设置弹窗一致）
        const px = (fx: number) => (fx - 0.5) * panelW;
        const py = (fy: number) => (0.5 - fy) * panelH;

        // 右上角 X 关闭热区（新图实测 0.930/0.073）
        const closeBtn = this.createNode('CloseBtn', panelNode, px(0.930), py(0.073), 48, 48);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.renderSettingsModal(false);
        }, this);

        // 开关 X：空槽中心 fx≈0.754 → 面板本地 76，createToggle 内部 +60，故传 16
        const toggleX = 16;
        // 音乐开关：第一行（音符图标同一水平线），只管 BGM
        this.createToggle(panelNode, toggleX, py(0.325), this.soundEnabled, (isOn) => {
            this.soundEnabled = isOn;
            localStorage.setItem('soundEnabled', String(isOn));
            SoundManager.getInstance()?.setMute(!isOn);
            if (isOn) {
                SoundManager.getInstance()?.playBGM();
            } else {
                SoundManager.getInstance()?.stopBGM();
            }
        });

        // 音效开关：第二行（喇叭图标同一水平线），只管点击音效
        this.createToggle(panelNode, toggleX, py(0.552), localStorage.getItem('sfxEnabled') !== 'false', (isOn) => {
            localStorage.setItem('sfxEnabled', String(isOn));
            SoundManager.getInstance()?.setSfxMute(!isOn);
            if (isOn) SoundManager.getInstance()?.playSystemClick();
        });

        // 震动开关：第三行（震动图标同一水平线）
        this.createToggle(panelNode, toggleX, py(0.779), this.vibrationEnabled, (isOn) => {
            this.vibrationEnabled = isOn;
            localStorage.setItem('vibrationEnabled', String(isOn));
            if (isOn) this.triggerVibration('light');
        });

        return panelNode;
    }

    /** 每日挑战设置：公共面板 + 面板下方唯一「返回主页」按钮 */
    private renderDailySettingsPanel() {
        const panelNode = this.renderSettingsPanelBase(40);
        if (!panelNode) return;
        const panelH = 300 * 674 / 640;

        // 面板下方唯一按钮：btn_action「返回主页」（二次确认与旧版一致）
        const btnHome = this.createSeparatedActionButton(
            panelNode, panelH, { text: '返回主页', pay: 'free' }, false,
            { width: 160, name: 'BtnHome' },
        );
        btnHome.on(Node.EventType.TOUCH_END, () => {
            this.renderConfirmTip(
                '返回主页',
                '本局进度将被放弃，\n重新开始一局新关卡。\n确定要返回主页吗？',
                '继续游戏',
                '返回主页',
                () => {
                    this.homePage.render();
                },
                () => this.renderSettingsModal(true),
            );
        }, this);
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
        this.modalLayerNode.destroyAllChildren();
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
                SoundManager.getInstance()?.playSystemClick();
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

        // 【死代码，未接线】secondButton/secondOnConfirm 双按钮能力：全项目搜索确认当前没有任何
        // renderModal 调用传了这两个参数，只服务于已废弃的 doShareForReward 求助分享链路。
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
        const isDaily = this.driver.mode === 'daily';
        // 开局洗一次颜色顺序：整局内所有「取前 N 种颜色」都从这份洗好的数组切片，
        // 保证批次间颜色集合的递增包含关系不受影响，只是具体颜色随局变化
        this.shuffledColors = [...COLORS].sort(() => Math.random() - 0.5);
        // 层流规则按关取：无限模式按关卡区间（第 1 关 driver 内写死新手局），每日挑战读自己的配置
        this.layerRules = this.driver.getLayerRules(levelNum);
        const numColors = Math.min(COLORS.length, 4 + Math.floor((levelNum - 1) / 2));
        const activeColors = this.shuffledColors.slice(0, numColors);
        this.boxes[0].color = 'empty';
        this.boxes[1].color = 'empty';
        this.boxes[2].color = 'locked';
        this.boxes[3].color = 'locked';
        this.boxes.forEach((box) => {
            box.fruits = [];
            box.isNew = false;
            box.isSlidingOut = false;
        });
        // 一关分成几层：每 2 关多一层，封顶由 layerRules.maxLayers 配置，板子和水果的总量全靠这个涨
        let waveCount = Math.min(this.layerRules.maxLayers, 2 + Math.floor((levelNum - 1) / 2));
        // 彩虹果不再随关卡生成（无限模式/每日挑战均不刷），仅保留签到背包发放入口
        const rainbowTotal = 0;

        // 每日挑战批次计划（daily_challenge_wave_plan）：batches 展开为逐层颜色数与层→批归属，
        // 批内各层共用该批颜色池（如批1四色/批2六色/批3八色），难度逐批递增；未配置走无限模式曲线
        const wavePlanBatches = isDaily ? this.gameConfig?.dailyWavePlan?.[String(levelNum)]?.batches : undefined;
        let layerColors: number[] | null = null;
        let layerBatchIndex: number[] | null = null;
        if (wavePlanBatches && wavePlanBatches.length > 0) {
            layerColors = [];
            layerBatchIndex = [];
            wavePlanBatches.forEach((batch, batchIdx) => {
                const layers = Math.max(0, Math.min(this.layerRules.maxLayers, batch.layers ?? 0));
                const colors = Math.max(1, Math.min(COLORS.length, batch.colors ?? numColors));
                for (let i = 0; i < layers; i++) {
                    layerColors!.push(colors);
                    layerBatchIndex!.push(batchIdx);
                }
            });
            waveCount = Math.min(this.layerRules.maxLayers, layerColors.length);
            layerColors = layerColors.slice(0, waveCount);
            layerBatchIndex = layerBatchIndex.slice(0, waveCount);
        }
        // 批次信息存字段：刷色池（getRemainingColors）跨批扩池时查询
        this.dailyLayerColors = layerColors;
        this.dailyLayerBatchIndex = layerBatchIndex;
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

        // 每日挑战每层板子数配置（daily_challenge_wave_plates，按批）：缺省批不限制铺满
        const wavePlatesCfgBatches = isDaily ? this.gameConfig?.dailyWavePlates?.[String(levelNum)]?.batches : undefined;

        for (let wave = 0; wave < waveCount; wave++) {
            // 先把这一层的板子铺满棋盘，再按孔位总数定这层发多少果子：
            // 果量向下取整到 3 的倍数（三胞胎必须同层，否则玩家拿到 1 个就得占着暂存区等下层），
            // 多余孔位空着不放果，不影响观感
            const plateOpts = wavePlatesCfgBatches && layerBatchIndex
                ? wavePlatesCfgBatches[layerBatchIndex[wave]]
                : { maxPlates: this.layerRules.maxPlates };
            const wavePlates = this.buildWavePlates(wave, waveCount, availableTemplates, plateIndex, plateOpts);
            plateIndex += wavePlates.length;
            this.plates.push(...wavePlates);

            const holeCount = wavePlates.reduce((sum, plate) => sum + plate.holes.length, 0);
            const triplets = Math.max(1, Math.floor(holeCount / 3));
            // 每日挑战：该层颜色池按批配置（批1四色/批2八色/批3八色）；无限模式用整关曲线色池
            const layerActiveColors = layerColors
                ? this.shuffledColors.slice(0, Math.min(COLORS.length, layerColors[wave]))
                : activeColors;
            // 该层颜色全部出场（不再限制6色上限），相邻层允许撞色；
            // 孔数不按场上可达数钳制（完全交给后端权重），颜色分散不影响果篮难度
            const wavePalette = [...layerActiveColors].sort(() => Math.random() - 0.5);
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
        // 兜底色池与第 0 层颜色池同口径（每日挑战批 1 颜色数）
        const baseColors = layerColors ? this.shuffledColors.slice(0, Math.min(COLORS.length, layerColors[0])) : activeColors;
        this.boxes[0].color = firstWaveColors[0] || FruitColor.YELLOW;
        if (firstWaveColors.length > 1) {
            this.boxes[1].color = firstWaveColors[1];
        } else {
            const otherColors = baseColors.filter((color) => color !== firstWaveColors[0]);
            this.boxes[1].color = otherColors.length > 0
                ? otherColors[Math.floor(Math.random() * otherColors.length)]
                : (firstWaveColors[0] || FruitColor.BLUE);
        }

        this.plates = this.plates.filter((plate) => plate.fruits.length > 0);
        // 开局启用几层由 layerRules.initialLoad 配置（首批全彩色），后面按“剩余果子跌破首批总量×refillRatio”逐层启用
        this.loadedWave = Math.min(this.maxWave, this.layerRules.initialLoad - 1);
        const initialFruits = this.plates
            .filter((plate) => (plate.wave ?? 0) <= this.loadedWave)
            .reduce((sum, plate) => sum + plate.fruits.length, 0);
        this.refillThreshold = Math.floor(initialFruits * this.layerRules.refillRatio);
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
        startIndex: number,
        opts?: { maxPlates?: number; rectFirst?: number; shapeFirst?: number; stripFirst?: number; shapeVariety?: number }
    ): PlateData[] {
        // 每日挑战可按批覆盖放板参数（daily_challenge_wave_plates）；缺省走 layerRules.maxPlates（无限模式已含关卡区间配置）
        const rectFirst = opts?.rectFirst ?? LAYER_RECT_PLATE_FIRST;
        const shapeFirst = opts?.shapeFirst ?? LAYER_SHAPE_PLATE_FIRST;
        const maxPlates = opts?.maxPlates ?? this.layerRules.maxPlates;
        let stripFirst = opts?.stripFirst ?? 0;
        const paddingX = 4;
        // 上边留得比下边多：顶部要避开头部 UI，底部紧着果篮
        const paddingTop = 60;
        const paddingBottom = 40;
        const placedBodies: PlateBody[] = [];
        const plates: PlateData[] = [];

        // 模板池拆成方板和异形两半：两边各有保底阶段，后面再合起来按孔密度铺
        let scaledRects = templates.map((template) => this.scaleTemplate(template));
        let scaledShapes = SHAPE_PLATE_SET.map((template) => this.scaleTemplate(template));
        let allowStrip = stripFirst > 0;

        // 每层形状种类限制（daily_challenge_wave_plates.shapeVariety）：从方板+异形+长条全部 7 种模板里
        // 随机抽 N 种，本层只从抽中的这几种里铺；未配置/0 时不限制，保持全 7 种混铺的原行为。
        // 抽完之后不动三阶段保底逻辑本身——被筛掉的池子自然是空的，对应保底数跟着变成 0，无需特殊处理
        if (opts?.shapeVariety && opts.shapeVariety > 0) {
            type PoolEntry = { kind: 'rect' | 'shape' | 'strip'; template: PlateTemplate };
            const allEntries: PoolEntry[] = [
                ...scaledRects.map((template) => ({ kind: 'rect' as const, template })),
                ...scaledShapes.map((template) => ({ kind: 'shape' as const, template })),
                ...(allowStrip ? [{ kind: 'strip' as const, template: this.scaleTemplate(STRIP_PLATE_TEMPLATE) }] : [])
            ];
            const variety = Math.min(opts.shapeVariety, allEntries.length);
            const picked = [...allEntries].sort(() => Math.random() - 0.5).slice(0, variety);
            scaledRects = picked.filter((e) => e.kind === 'rect').map((e) => e.template);
            scaledShapes = picked.filter((e) => e.kind === 'shape').map((e) => e.template);
            allowStrip = picked.some((e) => e.kind === 'strip');
        }
        if (!allowStrip) stripFirst = 0;
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
        for (let i = 0; i < Math.min(rectFirst, shuffledRects.length); i++) {
            if (plates.length >= maxPlates) break;
            const placement = this.findPackedPlacement(shuffledRects[i], placedBodies, paddingX, paddingTop, paddingBottom, fromLeft, fromTop);
            if (placement) pushPlate(shuffledRects[i], placement);
        }

        // 第 1.5 阶段：长条板保底（stripFirst，每日挑战按批配置）。横向一条宽大板，
        // 要趁空地还整时放；连续 stripFirst 块形成长条阵
        const scaledStrip = this.scaleTemplate(STRIP_PLATE_TEMPLATE);
        for (let i = 0; i < stripFirst; i++) {
            if (plates.length >= maxPlates) break;
            const placement = this.findPackedPlacement(scaledStrip, placedBodies, paddingX, paddingTop, paddingBottom, fromLeft, fromTop, 6);
            if (!placement) break;
            pushPlate(scaledStrip, placement);
        }

        // 第二阶段：异形板全家福各一块保底，保证每层形状齐全。
        // 它们是凹形的，后面的板子能嵌进 L 的缺口、十字的四个角里
        const shapeSet = [...scaledShapes].sort(() => Math.random() - 0.5);
        for (let i = 0; i < Math.min(shapeFirst, shapeSet.length); i++) {
            if (plates.length >= maxPlates) break;
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
            if (plates.length >= maxPlates) break;
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
        fromTop: boolean,
        gap: number = 1
    ): { x: number; y: number; rotation: number; renderW: number; renderH: number } | null {
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
    
        // 每日挑战第一关（单关制唯一关）：果篮按刷新次数递增孔数（3→4→5→6→6...），替代权重随机。
        // 每个果篮独立计数：首次刷新（含刚解锁）3 孔，之后逐次 +1，封顶 5 孔
        if (this.driver.mode === 'daily' && this.currentLevel === 1) {
            const count = targetBox.refreshCount || 0;
            targetBox.refreshCount = count + 1;
            return Math.min(6, 3 + count);
        }
    
        // 孔数完全交给后端权重决定，不按场上剩余数钳制。
        // 篮子没装满也卡不了关：某色果全进篮后 canClearBox 会提前清篮，
        // 且过关只看"板子全掉 + 暂存区清空"（checkWin），没满的篮子不挡路
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
        SoundManager.getInstance()?.playGameClick();

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
            if ((this.tempHoles.length + this.incomingTempCount) > this.getTempCapacity()) {
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
        this.updateCatProgress();
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
                // 先判满再入盘：溢出的果子不进暂存区，避免渲染到锁住的孔位上
                if (this.tempHoles.length + 1 > this.getTempCapacity()) {
                    this.gameOver = true;
                    this.renderTopUI();
                    this.renderFailModal();
                    return;
                }
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
                    // 先判满再入盘：溢出的果子不进暂存区，避免渲染到锁住的孔位上
                    if (this.tempHoles.length + 1 > this.getTempCapacity()) {
                        this.gameOver = true;
                        this.renderTopUI();
                        this.renderFailModal();
                        return;
                    }
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
        plate.stuckFrames = 0;
        plate.stuck = false;
        plate.prevFallSpeed = 0;

        body.type = ERigidBody2DType.Dynamic;
        body.gravityScale = 1.5;

        // 掉落板提到最前渲染：长条板 layer 偏小（stripFirst 阶段生成，同层内 layer 靠后），
        // 不提的话掉落被下方板 B 顶住时，A 会渲染在 B 后面（板面重叠 + 层级低 → "A在B后面"）。
        // 掉落是视觉焦点，本就该盖在静态板前面；掉出屏幕后节点销毁，层级自然归位
        pivotNode.setSiblingIndex(pivotNode.parent!.children.length - 1);
    }

    /** 找砸板子目标：最上层（wave 最小）那批未埋未掉落板子里，屏幕最靠下（y 最小）的一块 */
    private findSmashTargetPlate(): PlateData | null {
        let minWave = Number.MAX_SAFE_INTEGER;
        for (const plate of this.plates) {
            if (plate.removed || plate.state === 'falling' || plate.buried) continue;
            if (plate.id === this.smashingPlateId) continue;
            const wave = plate.wave ?? 0;
            if (wave < minWave) minWave = wave;
        }
        if (minWave === Number.MAX_SAFE_INTEGER) return null;
        let target: PlateData | null = null;
        for (const plate of this.plates) {
            if (plate.removed || plate.state === 'falling' || plate.buried) continue;
            if (plate.id === this.smashingPlateId) continue;
            if ((plate.wave ?? 0) !== minWave) continue;
            if (!target || plate.y < target.y) target = plate;
        }
        return target;
    }

    /** 砸板子：目标板呼吸 3 秒（缩放↔1.12+摇摆±2.5°，快弹慢收每秒 1 次共 3 次）后切 Dynamic 坠落，连带板上未摘水果一起移除；每局限次由 driver 决定（无限模式不限） */
    private smashTopBottomPlate() {
        const plate = this.findSmashTargetPlate();
        if (!plate) return;
        const pivotNode = this.plateNodes.get(plate.id);
        if (!pivotNode || !pivotNode.isValid) return;

        this.smashingPlateId = plate.id;
        this.driver.useTool('smash');
        this.triggerVibration('heavy');

        // 呼吸增强版：缩放 1↔1.12 + 以当前角度为基准左右摆 ±2.5°；快弹(0.35s backOut)慢收(0.65s sineInOut)
        const baseAngle = pivotNode.angle;
        tween(pivotNode)
            .to(0.35, { scale: new Vec3(1.12, 1.12, 1), angle: baseAngle + 2.5 }, { easing: 'backOut' })
            .to(0.65, { scale: new Vec3(1, 1, 1), angle: baseAngle - 2.5 }, { easing: 'sineInOut' })
            .union()
            .repeat(3)
            .call(() => {
                this.smashingPlateId = null;
                if (!pivotNode.isValid || plate.removed || plate.state === 'falling') return;
                pivotNode.setScale(new Vec3(1, 1, 1));
                pivotNode.angle = baseAngle;
                this.activatePlatePhysics(plate);
            })
            .start();
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
            this.applyPlatePhysics(plate);
        });
    }

    /**
     * 给单块板子加刚体+碰撞体（initAllPlatePhysics 的单板逻辑抽出来，供分帧版 initAllPlatePhysicsStaged 复用）。
     * 碰撞矩阵/重力这些只需要跑一次的全局配置仍按 _physicsGravitySet/_collisionMatrixConfigured 防重触发。
     */
    private applyPlatePhysics(plate: PlateData) {
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
        // 长条板原开 CCD(bullet) 防"旋转一帧穿过相邻长条板"，但实测 bullet 在"初始贴合(gap=1)切 Dynamic"
        // 瞬间会把板回退进下层板内部 → 两块板完全重叠、半透明板面透出下层水果。先关闭验证
        rigidBody.bullet = false;

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
                    // addComponent 时已经用默认尺寸(1x1)同步建好了 Box2D 的物理形状，
                    // 上面这几行只是改了 JS 侧的属性值，必须 apply() 才会真正重建 fixture，
                    // 否则真实碰撞体一直是那个几乎为 0 的默认尺寸——这正是同层板子"几乎完全重叠才碰撞"的根因
                    boxCol.apply();
                } else {
                    const circleCol = pivotNode.addComponent(CircleCollider2D);
                    circleCol.group = plateGroup;
                    circleCol.offset = new Vec2(px, py);
                    circleCol.radius = col.r;
                    circleCol.apply();
                }
            });
        } else {
            const boxCol = pivotNode.addComponent(BoxCollider2D);
            boxCol.group = plateGroup;
            boxCol.offset = new Vec2(-offsetX, -offsetY);
            boxCol.size = new Size(plate.w, plate.h);
            boxCol.apply();
        }
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
            // 回写板中心坐标（pivot 减 gravityOrigin 偏移）并同步物理旋转角。
            // 之前直接把 pivot 坐标写给 plate.x/y（带配重偏移的异形板会整体错位），
            // rotation 又不回写（板子物理里已歪、判定还按初始角度算），
            // stuck 板的遮挡判定框和视觉位置错开，出现"果子露着却点不动"的随机误判
            const offset = this.getPlatePivotOffset(plate);
            plate.x = pos.x - offset.x;
            plate.y = pos.y - offset.y;
            plate.rotation = node.angle;

            // 长条板又长又扁，一旦只有一角搭在邻居板上，重力力矩会把它甩得转得很快，
            // 悬空那一头的线速度（角速度×半宽）可能在一步内扫过邻居板的整个厚度，把邻居"甩穿"。
            // 钳制角速度上限（弧度/秒，Box2D 角速度单位），把甩动幅度压小，减少这种情况
            if (plate.texture === 'plate_bar') {
                const MAX_STRIP_ANGULAR_SPEED = Math.PI; // 约180度/秒
                const angSpeed = body.angularVelocity;
                if (angSpeed > MAX_STRIP_ANGULAR_SPEED) {
                    body.angularVelocity = MAX_STRIP_ANGULAR_SPEED;
                } else if (angSpeed < -MAX_STRIP_ANGULAR_SPEED) {
                    body.angularVelocity = -MAX_STRIP_ANGULAR_SPEED;
                }
            }

            // 卡住检测：掉落板被下层板支撑停住时标记 stuck，此时它仍停在画面上遮挡别的果子，这些果子应判为不可点。
            // 用"本帧速度比上一帧还小"判断真落地：自由下落靠重力驱动，每一帧速度只会递增（实测下落全程无一帧例外），
            // 真实碰撞会在一帧内把速度打下来，是唯一会让速度变小的情况——不受板间距大小影响，
            // 之前按"下落距离"判断时，间距很小的板子（比如只掉 7px 就到底）永远也够不着固定的距离门槛，导致永远判不了 stuck
            const vel = body.linearVelocity;
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
            const prevSpeed = plate.prevFallSpeed ?? 0;
            const speedDropped = prevSpeed > 0.5 && speed < prevSpeed;
            plate.prevFallSpeed = speed;

            if ((speedDropped && speed < 8) || (plate.stuck && speed < 8)) {
                plate.stuckFrames = (plate.stuckFrames || 0) + 1;
                plate.stuck = true;
            } else if (speed >= 8) {
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

    /** 获取金币图标的世界坐标（取图片左侧图形中心，而非整张图中心） */
    private getCoinWorldPos(): Vec3 | null {
        if (!this.coinIconNode || !this.coinIconNode.isValid) return null;
        const uiTransform = this.coinIconNode.getComponent(UITransform);
        if (uiTransform) {
            return uiTransform.convertToWorldSpaceAR(new Vec3(-uiTransform.width * 0.25, 0, 0));
        }
        return this.coinIconNode.getWorldPosition();
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
        // 每日挑战：最深已加载层进入批 2 起，刷色池并入「当前批全色 + 下一批全色」
        // （跨批提前备篮：批3的果子挖出来时有篮可进；批1期间不提前剧透）
        if (this.driver.mode === 'daily' && this.dailyLayerColors && this.dailyLayerBatchIndex) {
            const deepestWave = Math.min(this.loadedWave, this.dailyLayerBatchIndex.length - 1);
            const deepestBatch = this.dailyLayerBatchIndex[deepestWave] ?? 0;
            if (deepestBatch >= 1) {
                this.shuffledColors.slice(0, Math.min(COLORS.length, this.dailyLayerColors[deepestWave]))
                    .forEach((color) => colors.add(color));
                // 下一批（若有）：取其起始层的颜色数
                const nextWave = this.dailyLayerBatchIndex.findIndex((b) => b === deepestBatch + 1);
                if (nextWave >= 0) {
                    this.shuffledColors.slice(0, Math.min(COLORS.length, this.dailyLayerColors[nextWave]))
                        .forEach((color) => colors.add(color));
                }
            }
        }
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
        // 每日挑战按全局口径（含未加载深层）：深层还有该色果子就不提前清（等凑满），
        // 到最后一批全局=已加载，自然「果篮不满也消除」防死局；无限模式保持已加载层口径
        const isDaily = this.driver.mode === 'daily';
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            if (!isDaily && (plate.wave ?? 0) > this.loadedWave) return;
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
        // 每日挑战：固定用 daily_challenge_challenge_weights（缺省退回 challengeWeights）
        const wt = this.driver.mode === 'daily'
                    ? (config?.dailyChallengeWeights ?? config?.challengeWeights)
                    : (isChallenge ? (config?.challengeWeights) : (config?.normalWeights));
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

    private useTool(type: 'addTray' | 'clear') {
        if (this.gameOver) return;

        if (type === 'addTray') {
            this.renderAddTrayModal();
            return;
        }

        // 不校验果盘是否有水果，直接弹窗，让用户可以继续往下操作
        this.renderClearBasketModal();
    }

    /** 加果盘弹窗：分离式布局（panel_add_tray 底图 + 独立按钮），按钮走付费优先级链 */
    private renderAddTrayModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        // 底图宽 640，按宽度 320 缩放；高度按底图比例，由 driver 提供
        const panelW = 320;
        const panelH = this.driver.getPanelHeight('addTray');
        // 分离式布局：面板+按钮组合的视觉中心偏下，整体上移 50 居中
        const panelNode = this.createNode('AddTrayPanel', this.modalLayerNode, 0, 50, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${this.driver.getPanelAsset('addTray')}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 1. 关闭按钮：新图红 X 中心实测 (131, 107)
        const closeBtn = this.createNode('CloseBtn', panelNode, 131, 107, 60, 60);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            SoundManager.getInstance()?.playSystemClick();
            this.modalLayerNode!.destroyAllChildren();
        }, this);

        // 2. 分离式布局：面板下方唯一按钮，文案优先级 免费使用 > 求助好友 > 看广告
        const spec = this.driver.getActionButton('addTray');
        const btnAction = this.createSeparatedActionButton(panelNode, panelH, spec, this.driver.isToolExhausted('addTray'));
        btnAction.on(Node.EventType.TOUCH_END, () => {
            if (!this.driver.canUseTool('addTray')) {
                this.showCoinShortageTip('本局加果盘次数已用完');
                return;
            }
            // 先校验还有锁着的果盘（解完则不消耗）
            if (this.traysUnlockedThisLevel >= 1) {
                this.showCoinShortageTip('果盘已全部解锁');
                return;
            }
            // 免费道具优先（spec.pay==='free' 时必然命中）
            if (PropStore.consumeTool('addTray')) {
                this.driver.useTool('addTray');
                this.unlockOneTray();
                this.renderTools();
                return;
            }
            if (spec.pay === 'help') {
                // 求助好友（当日独立额度）
                if (!this.tryDailyHelp()) return;
                this.modalLayerNode!.destroyAllChildren();
                this.pendingDailyAction = () => {
                    this.driver.useTool('addTray');
                    this.unlockOneTray();
                };
                this.scheduleDailyActionOnShow();
            } else {
                // 兜底：看广告
                this.showAdThen(() => {
                    this.driver.useTool('addTray');
                    this.unlockOneTray();
                }, 'add_tray');
            }
        }, this);
    }

    /** 解锁一个果盘：关弹窗 + 已解锁数+1（锁的显隐由 renderTempSlots 按计数刷新） */
    private unlockOneTray() {
        if (this.traysUnlockedThisLevel >= 1) return;
        this.traysUnlockedThisLevel++;
        this.modalLayerNode?.destroyAllChildren();
        this.renderTopUI();
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
        }).catch((reason) => {
            // 防重入拒绝（连点）：静默忽略，不弹失败提示
            if (reason === '广告进行中') return;
            if (scene) {
                reportEvent(scene + '_skip');
            }
            if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
                wx.showToast({ title: '广告加载失败，请重试', icon: 'none' });
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
        // 延迟 1 秒弹出过关弹窗：等待最后一次金币收集动画完成并累加，保证弹窗数量取值正确
        this.showSuccessModalAfterSettle(1.0);
    }

    /** 延迟结算过关；若仍有果篮在滑出/待清除（金币未累加完），继续等待 */
    private showSuccessModalAfterSettle(delay: number) {
        this.scheduleOnce(() => {
            // 玩家可能在等这一秒里退回了首页，那就别把弹窗画过去了。
            // 这里不用回滚任何标志：gameOver 已经置上，关卡结算本身不靠这个弹窗
            if (!this.isGameViewAlive()) return;
            const settling = this.boxes.some((box) => box.isSlidingOut || box.clearScheduled);
            if (settling) {
                this.showSuccessModalAfterSettle(0.3);
                return;
            }
            this.dispatchClear();
        }, delay);
    }

    /**
     * 过关后的走向由 driver 决定，这里只做分派：
     *   modal        常规过关弹窗（无限模式）
     *   autoAdvance  不弹窗，直接推进并进加载页（每日挑战第 1 关）
     *   finish       整局完成，弹本模式收尾页（每日挑战第 2 关）
     */
    private dispatchClear() {
        switch (this.driver.getClearAction(this.currentLevel)) {
            case 'autoAdvance':
                this.modalLayerNode?.destroyAllChildren();
                this.currentLevel = this.driver.advanceLevel(this.currentLevel);
                this.transitionToNewLevel();
                break;
            case 'finish':
                // advanceLevel 内部会上报通关并回卷关号，必须先调再画页面（页面要读上报结果）
                this.currentLevel = this.driver.advanceLevel(this.currentLevel);
                this.renderDailySuccessModal();
                break;
            default:
                this.renderSuccessModal();
                break;
        }
    }

    /** 秒数格式化为 mm:ss；无有效计时显示 --:-- */
    private formatDuration(seconds: number | null | undefined): string {
        if (seconds == null || seconds < 0) return '--:--';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /**
     * 每日挑战通关页（过完第 2 关）：panel_daily_success.png。
     * 底图 1239x1750，按宽 320 缩放 → 高 452。
     * 蓝条中心底图 y≈182 → 游戏坐标 179；凹槽1中心 y≈1087 → -55；凹槽2中心 y≈1280 → -105；绿钮中心 y≈1512 → -165。
     * 「本次用时」用本地计时，立即可显示；「今日最快」等上报接口返回后回填。
     */
    private renderDailySuccessModal() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        const panelW = 320;
        const panelH = 452;
        const panelNode = this.createNode('DailySuccessPanel', this.modalLayerNode, 0, 0, panelW, panelH);

        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_daily_success/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 阻止点击穿透到遮罩
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 标题（蓝条内，底图未画文字）。蓝条实测中心 y≈182 → 游戏坐标 179
        const titleLabel = this.createLabel(panelNode, '挑战完成', 0, 179, 26, new Color(255, 255, 255, 255), true);
        const titleOutline = titleLabel.node.addComponent(LabelOutline);
        if (titleOutline) {
            titleOutline.color = new Color(12, 74, 140, 255);
            titleOutline.width = 3;
        }

        const slotTextColor = new Color(110, 75, 45, 255);
        const daily = this.getDailyDriverForResult();

        // 第一条槽：本次用时（本地计时，立即可显示）；击败历史最快时接口回来后在数字旁贴「新纪录」
        const runSeconds = daily ? daily.getLastRunSeconds() : null;
        this.createLabel(panelNode, '本次用时', -48, -55, 17, slotTextColor, true);
        const runLabel = this.createLabel(panelNode, this.formatDuration(runSeconds), 48, -55, 22, slotTextColor, true);

        // 第二条槽：今日最快（不含本次，等上报接口返回后回填，先占位）——与「本次用时」并排对比
        this.createLabel(panelNode, '今日最快', -48, -105, 17, slotTextColor, true);
        const bestLabel = this.createLabel(panelNode, '--:--', 48, -105, 22, slotTextColor, true);
        const report = daily ? daily.getClearReport() : null;
        if (report) {
            report.then((res) => {
                if (!bestLabel || !bestLabel.isValid) return;
                // 接口没给有效计时就退回本地耗时，避免一直显示占位
                const best = res && res.bestSeconds != null ? res.bestSeconds : runSeconds;
                bestLabel.string = this.formatDuration(best);
                if (res && res.newRecord && runLabel && runLabel.isValid) {
                    this.showDailyNewRecordBadge(runLabel);
                }
            }).catch(() => {});
        } else {
            bestLabel.string = this.formatDuration(runSeconds);
        }

        // 主按钮（绿色，底图未画文字）：点一次「领取奖励」进入链式金光弹窗流程。绿钮实测中心 y≈1512 → 游戏坐标 -165
        const btnHome = this.createNode('BtnHome', panelNode, 0, -165, 189, 56);
        const btnLabel = this.createLabel(btnHome, '领取奖励', 0, 0, 22, new Color(255, 255, 255, 255), true);
        this.bindDailyRewardButton(btnHome, btnLabel, panelNode);

        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 「本次用时」击败历史最快时的强调效果：数字变金色 + 弹跳，右侧贴「新纪录」小标签常驻显示，
     * 让用户即使划走弹窗也能确认自己看到了这个提示（不是一闪而过的动效）。
     */
    private showDailyNewRecordBadge(runLabel: Label) {
        const runNode = runLabel.node;
        runLabel.color = new Color(255, 170, 20, 255);
        runNode.setScale(0.4, 0.4, 1);
        tween(runNode)
            .to(0.35, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            .to(0.15, { scale: new Vec3(1, 1, 1) })
            .start();

        const parent = runNode.parent;
        if (!parent) return;
        // 往右挪开时间数字，字号加大+粗描边+小角度斜切，做出艺术字的跳出感
        const badge = this.createLabel(parent, '新纪录', runNode.position.x + 68, runNode.position.y, 22, new Color(255, 170, 20, 255), true);
        badge.node.angle = -8;
        const badgeOutline = badge.node.addComponent(LabelOutline);
        if (badgeOutline) {
            badgeOutline.color = new Color(140, 80, 10, 255);
            badgeOutline.width = 3;
        }
        badge.node.setScale(0.3, 0.3, 1);
        tween(badge.node)
            .delay(0.1)
            .to(0.35, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' })
            .to(0.15, { scale: new Vec3(1, 1, 1) })
            .start();
    }

    /**
     * 每日挑战过关奖励：通关页点一次「领取奖励」→ stage=1 弹金币金光弹窗；
     * 每弹领完自动拉下一 stage（1=金币 2=道具抽 3=收集抽，规则在后端代码里），
     * 后端返回空列表即链条结束，自动回主页。发放仍写本地 PropStore/totalCoins。
     * 无 claimStageReward 实现（如无限模式）时按钮直接是「返回主页」，行为与改造前一致。
     */
    private bindDailyRewardButton(btnNode: Node, label: Label, panelNode: Node) {
        const driver = this.driver;
        if (!driver.claimStageReward) {
            label.string = '返回主页';
            btnNode.on(Node.EventType.TOUCH_END, () => {
                this.modalLayerNode?.destroyAllChildren();
                this.homePage.render();
            }, this);
            return;
        }

        const goHome = () => {
            this.modalLayerNode?.destroyAllChildren();
            this.homePage.render();
        };
        const failTip = () => this.showCoinShortageTip('奖励领取失败，请稍后再试');

        let claiming = false;
        // 递归领 stage：领完当前串拉下一 stage；后端返空=链条结束回主页（stage1 空视为异常，横幅允许重试）
        // 收集抽奖前先取已拥有的 collectCode 列表传给后端排除（全部拥有则后端回退全量抽）；
        // getOwnedCodes 按本地已拥有 id 批量查，不整表拉取
        const claimStage = (stage: number) => {
            CollectStore.getOwnedCodes().then((ownedCodes) => {
                return driver.claimStageReward!(stage, ownedCodes);
            }).then((list) => {
                claiming = false;
                if (!list || list.length === 0) {
                    if (stage === 1) { failTip(); return; }
                    this.renderTools();
                    goHome();
                    return;
                }
                this.showRewardChain(list, 0, () => claimStage(stage + 1));
            }).catch(() => {
                claiming = false;
                if (stage === 1) { failTip(); return; }
                failTip();
                goHome();
            });
        };

        btnNode.on(Node.EventType.TOUCH_END, () => {
            if (claiming) return;
            claiming = true;
            claimStage(1);
        }, this);
    }

    /** 链式奖励弹窗：逐个展示 rewards[idx]，点「领取奖励」入账后弹下一个，全领完走 onDone。
     * 先按需查这一条的 collectCode 目录，rewardDisplayName/grantRewardSilently 才能正确按 collectCode 查到名字/id */
    private showRewardChain(rewards: RewardItem[], idx: number, onDone: () => void) {
        const reward = rewards[idx];
        this.ensureCollectCodeCached(reward.collectCode).then(() => {
            if (!this.modalLayerNode) return;
            this.renderRewardRevealModal(reward, () => {
                this.grantRewardSilently(reward);
                if (idx + 1 < rewards.length) {
                    this.showRewardChain(rewards, idx + 1, onDone);
                } else {
                    onDone();
                }
            });
        });
    }

    /**
     * 奖励展示弹窗：物品图 + 恭喜文案 + 「领取奖励」按钮，简洁无特效。
     * 物品图用后端下发的 imageUrl（loadRemoteImage，失败兜底占位圆）；入账与后续走向由 onClaim 调用方负责。
     */
    private renderRewardRevealModal(reward: RewardItem, onClaim: () => void) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 170), 0);

        const panelNode = this.createNode('RewardRevealPanel', this.modalLayerNode, 0, 0, 320, 360);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        const centerY = 40;
        // 物品图：后端下发 imageUrl，加载失败兜底占位金圆；入场 backOut 放大
        const imgNode = this.createNode('RewardImg', panelNode, 0, centerY, 150, 150);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.loadRemoteImage(reward.imageUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(255, 214, 90, 255);
            ph.circle(0, 0, 60);
            ph.fill();
        });
        imgNode.setScale(0.5, 0.5, 1);
        tween(imgNode).to(0.3, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();

        // 恭喜文案：白字深描边
        const text = this.createLabel(panelNode, `恭喜获得${this.rewardDisplayName(reward)}`, 0, -78, 22, new Color(255, 255, 255, 255), true);
        const textOutline = text.node.addComponent(LabelOutline);
        if (textOutline) {
            textOutline.color = new Color(122, 74, 20, 255);
            textOutline.width = 3;
        }

        // 「领取奖励」按钮：橙钮，面板正下方（yOffset 负值上移 20px，避免太靠下）
        const btn = this.createSeparatedActionButton(
            panelNode, 360, { text: '领取奖励', pay: 'free' }, false,
            { asset: 'btn_action', name: 'BtnClaimReward', yOffset: -20 }
        );
        btn.on(Node.EventType.TOUCH_END, onClaim, this);

        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 按需查一个 collectCode 并填进增量缓存：命中过直接跳过，未命中才发请求。
     * code 为空（无限模式普通关，reward 本身为 null）直接跳过。
     * 目录查询和背包内存缓存一起确保就位：调用方紧接着会用 CollectStore 的同步方法（own 等），
     * 缓存没就位就调用会读到还没拉取完成的初始空状态。
     */
    private ensureCollectCodeCached(code: string | undefined): Promise<void> {
        const codes = code && !this.collectCodeCache.has(code) ? [code] : [];
        return Promise.all([fetchCollectByCodes(codes), CollectStore.ensureLoaded()]).then(([items]) => {
            items.forEach((item) => this.collectCodeCache.set(item.collectCode, item));
        }).catch(() => {});
    }

    /** 奖励展示名：按枚举硬映射（组合果两个都显示）；收集品按 collectCode 从缓存查真实名字，查不到兜底显示编码 */
    private rewardDisplayName(reward: RewardItem): string {
        const amount = reward.amount || 0;
        if (reward.itemType === ItemTypeEnum.COLLECT) {
            const item = reward.collectCode ? this.collectCodeCache.get(reward.collectCode) : undefined;
            return item ? item.name : `水果「${reward.collectCode}」`;
        }
        switch (reward.resourceCode) {
            case ResourceCodeTypeEnum.COIN: return `金币x${amount}`;
            case ResourceCodeTypeEnum.ADD_TRAY: return `加果盘x${amount}`;
            case ResourceCodeTypeEnum.CLEAR: return `清空果盘x${amount}`;
            case ResourceCodeTypeEnum.ADD: return `加果篮x${amount}`;
            case ResourceCodeTypeEnum.RAINBOW: return `彩虹果x${amount}`;
            case ResourceCodeTypeEnum.BOMB: return `炸弹果x${amount}`;
            case ResourceCodeTypeEnum.RAINBOW_BOMB: return `彩虹果x${amount} 炸弹果x${amount}`;
            default: return `奖励x${amount}`;
        }
    }

    /** 奖励纯入账（展示由金光弹窗负责）。商城购买复用（COLLECT 分支目前只走每日挑战/无限模式弹窗链，
     * 调用前已由 showRewardChain/showEndlessClearChain 的 ensureCollectCodeCached 确保该 code 到位） */
    grantRewardSilently(reward: RewardItem) {
        if (reward.itemType === ItemTypeEnum.COLLECT) {
            const item = reward.collectCode ? this.collectCodeCache.get(reward.collectCode) : undefined;
            if (item) CollectStore.own(item.id, reward.amount || 1);
            return;
        }
        const amount = reward.amount || 0;
        if (amount <= 0) return;
        switch (reward.resourceCode) {
            case ResourceCodeTypeEnum.COIN:
                this.totalCoins += amount;
                localStorage.setItem('totalCoins', this.totalCoins.toString());
                return;
            case ResourceCodeTypeEnum.ADD_TRAY:
                PropStore.addTools('addTray', amount);
                return;
            case ResourceCodeTypeEnum.CLEAR:
                PropStore.addTools('clear', amount);
                return;
            case ResourceCodeTypeEnum.ADD:
                PropStore.addTools('addBasket', amount);
                return;
            case ResourceCodeTypeEnum.RAINBOW:
                PropStore.addFruits('rainbow', amount);
                return;
            case ResourceCodeTypeEnum.BOMB:
                PropStore.addFruits('bomb', amount);
                return;
            case ResourceCodeTypeEnum.RAINBOW_BOMB:
                PropStore.addFruits('rainbow', amount);
                PropStore.addFruits('bomb', amount);
                return;
            default:
                return;
        }
    }

    /** 取 DailyDriver 以读通关成绩；非每日挑战返回 null */
    private getDailyDriverForResult(): DailyDriver | null {
        return this.driver instanceof DailyDriver ? this.driver : null;
    }

    /**
     * 无限模式过关结算页：顶部 banner_success 横幅 + 中间后端返回的奖励图/文案 + 底部「领取奖励」橙钮。
     * 普通关只发金币；5 的倍数关发金币+按权重抽一个（EndlessDriver.getClearReward 返回列表），链式展示；
     * 领完（或查询失败）点击按钮进下一关。
     */
    private renderSuccessModal() {
        if (!this.modalLayerNode) return;

        // 金币已在果篮清除时实时累加，这里无需重复（过关锁定在 dispatchClear 里统一做）
        this.modalLayerNode.destroyAllChildren();

        const driver = this.driver;
        // 收集抽奖前先取已拥有的 collectCode 列表传给后端排除（全部拥有则后端回退全量抽）；
        // getOwnedCodes 按本地已拥有 id 批量查，不整表拉取
        const pending = driver.getClearReward
            ? CollectStore.getOwnedCodes().then((ownedCodes) =>
                driver.getClearReward!(this.currentLevel, ownedCodes))
            : Promise.resolve(null);
        pending.then((rewards) => {
            if (!this.modalLayerNode) return;
            const list = rewards && rewards.length > 0 ? rewards : null;
            this.showEndlessClearChain(list, 0);
        }).catch(() => {
            if (!this.modalLayerNode) return;
            this.showEndlessClearChain(null, 0);
        });
    }

    /** 无限结算链：逐个展示奖励（null 时只显横幅），领完进下一关。
     * 先按需查这一条的 collectCode 目录，rewardDisplayName/grantRewardSilently 才能正确按 collectCode 查到名字/id */
    private showEndlessClearChain(list: RewardItem[] | null, idx: number) {
        const reward = list ? list[idx] : null;
        this.ensureCollectCodeCached(reward?.collectCode).then(() => {
            if (!this.modalLayerNode) return;
            this.renderEndlessClearModal(reward, () => {
                if (reward) {
                    this.grantRewardSilently(reward);
                    this.renderTools();
                } else {
                    this.showCoinShortageTip('奖励领取失败，请稍后再试');
                }
                if (list && idx + 1 < list.length) {
                    this.showEndlessClearChain(list, idx + 1);
                    return;
                }
                // 领完（或失败）：进下一关
                this.modalLayerNode?.destroyAllChildren();
                this.currentLevel = this.driver.advanceLevel(this.currentLevel);
                this.transitionToNewLevel();
            });
        });
    }

    /** 无限结算页布局：顶部横幅 + 中间奖励图/文案 + 底部「领取奖励」橙钮 */
    private renderEndlessClearModal(reward: RewardItem | null, onClaim: () => void) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.destroyAllChildren();

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 150), 0);

        const panelNode = this.createNode('EndlessClearPanel', this.modalLayerNode, 0, 0, 320, 420);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 顶部：过关横幅（512x274 → 显示宽 260）
        const bannerNode = this.createNode('SuccessBanner', panelNode, 0, 150, 260, 139);
        const bannerSprite = bannerNode.addComponent(Sprite);
        bannerSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/banner_success/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && bannerSprite.isValid) {
                bannerSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        if (reward) {
            // 中间：奖励图 + 恭喜文案
            const imgNode = this.createNode('RewardImg', panelNode, 0, 20, 150, 150);
            const imgSprite = imgNode.addComponent(Sprite);
            imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            this.loadRemoteImage(reward.imageUrl, imgSprite, () => {
                if (!imgNode.isValid) return;
                const ph = imgNode.addComponent(Graphics);
                ph.fillColor = new Color(255, 214, 90, 255);
                ph.circle(0, 0, 60);
                ph.fill();
            });
            imgNode.setScale(0.5, 0.5, 1);
            tween(imgNode).to(0.3, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();

            const text = this.createLabel(panelNode, `恭喜获得${this.rewardDisplayName(reward)}`, 0, -85, 22, new Color(255, 255, 255, 255), true);
            const textOutline = text.node.addComponent(LabelOutline);
            if (textOutline) {
                textOutline.color = new Color(122, 74, 20, 255);
                textOutline.width = 3;
            }
        }

        // 底部「领取奖励」按钮
        const btn = this.createSeparatedActionButton(
            panelNode, 420, { text: '领取奖励', pay: 'free' }, false,
            { asset: 'btn_action', name: 'BtnClaimClear', yOffset: -55 }
        );
        btn.on(Node.EventType.TOUCH_END, onClaim, this);

        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    private readonly FRUIT_BLOCK_COVERAGE = 0.1;

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
            if (other.id === plate.id || other.removed) continue;
            // 掉落中但还没卡住的板子：马上就走了，不算遮挡
            if (other.state === 'falling' && !other.stuck) continue;
            // 卡住不动的掉落板仍按层级判断：只有排在 plate 前面（layer 更大）的才能挡它的果子，
            // 避免卡住的板子无视层级去挡本该在它前面、露在外面的果子
            if (other.layer <= plate.layer) continue;

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
     * 或者自己已经没被压住了（遮挡跌到 layerRules.unburyRatio 以下，单块翻彩）。
     */
    private isPlateBuried(plate: PlateData) {
        if (plate.removed || plate.state === 'falling') return false;
        if ((plate.wave ?? 0) <= this.loadedWave) return false;
        return this.getPlateCoverRatio(plate) >= this.layerRules.unburyRatio;
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
            if (this.getPlateCoverRatio(plate) >= this.layerRules.unburyRatio) return;
            plate.buried = false;
            this.revealPlate(plate);
        });
    }
    
    /**
     * 计数驱动的补层：剩余果子一跌破“首批总果量 × refillRatio”，就把下一层启用（灰→彩），
     * 同时把再下一层垫成灰板预告；启用完果数就回到阀值之上，所以一次只会启用一层。
     */
    private ensureLayerBudget() {
        let guard = 0;
        while (this.loadedWave < this.maxWave && guard++ <= this.layerRules.maxLayers) {
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
                        bgSprite.color = new Color(255, 255, 255, 120 + (PLATE_ALPHA - 120) * (ratio ?? 0));
                    },
                })
                .start();
        } else if (bgSprite) {
            // 手动插值而不直接 tween Sprite.color：color 的 getter 返回的是内部引用，
            // 交给 tween 取起始值会被后续赋值污染，过渡到一半就可能崩掉
            const from = PLATE_BURIED_COLOR;
            const to = new Color(tint.r, tint.g, tint.b, PLATE_ALPHA);
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
            // 白边也会跟着被染成同色系。alpha 取 PLATE_ALPHA，与普通彩板同口径
            bgSprite.color = new Color(255, 255, 255, PLATE_ALPHA);
            this.applyBakedPlateTexture(
                bgSprite,
                plate.texture,
                buried ? BAKED_PLATE_GRAY : (plate.bakedColor || BAKED_PLATE_COLORS[0])
            );
        } else {
            bgSprite.color = buried
                ? PLATE_BURIED_COLOR.clone()
                : new Color(tint.r, tint.g, tint.b, PLATE_ALPHA); // PLATE_ALPHA 半透明（180 ≈ 70% 不透明度）

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
            // 长条板原开 CCD(bullet) 防"旋转一帧穿过相邻长条板"，但实测 bullet 在"初始贴合(gap=1)切 Dynamic"
            // 瞬间会把板回退进下层板内部 → 两块板完全重叠、半透明板面透出下层水果。先关闭验证
            rigidBody.bullet = false;

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
                        // addComponent 时已经用默认尺寸(1x1)同步建好了 Box2D 的物理形状，
                        // 改属性只是改了 JS 侧的值，必须 apply() 才会真正重建 fixture
                        boxCol.apply();
                    } else {
                        const circleCol = pivotNode.addComponent(CircleCollider2D);
                        circleCol.group = plateGroup;
                        circleCol.offset = new Vec2(px, py);
                        circleCol.radius = col.r;
                        circleCol.apply();
                    }
                });
            } else {
                const boxCol = pivotNode.addComponent(BoxCollider2D);
                boxCol.group = plateGroup;
                boxCol.offset = new Vec2(-offsetX, -offsetY);
                boxCol.size = new Size(plate.w, plate.h);
                boxCol.apply();
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
                host.destroyAllChildren();
            }
            return;
        }

        if (existing && existing.name === expectedName) {
            return;
        }

        host.destroyAllChildren();
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

            // 解锁文字：图二样式 "解锁果篮"，上移给下方视频图标腾位置
            const lockLabel = this.createLabel(boxNode, '解 锁\n果 篮', 0, boxHeight * 0.13, 18, new Color(255, 255, 255, 255), true);
            const lockOutline = lockLabel.node.addComponent(LabelOutline);
            if (lockOutline) {
                lockOutline.color = new Color(30, 100, 30, 255); // 深绿色描边
                lockOutline.width = 2;
            }
            lockLabel.lineHeight = 28; // 增加行间距使其上下更分散
            lockLabel.node.active = false;

            // 视频图标：摄像机样式（白色机身 + 深绿描边 + 播放三角 + 镜头），仅锁定态显示
            const playIcon = this.createGraphicsNode('PlayIcon', boxNode, 34, 24, 0, -boxHeight * 0.20);
            this.drawVideoIcon(playIcon.getComponent(Graphics)!);
            playIcon.active = false;

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
                // 锁定果篮可点：弹现有的“加果篮”弹窗（看广告 / 花金币）。
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
                playIcon,
                slots,
                lastBodyColor: '',
                lastSlidingOut: false
            });
        }
    }

    private ensureTempSlotViews() {
        if (!this.tempContainerNode) return;

        if (this.tempSlotViews.length === this.maxTempHoles) return;

        const slotRadius = 12;
        const spacing = slotRadius * 2 + 5;
        const startX = -spacing * (this.maxTempHoles - 1) / 2; // 孔位整体居中（span = spacing*(maxTempHoles-1)，起点 = -span/2）

        // 设置按钮（btn_gear.png，分包）：放到屏幕左上角（挂 topAreaNode，关卡号徽章在正中 x=0，左上角空着）。
        // 游戏区域内不再显示金币余额（HUD 已移除，仅首页展示）；此按钮首次调用时创建，功能不变
        if (!this.settingsBtnNode) {
            const iconH = 36;
            const gearBtnNode = this.createNode('SettingsBtn', this.topAreaNode!, -this.screenWidth / 2 + 28, this.topHeight / 2 - 30, iconH, iconH);
            this.settingsBtnNode = gearBtnNode;
            const gearSprite = gearBtnNode.addComponent(Sprite);
            gearSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>('ui/btn_gear/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && gearSprite.isValid) {
                    gearSprite.spriteFrame = sf;
                }
            }).catch(() => {});
            gearBtnNode.on(Node.EventType.TOUCH_END, () => {
                SoundManager.getInstance()?.playSystemClick();
                this.renderSettingsModal(true);
            }, this);
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
            // 锁定图标：右侧 1 个孔位（index 4）默认带锁，用加果盘解开
            // 图 62x90 竖版，按原比例显示 20x29（孔位 24px 内不压不变形）
            const lockNode = this.createNode(`TempLock_${index}`, slotNode, 0, 0, 20, 29);
            const lockSprite = lockNode.addComponent(Sprite);
            lockSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>('ui/icon_lock/spriteFrame', SpriteFrame).then((sf) => {
                if (sf && lockSprite && lockNode.isValid) {
                    lockSprite.spriteFrame = sf;
                }
            }).catch(() => {});
            lockNode.active = false;
            this.tempSlotViews.push({ node: slotNode, hole, fruitHost, lock: lockNode });
        }
    }

    private ensureToolViews() {
        if (!this.toolContainerNode || this.toolViews.length > 0) return;

        const toolList = [
            { key: 'addTray' as const, label: '加果盘', icon: '🍽️' },
            { key: 'clear' as const, label: '清空果盘', icon: '🧹' }
        ];
        const buttonWidth = 74;
        const buttonHeight = 82;
        // 三个按钮（加果盘/清空果盘/特殊果）等距居中
        const gap = (this.screenWidth - 40 - buttonWidth * 3) / 2;
        const startX = -((buttonWidth * 3 + gap * 2) / 2) + buttonWidth / 2;
        const badgeX = buttonWidth / 2 - 6;
        const badgeY = buttonHeight / 2 - 6;

        toolList.forEach((tool, index) => {
            const x = startX + index * (buttonWidth + gap);
            const btnNode = this.createNode(`ToolBtn_${tool.key}`, this.toolContainerNode!, x, 0, buttonWidth, buttonHeight);

            // 使用 Sprite 显示按钮背景
            const btnSprite = btnNode.addComponent(Sprite);
            btnSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            btnSprite.type = Sprite.Type.SLICED;
            const imageName = tool.key === 'addTray' ? 'btn_add_tray' : 'btn_clear_tray';
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

        // 特殊果按钮（第 3 个）：点击弹特殊果弹窗，角标=彩虹果+炸弹果总数
        const sfX = startX + 2 * (buttonWidth + gap);
        const sfNode = this.createNode('ToolBtn_specialFruit', this.toolContainerNode!, sfX, 0, buttonWidth, buttonHeight);
        const sfSprite = sfNode.addComponent(Sprite);
        sfSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sfSprite.type = Sprite.Type.SLICED;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/btn_special_fruit/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sfSprite && sfNode.isValid) {
                sfSprite.spriteFrame = sf;
            }
        }).catch(() => {});
        const sfTextLabel = this.createLabel(sfNode, '特殊果', 0, -22, 14, new Color(255, 255, 255, 255), true);
        const sfOutline = sfTextLabel.node.addComponent(LabelOutline);
        if (sfOutline) {
            sfOutline.color = new Color(50, 100, 150, 255);
            sfOutline.width = 1.5;
        }
        const sfBadgeNode = this.createGraphicsNode('Badge', sfNode, 26, 26, badgeX, badgeY);
        sfBadgeNode.active = false;
        this.specialFruitBadge = sfBadgeNode.getComponent(Graphics)!;
        this.specialFruitBadgeLabel = this.createLabel(sfNode, '', badgeX, badgeY, 16, new Color(255, 255, 255, 255), true);
        this.specialFruitBadgeLabel.node.active = false;
        this.specialFruitBtnNode = sfNode;
        sfNode.on(Node.EventType.TOUCH_END, () => {
            this.renderSpecialFruitModal();
        }, this);
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
            const maxSize = diameter * 1.5; // 水果贴图最大边：孔距最密 32px，1.5×20=30px 时相邻果子仍留 2px 间隙
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

    /** 绘制摄像机样式的视频播放图标：白色机身 + 描边（默认深绿）+ 中央播放三角 + 右侧镜头 */
    private drawVideoIcon(graphics: Graphics, stroke: Color = new Color(30, 100, 30, 255)) {
        graphics.clear();
        graphics.lineWidth = 2;
        graphics.strokeColor = stroke;
        graphics.fillColor = new Color(255, 255, 255, 255);
        // 镜头：右侧梯形（先画镜头，让机身盖住接缝）
        graphics.moveTo(7, 4);
        graphics.lineTo(14, 7.5);
        graphics.lineTo(14, -7.5);
        graphics.lineTo(7, -4);
        graphics.close();
        graphics.fill();
        graphics.stroke();
        // 机身：圆角矩形（中心偏左，右侧留镜头位置）
        graphics.roundRect(-15.5, -8, 23, 16, 4);
        graphics.fill();
        graphics.stroke();
        // 播放三角：机身中央，描边同色实心
        graphics.fillColor = stroke;
        graphics.moveTo(-7.5, 4.5);
        graphics.lineTo(-7.5, -4.5);
        graphics.lineTo(1, 0);
        graphics.close();
        graphics.fill();
    }

    /** 绘制五角星 */
    public drawStar(graphics: Graphics, size: number, fill: Color) {
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
        'crimson': 'Pomegranate', // 石榴
        'brown': 'Potato',    // 土豆
        'grape': 'Grape',     // 葡萄
        'banana': 'Banana',   // 香蕉
        'melon': 'Watermelon', // 西瓜
        'cherry': 'Cherry',   // 樱桃
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
        'crimson': '石榴',
        'brown': '土豆',
        'grape': '葡萄',
        'banana': '香蕉',
        'melon': '西瓜',
        'cherry': '樱桃',
        'rainbow': '彩虹果',
    };

    private async loadFruitSprites(): Promise<void> {
        if (this.fruitsLoaded) return;
        return new Promise((resolve) => {
            // 普通水果从 resources 主包加载，彩虹果从分包加载
            const regularFruits = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot', 'Pomegranate', 'Potato', 'Grape', 'Banana', 'Watermelon', 'Cherry'];
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
                BundleManager.getInstance().loadAsset<SpriteFrame>(`fruits/${name}/spriteFrame`, SpriteFrame).then((spriteFrame) => {
                    loaded++;
                    if (spriteFrame) {
                        this.fruitSprites.set(name, spriteFrame);
                    }
                    tryResolve();
                }).catch(() => {
                    loaded++;
                    console.warn(`[Fruit] failed to load ${name}`);
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

    /**
     * 加载灰度果篮底图和板子底图（用于运行时动态染色）。
     * warmed 传入时直接复用 Loading 页已加载好的 SpriteFrame，不重新打一次分包请求。
     */
    private async loadBasketBase(warmed?: Promise<{ basket: SpriteFrame | null; plate: SpriteFrame | null }>): Promise<void> {
        if (warmed) {
            const { basket, plate } = await warmed;
            if (!this.basketSpriteFrame && basket) this.basketSpriteFrame = basket;
            if (!this.plateSpriteFrame && plate) this.plateSpriteFrame = plate;
            return;
        }
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

    /**
     * 分享并发放奖励。
     * 【死代码，未接线】全项目搜索确认当前无任何调用方，是废弃流程。
     * 已被数据库配置驱动的 help_max 求助机制（tryDailyHelp，见 getGameConfig().helpMax）取代，
     * 现在实际生效的次数上限是数据库 game_config 表 help_max 配置（当前为4），不是本方法里的任何数值。
     * 牵连的同样是死代码、未删除（保留以防其他地方有隐性依赖）：
     * getHelpButtonState()、isShareLimitReached()、setShareLimitReached()、pendingShareCallback、
     * shareStartTime、renderModal() 的 secondButton/secondOnConfirm 双按钮分支、
     * 后端 /api/game/share/consume 接口（UserService.consumeShareCount，硬编码5次，与数据库配置的4次不是同一套）。
     */
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

    /** 从排行榜返回游戏：只重建视图，继续当前局面（局面数据与金币都不动） */
    public goBackToGame() {
        this.rebuildGameView();
        this.renderAll();
    }

    /**
     * 从首页进入无限模式：重开一局全新局面（关卡号保持不变）。
     * 与 goBackToGame 的区别是要走 initGame 重新生成关卡。
     */
    public startGameFromHome() {
        this.rebuildGameView();
        this.initGame();
    }

    /** 重建游戏视图骨架（不碰局面数据），goBackToGame 与 startGameFromHome 共用 */
    private rebuildGameView() {
        this.rankPage.close();
        this.storagePage.close();
        this.shopPage.close();
        if (this.rootNode) {
            this.rootNode.destroyAllChildren();
        }
        this.gameOver = false;
        this.plateNodes.clear();
        this.fallingPlateNodes.clear();
        this.boxViews = [];
        this.tempSlotViews = [];
        this.toolViews = [];
        this.setupLayout();
    }

    /** 确保游戏界面存在：从首页打开设置弹窗点重开时，需先重建游戏布局再 initGame */
    private ensureGameUI() {
        if (this.boardAreaNode && this.boardAreaNode.isValid) return;
        this.homePage.close();
        this.rankPage.close();
        this.storagePage.close();
        this.shopPage.close();
        if (this.rootNode) {
            this.rootNode.destroyAllChildren();
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
        this.specialFruitBadge = null;
        this.specialFruitBadgeLabel = null;
        this.specialFruitBtnNode = null;
        // 设置按钮随主界面销毁，置空以便返回游戏时重建
        this.settingsBtnNode = null;
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
