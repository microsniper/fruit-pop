import { Node, Color, Graphics, Sprite, Label, UITransform } from 'cc';
import { fetchResources, ResourceCodeTypeEnum } from './api';
import { PropStore } from './PropStore';
import type { GameManager } from './GameManager';

/**
 * 个人仓库页：整页切换（与排行榜页同款架构），纯代码绘制、无底图素材。
 * 顶栏返回+标题；主 tab 横排「道具 | 收集」；收集页内横排子 tab「关卡收集 | 比赛收集」。
 * 格子全由数据数组驱动：道具 6 条固定目录（数量实时读 PropStore/totalCoins），
 * 收集目录 COLLECT_CATALOG 预留后端化（皮肤系统上线后随返回数据增减格子）。
 * 数据全本地，零后端依赖。
 */

/** 收集品目录（code 与 game_collect.collect_code 对齐；group 与收集表 group_code 同口径） */
const COLLECT_CATALOG = [
    { code: 'cat', name: '小猫', group: 'animal' },
    { code: 'dog', name: '小狗', group: 'animal' },
    { code: 'car', name: '汽车', group: 'car' },
    { code: 'doll', name: '公仔', group: 'doll' },
];

/** 收集分组显示名（顺序即子 tab 顺序） */
const COLLECT_GROUPS = [
    { key: 'animal', name: '动物' },
    { key: 'car', name: '车辆' },
    { key: 'doll', name: '公仔' },
];

const BROWN = new Color(110, 75, 45, 255);
const BEIGE = new Color(240, 230, 205, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const BLUE = new Color(30, 136, 229, 255);

export class StoragePage {
    private pageNode: Node | null = null;
    private contentNode: Node | null = null;
    private mainTab: 'tools' | 'collect' = 'tools';
    /** 收集页子 tab：按 group_code 分组（动物/车辆/公仔），不分模式 */
    private subTab = 'animal';
    /** 顶栏 tab 的 Y 坐标（render 里算好，内容层布局复用） */
    private tabY = 0;

    constructor(private gm: GameManager) {}

    open() {
        this.render();
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
            this.pageNode = null;
        }
        this.contentNode = null;
    }

    // ===== 页面骨架 =====

    private render() {
        this.close();
        if (this.gm.rootNode) this.gm.rootNode.removeAllChildren();
        this.gm.teardownGameView();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.pageNode = this.gm.createNode('StoragePage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // 弹窗层：横幅等挂载在此（整页切换销毁了游戏界面的弹窗层，需重建，与 HomePage 同款）
        this.gm.modalLayerNode = this.gm.createNode('ModalLayer', this.gm.rootNode!, 0, 0, pageW, pageH);
        this.gm.modalLayerNode.setSiblingIndex(999);

        // 背景（与排行榜页同色）
        const bg = this.gm.createGraphicsNode('StorageBg', this.pageNode, pageW, pageH, 0, 0);
        bg.getComponent(Graphics)!.fillColor = new Color(245, 248, 240, 255);
        bg.getComponent(Graphics)!.rect(-pageW / 2, -pageH / 2, pageW, pageH);
        bg.getComponent(Graphics)!.fill();

        // 顶栏：返回 + 标题
        const headerY = pageH / 2 - 40;
        const backBtn = this.gm.createNode('BackBtn', this.pageNode, -pageW / 2 + 30, headerY, 40, 40);
        this.gm.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true);
        backBtn.on(Node.EventType.TOUCH_END, () => {
            this.close();
            this.gm.homePage.render();
        }, this);
        this.gm.createLabel(this.pageNode, '仓库', 0, headerY, 26, BROWN, true);

        // 主 tab：横排两药丸
        this.tabY = headerY - 56;
        this.renderMainTabs();

        // 内容层
        this.contentNode = this.gm.createNode('StorageContent', this.pageNode, 0, 0, pageW, pageH);
        this.renderContent();
    }

    /** 主 tab 药丸（选中蓝底白字 / 未选中米色棕字），整块可点 */
    private renderMainTabs() {
        // 旧 tab 节点挂在 pageNode 上按名字清理
        ['MainTab_tools', 'MainTab_collect'].forEach((n) => {
            const old = this.pageNode?.getChildByName(n);
            if (old) old.destroy();
        });
        const tabs: { key: 'tools' | 'collect'; name: string; x: number }[] = [
            { key: 'tools', name: '道具', x: -62 },
            { key: 'collect', name: '收集', x: 62 },
        ];
        tabs.forEach((tab) => {
            const active = this.mainTab === tab.key;
            const pill = this.gm.createNode(`MainTab_${tab.key}`, this.pageNode!, tab.x, this.tabY, 112, 38);
            const g = pill.addComponent(Graphics);
            g.fillColor = active ? BLUE : BEIGE;
            g.roundRect(-56, -19, 112, 38, 19);
            g.fill();
            if (!active) {
                g.strokeColor = BEIGE_LINE;
                g.lineWidth = 2;
                g.roundRect(-56, -19, 112, 38, 19);
                g.stroke();
            }
            this.gm.createLabel(pill, tab.name, 0, 0, 18, active ? new Color(255, 255, 255, 255) : BROWN, true);
            pill.on(Node.EventType.TOUCH_END, () => {
                if (this.mainTab !== tab.key) {
                    this.mainTab = tab.key;
                    this.renderMainTabs();
                    this.renderContent();
                }
            }, this);
        });
    }

    // ===== 内容层 =====

    private renderContent() {
        if (!this.contentNode || !this.contentNode.isValid) return;
        this.contentNode.removeAllChildren();
        if (this.mainTab === 'tools') {
            this.renderToolsContent();
        } else {
            this.renderCollectContent();
        }
    }

    /** 道具页：6 条固定目录，2 列 × 3 行，数量实时读本地背包 */
    private renderToolsContent() {
        const items = [
            { code: ResourceCodeTypeEnum.RAINBOW, name: '彩虹果', count: PropStore.getFruitCount('rainbow') },
            { code: ResourceCodeTypeEnum.BOMB, name: '炸弹果', count: PropStore.getFruitCount('bomb') },
            { code: ResourceCodeTypeEnum.COIN, name: '金币', count: this.gm.totalCoins },
            { code: ResourceCodeTypeEnum.ADD_TRAY, name: '加果盘', count: PropStore.getToolCount('addTray') },
            { code: ResourceCodeTypeEnum.CLEAR, name: '清空果盘', count: PropStore.getToolCount('clear') },
            { code: ResourceCodeTypeEnum.ADD, name: '解锁果篮', count: PropStore.getToolCount('addBasket') },
        ];
        const cols = [-82, 82];
        const firstRowY = this.tabY - 66;
        fetchResources().then((resources) => {
            if (!this.contentNode || !this.contentNode.isValid) return;
            items.forEach((item, i) => {
                const x = cols[i % 2];
                const y = firstRowY - Math.floor(i / 2) * 80;
                this.drawSlot(this.contentNode!, x, y, {
                    iconUrl: resources[item.code]?.url || '',
                    name: item.name,
                    rightText: `x${item.count}`,
                    rightColor: new Color(199, 39, 30, 255),
                });
            });
        });
    }

    /** 收集页：子 tab 按 group_code 分组（动物/车辆/公仔）+ 目录格子（收集系统未落地，全部置灰未拥有） */
    private renderCollectContent() {
        const subY = this.tabY - 56;
        const groupCount = COLLECT_GROUPS.length;
        const gap = 8;
        const pillW = Math.min(128, (300 - gap * (groupCount - 1)) / groupCount);
        const startX = -((pillW * groupCount + gap * (groupCount - 1)) / 2) + pillW / 2;
        COLLECT_GROUPS.forEach((group, gi) => {
            const active = this.subTab === group.key;
            const pill = this.gm.createNode(`SubTab_${group.key}`, this.contentNode!, startX + gi * (pillW + gap), subY, pillW, 34);
            const g = pill.addComponent(Graphics);
            g.fillColor = active ? BLUE : BEIGE;
            g.roundRect(-pillW / 2, -17, pillW, 34, 17);
            g.fill();
            if (!active) {
                g.strokeColor = BEIGE_LINE;
                g.lineWidth = 2;
                g.roundRect(-pillW / 2, -17, pillW, 34, 17);
                g.stroke();
            }
            this.gm.createLabel(pill, group.name, 0, 0, 16, active ? new Color(255, 255, 255, 255) : BROWN, true);
            pill.on(Node.EventType.TOUCH_END, () => {
                if (this.subTab !== group.key) {
                    this.subTab = group.key;
                    this.renderContent();
                }
            }, this);
        });

        // 当前分组的收集格子：2 列排布（目录数组驱动，以后加收集品自动加格）
        const items = COLLECT_CATALOG.filter((c) => c.group === this.subTab);
        const cols = [-82, 82];
        const firstRowY = subY - 62;
        items.forEach((item, i) => {
            const x = cols[i % 2];
            const y = firstRowY - Math.floor(i / 2) * 80;
            this.drawSlot(this.contentNode!, x, y, {
                iconUrl: '',
                name: item.name,
                rightText: '未拥有',
                rightColor: new Color(150, 140, 120, 255),
                grayed: true,
            });
        });
    }

    /** 单个格子：米色圆角框 + 图标 + 名称 + 右侧数量/状态 */
    private drawSlot(
        parent: Node, x: number, y: number,
        opts: { iconUrl: string; name: string; rightText: string; rightColor: Color; grayed?: boolean }
    ) {
        const slot = this.gm.createNode(`Slot_${opts.name}`, parent, x, y, 152, 64);
        const g = slot.addComponent(Graphics);
        g.fillColor = BEIGE;
        g.roundRect(-76, -32, 152, 64, 12);
        g.fill();
        g.strokeColor = BEIGE_LINE;
        g.lineWidth = 2;
        g.roundRect(-76, -32, 152, 64, 12);
        g.stroke();

        // 图标：有 URL 走远程图，无则占位灰圆
        const imgNode = this.gm.createNode('Icon', slot, -50, 0, 44, 44);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        if (opts.iconUrl) {
            this.gm.loadRemoteImage(opts.iconUrl, imgSprite, () => {
                if (!imgNode.isValid) return;
                const ph = imgNode.addComponent(Graphics);
                ph.fillColor = new Color(220, 214, 198, 255);
                ph.circle(0, 0, 19);
                ph.fill();
            });
        } else {
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, 19);
            ph.fill();
        }
        if (opts.grayed) imgSprite.grayscale = true;

        // 名称（左对齐）
        const nameLabel = this.gm.createLabel(slot, opts.name, -20, 0, 15, BROWN, true);
        const nameTransform = nameLabel.node.getComponent(UITransform);
        if (nameTransform) nameTransform.setAnchorPoint(0, 0.5);
        nameLabel.horizontalAlign = 0; // LEFT

        // 右侧数量/状态（右对齐）
        const rightLabel = this.gm.createLabel(slot, opts.rightText, 70, 0, 16, opts.rightColor, true);
        const rightTransform = rightLabel.node.getComponent(UITransform);
        if (rightTransform) rightTransform.setAnchorPoint(1, 0.5);
        rightLabel.horizontalAlign = 2; // RIGHT
    }
}
