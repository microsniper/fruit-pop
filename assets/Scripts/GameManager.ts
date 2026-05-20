import { _decorator, Component, Node, Vec3, UITransform, Label, Color, tween, Graphics, director, Canvas, Mask, view, ResolutionPolicy } from 'cc';
import { loginAndGetProgress, saveProgress } from './api';

const { ccclass } = _decorator;

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
    rotation?: number;
    gravityOrigin?: { x: number; y: number };
}

interface BoxData {
    color: BoxColor;
    capacity: number;
    screws: ScrewColor[];
    isNew: boolean;
    isSlidingOut?: boolean;
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

const FACE_COLORS: Record<PlateTheme, Color> = {
    yellow: new Color(241, 208, 86, 255),
    blue: new Color(102, 138, 228, 255)
};

const SCREW_FACE_COLORS: Record<ScrewColor, Color> = {
    red: new Color(166, 75, 92, 255),
    blue: new Color(102, 138, 228, 255),
    yellow: new Color(242, 209, 90, 255),
    pink: new Color(231, 119, 170, 255),
    orange: new Color(245, 157, 59, 255),
    green: new Color(85, 189, 167, 255),
    purple: new Color(134, 88, 213, 255),
    cyan: new Color(90, 206, 226, 255)
};

@ccclass('GameManager')
export class GameManager extends Component {
    private rootNode: Node | null = null;
    private currentLevel = 1;
    private maxTempHoles = 5;
    private totalScrews = 0;
    private removedScrews = 0;
    private gameOver = false;

    private boxes: BoxData[] = [];
    private tempHoles: ScrewColor[] = [];
    private plates: PlateData[] = [];
    private tools = { add: 0, break: 1, clear: 1 };

    private topAreaNode: Node | null = null;
    private boardAreaNode: Node | null = null;
    private boardContentNode: Node | null = null;
    private bottomAreaNode: Node | null = null;
    private boxesContainerNode: Node | null = null;
    private tempContainerNode: Node | null = null;
    private toolContainerNode: Node | null = null;
    private modalLayerNode: Node | null = null;
    private titleLabel: Label | null = null;
    private levelBadgeLabel: Label | null = null;
    private progressLabel: Label | null = null;
    private plateNodes = new Map<string, Node>();

    private screenWidth = 0;
    private screenHeight = 0;
    private topHeight = 0;
    private boardHeight = 0;
    private bottomHeight = 0;
    private boardWidth = 0;

    async start() {
        this.setupLayout();
        this.currentLevel = await loginAndGetProgress();
        this.initGame();
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
        // 强制设置微信小游戏环境下的屏幕适配策略为 EXACT_FIT，拉伸铺满全屏
        view.setDesignResolutionSize(375, 812, ResolutionPolicy.EXACT_FIT);

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

        this.rootNode = new Node('GameRoot');
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
            // 在微信小游戏环境下，直接使用 view 获取的实际可见区域大小来计算缩放
            const visibleSize = view.getVisibleSize();
            if (visibleSize.width > 0 && visibleSize.height > 0) {
                const scaleX = visibleSize.width / this.screenWidth;
                const scaleY = visibleSize.height / this.screenHeight;
                // 微信下通常需要铺满，这里取较大值或者直接依赖 EXACT_FIT，这里取较小值保证内容不被裁切
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

        // 设置缩放，并居中显示
        this.rootNode.setScale(new Vec3(scale, scale, 1));
        this.rootNode.setPosition(new Vec3(0, 0, 0));

        // 清理当前测试节点的默认文字
        const selfLabel = this.node.getComponent(Label);
        if (selfLabel) {
            selfLabel.string = '';
        }

        const background = this.createGraphicsNode('Background', this.rootNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(background.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(232, 239, 247, 255), 0);

        const topY = this.screenHeight / 2 - this.topHeight / 2;
        const boardY = -this.screenHeight / 2 + this.bottomHeight + this.boardHeight / 2;
        const bottomY = -this.screenHeight / 2 + this.bottomHeight / 2;

        this.topAreaNode = this.createNode('TopArea', this.rootNode, 0, topY, this.screenWidth, this.topHeight);
        const topBg = this.createGraphicsNode('TopBg', this.topAreaNode, this.screenWidth, this.topHeight, 0, 0);
        this.drawRoundedRect(topBg.getComponent(Graphics)!, this.screenWidth, this.topHeight, new Color(240, 244, 249, 255), 0);

        this.boardAreaNode = this.createNode('BoardArea', this.rootNode, 0, boardY, this.screenWidth, this.boardHeight);
        const boardMask = this.boardAreaNode.addComponent(Mask);
        
        const boardBg = this.createGraphicsNode('BoardBg', this.boardAreaNode, this.screenWidth, this.boardHeight, 0, 0);
        this.drawRoundedRect(boardBg.getComponent(Graphics)!, this.screenWidth, this.boardHeight, new Color(204, 220, 235, 255), 0);

        this.boardContentNode = this.createNode('BoardContent', this.boardAreaNode, 0, 0, this.boardWidth, this.boardHeight - 20);

        this.bottomAreaNode = this.createNode('BottomArea', this.rootNode, 0, bottomY, this.screenWidth, this.bottomHeight);
        const bottomBg = this.createGraphicsNode('BottomBg', this.bottomAreaNode, this.screenWidth, this.bottomHeight, 0, 0);
        this.drawRoundedRect(bottomBg.getComponent(Graphics)!, this.screenWidth, this.bottomHeight, new Color(201, 218, 234, 255), 0);

        this.modalLayerNode = this.createNode('ModalLayer', this.rootNode, 0, 0, this.screenWidth, this.screenHeight);
        this.modalLayerNode.setSiblingIndex(999);

        this.buildStaticTopUI();
        this.boxesContainerNode = this.createNode('Boxes', this.topAreaNode, 0, 8, this.screenWidth - 40, 130);
        this.tempContainerNode = this.createNode('TempSlots', this.topAreaNode, 0, -this.topHeight * 0.26, this.screenWidth - 60, 90);
        this.toolContainerNode = this.createNode('Tools', this.bottomAreaNode, 0, 0, this.screenWidth - 40, this.bottomHeight - 10);
    }

    private buildStaticTopUI() {
        if (!this.topAreaNode) return;

        const topInnerY = this.topHeight / 2 - 42;

        this.levelBadgeLabel = this.createLabel(this.topAreaNode, '第 1 关', 0, topInnerY + 8, 22, new Color(255, 255, 255, 255), true);

        const badge = this.createGraphicsNode('LevelBadgeBg', this.topAreaNode, 130, 44, 0, topInnerY + 8);
        badge.setSiblingIndex(0);
        this.drawRoundedRect(badge.getComponent(Graphics)!, 130, 44, new Color(165, 172, 183, 255), 22);

        this.progressLabel = this.createLabel(this.topAreaNode, '进度 0%', this.screenWidth / 2 - 78, -this.topHeight / 2 + 30, 16, new Color(52, 58, 68, 255), true);
    }

    private initGame() {
        this.gameOver = false;
        this.tempHoles = [];
        this.removedScrews = 0;
        this.tools = { add: 0, break: 1, clear: 1 };
        this.boxes = [
            { color: 'empty', capacity: 3, screws: [], isNew: false, isSlidingOut: false },
            { color: 'empty', capacity: 3, screws: [], isNew: false, isSlidingOut: false },
            { color: 'locked', capacity: 3, screws: [], isNew: false, isSlidingOut: false },
            { color: 'locked', capacity: 3, screws: [], isNew: false, isSlidingOut: false }
        ];
        this.generateLevel();
        this.renderAll();
    }

    private renderAll() {
        this.renderTopUI();
        this.renderBoard();
        this.renderTools();
        this.renderModal(null);
    }

    private renderTopUI() {
        if (this.titleLabel) {
            this.titleLabel.string = '放我出去呗';
        }
        if (this.levelBadgeLabel) {
            this.levelBadgeLabel.string = `第 ${this.currentLevel} 关`;
        }
        if (this.progressLabel) {
            this.progressLabel.string = `进度 ${this.getProgressText()}`;
        }

        this.renderBoxes();
        this.renderTempSlots();
    }

    private renderBoxes() {
        if (!this.boxesContainerNode) return;
        this.boxesContainerNode.removeAllChildren();

        const boxWidth = Math.min(76, this.screenWidth * 0.18); // 再缩窄，原来是 84
        const boxHeight = 80; // 再压扁，原来是 90
        const gap = (this.screenWidth - 40 - boxWidth * 4) / 3;
        const startX = -((boxWidth * 4 + gap * 3) / 2) + boxWidth / 2;

        this.boxes.forEach((box, index) => {
            const x = startX + index * (boxWidth + gap);
            const boxNode = this.createNode(`Box_${index}`, this.boxesContainerNode!, x, 0, boxWidth, boxHeight);

            const shadow = this.createGraphicsNode('Shadow', boxNode, boxWidth + 6, boxHeight + 6, 2, -2);
            this.drawRoundedRect(shadow.getComponent(Graphics)!, boxWidth + 6, boxHeight + 6, new Color(210, 218, 228, 120), 10);

            const body = this.createGraphicsNode('Body', boxNode, boxWidth, boxHeight, 0, 0);
            const bodyColor = box.color === 'locked'
                ? new Color(91, 204, 189, 255)
                : box.color === 'empty'
                    ? new Color(240, 244, 249, 0)
                    : this.getBoxColor(box.color);
            this.drawRoundedRect(body.getComponent(Graphics)!, boxWidth, boxHeight, bodyColor, 10, box.color === 'empty' ? 0 : 4, new Color(255, 255, 255, 210));

            if (box.color !== 'empty') {
                const handle = this.createGraphicsNode('Handle', boxNode, 38, 14, 0, boxHeight / 2 + 5);
                this.drawRoundedRect(handle.getComponent(Graphics)!, 38, 14, new Color(217, 218, 219, 255), 6, 2, new Color(190, 192, 197, 255));
            }

            if (box.color === 'locked') {
                this.createLabel(boxNode, '解锁\n盒子', 0, 0, 14, new Color(255, 255, 255, 255), true, 18);
                boxNode.on(Node.EventType.TOUCH_END, () => this.handleUnlockBox(box), this);
            } else if (box.color !== 'empty') {
                const slotPositions = [
                    { x: -14, y: 14 },
                    { x: 14, y: 14 },
                    { x: 0, y: -10 }
                ];
                slotPositions.forEach((pos, slotIndex) => {
                    if (!box.screws[slotIndex]) {
                        const slot = this.createGraphicsNode(`Slot_${slotIndex}`, boxNode, 20, 20, pos.x, pos.y);
                        this.drawCircle(slot.getComponent(Graphics)!, 10, new Color(0, 0, 0, 35), 0);
                    } else {
                        this.createScrewVisual(boxNode, pos.x, pos.y, 22, box.screws[slotIndex], false);
                    }
                });
            }

            if (box.isNew) {
                boxNode.scale = new Vec3(0.92, 0.92, 1);
                tween(boxNode).to(0.18, { scale: new Vec3(1.04, 1.04, 1) }).to(0.16, { scale: new Vec3(1, 1, 1) }).start();
                box.isNew = false;
            }
        });
    }

    private renderTempSlots() {
        if (!this.tempContainerNode) return;
        this.tempContainerNode.removeAllChildren();

        const containerW = this.screenWidth - 120; // 再次收窄，原来是 -90
        const containerH = 40; // 再次压扁高度，原来是 50
        const bgNode = this.createGraphicsNode('TempBg', this.tempContainerNode, containerW, containerH, 0, 0);
        this.drawRoundedRect(bgNode.getComponent(Graphics)!, containerW, containerH, new Color(228, 233, 240, 255), 20, 2, new Color(255, 255, 255, 180));

        const slotRadius = 12; // 孔位再次缩小，原来是 14
        const spacing = slotRadius * 2 + 6; // 间距收紧，原来是 + 10
        const startX = -spacing * 2;

        for (let i = 0; i < this.maxTempHoles; i++) {
            const slotNode = this.createGraphicsNode(`TempSlot_${i}`, this.tempContainerNode, slotRadius * 2, slotRadius * 2, startX + i * spacing, 0);
            this.drawCircle(slotNode.getComponent(Graphics)!, slotRadius, new Color(202, 206, 212, 255), 0);
            if (this.tempHoles[i]) {
                this.createScrewVisual(this.tempContainerNode, startX + i * spacing, 0, slotRadius * 2 - 2, this.tempHoles[i], false);
            }
        }
    }

    private renderTools() {
        if (!this.toolContainerNode) return;
        this.toolContainerNode.removeAllChildren();

        const toolList = [
            { key: 'add' as const, label: '加孔位', icon: '🔍', count: this.tools.add },
            { key: 'break' as const, label: '熔玻璃', icon: '🔨', count: this.tools.break },
            { key: 'clear' as const, label: '清空孔位', icon: '🧹', count: this.tools.clear }
        ];

        const buttonWidth = 90;
        const buttonHeight = 100;
        const gap = (this.screenWidth - 40 - buttonWidth * 3) / 2;
        const startX = -((buttonWidth * 3 + gap * 2) / 2) + buttonWidth / 2;

        toolList.forEach((tool, index) => {
            const x = startX + index * (buttonWidth + gap);
            const btnNode = this.createNode(`ToolBtn_${tool.key}`, this.toolContainerNode!, x, 0, buttonWidth, buttonHeight);

            // 背景阴影层
            const shadow = this.createGraphicsNode('Shadow', btnNode, buttonWidth + 8, buttonHeight + 8, 0, -2);
            this.drawRoundedRect(shadow.getComponent(Graphics)!, buttonWidth + 8, buttonHeight + 8, new Color(201, 218, 234, 255), 24);

            // 主底板 (带有描边效果)
            const body = this.createGraphicsNode('Body', btnNode, buttonWidth, buttonHeight, 0, 0);
            this.drawRoundedRect(body.getComponent(Graphics)!, buttonWidth, buttonHeight, new Color(138, 77, 232, 255), 22, 6, new Color(175, 133, 240, 255));

            // 图标与文字
            const iconLabel = this.createLabel(btnNode, tool.icon, 0, 10, 36, new Color(255, 255, 255, 255), false, 40);
            iconLabel.enableWrapText = false;
            // 如果工具数量不够且不是加号，增加半透明过滤效果（Cocos 中暂时用颜色变暗模拟）
            if (tool.count <= 0 && tool.key !== 'add') {
                iconLabel.color = new Color(200, 200, 200, 255);
            }
            this.createLabel(btnNode, tool.label, 0, -26, 18, new Color(255, 255, 255, 255), true);

            // 右上角数字徽标
            const badgeSize = 34;
            const badgeX = buttonWidth / 2 - 8;
            const badgeY = buttonHeight / 2 - 8;
            const badge = this.createGraphicsNode('Badge', btnNode, badgeSize, badgeSize, badgeX, badgeY);
            
            // 如果没数量了且是功能道具，徽标变成灰色
            const badgeColor = (tool.count <= 0 && tool.key !== 'add') ? new Color(168, 162, 158, 255) : new Color(245, 158, 11, 255);
            this.drawCircle(badge.getComponent(Graphics)!, badgeSize / 2, badgeColor, 3, new Color(255, 238, 196, 255));
            this.createLabel(btnNode, String(tool.count > 0 ? tool.count : '+'), badgeX, badgeY, 20, new Color(255, 255, 255, 255), true);

            btnNode.on(Node.EventType.TOUCH_END, () => {
                this.useTool(tool.key);
            }, this);
        });
    }

    private renderBoard() {
        if (!this.boardContentNode) return;
        this.boardContentNode.removeAllChildren();
        this.plateNodes.clear();

        const visiblePlates = this.plates.filter((plate) => !plate.removed).sort((a, b) => a.layer - b.layer);
        visiblePlates.forEach((plate) => {
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

            const pivotNode = this.createNode(`Pivot_${plate.id}`, this.boardContentNode!, pivotX, pivotY, 0, 0);
            pivotNode.angle = plate.rotation || 0;
            this.plateNodes.set(plate.id, pivotNode);

            const plateNode = this.createNode(`PlateVisual_${plate.id}`, pivotNode, -offsetX, -offsetY, plate.w, plate.h);

            const shadow = this.createGraphicsNode('Shadow', plateNode, plate.w + 6, plate.h + 6, 6, -6);
            this.drawPlateShape(shadow.getComponent(Graphics)!, plate.type, plate.w + 6, plate.h + 6, new Color(162, 176, 190, 105), 24, 0);

            const face = this.createGraphicsNode('Face', plateNode, plate.w, plate.h, 0, 0);
            this.drawPlateShape(face.getComponent(Graphics)!, plate.type, plate.w, plate.h, FACE_COLORS[plate.color], 22, 5, new Color(245, 248, 250, 230));

            plate.screws.filter((screw) => !screw.removed).forEach((screw) => {
                const screwSize = 38;
                const localX = -plate.w / 2 + screw.x;
                const localY = plate.h / 2 - screw.y;
                
                const screwContainer = this.createNode(`ScrewContainer_${screw.id}`, plateNode, localX, localY, screwSize, screwSize);
                
                const holeShadow = this.createGraphicsNode('Hole', screwContainer, screwSize, screwSize, 0, 0);
                this.drawCircle(holeShadow.getComponent(Graphics)!, screwSize / 2, new Color(0, 0, 0, 40), 0);
                
                const screwNode = this.createScrewVisual(screwContainer, 0, 0, screwSize, screw.color, true);
                screwNode.on(Node.EventType.TOUCH_END, (e) => {
                    e.propagationStopped = true;
                    this.handleScrewClick(plate, screw);
                }, this);
            });
        });
    }

    private renderModal(config: { title: string; sub: string; button: string; onConfirm: () => void } | null) {
        if (!this.modalLayerNode) return;
        this.modalLayerNode.removeAllChildren();
        if (!config) return;

        const mask = this.createGraphicsNode('Mask', this.modalLayerNode, this.screenWidth, this.screenHeight, 0, 0);
        this.drawRoundedRect(mask.getComponent(Graphics)!, this.screenWidth, this.screenHeight, new Color(0, 0, 0, 110), 0);

        const panel = this.createNode('Panel', this.modalLayerNode, 0, 0, this.screenWidth * 0.72, 220);
        const panelBg = this.createGraphicsNode('PanelBg', panel, this.screenWidth * 0.72, 220, 0, 0);
        this.drawRoundedRect(panelBg.getComponent(Graphics)!, this.screenWidth * 0.72, 220, new Color(255, 255, 255, 255), 24);

        this.createLabel(panel, config.title, 0, 50, 28, new Color(32, 36, 42, 255), true);
        this.createLabel(panel, config.sub, 0, 4, 18, new Color(88, 95, 108, 255), true, 28);

        const button = this.createNode('Confirm', panel, 0, -66, 150, 54);
        const buttonBg = this.createGraphicsNode('BtnBg', button, 150, 54, 0, 0);
        this.drawRoundedRect(buttonBg.getComponent(Graphics)!, 150, 54, new Color(136, 74, 231, 255), 27);
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
        this.boxes[1].color = distinctColors[1] || activeColors.find((color) => color !== this.boxes[0].color) || distinctColors[0] || ScrewColor.BLUE;

        let availableTemplates = PLATE_TEMPLATES;
        if (levelNum === 1) {
            availableTemplates = PLATE_TEMPLATES.filter((template) => template.holes.length >= 3);
        }

        const spreadFactor = Math.max(0.5, 1.2 - levelNum * 0.1); 
        const rangeX = 160 * spreadFactor; // 扩大范围，避免太居中
        const rangeY = 220 * spreadFactor; 
        const centerYOffset = 0;
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
                const ty = (Math.random() * 2 - 1) * rangeY;
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
                    return { x: hole.y * template.h, y: (1 - hole.x) * template.w };
                }
                return { x: hole.x * template.w, y: hole.y * template.h };
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

        const targetBox = this.boxes.find((box) => box.color === screw.color && box.screws.length < box.capacity);
        if (!targetBox) {
            if (this.tempHoles.length >= this.maxTempHoles) {
                this.gameOver = true;
                this.renderModal({
                    title: '暂存孔满了',
                    sub: '孔位已满，重试这一关吧',
                    button: '重试一次',
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

        if (targetBox && targetBox.screws.length === targetBox.capacity) {
            this.scheduleOnce(() => {
                this.clearBoxAndAssignNewColor(targetBox);
            }, 0.25);
        }

        const remaining = plate.screws.filter((item) => !item.removed);
        if (remaining.length === 0) {
            this.renderBoard();
            const plateNode = this.plateNodes.get(plate.id);
            if (plateNode) {
                tween(plateNode)
                    .to(0.7, { position: new Vec3(plateNode.position.x, plateNode.position.y - this.boardHeight - 120, 0), angle: (plate.rotation || 0) - 18 }, { easing: 'quadIn' })
                    .call(() => {
                        plate.removed = true;
                        this.renderBoard();
                        this.checkWin();
                    })
                    .start();
            } else {
                plate.removed = true;
                this.renderBoard();
                this.checkWin();
            }
        } else {
            const oldRotation = plate.rotation || 0;
            this.updatePlateGravity(plate);
            this.renderBoard();

            if (oldRotation !== (plate.rotation || 0)) {
                const plateNode = this.plateNodes.get(plate.id);
                if (plateNode) {
                    plateNode.angle = oldRotation;
                    // 旋转动画时间从 0.5 秒延长到 1.2 秒，使用 backOut 缓动让它下垂时有轻微回弹，显得更真实沉重
                    tween(plateNode).stop();
                    tween(plateNode)
                        .to(1.2, { angle: plate.rotation || 0 }, { easing: 'backOut' })
                        .start();
                }
            }

            this.checkWin();
        }
    }

    private clearBoxAndAssignNewColor(targetBox: BoxData) {
        targetBox.isSlidingOut = true;
        this.renderBoxes();

        this.scheduleOnce(() => {
            targetBox.screws = [];
            targetBox.isSlidingOut = false;

            let colorsToConsider = new Set<ScrewColor>();
            this.plates.forEach((plate) => {
                if (plate.removed) return;
                plate.screws.forEach((screw) => {
                    if (!screw.removed && !this.isScrewBlocked(plate, screw)) {
                        colorsToConsider.add(screw.color);
                    }
                });
            });

            let remaining = Array.from(colorsToConsider);
            if (remaining.length === 0) {
                remaining = this.getRemainingColors();
            }

            const currentColors = this.boxes.filter((box) => box !== targetBox && box.color !== 'locked' && box.color !== 'empty').map((box) => box.color);
            let available = remaining.filter((color) => currentColors.indexOf(color) === -1);
            if (available.length === 0) {
                available = this.getRemainingColors().filter((color) => currentColors.indexOf(color) === -1);
            }

            targetBox.color = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : 'empty';
            targetBox.isNew = available.length > 0;
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

            if (targetBox.screws.length === targetBox.capacity) {
                this.scheduleOnce(() => {
                    this.clearBoxAndAssignNewColor(targetBox);
                }, 0.2);
            }
        }
        if (changed) {
            this.renderTopUI();
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

    private handleUnlockBox(targetBox: BoxData) {
        if (this.gameOver || targetBox.color !== 'locked') return;

        const remaining = this.getRemainingColors();
        const active = this.boxes.filter((box) => box.color !== 'locked' && box.color !== 'empty').map((box) => box.color);
        let available = remaining.filter((color) => active.indexOf(color) === -1);
        if (available.length === 0) {
            available = COLORS.filter((color) => active.indexOf(color) === -1);
        }

        if (available.length > 0) {
            targetBox.color = available[Math.floor(Math.random() * available.length)];
            targetBox.isNew = true;
            this.renderTopUI();
            this.autoFillFromTemp();
        }
    }

    private useTool(type: 'add' | 'break' | 'clear') {
        if (this.gameOver) return;

        if (type === 'add') {
            const lockedBox = this.boxes.find((box) => box.color === 'locked');
            if (!lockedBox) return;
            this.tryConsumeTool(type, () => this.handleUnlockBox(lockedBox));
            return;
        }

        if (type === 'break') {
            const visible = this.plates.filter((plate) => !plate.removed);
            if (visible.length === 0) return;
            this.tryConsumeTool(type, () => {
                visible.sort((a, b) => b.layer - a.layer);
                const target = visible[0];
                target.removed = true;
                this.renderBoard();
                this.checkWin();
            });
            return;
        }

        const hasPartialBox = this.boxes.some((box) => box.color !== 'locked' && box.color !== 'empty' && box.screws.length > 0 && box.screws.length < box.capacity);
        if (!hasPartialBox && this.tempHoles.length === 0) return;
        this.tryConsumeTool(type, () => {
            this.boxes.forEach((box) => {
                if (box.color !== 'locked' && box.color !== 'empty' && box.screws.length > 0 && box.screws.length < box.capacity) {
                    box.screws = [];
                }
            });
            this.tempHoles = [];
            this.renderTopUI();
        });
    }

    private tryConsumeTool(type: 'add' | 'break' | 'clear', callback: () => void) {
        if (this.tools[type] > 0) {
            this.tools[type]--;
        }
        callback();
        this.renderTools();
    }

    private checkWin() {
        if (this.gameOver) return;
        const allRemoved = this.plates.every((plate) => plate.removed);
        if (!allRemoved || this.tempHoles.length > 0) return;

        this.gameOver = true;
        this.renderModal({
            title: '通关成功',
            sub: `太棒了，你已完成第 ${this.currentLevel} 关`,
            button: '下一关',
            onConfirm: () => {
                this.currentLevel++;
                saveProgress(this.currentLevel);
                this.initGame();
            }
        });
    }

    private isScrewBlocked(plate: PlateData, screw: ScrewData) {
        const screwAbsX = plate.x - plate.w / 2 + screw.x;
        const screwAbsY = plate.y + plate.h / 2 - screw.y;
        const samplePoints = [
            { x: 0, y: 0 },
            { x: 0, y: -8 },
            { x: 8, y: 0 },
            { x: 0, y: 8 },
            { x: -8, y: 0 },
            { x: 6, y: -6 },
            { x: 6, y: 6 },
            { x: -6, y: 6 },
            { x: -6, y: -6 }
        ];

        for (const other of this.plates) {
            if (other.id === plate.id || other.removed || other.layer <= plate.layer) continue;
            let insideCount = 0;
            samplePoints.forEach((point) => {
                if (this.isPointInsidePlate(other, screwAbsX + point.x, screwAbsY + point.y)) {
                    insideCount++;
                }
            });
            if (insideCount >= 7) {
                return true;
            }
        }
        return false;
    }

    private isPointInsidePlate(plate: PlateData, x: number, y: number) {
        const rotation = plate.rotation || 0;
        let localX = x;
        let localY = y;

        if (rotation !== 0) {
            const originX = plate.x - plate.w / 2 + (plate.gravityOrigin?.x ?? plate.w / 2);
            const originY = plate.y + plate.h / 2 - (plate.gravityOrigin?.y ?? plate.h / 2);
            const rad = -rotation * Math.PI / 180;
            const dx = x - originX;
            const dy = y - originY;
            localX = originX + dx * Math.cos(rad) - dy * Math.sin(rad);
            localY = originY + dx * Math.sin(rad) + dy * Math.cos(rad);
        }

        const left = plate.x - plate.w / 2;
        const right = plate.x + plate.w / 2;
        const bottom = plate.y - plate.h / 2;
        const top = plate.y + plate.h / 2;
        return localX >= left && localX <= right && localY >= bottom && localY <= top;
    }

    private createNode(name: string, parent: Node, x: number, y: number, width: number, height: number) {
        const node = new Node(name);
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);
        node.setPosition(new Vec3(x, y, 0));
        parent.addChild(node);
        return node;
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

    private createScrewVisual(parent: Node, x: number, y: number, size: number, color: ScrewColor, clickable: boolean) {
        const node = this.createNode('Screw', parent, x, y, size + 8, size + 8);
        const shadow = this.createGraphicsNode('Shadow', node, size + 4, size + 4, 0, -4);
        this.drawCircle(shadow.getComponent(Graphics)!, (size + 4) / 2, new Color(71, 58, 66, 80), 0);

        const face = this.createGraphicsNode('Face', node, size, size, 0, 0);
        this.drawCircle(face.getComponent(Graphics)!, size / 2, SCREW_FACE_COLORS[color], 3, new Color(255, 255, 255, 90));

        this.createLabel(node, '+', 0, -1, Math.floor(size * 0.52), color === ScrewColor.YELLOW ? new Color(109, 85, 32, 255) : new Color(66, 23, 31, 255), true);

        if (clickable) {
            const hit = node.getComponent(UITransform);
            if (hit) {
                hit.setContentSize(size + 14, size + 14);
            }
        }
        return node;
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

    private getBoxColor(color: BoxColor) {
        if (color === 'empty' || color === 'locked') {
            return new Color(255, 255, 255, 255);
        }
        const faceColor = SCREW_FACE_COLORS[color];
        return new Color(
            Math.min(255, faceColor.r + 18),
            Math.min(255, faceColor.g + 22),
            Math.min(255, faceColor.b + 18),
            255
        );
    }
}
