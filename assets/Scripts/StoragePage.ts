import { Node, Color, Graphics, Sprite, Label, UITransform } from 'cc';
import { fetchResources, fetchCollectList, ResourceCodeTypeEnum, CollectItem } from './api';
import { PropStore } from './PropStore';
import { CollectStore } from './CollectStore';
import { drawTitlePlate, drawSegmentedTabs } from './PageTabs';
import type { GameManager } from './GameManager';

/**
 * 个人仓库页：整页切换（与排行榜页同款架构），纯代码绘制、无底图素材。
 * 顶栏返回+标题；主 tab 横排「道具 | 收集」；收集页内横排子 tab 按 group_code 动态分组。
 * 道具 6 条固定目录（数量实时读 PropStore/totalCoins）；
 * 收集目录来自后端 game_collect 全量配置，拥有/当前展示状态读本地 CollectStore。
 */

/** 收集分组显示名兜底（后端目录为空时的占位子 tab） */
const COLLECT_GROUP_FALLBACK = [{ key: 'animal', name: '动物' }];

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

        // 顶栏：返回 + 标题（与商城页同高：pageH/2 - 80）
        const headerY = pageH / 2 - 80;
        const backBtn = this.gm.createNode('BackBtn', this.pageNode, -pageW / 2 + 30, headerY, 40, 40);
        this.gm.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true);
        backBtn.on(Node.EventType.TOUCH_END, () => {
            this.close();
            this.gm.homePage.render();
        }, this);
        drawTitlePlate(this.gm, this.pageNode, headerY, '仓库');

        // 主 tab：分段控制条（一级导航）
        this.tabY = headerY - 56;
        this.renderMainTabs();

        // 内容层
        this.contentNode = this.gm.createNode('StorageContent', this.pageNode, 0, 0, pageW, pageH);
        this.renderContent();
    }

    /** 主 tab 分段条（选中蓝底白字 / 未选中浅灰字），整段可点 */
    private renderMainTabs() {
        drawSegmentedTabs(
            this.gm, this.pageNode!, 'MainSegBar', this.tabY,
            [{ key: 'tools', name: '道具' }, { key: 'collect', name: '收集' }],
            this.mainTab, 'main',
            (key) => {
                this.mainTab = key as 'tools' | 'collect';
                this.renderMainTabs();
                this.renderContent();
            }
        );
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

    /** 收集页：子 tab 按后端目录的 group_code 动态分组 + 格子（已拥有/未拥有读本地 CollectStore） */
    private renderCollectContent() {
        const subY = this.tabY - 56;
        fetchCollectList().then((catalog) => {
            if (!this.contentNode || !this.contentNode.isValid) return;
            this.renderCollectGroups(catalog, subY);
        });
    }

    private renderCollectGroups(catalog: CollectItem[], subY: number) {
        const groups = catalog.length > 0
            ? Array.from(new Map(catalog.map((c) => [c.groupCode, { key: c.groupCode, name: c.groupName }])).values())
            : COLLECT_GROUP_FALLBACK;
        if (!groups.some((g) => g.key === this.subTab)) this.subTab = groups[0]?.key || 'animal';

        // 子 tab 分段条（二级导航：小一号、米色容器、橙色选中段）
        drawSegmentedTabs(
            this.gm, this.contentNode!, 'SubSegBar', subY,
            groups, this.subTab, 'sub',
            (key) => {
                this.subTab = key;
                this.renderContent();
            }
        );

        // 当前分组的收集格子：只显示已拥有的（仓库不展示"未拥有"占位，避免名称与状态文字挤在一起）
        const ownedIds = CollectStore.getOwnedIds();
        const currentId = CollectStore.getCurrentId();
        const items = catalog.filter((c) => c.groupCode === this.subTab && ownedIds.indexOf(c.id) !== -1);
        const cols = [-82, 82];
        const firstRowY = subY - 62;
        if (items.length === 0) {
            this.gm.createLabel(this.contentNode!, '暂未收集到该分类的玩偶', 0, firstRowY - 20, 15, new Color(150, 160, 140, 255), true);
            return;
        }
        items.forEach((item, i) => {
            const x = cols[i % 2];
            const y = firstRowY - Math.floor(i / 2) * 80;
            const isCurrent = item.id === currentId || (currentId == null && item.id === ownedIds[0]);
            this.drawSlot(this.contentNode!, x, y, {
                iconUrl: item.colorUrl,
                name: item.name,
                showStar: isCurrent,
                rightText: `x${CollectStore.getCount(item.id)}`,
                rightColor: BROWN,
                onTap: () => {
                    this.gm.renderCollectDetail(item.name, item.colorUrl, () => {
                        CollectStore.setCurrent(item.id);
                        this.renderContent();
                    });
                },
            });
        });
    }

    /**
     * 单个格子：米色圆角框 + 图标 + 名称 + 右侧数量/状态（道具页用 rightText/rightColor）。
     * onTap 有值时整块可点；showStar 为真时左上角画金色五角星角标（收集页"当前应用于游戏"标记）。
     */
    private drawSlot(
        parent: Node, x: number, y: number,
        opts: { iconUrl: string; name: string; rightText?: string; rightColor?: Color; grayed?: boolean; onTap?: () => void; showStar?: boolean }
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

        // 当前应用于游戏的角标：格子左上角一颗金色五角星
        if (opts.showStar) {
            const starNode = this.gm.createNode('StarBadge', slot, -68, 24, 20, 20);
            const starG = starNode.addComponent(Graphics);
            this.gm.drawStar(starG, 20, new Color(255, 200, 40, 255));
        }

        // 名称（左对齐）
        const nameLabel = this.gm.createLabel(slot, opts.name, -20, 0, 15, BROWN, true);
        const nameTransform = nameLabel.node.getComponent(UITransform);
        if (nameTransform) nameTransform.setAnchorPoint(0, 0.5);
        nameLabel.horizontalAlign = 0; // LEFT

        // 右侧数量/状态（右对齐，仅道具页传了 rightText 时才画）
        if (opts.rightText) {
            const rightLabel = this.gm.createLabel(slot, opts.rightText, 70, 0, 16, opts.rightColor || BROWN, true);
            const rightTransform = rightLabel.node.getComponent(UITransform);
            if (rightTransform) rightTransform.setAnchorPoint(1, 0.5);
            rightLabel.horizontalAlign = 2; // RIGHT
        }

        if (opts.onTap) {
            const onTap = opts.onTap;
            slot.on(Node.EventType.TOUCH_END, () => onTap(), this);
        }
    }
}
