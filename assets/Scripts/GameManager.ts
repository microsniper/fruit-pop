import { _decorator, Component, Node, Vec3, UITransform, Label, Color, tween, Graphics, director, Canvas, Widget, Mask, screen, ResolutionPolicy, Layers, Sprite, SpriteFrame, resources, ImageAsset, ScrollView, EditBox } from 'cc';
import { saveProgress, loginAndGetProgress, fetchRank, RankItem, consumeShareCount, hasUserProfile, updateProfile } from './api';
import { SoundManager } from './SoundManager';
import { AdManager } from './AdManager';

// @ts-ignore
import { SDK } from '@dn-sdk/minigame/build/index.js';

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

interface PlateTemplate {
    type: 'circle' | 'rect';
    w: number;
    h: number;
    holes: { x: number; y: number }[];
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
    supportPlateId?: string;
    supportY?: number;
    isFalling?: boolean;
    fallDistance?: number;
    rotation?: number;
    gravityOrigin?: { x: number; y: number };
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

const PLATE_TEMPLATES: PlateTemplate[] = [
    { type: 'rect', w: 160, h: 160, holes: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.2, y: 0.8 }, { x: 0.8, y: 0.8 }] },
    { type: 'rect', w: 140, h: 140, holes: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.8 }] },
    { type: 'rect', w: 110, h: 110, holes: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }] },
    { type: 'rect', w: 180, h: 100, holes: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] },
    { type: 'rect', w: 100, h: 180, holes: [{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }] },
    { type: 'circle', w: 140, h: 140, holes: [{ x: 0.5, y: 0.5 }] }
];

const BOX_COLORS: Record<FruitColor, Color> = {
    [FruitColor.RED]: new Color(220, 80, 70),
    [FruitColor.BLUE]: new Color(240, 195, 60),    // 玉米黄
    [FruitColor.YELLOW]: new Color(240, 190, 50),
    [FruitColor.PINK]: new Color(235, 120, 150),
    [FruitColor.ORANGE]: new Color(245, 150, 60),
    [FruitColor.GREEN]: new Color(100, 190, 120),
    [FruitColor.PURPLE]: new Color(155, 85, 195),
    [FruitColor.CYAN]: new Color(240, 130, 50),     // 胡萝卜橙
    [FruitColor.RAINBOW]: new Color(255, 255, 255)  // 彩虹果（白色底）
};

const FACE_COLORS: Record<PlateTheme, Color> = {
    yellow: new Color(200, 170, 100, 255),
    blue: new Color(180, 150, 110, 255)
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
const SUPPORT_SAMPLE_COUNT = 21;
const SUPPORT_RATIO_THRESHOLD = 0.3;
const SUPPORT_MIN_CONTINUOUS_SAMPLES = 6;
const SUPPORT_CONTACT_TOLERANCE = 3;
const SUPPORT_MIN_DROP_DISTANCE = 6;
const SUPPORT_SURFACE_SCAN_STEP = 4;
const SUPPORT_SURFACE_REFINE_ITERATIONS = 8;

let tutorialShown = false;
let rainbowIntroduced = false;
let challengeTipShown = false;

@ccclass('GameManager')
export class GameManager extends Component {
    private rootNode: Node | null = null;
    private currentLevel = 1;
    private maxTempHoles = 5;
    private totalFruits = 0;
    private removedFruits = 0;
    private gameOver = false;
    private loadingNode: Node | null = null;

    private boxes: BoxData[] = [];
    private tempHoles: FruitColor[] = [];
    private plates: PlateData[] = [];
    private tools = { add: 0, clear: 1 };

    private topAreaNode: Node | null = null;
    private boardAreaNode: Node | null = null;
    private boardContentNode: Node | null = null;
    private boardEffectNode: Node | null = null;
    private bottomAreaNode: Node | null = null;
    private boxesContainerNode: Node | null = null;
    private tempContainerNode: Node | null = null;
    private toolContainerNode: Node | null = null;
    private modalLayerNode: Node | null = null;
    private rankPageNode: Node | null = null;
    private defaultAvatarsLoaded = false;
    private defaultAvatarFrames: SpriteFrame[] = [];
    private fruitSprites: Map<string, SpriteFrame> = new Map();
    private fruitsLoaded = false;
    /** 灰度果篮底图，运行时动态染色 */
    private basketSpriteFrame: SpriteFrame | null = null;
    /** 分享图片本地路径缓存 */
    private shareImageUrls: Record<string, string> = {};
    /** 待执行的分享奖励回调 */
    private pendingShareCallback: (() => void) | null = null;
    /** 记录点击分享拉起微信面板时的时间戳，用于防御秒关白嫖 */
    private shareStartTime = 0;
    /** 上次收集水果的时间戳（毫秒），用于连击判定 */
    private lastCollectTime = 0;

    /** 腾讯广告 SDK 实例 */
    private tencentAdsSDK: any = null;

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

    private getTodayStr(): string {
        const d = new Date();
        return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}`;
    }

    private getTencentAdsOpenId(): string {
        try {
            if (typeof wx !== 'undefined') {
                return wx.getStorageSync('openid') || '';
            }
            return localStorage.getItem('openid') || '';
        } catch {
            return '';
        }
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
    private tempSlotViews: TempSlotView[] = [];
    private toolViews: ToolView[] = [];

    private screenWidth = 0;
    private screenHeight = 0;
    private topHeight = 0;
    private boardHeight = 0;
    private bottomHeight = 0;
    private boardWidth = 0;

    async start() {
        this.setupLayout();

        if (typeof wx !== 'undefined' && typeof wx.onNeedPrivacyAuthorization === 'function') {
            wx.onNeedPrivacyAuthorization((resolve: any) => {
                resolve({ buttonId: 'agree', event: 'agree' });
            });
        }

        // 初始化腾讯广告 SDK
        if (typeof wx !== 'undefined') {
            try {
                // @ts-ignore
                this.tencentAdsSDK = new SDK({
                    appid: 'wx1b17732d2eaef53a',
                    user_action_set_id: 1222652382,
                    secret_key: '2243d8ef6c26f8dcae8d61a9aa0d9233',
                });
                console.log('[TencentAds] SDK init success');
            } catch (e) {
                console.error('[TencentAds] SDK init failed:', e);
            }
        }

        this.initSound();
        this.initAd();
        this.showLoadingOverlay();
        const loadStart = Date.now();
        this.currentLevel = await loginAndGetProgress();
        
        // 登录后设置 openid 到广告 SDK，并手动上报注册（联调阶段无条件触发）
        if (this.tencentAdsSDK) {
            try {
                const openid = this.getTencentAdsOpenId();
                if (openid) {
                    // @ts-ignore
                    this.tencentAdsSDK.setOpenId(openid);
                    console.log('[TencentAds] openid set:', openid);

                    // 联调阶段：无条件触发一次注册上报
                    // @ts-ignore
                    if (this.tencentAdsSDK.onRegister) {
                        // @ts-ignore
                        this.tencentAdsSDK.onRegister();
                    } else {
                        // @ts-ignore
                        this.tencentAdsSDK.track('REGISTER');
                    }
                    console.log('[TencentAds] track REGISTER manual trigger');
                }
            } catch (e) {
                console.error('[TencentAds] setOpenId or track REGISTER failed:', e);
            }
        }

        await this.loadFruitSprites();  // 确保水果图片加载完成后再初始化游戏
        await this.loadBasketBase();    // 加载灰度果篮底图
        this.preloadShareImages();      // 预加载分享图片
        this.initGame();
        const elapsed = (Date.now() - loadStart) / 1000;
        const delay = Math.max(0, 2.0 - elapsed);
        this.scheduleOnce(() => {
            this.hideLoadingOverlay();
            this.scheduleOnce(() => this.showTutorialIfNeeded(), 0.35);
        }, delay);
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

    private showTutorialIfNeeded() {
        if (this.currentLevel !== 1) return;
        if (tutorialShown) return;

        tutorialShown = true;

        this.renderModal({
            title: '🎉 欢迎来到果园',
            sub: '🍎 点击果子 → 投入同色果篮\n🧺 凑满果篮 → 自动清空继续\n🍃 树枝清空 → 掉落露出新果子\n\n没合适果篮？先放果盘暂存！',
            button: '知道了！',
            onConfirm: () => {}
        });
    }

    private showRainbowTutorial() {
        this.renderModal({
            title: '🌈 彩虹果！',
            sub: '彩虹果是万能果实！\n✨它可以放入任意果篮，无视颜色\n哪里有空位就能去哪里\n\n合理利用彩虹果，轻松过关～',
            button: '太棒了！',
            onConfirm: () => {},
            height: 280
        });
    }

    private showChallengeTip() {
        this.renderModal({
            title: '⚡ 挑战关卡',
            sub: '果篮刷新变懒了！不再优先帮你匹配颜色，\n规划好再摘，别让暂存盘塞满～',
            button: '知道了',
            onConfirm: () => {},
            height: 240
        });
    }

    private showLoadingOverlay() {
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

    private hideLoadingOverlay() {
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
        
        this.topHeight = this.screenHeight * 0.31;
        this.bottomHeight = this.screenHeight * 0.16;
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
        const topBg = this.createGraphicsNode('TopBg', this.topAreaNode, this.screenWidth, this.topHeight, 0, 0);
        this.drawRoundedRect(topBg.getComponent(Graphics)!, this.screenWidth, this.topHeight, new Color(245, 248, 235, 255), 0);

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
        this.tempContainerNode = this.createNode('TempSlots', this.topAreaNode, 0, -this.topHeight * 0.26 - TOP_CONTENT_OFFSET, this.screenWidth - 60, 90);
        this.toolContainerNode = this.createNode('Tools', this.bottomAreaNode, 0, 0, this.screenWidth - 40, this.bottomHeight - 10);
    }

    private buildStaticTopUI() {
        if (!this.topAreaNode) return;

        const topInnerY = this.topHeight / 2 - 42 - TOP_CONTENT_OFFSET;

        this.levelBadgeLabel = this.createLabel(this.topAreaNode, '第 1 关', 0, topInnerY + 8, 22, new Color(80, 55, 30, 255), true);

        const badge = this.createGraphicsNode('LevelBadgeBg', this.topAreaNode, 130, 44, 0, topInnerY + 8);
        badge.setSiblingIndex(0);
        this.drawRoundedRect(badge.getComponent(Graphics)!, 130, 44, new Color(130, 160, 90, 255), 22);

        const rankBtnX = -this.screenWidth / 2 + 60;
        const rankBtnNode = this.createNode('RankBtn', this.topAreaNode, rankBtnX, topInnerY + 8, 90, 36);
        
        // 暂时隐藏排行榜按钮
        rankBtnNode.active = true;
        
        const rankBtnBg = this.createGraphicsNode('RankBtnBg', rankBtnNode, 90, 36, 0, 0);
        this.drawRoundedRect(rankBtnBg.getComponent(Graphics)!, 90, 36, new Color(200, 160, 60, 255), 18);
        const rankLabel = this.createLabel(rankBtnNode, '🏆排行榜', 0, 0, 14, new Color(255, 255, 255, 255), true);

        rankBtnNode.on(Node.EventType.TOUCH_END, () => {
            this.handleRankButtonClick();
        }, this);

        this.progressLabel = null;
    }

    private initGame() {
        this.gameOver = false;
        this.plates = [];
        this.tempHoles = [];
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

        // 关卡含彩虹果且首次出现时，弹出提示
        if (!rainbowIntroduced) {
            const hasRainbowInLevel = this.plates.some(p => p.fruits?.some(s => !s.removed && s.color === FruitColor.RAINBOW));
            if (hasRainbowInLevel) {
                rainbowIntroduced = true;
                this.scheduleOnce(() => this.showRainbowTutorial(), 0.5);
            }
        }

        // 5的倍数关卡，弹出挑战提示
        if (this.currentLevel % 5 === 0 && !challengeTipShown) {
            challengeTipShown = true;
            this.scheduleOnce(() => this.showChallengeTip(), 0.8);
        }
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
                ? new Color(140, 120, 90, 255)
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

                // 锁状态的 X 覆盖层
                if (isLocked) {
                    view.lockOverlay.node.active = true;
                    view.lockOverlay.clear();
                    view.lockOverlay.strokeColor = new Color(60, 40, 20, 200);
                    view.lockOverlay.lineWidth = 3;
                    const hh = boxHeight / 2;
                    view.lockOverlay.moveTo(-hh * 0.3, -hh * 0.3);
                    view.lockOverlay.lineTo(hh * 0.3, hh * 0.3);
                    view.lockOverlay.stroke();
                    view.lockOverlay.moveTo(-hh * 0.3, hh * 0.3);
                    view.lockOverlay.lineTo(hh * 0.3, -hh * 0.3);
                    view.lockOverlay.stroke();
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

            // 有果子放入后，隐藏背景图标；汉字保留
            if (isActive && this.isValidPrimaryBoxFruitColor(box.color)) {
                const hasFruits = box.fruits && box.fruits.length > 0;
                view.fruitIcon.node.active = !hasFruits && view.fruitIcon.spriteFrame !== null;
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
                
                // 动态绘制孔洞大小
                const holeRadius = boxCapacity >= 6 ? 10 : 12;
                this.drawCircle(slotView.hole, holeRadius, new Color(0, 0, 0, 35), 0);

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

        const containerW = this.screenWidth - 154;
        const containerH = 36;
        if (this.tempBgGraphics) {
            this.drawRoundedRect(this.tempBgGraphics, containerW, containerH, new Color(215, 225, 190, 255), 15, 2, new Color(180, 195, 160, 180));
        }

        this.tempSlotViews.forEach((slotView, index) => {
            const color = this.tempHoles[index];
            this.updateFruitHost(slotView.fruitHost, 26, color);
        });
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
            view.iconLabel.string = tool.icon;
            view.iconLabel.color = (tool.count <= 0 && tool.key !== 'add' && tool.key !== 'clear')
                ? new Color(200, 200, 200, 255)
                : new Color(255, 255, 255, 255);
            const badgeColor = (tool.count <= 0 && tool.key !== 'add' && tool.key !== 'clear') ? new Color(160, 150, 130, 255) : new Color(220, 160, 50, 255);
            this.drawCircle(view.badge, 13, badgeColor, 3, new Color(255, 245, 220, 255));
            view.badgeLabel.string = String(tool.count > 0 ? tool.count : '+');
        });
    }

    private renderBoard() {
        if (!this.boardContentNode) return;
        this.boardContentNode.removeAllChildren();
        this.plateNodes.clear();

        const visiblePlates = this.plates.filter((plate) => !plate.removed).sort((a, b) => a.layer - b.layer);
        visiblePlates.forEach((plate) => {
            this.createPlateNode(this.boardContentNode!, plate, true);
        });
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
        const numTriplets = Math.min(15, 2 + levelNum);
        const fruitsToPlace: FruitColor[] = [];

        for (let i = 0; i < numTriplets; i++) {
            const color = activeColors[Math.floor(Math.random() * activeColors.length)];
            fruitsToPlace.push(color, color, color);
        }

        fruitsToPlace.sort(() => Math.random() - 0.5);

        // 彩虹果：从第6关开始出现，数量随关卡递增
        const RAINBOW_START_LEVEL = 6;
        if (levelNum >= RAINBOW_START_LEVEL) {
            let rainbowCount = 1;
            if (levelNum >= 12) rainbowCount = 2;
            if (levelNum >= 20) rainbowCount = 3;
            for (let i = 0; i < rainbowCount; i++) {
                fruitsToPlace.push(FruitColor.RAINBOW);
            }
        }

        this.totalFruits = fruitsToPlace.length;

        const distinctColors = [...new Set(fruitsToPlace)].filter(c => c !== FruitColor.RAINBOW);
        this.boxes[0].color = distinctColors[0] || FruitColor.YELLOW;
        if (distinctColors.length > 1) {
            this.boxes[1].color = distinctColors[1];
        } else {
            const otherColors = activeColors.filter((color) => color !== distinctColors[0]);
            this.boxes[1].color = otherColors.length > 0
                ? otherColors[Math.floor(Math.random() * otherColors.length)]
                : (distinctColors[0] || FruitColor.BLUE);
        }

        let availableTemplates = PLATE_TEMPLATES;
        if (levelNum === 1) {
            availableTemplates = PLATE_TEMPLATES.filter((template) => template.holes.length >= 3);
        }

        // 高难度下动态加入“长条恶心板”模板
        if (levelNum > 5) {
            const barProbability = Math.min(0.3, (levelNum - 5) * 0.05);
            if (Math.random() < barProbability) {
                const isHorizontal = Math.random() > 0.5;
                const barTemplate = isHorizontal
                    ? { type: 'rect' as const, w: 320, h: 90, holes: [{ x: 50, y: 45 }, { x: 160, y: 45 }, { x: 270, y: 45 }] }
                    : { type: 'rect' as const, w: 90, h: 320, holes: [{ x: 45, y: 50 }, { x: 45, y: 160 }, { x: 45, y: 270 }] };
                availableTemplates = [...availableTemplates, barTemplate];
            }
        }

        // 10关后加入宽横板（6孔），20关后加入巨方板（7孔）
        if (levelNum >= 20) {
            const jumboProbability = Math.min(0.25, (levelNum - 20) * 0.02);
            if (Math.random() < jumboProbability) {
                const jumboTemplate = { type: 'rect' as const, w: 200, h: 200, holes: [
                    { x: 0.12, y: 0.12 }, { x: 0.50, y: 0.10 }, { x: 0.88, y: 0.12 },
                    { x: 0.25, y: 0.50 }, { x: 0.75, y: 0.50 },
                    { x: 0.12, y: 0.88 }, { x: 0.88, y: 0.88 }
                ]};
                availableTemplates = [...availableTemplates, jumboTemplate];
            }
        }
        if (levelNum >= 10) {
            const wideProbability = Math.min(0.35, (levelNum - 10) * 0.03);
            if (Math.random() < wideProbability) {
                const wideTemplate = { type: 'rect' as const, w: 260, h: 120, holes: [
                    { x: 0.12, y: 0.25 }, { x: 0.38, y: 0.22 }, { x: 0.62, y: 0.25 },
                    { x: 0.18, y: 0.75 }, { x: 0.50, y: 0.78 }, { x: 0.82, y: 0.75 }
                ]};
                availableTemplates = [...availableTemplates, wideTemplate];
            }
        }

        const spreadFactor = Math.max(0.62, 1.16 - levelNum * 0.07);
        const rangeX = 168 * spreadFactor;
        const rangeY = 228 * spreadFactor;
        const centerYOffset = 12;
        const generatedCenters: { x: number; y: number }[] = [];
        let totalHolesAvailable = 0;
        let plateIndex = 0;

        while (totalHolesAvailable < this.totalFruits) {
            const template = availableTemplates[Math.floor(Math.random() * availableTemplates.length)];
            let x = 0;
            let y = 0;
            let bestDistance = -1;

            for (let tryCount = 0; tryCount < 10; tryCount++) {
                const tx = (Math.random() * 2 - 1) * rangeX;
                const ty = centerYOffset + (Math.random() * 2 - 1) * rangeY;
                if (generatedCenters.length === 0) {
                    x = tx;
                    y = ty;
                    break;
                }

                let minDistance = 9999;
                generatedCenters.forEach((center) => {
                    const distance = Math.sqrt(Math.pow(tx - center.x, 2) + Math.pow(ty - center.y, 2));
                    if (distance < minDistance) {
                        minDistance = distance;
                    }
                });

                if (minDistance > bestDistance) {
                    bestDistance = minDistance;
                    x = tx;
                    y = ty;
                }
            }

            const maxLayer = levelNum === 1 ? 1 : Math.min(8, 2 + Math.floor(levelNum * 1.4));
            const layer = Math.floor(Math.random() * maxLayer);
            const rotation = template.type === 'circle' ? 0 : (Math.random() > 0.5 ? 0 : 90);
            const renderW = rotation === 90 ? template.h : template.w;
            const renderH = rotation === 90 ? template.w : template.h;

            // 限制板子不要超出棋盘边缘
            const padding = 10;
            const maxLeft = -this.boardWidth / 2 + renderW / 2 + padding;
            const maxRight = this.boardWidth / 2 - renderW / 2 - padding;
            const maxBottom = -this.boardHeight / 2 + renderH / 2 + padding;
            const maxTop = this.boardHeight / 2 - renderH / 2 - padding;

            x = Math.max(maxLeft, Math.min(maxRight, x));
            y = Math.max(maxBottom, Math.min(maxTop, y));

            generatedCenters.push({ x, y });

            const actualHoles = template.holes.map((hole) => {
                if (rotation === 90) {
                    // 对于标准化坐标 (x,y 在 0~1 之间)，旋转 90 度的映射是 x'=y, y'=1-x
                    // 但我们在添加长条板时，传入的是实际像素坐标，而不是 0~1 的比例！
                    // 为了兼容旧的 PLATE_TEMPLATES (0~1比例) 和新的长条板 (实际像素)，这里需要做区分
                    const isRatio = template.holes[0].x <= 1 && template.holes[0].y <= 1;
                    if (isRatio) {
                        return { x: hole.y * template.h, y: (1 - hole.x) * template.w };
                    } else {
                        // 已经是实际像素，旋转 90 度: 以中心点 (w/2, h/2) 旋转
                        const cx = template.w / 2;
                        const cy = template.h / 2;
                        const dx = hole.x - cx;
                        const dy = hole.y - cy;
                        // 旋转后中心点变成了 (h/2, w/2)
                        return { x: template.h / 2 - dy, y: template.w / 2 + dx };
                    }
                }
                
                const isRatio = template.holes[0].x <= 1 && template.holes[0].y <= 1;
                if (isRatio) {
                    return { x: hole.x * template.w, y: hole.y * template.h };
                } else {
                    return { x: hole.x, y: hole.y }; // 已经是像素坐标，直接返回
                }
            });

            this.plates.push({
                id: `p${plateIndex++}`,
                type: template.type,
                color: Math.random() > 0.5 ? 'yellow' : 'blue',
                w: renderW,
                h: renderH,
                x,
                y,
                layer,
                fruits: [],
                holes: actualHoles,
                removed: false,
                state: 'stable',
                supportPlateId: undefined,
                supportY: undefined,
                isFalling: false,
                fallDistance: 0,
                rotation: 0
            });

            totalHolesAvailable += actualHoles.length;
        }

        const allAvailableHoles: { plate: PlateData; holeIndex: number }[] = [];
        this.plates.forEach((plate) => {
            plate.holes.forEach((_, holeIndex) => {
                allAvailableHoles.push({ plate, holeIndex });
            });
        });
        allAvailableHoles.sort(() => Math.random() - 0.5);

        fruitsToPlace.forEach((color, index) => {
            const target = allAvailableHoles.pop();
            if (!target) return;

            const hole = target.plate.holes[target.holeIndex];
            target.plate.fruits.push({
                id: `s_${index}`,
                color,
                x: hole.x,
                y: hole.y,
                removed: false
            });
        });

        this.plates = this.plates.filter((plate) => plate.fruits.length > 0);
        this.plates.forEach((plate) => this.updatePlateGravity(plate));
    }

    private getAvailableFruitsForNewBox(color: FruitColor, targetBox: BoxData): number {
        const totalOutstanding = this.getOutstandingFruitCount(color);
        let reservedByOthers = 0;

        this.boxes.forEach((box) => {
            if (box !== targetBox && box.color === color) {
                reservedByOthers += box.capacity;
            }
        });

        return totalOutstanding - reservedByOthers;
    }

    private getNextCapacityForColor(color: BoxColor, targetBox: BoxData, minCapacity: number = 3): number {
        if (color === 'empty' || color === 'locked') return 3;

        const remaining = this.getAvailableFruitsForNewBox(color as FruitColor, targetBox);
        const normalizedMinCapacity = Math.max(3, Math.min(6, minCapacity));
        const validCaps: number[] = [];
        for (const c of [3, 4, 5, 6]) {
            if (c < normalizedMinCapacity || c > remaining) continue;
            if (remaining - c === 0 || remaining - c >= 3) {
                validCaps.push(c);
            }
        }

        if (validCaps.length === 0) {
            return Math.max(normalizedMinCapacity, Math.min(remaining, 6));
        }

        const desired = this.getBoxCapacity();
        if (validCaps.indexOf(desired) !== -1) {
            return desired;
        }

        return validCaps[Math.floor(Math.random() * validCaps.length)];
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
        if (level <= 6) return 3;
        if (level <= 11) return Math.random() < 0.15 ? 4 : 3;
        if (level <= 16) return Math.random() < 0.35 ? 4 : 3;
        if (level <= 21) {
            const r = Math.random();
            return r < 0.15 ? 5 : (r < 0.50 ? 4 : 3);
        }
        if (level <= 27) {
            const r = Math.random();
            return r < 0.25 ? 5 : (r < 0.60 ? 4 : 3);
        }
        if (level <= 35) {
            const r = Math.random();
            return r < 0.10 ? 6 : (r < 0.40 ? 5 : (r < 0.75 ? 4 : 3));
        }
        if (level <= 45) {
            const r = Math.random();
            return r < 0.15 ? 6 : (r < 0.50 ? 5 : (r < 0.85 ? 4 : 3));
        }
        const r = Math.random();
        return r < 0.25 ? 6 : (r < 0.60 ? 5 : (r < 0.90 ? 4 : 3));
    }

    private updatePlateGravity(plate: PlateData) {
        const remaining = plate.fruits.filter(s => !s.removed);
        if (remaining.length !== 1) {
            plate.rotation = 0;
            plate.gravityOrigin = undefined;
            return;
        }
        
        const anchorX = remaining[0].x;
        const anchorY = remaining[0].y;
        
        const cx = plate.w / 2;
        const cy = plate.h / 2;
        
        const dx = cx - anchorX;
        const dy = cy - anchorY;
        
        if (dy <= 0 && Math.abs(dx) < 10) {
            plate.rotation = 0;
            plate.gravityOrigin = undefined;
            return;
        }
        
        let targetRotation = Math.atan2(dx, dy) * (180 / Math.PI);
        // Cocos Creator uses counter-clockwise rotation for positive angles, but the math gives clockwise.
        // Let's negate it for Cocos.
        targetRotation = -targetRotation;
        
        plate.rotation = targetRotation;
        plate.gravityOrigin = { x: anchorX, y: anchorY };
    }

    private handleFruitClick(plate: PlateData, fruit: FruitData) {
        if (this.gameOver) return;

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
        // 优化：如果有果篮差一个果子就满了（capacity - length === 1），优先放进去；否则找一个有同色果子最多的未满果篮；否则随便找个有空间的
        const isRainbow = fruit.color === FruitColor.RAINBOW;
        let targetBox: BoxData | undefined;
        
        if (isRainbow) {
            const activeBoxes = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty' && box.fruits.length < box.capacity);
            
            if (activeBoxes.length > 0) {
                activeBoxes.sort((a, b) => {
                    const diffA = a.capacity - a.fruits.length;
                    const diffB = b.capacity - b.fruits.length;
                    if (diffA !== diffB) {
                        return diffA - diffB; // 距离满差距小的排前面
                    }
                    return b.fruits.length - a.fruits.length; // 差距相同，装得多的排前面
                });
                targetBox = activeBoxes[0];
            }
        } else {
            targetBox = this.boxes.find((box) => box.color === fruit.color && box.fruits.length < box.capacity);
        }

        if (!targetBox) {
            if (this.tempHoles.length >= this.maxTempHoles) {
                this.gameOver = true;
                const btnState = this.getHelpButtonState();
                this.renderModal({
                    title: '暂存盘满了',
                    sub: '果盘已被塞满！看个广告清空果盘继续闯关，\n或者重新开始本关～',
                    button: '重新开始',
                    onConfirm: () => {
                        this.gameOver = false;
                        this.initGame();
                    },
                    secondButton: '看广告复活',
                    secondOnConfirm: () => {
                        this.showAdThen(() => {
                            this.gameOver = false;
                            this.tempHoles = [];
                            this.renderTopUI();
                            this.renderModal(null);
                        });
                    },
                    hideClose: true,
                    height: 240,
                });
                return;
            }
            this.tempHoles.push(fruit.color);
        } else {
            targetBox.fruits.push(fruit.color);
            
            // ===== 连击判定 =====
            const COMBO_WINDOW = 1500; // 1.5秒内连续收集算连击
            const now = Date.now();
            if (this.lastCollectTime > 0 && (now - this.lastCollectTime) < COMBO_WINDOW) {
                this.comboCount++;
            } else {
                this.comboCount = 1;
            }
            this.lastCollectTime = now;
            
            // 连击 >=2 时显示飘字
            if (this.comboCount >= 2) {
                const comboInfo = this.getComboInfo(this.comboCount);
                if (comboInfo.text) {
                    // 从屏幕中央飘出
                    this.showFloatText(comboInfo.text, 0, 10, comboInfo.color, comboInfo.fontSize);
                }
            }
            // ===== 连击判定结束 =====
        }

        fruit.removed = true;
        this.removedFruits++;

        this.renderTopUI();

        if (targetBox && this.canClearBox(targetBox)) {
            this.scheduleBoxClear(targetBox, 0.25, true);
        }

        const remaining = plate.fruits.filter((item) => !item.removed);
        if (remaining.length === 0) {
            plate.state = 'stable';
            plate.supportPlateId = undefined;
            plate.supportY = undefined;
            const currentAngle = plate.rotation || 0;
            this.refreshPlateNode(plate, currentAngle);
            this.startPlateFalling(plate);
        } else {
            plate.state = 'stable';
            plate.supportPlateId = undefined;
            plate.supportY = undefined;
            const oldRotation = plate.rotation || 0;
            this.updatePlateGravity(plate);
            const plateNode = this.refreshPlateNode(plate, oldRotation);

            if (oldRotation !== (plate.rotation || 0)) {
                if (plateNode) {
                    // 旋转动画时间从 0.5 秒延长到 1.2 秒，使用 backOut 缓动让它下垂时有轻微回弹，显得更真实沉重
                    tween(plateNode).stop();
                    tween(plateNode)
                        .to(1.2, { angle: plate.rotation || 0 }, { easing: 'backOut' })
                        .start();
                }
            }

            this.checkAllBoxesForClear();
            this.checkWin();
        }
    }

    private clearBoxAndAssignNewColor(targetBox: BoxData) {
        if (!this.canClearBox(targetBox)) {
            targetBox.clearScheduled = false;
            targetBox.isSlidingOut = false;
            this.renderBoxes();
            return;
        }

        targetBox.clearScheduled = false;
        targetBox.isSlidingOut = true;
        this.renderBoxes();

        this.scheduleOnce(() => {
            if (!this.canClearBox(targetBox)) {
                targetBox.isSlidingOut = false;
                this.renderBoxes();
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
                ? this.boxes.find((box) => box.color !== 'locked' && box.color !== 'empty' && box.fruits.length < box.capacity)
                : this.boxes.find((box) => box.color === color && box.fruits.length < box.capacity);
                
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

    private getRemainingColors() {
        const colors = new Set<FruitColor>();
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            plate.fruits.forEach((fruit) => {
                if (!fruit.removed && fruit.color !== FruitColor.RAINBOW) {
                    colors.add(fruit.color);
                }
            });
        });
        this.tempHoles.forEach((color) => {
            if (color !== FruitColor.RAINBOW) colors.add(color);
        });
        return Array.from(colors);
    }

    private isValidPrimaryBoxFruitColor(color: BoxColor): color is FruitColor {
        return COLORS.indexOf(color as FruitColor) !== -1;
    }

    private getPrimaryBoxFruitFallbackColor(index: number): FruitColor {
        const remaining = this.getRemainingColors();
        const otherPrimary = index === 0 ? this.boxes[1] : this.boxes[0];
        const otherColor = otherPrimary && this.isValidPrimaryBoxFruitColor(otherPrimary.color)
            ? otherPrimary.color
            : null;
        const candidate = remaining.find((color) => color !== otherColor);
        if (candidate) return candidate;
        return COLORS[index] || FruitColor.YELLOW;
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

    private getOutstandingFruitCount(color: FruitColor) {
        let count = 0;
        this.boxes.forEach((box) => {
            count += box.fruits.filter((fruit) => fruit === color).length;
        });
        this.tempHoles.forEach((tempColor) => {
            if (tempColor === color) count++;
        });
        this.plates.forEach((plate) => {
            if (plate.removed) return;
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

        // 5的倍数关卡为挑战关卡，系统不再全力帮忙
        const isChallenge = this.currentLevel % 5 === 0;
        const tempWeight   = isChallenge ? 10  : 20;
        const clickWeight  = isChallenge ? 20  : 30;
        const blockWeight  = isChallenge ? 60  : 60;

        this.tempHoles.forEach((color) => addWeight(color, tempWeight));
        this.plates.forEach((plate) => {
            if (plate.removed) return;
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

    private pickRefreshColor(targetBox: BoxData): BoxColor {
        const currentColors = this.boxes
            .filter((box) => box !== targetBox && box.color !== 'locked' && box.color !== 'empty')
            .map((box) => box.color as FruitColor);

        const preferred = this.getPreferredRefreshColors();
        const preferredAvailable = preferred.filter((color) => currentColors.indexOf(color) === -1);
        if (preferredAvailable.length > 0) {
            return preferredAvailable[0];
        }

        const remaining = this.getRemainingColors().filter((color) => currentColors.indexOf(color) === -1);
        if (remaining.length > 0) {
            return remaining[0];
        }

        if (preferred.length > 0) {
            return preferred[0];
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

        const fallback = COLORS.filter((color) => color !== duplicateColor && activeColors.indexOf(color) === -1);
        if (fallback.length > 0) {
            return fallback[0];
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

        if (box.fruits.length === box.capacity) return true;

        // 如果包含彩虹果，它也可以作为该颜色的一部分被清除
        // 这里计算真正的该颜色剩余量加上剩余的彩虹果数量，来判断是否能提前清除
        const outstanding = this.getOutstandingFruitCount(box.color) + this.getOutstandingFruitCount(FruitColor.RAINBOW);
        if (box.fruits.length === outstanding) return true;

        return false;
    }

    private scheduleBoxClear(box: BoxData, delay: number, withSuccessVibration: boolean = false) {
        if (box.clearScheduled || !this.canClearBox(box)) return;

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
        const used = new Set(active.map((box) => box.color as FruitColor));
        const fillColors = remaining.filter((color) => !used.has(color));

        for (let i = 0; i < 2; i++) {
            const box = this.boxes[i];
            if (this.isValidPrimaryBoxFruitColor(box.color)) continue;
            const color = fillColors.shift() || remaining[0] || COLORS[i] || FruitColor.YELLOW;
            this.updateBoxColor(box, color);
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

        const remaining = this.getRemainingColors();
        const active = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty').map((box) => box.color);
        let available = remaining.filter((color) => active.indexOf(color) === -1);
        if (available.length === 0) {
            available = COLORS.filter((color) => active.indexOf(color) === -1);
        }

        if (available.length > 0) {
            const nextColor = available[Math.floor(Math.random() * available.length)];
            this.updateBoxColor(targetBox, nextColor);
            targetBox.capacity = this.getNextCapacityForColor(nextColor, targetBox);
            targetBox.isNew = true;
            this.renderTopUI();
            this.autoFillFromTemp();
        }
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
            
            const btnState = this.getHelpButtonState();
            this.renderModal({
                title: '解锁果篮',
                sub: '看一段广告即可解锁新果篮，\n或者求助群友帮忙～',
                button: '看广告解锁',
                onConfirm: () => {
                    this.showAdThen(() => {
                        this.tryConsumeTool(type, () => this.handleUnlockBox(lockedBox));
                    });
                },
                secondButton: btnState.text,
                secondOnConfirm: () => {
                    if (btnState.disabled) return;
                    this.doShareForReward('unlock', () => {
                        this.tryConsumeTool(type, () => this.handleUnlockBox(lockedBox));
                    });
                },
                height: 250,
            });
            return;
        }

        if (this.tempHoles.length === 0) {
            this.renderModal({
                title: '提示',
                sub: '果盘中没有果子',
                button: '知道了',
                height: 170,
                onConfirm: () => {}
            });
            return;
        }

        const btnState = this.getHelpButtonState();
        this.renderModal({
            title: '清空果盘',
            sub: '看一段广告即可清空暂存的果子，\n或者求助群友帮忙～',
            button: '看广告清空',
            onConfirm: () => {
                this.showAdThen(() => {
                    this.tryConsumeTool(type, () => {
                        this.tempHoles = [];
                        this.renderTopUI();
                        this.checkWin();
                    });
                });
            },
            secondButton: btnState.text,
            secondOnConfirm: () => {
                if (btnState.disabled) return;
                this.doShareForReward('clear', () => {
                    this.tryConsumeTool(type, () => {
                        this.tempHoles = [];
                        this.renderTopUI();
                        this.checkWin();
                    });
                });
            },
            height: 250,
        });
    }

    private showAdThen(callback: () => void) {
        const adManager = AdManager.getInstance();
        if (!adManager) {
            callback();
            return;
        }
        adManager.showRewardedAd().then(() => {
            callback();
        }).catch(() => {
        });
    }

    private tryConsumeTool(type: 'add' | 'clear', callback: () => void) {
        if (this.tools[type] > 0) {
            this.tools[type]--;
        }
        callback();
        this.renderTools();
    }

    private startPlateFalling(plate: PlateData, forceDropOut = false) {
        if (plate.removed || plate.state === 'falling') return;
        if (!forceDropOut && this.hasRemainingFruits(plate)) return;

        this.dropPlateOutOfScene(plate);
    }

    private checkWin() {
        if (this.gameOver) return;
        if (this.fallingPlateNodes.size > 0 || this.plates.some((plate) => plate.state === 'falling')) return;
        const allRemoved = this.plates.every((plate) => plate.removed);
        if (!allRemoved || this.tempHoles.length > 0) return;

        this.gameOver = true;
        this.renderModal({
            title: '通关成功',
            sub: `太棒了，你已完成第 ${this.currentLevel} 关`,
            button: '下一关',
            height: 200,
            onConfirm: () => {
                this.currentLevel++;
                saveProgress(this.currentLevel);
                this.initGame();
            }
        });
    }

    private readonly FRUIT_BLOCK_COVERAGE = 0.3;

    private isFruitBlocked(plate: PlateData, fruit: FruitData) {
        const fruitLocalX = fruit.x - plate.w / 2;
        const fruitLocalY = plate.h / 2 - fruit.y;
        const fruitWorld = this.plateLocalToWorld(plate, fruitLocalX, fruitLocalY);

        const fruitRadius = 15;
        const sampleStep = 5;
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
            if (other.id === plate.id || other.removed || other.state === 'falling' || other.layer <= plate.layer) continue;

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
        if (plate.type === 'circle') {
            const radius = Math.min(plate.w, plate.h) / 2;
            return local.x * local.x + local.y * local.y <= radius * radius + 1;
        }
        return local.x >= -plate.w / 2 && local.x <= plate.w / 2
            && local.y >= -plate.h / 2 && local.y <= plate.h / 2;
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
        const bounds = this.getPlateWorldBounds(plate);
        if (worldX < bounds.minX - 1 || worldX > bounds.maxX + 1) return null;

        const scanTop = bounds.maxY + SUPPORT_SURFACE_SCAN_STEP;
        const scanBottom = bounds.minY - SUPPORT_SURFACE_SCAN_STEP;
        let lastOutsideY = scanTop;

        for (let y = scanTop; y >= scanBottom; y -= SUPPORT_SURFACE_SCAN_STEP) {
            if (!this.isPointInsidePlate(plate, worldX, y)) {
                lastOutsideY = y;
                continue;
            }

            let insideY = y;
            let outsideY = lastOutsideY;
            for (let i = 0; i < SUPPORT_SURFACE_REFINE_ITERATIONS; i++) {
                const midY = (insideY + outsideY) / 2;
                if (this.isPointInsidePlate(plate, worldX, midY)) {
                    insideY = midY;
                } else {
                    outsideY = midY;
                }
            }
            return insideY;
        }

        return null;
    }



    private dropPlateOutOfScene(plate: PlateData) {
        if (plate.removed || plate.state === 'falling' || !this.boardEffectNode) return;

        const fallingNode = this.createPlateNode(this.boardEffectNode, plate, false, plate.rotation || 0);
        if (!fallingNode) return;

        plate.isFalling = true;
        plate.state = 'falling';
        this.destroyPlateNode(plate.id);
        this.fallingPlateNodes.set(plate.id, fallingNode);

        const dropDistance = Math.max(800, this.boardHeight + this.bottomHeight + 220);
        tween(fallingNode)
            .to(1.2, { position: new Vec3(fallingNode.position.x, fallingNode.position.y - dropDistance, 0) }, { easing: 'quadIn' })
            .call(() => {
                this.triggerVibration('success');
                plate.removed = true;
                plate.isFalling = false;
                plate.state = 'removed';
                const activeNode = this.fallingPlateNodes.get(plate.id);
                if (activeNode && activeNode.isValid) {
                    activeNode.destroy();
                }
                this.fallingPlateNodes.delete(plate.id);
                this.checkAllBoxesForClear();
                this.renderTopUI();
                this.checkWin();
            })
            .start();
    }

    private createNode(name: string, parent: Node, x: number, y: number, width: number, height: number) {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);
        node.setPosition(new Vec3(x, y, 0));
        parent.addChild(node);
        return node;
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

        const shadow = this.createGraphicsNode('Shadow', plateNode, plate.w + 6, plate.h + 6, 6, -6);
        this.drawPlateShape(shadow.getComponent(Graphics)!, plate.type, plate.w + 6, plate.h + 6, new Color(130, 110, 75, 120), 24, 0);

        const face = this.createGraphicsNode('Face', plateNode, plate.w, plate.h, 0, 0);
        this.drawPlateShape(face.getComponent(Graphics)!, plate.type, plate.w, plate.h, FACE_COLORS[plate.color], 22, 5, new Color(225, 210, 180, 200));

        plate.fruits.filter((fruit) => !fruit.removed).forEach((fruit) => {
            const fruitIconSize = 34;
            const localX = -plate.w / 2 + fruit.x;
            const localY = plate.h / 2 - fruit.y;

            const fruitContainer = this.createNode(`FruitContainer_${fruit.id}`, plateNode, localX, localY, fruitIconSize, fruitIconSize);

            const holeShadow = this.createGraphicsNode('Hole', fruitContainer, fruitIconSize, fruitIconSize, 0, 0);
            this.drawCircle(holeShadow.getComponent(Graphics)!, fruitIconSize / 2, new Color(80, 60, 30, 60), 0);

            const fruitNode = this.createFruitVisual(fruitContainer, 0, 0, fruitIconSize, fruit.color, true);
            if (interactive) {
                fruitNode.on(Node.EventType.TOUCH_END, (e) => {
                    e.propagationStopped = true;
                    this.handleFruitClick(plate, fruit);
                }, this);
            }
        });

        return pivotNode;
    }

    private refreshPlateNode(plate: PlateData, angleOverride?: number) {
        if (!this.boardContentNode || plate.removed) return null;
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
            return [
                { x: -18, y: 18 },
                { x: 18, y: 18 },
                { x: -18, y: -8 },
                { x: 18, y: -8 }
            ];
        }
        if (capacity === 5) {
            return [
                { x: -20, y: 22 },
                { x: 20, y: 22 },
                { x: -20, y: -10 },
                { x: 20, y: -10 },
                { x: 0, y: 6 }
            ];
        }
        if (capacity === 6) {
            return [
                { x: -16, y: 28 },
                { x: -16, y: 4 },
                { x: -16, y: -20 },
                { x: 16, y: 28 },
                { x: 16, y: 4 },
                { x: 16, y: -20 }
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

            // 锁状态的 X 覆盖层
            const lockOverlayNode = this.createGraphicsNode('LockOverlay', boxNode, boxWidth, boxHeight, 0, 0);
            const lockOverlay = lockOverlayNode.getComponent(Graphics)!;
            lockOverlayNode.active = false;

            // 中心水果图标 (半透明)
            // 对齐中间孔位的中心点
            const iconNode = this.createNode('FruitIcon', boxNode, 0, boxHeight * 0.08, 48, 48);
            const fruitIcon = iconNode.addComponent(Sprite);
            fruitIcon.sizeMode = Sprite.SizeMode.CUSTOM;
            fruitIcon.color = new Color(255, 255, 255, 70); // 更透明，不抢夺底色
            
            // 底部中文标签 (精准对齐底部的白色标签框，往下挪)
            const nameLabel = this.createLabel(boxNode, '', 0, -boxHeight / 2 + boxHeight * 0.15, 15, new Color(90, 60, 30, 255), true);

            // 解锁文字：颜色改为深棕色，放在白色标签框的位置
            const lockLabel = this.createLabel(boxNode, '解锁', 0, -boxHeight / 2 + boxHeight * 0.15, 15, new Color(90, 60, 30, 255), true);
            lockLabel.node.active = false;

            const slots: BoxSlotView[] = allSlotPositions.map((pos, slotIndex) => {
                const slotNode = this.createNode(`SlotWrap_${slotIndex}`, boxNode, pos.x, pos.y, 24, 24);
                const holeNode = this.createGraphicsNode(`Slot_${slotIndex}`, slotNode, 24, 24, 0, 0);
                const fruitHost = this.createNode(`FruitHost_${slotIndex}`, slotNode, 0, 0, 24, 24);
                return { node: slotNode, hole: holeNode.getComponent(Graphics)!, fruitHost };
            });

            boxNode.on(Node.EventType.TOUCH_END, () => {
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

        if (!this.tempBgGraphics) {
            const containerW = this.screenWidth - 154;
            const containerH = 30;
            const bgNode = this.createGraphicsNode('TempBg', this.tempContainerNode, containerW, containerH, 0, 0);
            this.tempBgGraphics = bgNode.getComponent(Graphics)!;
        }

        if (this.tempSlotViews.length === this.maxTempHoles) return;

        const slotRadius = 12;
        const spacing = slotRadius * 2 + 5;
        const startX = -spacing * 2;
        while (this.tempSlotViews.length < this.maxTempHoles) {
            const index = this.tempSlotViews.length;
            const slotNode = this.createNode(`TempSlotWrap_${index}`, this.tempContainerNode, startX + index * spacing, 0, slotRadius * 2, slotRadius * 2);
            const holeNode = this.createGraphicsNode(`TempSlot_${index}`, slotNode, slotRadius * 2, slotRadius * 2, 0, 0);
            const hole = holeNode.getComponent(Graphics)!;
            this.drawCircle(hole, slotRadius, new Color(170, 155, 120, 255), 0);
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

            const shadow = this.createGraphicsNode('Shadow', btnNode, buttonWidth + 6, buttonHeight + 6, 0, -2);
            this.drawRoundedRect(shadow.getComponent(Graphics)!, buttonWidth + 6, buttonHeight + 6, new Color(180, 195, 160, 255), 18);

            const body = this.createGraphicsNode('Body', btnNode, buttonWidth, buttonHeight, 0, 0);
            this.drawRoundedRect(body.getComponent(Graphics)!, buttonWidth, buttonHeight, new Color(100, 155, 85, 255), 16, 5, new Color(145, 190, 120, 255));

            const iconLabel = this.createLabel(btnNode, tool.icon, 0, 8, 28, new Color(255, 255, 255, 255), false, 32);
            iconLabel.enableWrapText = false;
            this.createLabel(btnNode, tool.label, 0, -22, 15, new Color(255, 255, 255, 255), true);

            const badgeNode = this.createGraphicsNode('Badge', btnNode, 26, 26, badgeX, badgeY);
            const badge = badgeNode.getComponent(Graphics)!;
            const badgeLabel = this.createLabel(btnNode, '+', badgeX, badgeY, 18, new Color(255, 255, 255, 255), true);

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

    private createGraphicsNode(name: string, parent: Node, width: number, height: number, x: number, y: number) {
        const node = this.createNode(name, parent, x, y, width, height);
        node.addComponent(Graphics);
        return node;
    }

    private createLabel(parent: Node, text: string, x: number, y: number, fontSize: number, color: Color, bold = false, lineHeight?: number) {
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

    private triggerVibration(type: 'light' | 'heavy' | 'success' = 'light') {
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

    private drawRoundedRect(graphics: Graphics, width: number, height: number, fill: Color, radius: number, lineWidth = 0, stroke?: Color) {
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

    private drawCircle(graphics: Graphics, radius: number, fill: Color, lineWidth = 0, stroke?: Color) {
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

    private handleRankButtonClick() {
        if (hasUserProfile()) {
            this.loadAndShowRank();
        } else {
            this.showProfilePanel();
        }
    }

    private showProfilePanel() {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();

        const page = this.createNode('ProfilePage', this.modalLayerNode, 0, 0, this.screenWidth, this.screenHeight);
        
        // 黑色半透明背景
        const maskNode = this.createGraphicsNode('Mask', page, this.screenWidth, this.screenHeight, 0, 0);
        const g = maskNode.getComponent(Graphics)!;
        g.fillColor = new Color(0, 0, 0, 180);
        g.fillRect(-this.screenWidth/2, -this.screenHeight/2, this.screenWidth, this.screenHeight);

        // 面板背景
        const panelW = 320;
        const panelH = 420;
        const panel = this.createNode('Panel', page, 0, 0, panelW, panelH);
        const panelBg = this.createGraphicsNode('PanelBg', panel, panelW, panelH, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(245, 235, 210, 255), 20);

        // 标题
        this.createLabel(panel, '🍎 建立果园档案 🍎', 0, panelH/2 - 40, 24, new Color(120, 80, 40, 255), true);
        this.createLabel(panel, '请选择你的专属形象', 0, panelH/2 - 80, 14, new Color(140, 100, 60, 255), false);

        // 头像网格 (使用 ProfileManager 脚本管理)
        const profileManager = page.addComponent('ProfileManager') as any;

        const avatarLayout = this.createNode('AvatarLayout', panel, 0, 40, 240, 160);
        profileManager.avatarLayout = avatarLayout;

        const startX = -75;
        const startY = 40;
        const spacingX = 75;
        const spacingY = 75;

        for (let i = 0; i < 6; i++) {
            const row = Math.floor(i / 3);
            const col = i % 3;
            const x = startX + col * spacingX;
            const y = startY - row * spacingY;
            
            const avatarNode = this.createNode(`Avatar${i+1}`, avatarLayout, x, y, 55, 55);
            
            const avatarBg = this.createGraphicsNode('Bg', avatarNode, 55, 55, 0, 0);
            this.drawRoundedRect(avatarBg.getComponent(Graphics)!, 55, 55, new Color(255, 255, 255, 255), 10);
            
            const spriteNode = this.createNode('Img', avatarNode, 0, 0, 45, 45);
            const sprite = spriteNode.addComponent(Sprite);
            // 强制设置宽高和尺寸模式，防止原图撑爆
            const uiTransform = spriteNode.getComponent(UITransform);
            if (uiTransform) {
                uiTransform.setContentSize(45, 45);
            }
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            
            resources.load(`avatar/Avatars${i+1}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
                if (!err && spriteFrame) {
                    sprite.spriteFrame = spriteFrame;
                }
            });
        }

        // 提示文本：请输入你的果园代号
        this.createLabel(panel, '请输入你的果园代号', 0, -85, 14, new Color(140, 100, 60, 255), false);
        
        const editBoxNode = this.createNode('NameEditBox', panel, -25, -130, 160, 40);
        const editBg = this.createGraphicsNode('EditBg', editBoxNode, 160, 40, 0, 0);
        this.drawRoundedRect(editBg.getComponent(Graphics)!, 160, 40, new Color(255, 255, 255, 255), 8);
        const editMask = editBoxNode.addComponent(Mask);
        editMask.type = Mask.Type.GRAPHICS_RECT;
        
        const editBox = editBoxNode.addComponent(EditBox);
        
        // 禁掉 EditBox 可能残留的默认 Label，避免左侧出现 "label" 之类的占位文本。
        const autoLabel = editBoxNode.getComponent(Label);
        if (autoLabel) {
            autoLabel.string = '';
            autoLabel.enabled = false;
        }
        editBoxNode.children.forEach((child) => {
            if (child === editBg) return;
            const childLabel = child.getComponent(Label);
            if (childLabel) {
                childLabel.string = '';
                child.active = false;
            }
        });
        
        // 手动接管显示层，确保昵称和 placeholder 在输入框里稳定居中显示。
        const textNode = this.createNode('TEXT_LABEL', editBoxNode, 0, -5, 144, 36);
        const textLabel = textNode.addComponent(Label);
        textLabel.color = new Color(80, 55, 30, 255);
        textLabel.fontSize = 18;
        textLabel.lineHeight = 36;
        textLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        textLabel.verticalAlign = Label.VerticalAlign.CENTER;
        textLabel.overflow = Label.Overflow.CLAMP;
        textLabel.string = '';
        
        const placeholderNode = this.createNode('PLACEHOLDER_LABEL', editBoxNode, 0, -5, 144, 36);
        const placeholderLabel = placeholderNode.addComponent(Label);
        placeholderLabel.color = new Color(180, 180, 180, 255);
        placeholderLabel.fontSize = 18;
        placeholderLabel.lineHeight = 36;
        placeholderLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        placeholderLabel.verticalAlign = Label.VerticalAlign.CENTER;
        placeholderLabel.overflow = Label.Overflow.CLAMP;
        placeholderLabel.string = '';

        editBox.textLabel = textLabel;
        editBox.placeholderLabel = placeholderLabel;
        editBox.placeholder = '点击输入代号';
        editBox.string = ''; // 强制清空 EditBox 的默认 string（Cocos 会默认生成 'label'）
        
        profileManager.nameEditBox = editBox;
        
        // 随机按钮
        const diceBtn = this.createNode('DiceBtn', panel, 85, -130, 40, 40);
        const diceBg = this.createGraphicsNode('DiceBg', diceBtn, 40, 40, 0, 0);
        this.drawRoundedRect(diceBg.getComponent(Graphics)!, 40, 40, new Color(200, 200, 200, 255), 8);
        this.createLabel(diceBtn, '🎲', 0, 0, 20, new Color(255, 255, 255, 255), true);
        diceBtn.on(Node.EventType.TOUCH_END, () => {
            profileManager.onRandomName();
        });

        // 提示文本
        const tipLabelNode = this.createLabel(panel, '', 0, -165, 14, new Color(255, 80, 80, 255), true);
        tipLabelNode.string = '';
        profileManager.tipLabel = tipLabelNode;

        // 保存按钮
        const saveBtn = this.createNode('SaveBtn', panel, 0, -210, 160, 48);
        const saveBg = this.createGraphicsNode('SaveBg', saveBtn, 160, 48, 0, 0);
        this.drawRoundedRect(saveBg.getComponent(Graphics)!, 160, 48, new Color(100, 180, 80, 255), 24);
        this.createLabel(saveBtn, '✅ 开启排行', 0, 0, 18, new Color(255, 255, 255, 255), true);
        
        saveBtn.on(Node.EventType.TOUCH_END, () => {
            profileManager.onSaveClicked();
        });

        // 关闭按钮
        const closeBtn = this.createNode('CloseBtn', panel, panelW/2 - 20, panelH/2 - 20, 40, 40);
        this.createLabel(closeBtn, '✖', 0, 0, 20, new Color(150, 150, 150, 255), true);
        closeBtn.on(Node.EventType.TOUCH_END, () => {
            page.destroy();
        }, this);

        profileManager.show(() => {
            page.destroy();
            this.loadAndShowRank();
        });
    }

    private async loadDefaultAvatars(): Promise<void> {
        if (this.defaultAvatarsLoaded) return;
        return new Promise((resolve) => {
            const avatarNames = ['Avatars1', 'Avatars2', 'Avatars3', 'Avatars4', 'Avatars5', 'Avatars6'];
            let loaded = 0;
            avatarNames.forEach((name) => {
                resources.load(`avatar/${name}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
                    loaded++;
                    if (!err && spriteFrame) {
                        this.defaultAvatarFrames.push(spriteFrame);
                    }
                    if (loaded === avatarNames.length) {
                        this.defaultAvatarsLoaded = true;
                        resolve();
                    }
                });
            });
        });
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
            const fruitNames = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot', 'Rainbow Fruit'];
            let loaded = 0;
            fruitNames.forEach((name) => {
                resources.load(`fruits/${name}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
                    loaded++;
                    if (!err && spriteFrame) {
                        this.fruitSprites.set(name, spriteFrame);
                    } else {
                        console.warn(`[Fruit] failed to load ${name}:`, err);
                    }
                    if (loaded === fruitNames.length) {
                        this.fruitsLoaded = true;
                        console.log(`[Fruit] loaded ${this.fruitSprites.size}/${fruitNames.length} fruit sprites`);
                        resolve();
                    }
                });
            });
        });
    }

    /** 加载灰度果篮底图（用于运行时动态染色） */
    private async loadBasketBase(): Promise<void> {
        if (this.basketSpriteFrame) return;
        return new Promise((resolve) => {
            resources.load('baskets/basket_base/spriteFrame', SpriteFrame, (err, spriteFrame) => {
                if (!err && spriteFrame) {
                    this.basketSpriteFrame = spriteFrame;
                    console.log('[Basket] loaded grayscale basket base');
                } else {
                    console.warn('[Basket] failed to load basket base, fallback to drawing:', err);
                }
                resolve();
            });
        });
    }

    /** 预加载分享卡片图片（转换为本地可访问路径） */
    private preloadShareImages() {
        if (typeof wx === 'undefined') return;
        // 所有分享场景统一用摘呀摘呀摘这张图
        resources.load('share/摘呀摘呀摘', ImageAsset, (err, asset) => {
            if (!err && asset) {
                const url = asset.nativeUrl;
                this.shareImageUrls['unlock'] = url;
                this.shareImageUrls['revive'] = url;
                this.shareImageUrls['win'] = url;
                this.shareImageUrls['clear'] = url;
            }
        });

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

    /** 根据 avatarUrl 解析默认头像索引，兼容旧数据 "1"~"6" */
    private getDefaultAvatarFrame(avatarUrl: string): SpriteFrame | null {
        if (!avatarUrl || this.defaultAvatarFrames.length === 0) return null;
        // 匹配 default:N 或纯数字格式
        const match = avatarUrl.match(/^default:(\d+)$|^(\d+)$/);
        if (!match) return null;
        const index = parseInt(match[1] || match[2], 10) - 1;
        if (index < 0 || index >= this.defaultAvatarFrames.length) return null;
        return this.defaultAvatarFrames[index];
    }

    private getRandomDefaultAvatar(): SpriteFrame | null {
        if (this.defaultAvatarFrames.length === 0) return null;
        const idx = Math.floor(Math.random() * this.defaultAvatarFrames.length);
        return this.defaultAvatarFrames[idx];
    }

    private createAvatarSpriteNode(parent: Node, x: number, y: number, size: number, avatarUrl?: string): Node {
        const node = this.createNode('Avatar', parent, x, y, size, size);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM; // 强制使用自定义尺寸，避免原图过大
        
        // 可选：添加一个 Mask 组件让图片变成圆形
        const maskNode = this.createNode('AvatarMask', parent, x, y, size, size);
        const mask = maskNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_ELLIPSE; // 圆形遮罩
        
        // 把 sprite 放到 mask 下面
        node.parent = maskNode;
        node.setPosition(0, 0, 0);
        
        // 优先用 avatarUrl 解析对应的默认头像，解析失败则随机兜底
        const frame = this.getDefaultAvatarFrame(avatarUrl || '') || this.getRandomDefaultAvatar();
        if (frame) {
            sprite.spriteFrame = frame;
        }
        return maskNode;
    }

    private async loadAndShowRank() {
        this.showLoadingOverlay();
        try {
            const data = await fetchRank();
            await this.loadDefaultAvatars();
            this.hideLoadingOverlay();
            this.renderRankPage(data.list, data.myRank);
        } catch {
            this.hideLoadingOverlay();
        }
    }

    private closeRankPage() {
        if (this.rankPageNode && this.rankPageNode.isValid) {
            this.rankPageNode.destroy();
            this.rankPageNode = null;
        }
        if (this.modalLayerNode) {
            this.modalLayerNode.active = false;
        }
        if (this.topAreaNode) this.topAreaNode.active = true;
        if (this.boardAreaNode) this.boardAreaNode.active = true;
        if (this.bottomAreaNode) this.bottomAreaNode.active = true;
    }

    private renderRankPage(list: RankItem[], myRank: RankItem | null) {
        this.closeRankPage();
        if (this.rootNode) {
            this.rootNode.removeAllChildren();
        }

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

        const pageW = this.screenWidth;
        const pageH = this.screenHeight;
        const padX = 20;
        const listW = pageW - padX * 2;

        this.rankPageNode = this.createNode('RankPage', this.rootNode, 0, 0, pageW, pageH);

        // --- 整体背景 (采用浅色清新的原木/休闲主题色) ---
        const bg = this.createGraphicsNode('RankBg', this.rankPageNode, pageW, pageH, 0, 0);
        bg.getComponent(Graphics)!.fillColor = new Color(245, 248, 240, 255); // 极浅的米绿色背景
        bg.getComponent(Graphics)!.rect(-pageW / 2, -pageH / 2, pageW, pageH);
        bg.getComponent(Graphics)!.fill();

        // --- 顶部导航区域 ---
        const headerY = pageH / 2 - 40;
        
        // 返回按钮 (< 图标)
        const backBtnW = 40;
        const backBtnH = 40;
        const backBtn = this.createNode('BackBtn', this.rankPageNode, -pageW / 2 + 30, headerY, backBtnW, backBtnH);
        this.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true); // 绿色箭头
        backBtn.on(Node.EventType.TOUCH_END, () => this.goBackToGame(), this);

        // 标题 (排行榜)
        this.createLabel(this.rankPageNode, '排行榜', 0, headerY, 22, new Color(60, 80, 50, 255), true); // 深绿色标题

        // --- 前三名领奖台区域 (Top 3 Podium) ---
        // 按实际排名取，避免并列排名时 slice 错位
        const top1 = list.find(t => t.rank === 1);
        const top2 = list.find(t => t.rank === 2);
        const top3 = list.find(t => t.rank === 3);
        const podiumY = headerY - 140; // 领奖台中心高度
        
        // 定义领奖台配置：[2, 1, 3] 的顺序 (左，中，右)
        const podiumConfigs = [
            { rank: 2, offsetX: -90, yOffset: -30, scale: 0.85, color: new Color(160, 200, 240, 255) }, // 银色/浅蓝
            { rank: 1, offsetX: 0,   yOffset: 20,  scale: 1.1,  color: new Color(255, 190, 60, 255) },  // 金色
            { rank: 3, offsetX: 90,  yOffset: -40, scale: 0.8,  color: new Color(140, 220, 160, 255) }  // 铜色/浅绿
        ];

        // 绘制领奖台底板 (一个大圆角矩形，包裹前三名)
        const podiumBgH = 160;
        const podiumBgY = podiumY - 40;
        const podiumBg = this.createGraphicsNode('PodiumBg', this.rankPageNode, listW, podiumBgH, 0, podiumBgY);
        this.drawRoundedRect(podiumBg.getComponent(Graphics)!, listW, podiumBgH, new Color(230, 240, 220, 255), 24);

        // 渲染前三名
        const podiumMap: Record<number, RankItem | undefined> = { 1: top1, 2: top2, 3: top3 };
        podiumConfigs.forEach(config => {
            const item = podiumMap[config.rank];
            if (!item) return;

            const itemX = config.offsetX;
            const itemY = podiumY + config.yOffset;

            // 头像
            const avatarSize = 64 * config.scale;
            // 头像图片 (使用用户选择的头像)
            this.createAvatarSpriteNode(this.rankPageNode, itemX, itemY, avatarSize, item.avatarUrl);
            // 外圈装饰环
            const avatarBorder = this.createGraphicsNode(`PodiumBorder_${config.rank}`, this.rankPageNode, avatarSize + 8, avatarSize + 8, itemX, itemY);
            this.drawCircle(avatarBorder.getComponent(Graphics)!, avatarSize / 2 + 4, new Color(0, 0, 0, 0), 3, config.color);

            // 排名徽章 (贴在头像下方)
            const badgeSize = 20 * config.scale;
            const badgeY = itemY - avatarSize / 2;
            const badge = this.createGraphicsNode(`PodiumBadge_${config.rank}`, this.rankPageNode, badgeSize, badgeSize, itemX, badgeY);
            this.drawCircle(badge.getComponent(Graphics)!, badgeSize / 2, config.color);
            this.createLabel(this.rankPageNode, `${config.rank}`, itemX, badgeY, 12 * config.scale, new Color(255, 255, 255, 255), true);

            // 昵称
            const nick = (item.nickname || '玩家').substring(0, 8);
            this.createLabel(this.rankPageNode, nick, itemX, badgeY - 20, 14, new Color(80, 100, 70, 255), config.rank === 1);

            // 关卡数 (高亮颜色)
            this.createLabel(this.rankPageNode, `${item.levelNum}关`, itemX, badgeY - 40, 16, config.color, true);
            
            // 皇冠 (仅第一名有)
            if (config.rank === 1) {
                this.createLabel(this.rankPageNode, '👑', itemX, itemY + avatarSize / 2 + 15, 24, new Color(255, 190, 60, 255), true);
            }
        });

        // --- 列表区域 (List Area) ---
        // 列表大底板
        let listStartY = podiumBgY - podiumBgH / 2 - 20;
        const myRankH = myRank ? 90 : 20; // 为底部的"我的排名"预留高度
        const listBgH = pageH / 2 + listStartY; // 延伸到底部，刚好到屏幕边缘
        const listBgCenterY = listStartY - listBgH / 2;
        
        const listBg = this.createGraphicsNode('ListBg', this.rankPageNode, pageW, listBgH, 0, listBgCenterY);
        // 上边两个角是圆角，下面直角
        const g = listBg.getComponent(Graphics)!;
        g.fillColor = new Color(255, 255, 255, 255); // 纯白底板，显得干净
        g.roundRect(-pageW / 2, -listBgH / 2, pageW, listBgH, 30); // 简单起见统一用大圆角
        g.fill();

        // 渲染列表项 (从第 4 名开始)
        const listItems = list.filter(t => t.rank > 3); // 排除领奖台已展示的前三名
        const visibleCount = listItems.length;
        const itemH = 64;

        // 创建 ScrollView 可视区域
        const viewW = pageW;
        const viewH = listBgH - 30 - myRankH; // 上边距 30，下边距 myRankH
        const viewY = listBgCenterY - 15 + myRankH / 2; // 微调位置

        const scrollViewNode = this.createNode('ScrollView', this.rankPageNode, 0, viewY, viewW, viewH);
        const scrollView = scrollViewNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;
        
        const viewNode = this.createNode('View', scrollViewNode, 0, 0, viewW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;
        
        const contentH = Math.max(visibleCount * itemH, viewH);
        const contentNode = this.createNode('Content', viewNode, 0, 0, viewW, contentH);
        const contentUI = contentNode.getComponent(UITransform)!;
        contentUI.setAnchorPoint(0.5, 1); // 顶部对齐
        contentNode.setPosition(0, viewH / 2, 0); // 放在 view 的最上面
        
        scrollView.content = contentNode;

        for (let i = 0; i < visibleCount; i++) {
            const item = listItems[i];
            const itemY = -i * itemH - itemH / 2; // 相对 contentNode (anchor 0.5, 1)

            const isMe = item.isMe;
            const itemLeftX = -listW / 2 + 20;

            // 排名数字 (最左侧，放大、加粗、醒目颜色)
            const rankColor = isMe ? new Color(255, 150, 0, 255) : new Color(120, 140, 110, 255);
            const rankLabel = this.createLabel(contentNode, `${item.rank}`, itemLeftX + 10, itemY, 20, rankColor, true);
            rankLabel.horizontalAlign = 0; // LEFT
            rankLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 头像 (紧跟在排名右侧)
            const avatarSize = 40;
            const avatarX = itemLeftX + 60; // 排名占约 40px 宽度
            this.createAvatarSpriteNode(contentNode, avatarX, itemY, avatarSize, item.avatarUrl);

            // 昵称 (紧跟在头像右侧)
            const nick = (item.nickname || '玩家').substring(0, 8);
            const nameColor = isMe ? new Color(200, 140, 30, 255) : new Color(80, 100, 70, 255);
            
            const nickLabel = this.createLabel(contentNode, nick, avatarX + 30, itemY, 16, nameColor, isMe);
            nickLabel.horizontalAlign = 0; // LEFT
            nickLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 关卡数 (靠最右)
            const rightX = listW / 2 - 20;
            const lvLabel = this.createLabel(contentNode, `${item.levelNum} 关`, rightX, itemY, 18, nameColor, true);
            lvLabel.horizontalAlign = 2; // RIGHT
            lvLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);

            // 分割线
            if (i < visibleCount - 1) {
                const lineY = itemY - itemH / 2;
                const lineNode = this.createGraphicsNode('ItemLine', contentNode, listW, 1, 0, lineY);
                lineNode.getComponent(Graphics)!.fillColor = new Color(240, 245, 235, 255);
                lineNode.getComponent(Graphics)!.rect(-listW / 2, -0.5, listW, 1);
                lineNode.getComponent(Graphics)!.fill();
            }
        }

        // --- 底部悬浮的“我”的排名 ---
        if (myRank) {
            const myCardH = 70;
            const myCardY = -pageH / 2 + myCardH / 2 + 20; // 悬浮在底部

            // 我的排名底板 (带阴影)
            const myBg = this.createGraphicsNode('MyRankBg', this.rankPageNode, listW, myCardH, 0, myCardY);
            this.drawRoundedRect(myBg.getComponent(Graphics)!, listW, myCardH, new Color(255, 190, 60, 255), 20); // 醒目的暖黄色
            
            const itemLeftX = -listW / 2 + 20;

            // 排名数字 (最左侧)
            const rankLabel = this.createLabel(this.rankPageNode, `${myRank.rank || '?'}`, itemLeftX + 10, myCardY, 20, new Color(255, 255, 255, 255), true);
            rankLabel.horizontalAlign = 0; // LEFT
            rankLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 头像 (紧跟排名)
            const avatarSize = 40;
            const avatarX = itemLeftX + 60;
            this.createAvatarSpriteNode(this.rankPageNode, avatarX, myCardY, avatarSize, myRank.avatarUrl);

            // 昵称
            const nick = (myRank.nickname || '玩家').substring(0, 8);
            const nickLabel = this.createLabel(this.rankPageNode, nick, avatarX + 30, myCardY, 18, new Color(255, 255, 255, 255), true);
            nickLabel.horizontalAlign = 0; // LEFT
            nickLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 关卡数
            const rightX = listW / 2 - 20;
            const lvLabel = this.createLabel(this.rankPageNode, `${myRank.levelNum || 0} 关`, rightX, myCardY, 20, new Color(255, 255, 255, 255), true);
            lvLabel.horizontalAlign = 2; // RIGHT
            lvLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
        }
    }

    private goBackToGame() {
        this.closeRankPage();
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
        this.initGame();
        this.renderAll();
    }
}
