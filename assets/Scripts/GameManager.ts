import { _decorator, Component, Node, Vec3, UITransform, Label, Color, tween, Graphics, director, Canvas, Widget, Mask, screen, ResolutionPolicy, Layers } from 'cc';
import { loginAndGetProgress, saveProgress } from './api';
import { SoundManager } from './SoundManager';
import { AdManager } from './AdManager';

const { ccclass } = _decorator;
void Widget;

export enum ScrewColor {
    RED = 'red',
    BLUE = 'blue',
    YELLOW = 'yellow',
    PINK = 'pink',
    ORANGE = 'orange',
    GREEN = 'green',
    PURPLE = 'purple',
    CYAN = 'cyan'
}

type BoxColor = ScrewColor | 'locked' | 'empty';
type PlateTheme = 'yellow' | 'blue';

interface PlateTemplate {
    type: 'circle' | 'rect';
    w: number;
    h: number;
    holes: { x: number; y: number }[];
}

interface ScrewData {
    id: string;
    color: ScrewColor;
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
    screws: ScrewData[];
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
    screws: ScrewColor[];
    isNew: boolean;
    isSlidingOut?: boolean;
    clearScheduled?: boolean;
}

interface BoxSlotView {
    node: Node;
    hole: Graphics;
    screwHost: Node;
}

interface BoxView {
    node: Node;
    body: Graphics;
    lockLabel: Label;
    slots: BoxSlotView[];
    lastBodyColor: string;
}

interface TempSlotView {
    node: Node;
    hole: Graphics;
    screwHost: Node;
}

interface ToolView {
    key: 'add' | 'clear';
    node: Node;
    iconLabel: Label;
    badge: Graphics;
    badgeLabel: Label;
}

const COLORS: ScrewColor[] = [
    ScrewColor.RED,
    ScrewColor.BLUE,
    ScrewColor.YELLOW,
    ScrewColor.PINK,
    ScrewColor.ORANGE,
    ScrewColor.GREEN,
    ScrewColor.PURPLE,
    ScrewColor.CYAN
];

const PLATE_TEMPLATES: PlateTemplate[] = [
    { type: 'rect', w: 160, h: 160, holes: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.2, y: 0.8 }, { x: 0.8, y: 0.8 }] },
    { type: 'rect', w: 140, h: 140, holes: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.8 }] },
    { type: 'rect', w: 110, h: 110, holes: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }] },
    { type: 'rect', w: 180, h: 100, holes: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] },
    { type: 'rect', w: 100, h: 180, holes: [{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }] },
    { type: 'circle', w: 140, h: 140, holes: [{ x: 0.5, y: 0.5 }] }
];

const BOX_COLORS: Record<ScrewColor, Color> = {
    [ScrewColor.RED]: new Color(220, 80, 70),
    [ScrewColor.BLUE]: new Color(70, 110, 200),
    [ScrewColor.YELLOW]: new Color(240, 190, 50),
    [ScrewColor.PINK]: new Color(235, 120, 150),
    [ScrewColor.ORANGE]: new Color(245, 150, 60),
    [ScrewColor.GREEN]: new Color(100, 190, 120),
    [ScrewColor.PURPLE]: new Color(155, 85, 195),
    [ScrewColor.CYAN]: new Color(80, 180, 200)
};

const FACE_COLORS: Record<PlateTheme, Color> = {
    yellow: new Color(200, 170, 100, 255),
    blue: new Color(180, 150, 110, 255)
};

const SCREW_FACE_COLORS: Record<ScrewColor, Color> = {
    red: new Color(200, 60, 50, 255),
    blue: new Color(55, 90, 180, 255),
    yellow: new Color(225, 175, 40, 255),
    pink: new Color(220, 100, 130, 255),
    orange: new Color(230, 135, 45, 255),
    green: new Color(80, 170, 100, 255),
    purple: new Color(135, 70, 175, 255),
    cyan: new Color(60, 160, 185, 255)
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

@ccclass('GameManager')
export class GameManager extends Component {
    private rootNode: Node | null = null;
    private currentLevel = 1;
    private maxTempHoles = 5;
    private totalScrews = 0;
    private removedScrews = 0;
    private gameOver = false;
    private loadingNode: Node | null = null;

    private boxes: BoxData[] = [];
    private tempHoles: ScrewColor[] = [];
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
        this.initSound();
        this.initAd();
        this.showLoadingOverlay();
        const loadStart = Date.now();
        this.currentLevel = await loginAndGetProgress();
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
        this.progressLabel = null;
    }

    private initGame() {
        this.gameOver = false;
        this.plates = [];
        this.tempHoles = [];
        this.removedScrews = 0;
        this.tools = { add: 0, clear: 1 };
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
            { color: ScrewColor.YELLOW, capacity: 3, screws: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: ScrewColor.BLUE, capacity: 3, screws: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: 'locked', capacity: 3, screws: [], isNew: false, isSlidingOut: false, clearScheduled: false },
            { color: 'locked', capacity: 3, screws: [], isNew: false, isSlidingOut: false, clearScheduled: false }
        ];
        this.generateLevel();
        
        this.boxes[0].capacity = this.getNextCapacityForColor(this.boxes[0].color, this.boxes[0]);
        this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
        
        this.ensurePrimaryBoxes();
        this.renderAll();
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
        const boxHeight = 92;
        const gap = (this.screenWidth - 40 - boxWidth * 4) / 3;
        const startX = -((boxWidth * 4 + gap * 3) / 2) + boxWidth / 2;

        this.boxes.forEach((box, index) => {
            if (index < 2 && !this.isValidPrimaryBoxColor(box.color)) {
                const fallback = this.getPrimaryBoxFallbackColor(index);
                this.updateBoxColor(box, fallback);
            }

            const x = startX + index * (boxWidth + gap);
            const view = this.boxViews[index];
            const boxNode = view.node;
            boxNode.setPosition(new Vec3(x, 0, 0));
            boxNode.active = true;
            const bodyColor = box.color === 'locked'
                ? new Color(140, 120, 90, 255)
                : box.color === 'empty'
                    ? new Color(180, 170, 150, 255)
                    : this.getBoxColor(box.color);
            const colorKey = `${box.color}_${box.capacity}`;
            if (view.lastBodyColor !== colorKey) {
                this.drawBasketBody(view.body, boxWidth, boxHeight, bodyColor, box.color);
                view.lastBodyColor = colorKey;
            }

            const isLocked = box.color === 'locked';
            view.lockLabel.node.active = isLocked;
            const boxCapacity = box.capacity || 3;
            const screwSize = boxCapacity >= 6 ? 20 : (boxCapacity >= 5 ? 22 : (boxCapacity >= 4 ? 24 : 26));
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
                    this.updateScrewHost(slotView.screwHost, screwSize);
                    return;
                }

                if (isLocked) {
                    this.updateScrewHost(slotView.screwHost, screwSize);
                    return;
                }

                const screwColor = box.color === 'empty' ? undefined : box.screws[slotIndex];
                slotView.hole.node.active = !screwColor;
                this.updateScrewHost(slotView.screwHost, screwSize, screwColor);
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
            this.updateScrewHost(slotView.screwHost, 26, color);
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
            view.iconLabel.color = (tool.count <= 0 && tool.key !== 'add')
                ? new Color(200, 200, 200, 255)
                : new Color(255, 255, 255, 255);
            const badgeColor = (tool.count <= 0 && tool.key !== 'add') ? new Color(160, 150, 130, 255) : new Color(220, 160, 50, 255);
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

    private renderModal(config: { title: string; sub: string; button: string; onConfirm: () => void; height?: number } | null) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();
        if (!config) return;

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 110), 0);

        const panelH = config.height || 300;
        const panelW = this.screenWidth * 0.78;
        const panel = this.createNode('Panel', this.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.createGraphicsNode('PanelBg', panel, panelW, panelH, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(255, 255, 255, 255), 24);

        this.createLabel(panel, config.title, 0, panelH / 2 - 40, 26, new Color(32, 36, 42, 255), true);

        const subH = panelH - 130;
        const subNode = this.createNode('SubLabel', panel, 0, 0, panelW - 40, subH);
        const subLabel = subNode.addComponent(Label);
        subLabel.string = config.sub;
        subLabel.fontSize = 16;
        subLabel.lineHeight = 26;
        subLabel.color = new Color(88, 95, 108, 255);
        subLabel.horizontalAlign = 1;
        subLabel.verticalAlign = 1;
        subLabel.enableWrapText = true;

        const button = this.createNode('Confirm', panel, 0, -panelH / 2 + 40, 150, 50);
        const buttonBg = this.createGraphicsNode('BtnBg', button, 150, 50, 0, 0);
        this.drawRoundedRect(buttonBg.getComponent(Graphics)!, 150, 50, new Color(100, 155, 85, 255), 25);
        this.createLabel(button, config.button, 0, 0, 20, new Color(255, 255, 255, 255), true);
        button.on(Node.EventType.TOUCH_END, () => {
            this.renderModal(null);
            config.onConfirm();
        }, this);
    }

    private getProgressText() {
        if (this.totalScrews <= 0) return '0%';
        return `${Math.floor((this.removedScrews / this.totalScrews) * 100)}%`;
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
            box.screws = [];
            box.isNew = false;
            box.isSlidingOut = false;
        });
        const numTriplets = Math.min(15, 2 + levelNum);
        const screwsToPlace: ScrewColor[] = [];

        for (let i = 0; i < numTriplets; i++) {
            const color = activeColors[Math.floor(Math.random() * activeColors.length)];
            screwsToPlace.push(color, color, color);
        }

        screwsToPlace.sort(() => Math.random() - 0.5);
        this.totalScrews = screwsToPlace.length;

        const distinctColors = [...new Set(screwsToPlace)];
        this.boxes[0].color = distinctColors[0] || ScrewColor.YELLOW;
        if (distinctColors.length > 1) {
            this.boxes[1].color = distinctColors[1];
        } else {
            const otherColors = activeColors.filter((color) => color !== distinctColors[0]);
            this.boxes[1].color = otherColors.length > 0
                ? otherColors[Math.floor(Math.random() * otherColors.length)]
                : (distinctColors[0] || ScrewColor.BLUE);
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

        const spreadFactor = Math.max(0.62, 1.16 - levelNum * 0.07);
        const rangeX = 168 * spreadFactor;
        const rangeY = 228 * spreadFactor;
        const centerYOffset = 12;
        const generatedCenters: { x: number; y: number }[] = [];
        let totalHolesAvailable = 0;
        let plateIndex = 0;

        while (totalHolesAvailable < this.totalScrews) {
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
                screws: [],
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

        screwsToPlace.forEach((color, index) => {
            const target = allAvailableHoles.pop();
            if (!target) return;

            const hole = target.plate.holes[target.holeIndex];
            target.plate.screws.push({
                id: `s_${index}`,
                color,
                x: hole.x,
                y: hole.y,
                removed: false
            });
        });

        this.plates = this.plates.filter((plate) => plate.screws.length > 0);
        this.plates.forEach((plate) => this.updatePlateGravity(plate));
    }

    private getAvailableScrewsForNewBox(color: ScrewColor, targetBox: BoxData): number {
        const totalOutstanding = this.getOutstandingColorCount(color);
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

        const remaining = this.getAvailableScrewsForNewBox(color as ScrewColor, targetBox);
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
        const remaining = plate.screws.filter(s => !s.removed);
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

    private handleScrewClick(plate: PlateData, screw: ScrewData) {
        if (this.gameOver) return;

        if (this.isScrewBlocked(plate, screw)) {
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

        const targetBox = this.boxes.find((box) => box.color === screw.color && box.screws.length < box.capacity);
        if (!targetBox) {
            if (this.tempHoles.length >= this.maxTempHoles) {
                this.gameOver = true;
                this.renderModal({
                    title: '暂存孔满了',
                    sub: '孔位已满，重试这一关吧',
                    button: '重试一次',
                    height: 180,
                    onConfirm: () => {
                        this.initGame();
                    }
                });
                return;
            }
            this.tempHoles.push(screw.color);
        } else {
            targetBox.screws.push(screw.color);
        }

        screw.removed = true;
        this.removedScrews++;

        this.renderTopUI();

        if (targetBox && this.canClearBox(targetBox)) {
            this.scheduleBoxClear(targetBox, 0.25, true);
        }

        const remaining = plate.screws.filter((item) => !item.removed);
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

            targetBox.screws = [];
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
            const targetBox = this.boxes.find((box) => box.color === color && box.screws.length < box.capacity);
            if (!targetBox) continue;
            targetBox.screws.push(color);
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
        const colors = new Set<ScrewColor>();
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            plate.screws.forEach((screw) => {
                if (!screw.removed) {
                    colors.add(screw.color);
                }
            });
        });
        this.tempHoles.forEach((color) => colors.add(color));
        return Array.from(colors);
    }

    private isValidPrimaryBoxColor(color: BoxColor): color is ScrewColor {
        return COLORS.indexOf(color as ScrewColor) !== -1;
    }

    private getPrimaryBoxFallbackColor(index: number): ScrewColor {
        const remaining = this.getRemainingColors();
        const otherPrimary = index === 0 ? this.boxes[1] : this.boxes[0];
        const otherColor = otherPrimary && this.isValidPrimaryBoxColor(otherPrimary.color)
            ? otherPrimary.color
            : null;
        const candidate = remaining.find((color) => color !== otherColor);
        if (candidate) return candidate;
        return COLORS[index] || ScrewColor.YELLOW;
    }

    private updateBoxColor(box: BoxData, color: BoxColor) {
        if (box.color === color) return;
        box.clearScheduled = false;
        box.isSlidingOut = false;
        box.color = color;
        if (color === 'locked' || color === 'empty') {
            box.screws = [];
            return;
        }
        if (box.screws.some((screw) => screw !== color)) {
            box.screws = [];
        }
    }

    private getOutstandingColorCount(color: ScrewColor) {
        let count = 0;
        this.boxes.forEach((box) => {
            count += box.screws.filter((screw) => screw === color).length;
        });
        this.tempHoles.forEach((tempColor) => {
            if (tempColor === color) count++;
        });
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            plate.screws.forEach((screw) => {
                if (!screw.removed && screw.color === color) {
                    count++;
                }
            });
        });
        return count;
    }

    private getPreferredRefreshColors() {
        const weights = new Map<ScrewColor, number>();
        const addWeight = (color: ScrewColor, weight: number) => {
            weights.set(color, (weights.get(color) || 0) + weight);
        };

        this.tempHoles.forEach((color) => addWeight(color, 100));
        this.plates.forEach((plate) => {
            if (plate.removed) return;
            plate.screws.forEach((screw) => {
                if (screw.removed) return;
                addWeight(screw.color, 1);
                if (!this.isScrewBlocked(plate, screw)) {
                    addWeight(screw.color, 20);
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
            .map((box) => box.color as ScrewColor);

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

    private getUniqueReplacementColor(exclude: BoxData, duplicateColor: ScrewColor): BoxColor {
        const remaining = this.getRemainingColors().filter((color) => color !== duplicateColor);
        const activeColors = this.boxes
            .filter((box) => box !== exclude && box.color !== 'locked' && box.color !== 'empty')
            .map((box) => box.color as ScrewColor);

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
        const activeBoxes = this.boxes.filter((box): box is BoxData & { color: ScrewColor } => this.isValidPrimaryBoxColor(box.color));
        const processed = new Set<ScrewColor>();

        activeBoxes.forEach((box) => {
            const color = box.color;
            if (processed.has(color)) return;
            processed.add(color);

            const sameColorBoxes = this.boxes.filter((item) => item.color === color);
            if (sameColorBoxes.length <= 1) return;

            const outstandingCount = this.getOutstandingColorCount(color);
            if (outstandingCount > box.capacity) return;

            sameColorBoxes.sort((a, b) => b.screws.length - a.screws.length);
            const primary = sameColorBoxes[0];
            let mergedCount = 0;
            sameColorBoxes.forEach((item) => {
                mergedCount += item.screws.filter((screw) => screw === color).length;
            });
            primary.screws = Array(Math.min(primary.capacity, mergedCount)).fill(color);

            for (let i = 1; i < sameColorBoxes.length; i++) {
                const extraBox = sameColorBoxes[i];
                extraBox.screws = [];
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
        if (!this.isValidPrimaryBoxColor(box.color) || box.screws.length === 0) return false;
        if (!box.screws.every((screw) => screw === box.color)) return false;

        if (box.screws.length === box.capacity) return true;

        if (box.screws.length === this.getOutstandingColorCount(box.color)) return true;

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
        const active = firstTwo.filter((box) => this.isValidPrimaryBoxColor(box.color));
        const missing = 2 - active.length;
        if (missing <= 0) {
            if (this.boxes[0].color === this.boxes[1].color) {
                this.updateBoxColor(this.boxes[1], this.getPrimaryBoxFallbackColor(1));
                this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
            }
            return;
        }

        const remaining = this.getRemainingColors();
        const used = new Set(active.map((box) => box.color as ScrewColor));
        const fillColors = remaining.filter((color) => !used.has(color));

        for (let i = 0; i < 2; i++) {
            const box = this.boxes[i];
            if (this.isValidPrimaryBoxColor(box.color)) continue;
            const color = fillColors.shift() || remaining[0] || COLORS[i] || ScrewColor.YELLOW;
            this.updateBoxColor(box, color);
            box.screws = [];
            box.capacity = this.getNextCapacityForColor(box.color, box);
        }

        if (this.boxes[0].color === this.boxes[1].color) {
            this.updateBoxColor(this.boxes[1], this.getPrimaryBoxFallbackColor(1));
            this.boxes[1].capacity = this.getNextCapacityForColor(this.boxes[1].color, this.boxes[1]);
        }
    }

    private reevaluateBoxColors() {
        const remaining = this.getRemainingColors();
        if (remaining.length === 0) return;

        const activeBoxes = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty');
        const missingColors = remaining.filter((color) => !activeBoxes.some((box) => box.color === color));
        if (missingColors.length === 0) return;

        const emptyActiveBoxes = activeBoxes.filter((box) => box.screws.length === 0);
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
            this.showAdThen(() => {
                this.tryConsumeTool(type, () => this.handleUnlockBox(lockedBox));
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
        this.showAdThen(() => {
            this.tryConsumeTool(type, () => {
                this.tempHoles = [];
                this.renderTopUI();
                this.checkWin();
            });
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
        if (!forceDropOut && this.hasRemainingScrews(plate)) return;

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
            height: 180,
            onConfirm: () => {
                this.currentLevel++;
                saveProgress(this.currentLevel);
                this.initGame();
            }
        });
    }

    private readonly SCREW_BLOCK_COVERAGE = 0.3;

    private isScrewBlocked(plate: PlateData, screw: ScrewData) {
        const screwLocalX = screw.x - plate.w / 2;
        const screwLocalY = plate.h / 2 - screw.y;
        const screwWorld = this.plateLocalToWorld(plate, screwLocalX, screwLocalY);

        const screwRadius = 15;
        const sampleStep = 5;
        const samplePoints: { x: number; y: number }[] = [];

        for (let sx = -screwRadius; sx <= screwRadius; sx += sampleStep) {
            for (let sy = -screwRadius; sy <= screwRadius; sy += sampleStep) {
                if (sx * sx + sy * sy <= screwRadius * screwRadius) {
                    samplePoints.push({ x: screwWorld.x + sx, y: screwWorld.y + sy });
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

            if (coveredCount / totalSamples >= this.SCREW_BLOCK_COVERAGE) {
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

    private hasRemainingScrews(plate: PlateData) {
        return plate.screws.some((screw) => !screw.removed);
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

        plate.screws.filter((screw) => !screw.removed).forEach((screw) => {
            const screwSize = 34;
            const localX = -plate.w / 2 + screw.x;
            const localY = plate.h / 2 - screw.y;

            const fruitContainer = this.createNode(`FruitContainer_${screw.id}`, plateNode, localX, localY, screwSize, screwSize);

            const holeShadow = this.createGraphicsNode('Hole', fruitContainer, screwSize, screwSize, 0, 0);
            this.drawCircle(holeShadow.getComponent(Graphics)!, screwSize / 2, new Color(80, 60, 30, 60), 0);

            const screwNode = this.createScrewVisual(fruitContainer, 0, 0, screwSize, screw.color, true);
            if (interactive) {
                screwNode.on(Node.EventType.TOUCH_END, (e) => {
                    e.propagationStopped = true;
                    this.handleScrewClick(plate, screw);
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

    private updateScrewHost(host: Node, diameter: number, color?: ScrewColor) {
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
        this.createScrewVisual(host, 0, 0, diameter, color, false);
    }

    private getBoxSlotPositions(capacity: number) {
        if (capacity === 4) {
            return [
                { x: -17, y: 14 },
                { x: 17, y: 14 },
                { x: -17, y: -11 },
                { x: 17, y: -11 }
            ];
        }
        if (capacity === 5) {
            return [
                { x: -19, y: 17 },
                { x: 19, y: 17 },
                { x: -19, y: -14 },
                { x: 19, y: -14 },
                { x: 0, y: 2 }
            ];
        }
        if (capacity === 6) {
            return [
                { x: -13, y: 24 },
                { x: -13, y: 2 },
                { x: -13, y: -20 },
                { x: 13, y: 24 },
                { x: 13, y: 2 },
                { x: 13, y: -20 }
            ];
        }
        return [
            { x: -16, y: 13 },
            { x: 16, y: 13 },
            { x: 0, y: -12 }
        ];
    }

    private ensureBoxViews() {
        if (!this.boxesContainerNode || this.boxViews.length === this.boxes.length) return;

        const boxWidth = Math.min(84, this.screenWidth * 0.2);
        const boxHeight = 92;
        const gap = (this.screenWidth - 40 - boxWidth * 4) / 3;
        const startX = -((boxWidth * 4 + gap * 3) / 2) + boxWidth / 2;
        const maxSlots = 6;
        const allSlotPositions = this.getBoxSlotPositions(maxSlots);

        while (this.boxViews.length < this.boxes.length) {
            const index = this.boxViews.length;
            const x = startX + index * (boxWidth + gap);
            const boxNode = this.createNode(`Box_${index}`, this.boxesContainerNode, x, 0, boxWidth, boxHeight);

            const backLayer = this.createGraphicsNode('BackLayer', boxNode, boxWidth + 8, boxHeight + 8, 5, -4);
            this.drawRoundedRect(backLayer.getComponent(Graphics)!, boxWidth + 8, boxHeight + 8, new Color(140, 115, 80, 120), 12);

            const shadow = this.createGraphicsNode('Shadow', boxNode, boxWidth + 6, boxHeight + 6, 2, -2);
            this.drawRoundedRect(shadow.getComponent(Graphics)!, boxWidth + 6, boxHeight + 6, new Color(155, 130, 95, 100), 12);

            const body = this.createGraphicsNode('Body', boxNode, boxWidth, boxHeight, 0, 0);
            const bodyGraphics = body.getComponent(Graphics)!;

            const lockLabel = this.createLabel(boxNode, '解锁\n果篮', 0, 0, 15, new Color(255, 255, 255, 255), true, 19);
            lockLabel.node.active = false;

            const slots: BoxSlotView[] = allSlotPositions.map((pos, slotIndex) => {
                const slotNode = this.createNode(`SlotWrap_${slotIndex}`, boxNode, pos.x, pos.y, 24, 24);
                const holeNode = this.createGraphicsNode(`Slot_${slotIndex}`, slotNode, 24, 24, 0, 0);
                const screwHost = this.createNode(`ScrewHost_${slotIndex}`, slotNode, 0, 0, 24, 24);
                return { node: slotNode, hole: holeNode.getComponent(Graphics)!, screwHost };
            });

            boxNode.on(Node.EventType.TOUCH_END, () => {
            }, this);

            this.boxViews.push({
                node: boxNode,
                body: bodyGraphics,
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
            const screwHost = this.createNode(`TempScrewHost_${index}`, slotNode, 0, 0, slotRadius * 2, slotRadius * 2);
            this.tempSlotViews.push({ node: slotNode, hole, screwHost });
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

    private createScrewVisual(parent: Node, x: number, y: number, diameter: number, color: ScrewColor, addShadow: boolean = true): Node {
        const fruitNode = this.createNode(`Fruit_${color}`, parent, x, y, diameter, diameter);

        if (addShadow) {
            const shadow = this.createGraphicsNode('Shadow', fruitNode, diameter, diameter, 0, -3);
            this.drawCircle(shadow.getComponent(Graphics)!, diameter / 2, new Color(0, 0, 0, 50), 0);
        }

        const bodyColor = BOX_COLORS[color];
        const darkColor = SCREW_FACE_COLORS[color];
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
        const sg = stemG.getComponent(Graphics)!;
        sg.fillColor = new Color(90, 150, 65, 220);
        sg.rect(-1.5, 0, 3, diameter * 0.18);
        sg.fill();
        sg.fillColor = new Color(115, 180, 80, 200);
        sg.ellipse(diameter * 0.06, diameter * 0.06, diameter * 0.06, diameter * 0.04);
        sg.fill();

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

    private drawBasketBody(graphics: Graphics, width: number, height: number, fill: Color, boxColor: BoxColor) {
        graphics.clear();
        const hw = width / 2;
        const hh = height / 2;
        const radius = 12;
        const rimH = 7;

        const isLocked = boxColor === 'locked';
        const isEmpty = boxColor === 'empty';
        const isActive = !isLocked && !isEmpty;

        const basketOuter = isLocked ? new Color(120, 100, 70, 255)
            : isEmpty ? new Color(175, 160, 140, 255)
            : new Color(185, 150, 115, 255);
        const darkBrown = new Color(105, 78, 48, 220);
        const lightBrown = new Color(210, 175, 135, 180);

        graphics.fillColor = basketOuter;
        graphics.roundRect(-hw, -hh, width, height, radius);
        graphics.fill();

        if (isActive) {
            graphics.fillColor = fill;
            graphics.roundRect(-hw + 3, -hh + 3, width - 6, height - 6, radius - 2);
            graphics.fill();
        } else if (isLocked) {
            graphics.fillColor = new Color(135, 112, 78, 255);
            graphics.roundRect(-hw + 3, -hh + 3, width - 6, height - 6, radius - 2);
            graphics.fill();
        }

        graphics.strokeColor = darkBrown;
        graphics.lineWidth = 2;
        graphics.roundRect(-hw, -hh, width, height, radius);
        graphics.stroke();

        graphics.strokeColor = lightBrown;
        graphics.lineWidth = 1;
        graphics.roundRect(-hw, -hh, width - 2, height - 2, radius);
        graphics.stroke();

        const rimY = hh - rimH;
        graphics.fillColor = new Color(140, 108, 72, 255);
        graphics.ellipse(0, rimY, hw, rimH);
        graphics.fill();
        graphics.strokeColor = lightBrown;
        graphics.lineWidth = 1;
        graphics.ellipse(0, rimY, hw - 2, rimH - 2);
        graphics.stroke();

        const handleH = 16;
        const handleW = width * 0.4;
        const handleStartY = hh - 4;
        graphics.strokeColor = new Color(145, 112, 72, 240);
        graphics.lineWidth = 3;
        graphics.moveTo(-handleW, handleStartY);
        graphics.quadraticCurveTo(0, hh + handleH, handleW, handleStartY);
        graphics.stroke();

        if (isLocked) {
            graphics.strokeColor = new Color(60, 40, 20, 200);
            graphics.lineWidth = 3;
            graphics.moveTo(-8, -4);
            graphics.lineTo(8, 4);
            graphics.stroke();
            graphics.moveTo(-8, 4);
            graphics.lineTo(8, -4);
            graphics.stroke();
        }
    }

    private getBoxColor(color: BoxColor): Color {
        return BOX_COLORS[color] || new Color(200, 200, 200, 255);
    }
}
