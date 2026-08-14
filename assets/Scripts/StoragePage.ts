import { Node, Color, Graphics, Sprite, Label, UITransform, ScrollView, Mask } from 'cc';
import { fetchResources, fetchMyStorage, ResourceCodeTypeEnum, MyStoragePage, MyStorageItem, StorageGroup } from './api';
import { PropStore } from './PropStore';
import { CollectStore } from './CollectStore';
import { drawTitlePlate, drawSegmentedTabs } from './PageTabs';
import type { GameManager } from './GameManager';

/**
 * 个人仓库页：整页切换（与排行榜页同款架构），纯代码绘制、无底图素材。
 * 顶栏返回+标题；主 tab 横排「道具 | 收集」；收集页内横排子 tab 按 group_code 动态分组。
 * 道具 6 条固定目录（数量实时读 PropStore/totalCoins）；
 * 收集页走 /backpack/my-storage：目录配置和持有状态由后端拼好并分页下发，
 * 前端不再自己关联 game_collect 与 user_backpack（目录表会涨到几万条，不能再全量拉）。
 */

/** 收集页每页条数，与后端默认值一致 */
const COLLECT_PAGE_SIZE = 10;

/** 格子行距（drawSlot 高 64 + 间隙 16） */
const SLOT_PITCH = 80;

/** 距底部还有这么多像素就预加载下一页，别等滑到底才请求 */
const LOAD_MORE_THRESHOLD = 120;

const BROWN = new Color(110, 75, 45, 255);
const BEIGE = new Color(240, 230, 205, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const BLUE = new Color(30, 136, 229, 255);

export class StoragePage {
    private pageNode: Node | null = null;
    private contentNode: Node | null = null;
    private mainTab: 'tools' | 'collect' = 'tools';
    /**
     * 收集页子 tab：按 group_code 分组（动物/车辆/公仔），不分模式。
     * 空串=还没拿到后端分组列表，首次请求不带 groupCode（返回全部），拿到 groups 后锁定第一个分组。
     */
    private subTab = '';
    /** 顶栏 tab 的 Y 坐标（render 里算好，内容层布局复用） */
    private tabY = 0;

    // ===== 收集页滚动分页状态（切 tab / 重进页面时由 resetCollectScroll 清空）=====
    /** 已加载的累积条目（滑动追加，不是替换） */
    private collectItems: MyStorageItem[] = [];
    /** 已加载到第几页 */
    private collectPage = 0;
    /** 当前筛选下的总条数（后端下发，用于判断还有没有下一页） */
    private collectTotal = 0;
    /** 请求飞行中标记：防止一次滚动触发多次相同请求 */
    private collectLoading = false;
    /** ScrollView 的 content 节点，追加格子时往它上面挂 */
    private collectGridNode: Node | null = null;
    /** ScrollView 组件，追加后要同步 content 高度 */
    private collectScrollView: ScrollView | null = null;
    /** 可视区高度，算 content 最小高度用 */
    private collectViewH = 0;

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
        if (this.gm.rootNode) this.gm.rootNode.destroyAllChildren();
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
        this.contentNode.destroyAllChildren();
        // 内容层被清空，滚动容器的节点引用一并失效，避免旧引用被滚动回调误用
        this.collectGridNode = null;
        this.collectScrollView = null;
        if (this.mainTab === 'tools') {
            this.renderToolsContent();
        } else {
            this.renderCollectContent();
        }
    }

    /** 道具页：6 条固定目录，2 列 × 3 行，数量实时读本地背包；金币是余额概念始终展示，其余道具数量为 0 时隐藏格子 */
    private renderToolsContent() {
        const items = [
            { code: ResourceCodeTypeEnum.COIN, name: '金币', count: this.gm.totalCoins, alwaysShow: true },
            { code: ResourceCodeTypeEnum.RAINBOW, name: '彩虹果', count: PropStore.getFruitCount('rainbow'), alwaysShow: false },
            { code: ResourceCodeTypeEnum.BOMB, name: '炸弹果', count: PropStore.getFruitCount('bomb'), alwaysShow: false },
            { code: ResourceCodeTypeEnum.ADD_TRAY, name: '加果盘', count: PropStore.getToolCount('addTray'), alwaysShow: false },
            { code: ResourceCodeTypeEnum.CLEAR, name: '清空果盘', count: PropStore.getToolCount('clear'), alwaysShow: false },
            { code: ResourceCodeTypeEnum.ADD, name: '解锁果篮', count: PropStore.getToolCount('addBasket'), alwaysShow: false },
        ].filter((item) => item.alwaysShow || item.count > 0);
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

    /**
     * 收集页：数据来自 /backpack/my-storage（后端拼好目录+持有状态，分页下发）。
     * 滚动加载——往下滑到接近底部自动拉下一页并追加，不是点按钮翻页。
     * 进页/切 tab 时清空累积数据从第一页重来。
     */
    private renderCollectContent() {
        this.resetCollectScroll();
        this.loadCollectPage(true);
    }

    /** 切 tab / 重进收集页：清空累积条目和页码，节点引用由 renderContent 负责清 */
    private resetCollectScroll() {
        this.collectItems = [];
        this.collectPage = 0;
        this.collectTotal = 0;
        this.collectLoading = false;
    }

    /**
     * 拉下一页并追加。isFirst=true 时这是本次筛选的第一页，需要连带建 tab 条和滚动容器。
     * collectLoading 兜住重复触发：滚动事件密集，一次滑动可能连着来好几发。
     */
    private loadCollectPage(isFirst: boolean) {
        if (this.collectLoading) return;
        // 非首页时先确认还有没有下一页，避免到底后继续空转请求
        if (!isFirst && this.collectItems.length >= this.collectTotal) return;

        this.collectLoading = true;
        const nextPage = this.collectPage + 1;
        const requestedTab = this.subTab;
        fetchMyStorage(this.subTab || undefined, nextPage, COLLECT_PAGE_SIZE).then((data) => {
            this.collectLoading = false;
            if (!this.contentNode || !this.contentNode.isValid) return;
            // 请求飞行期间用户切了 tab：这批数据已经不属于当前筛选，丢弃
            if (requestedTab !== this.subTab) return;

            this.collectPage = nextPage;
            this.collectTotal = data.total;
            this.collectItems = this.collectItems.concat(data.items);

            if (isFirst) {
                this.buildCollectView(data);
            } else {
                this.appendCollectSlots(data.items);
            }
        }).catch(() => {
            this.collectLoading = false;
        });
    }

    /** 首页数据到位：画子 tab + 建滚动容器 + 铺第一批格子 */
    private buildCollectView(data: MyStoragePage) {
        const subY = this.tabY - 56;
        const groups = data.groups.map((g: StorageGroup) => ({ key: g.groupCode, name: g.groupName }));

        // 首次进页 subTab 为空（不带 groupCode 拿全部），或当前分组已不存在：锁到第一个分组重来一次
        if (groups.length > 0 && !groups.some((g) => g.key === this.subTab)) {
            this.subTab = groups[0].key;
            this.renderContent();
            return;
        }

        if (groups.length === 0) {
            this.gm.createLabel(this.contentNode!, '暂未收集到玩偶', 0, subY - 40, 15, new Color(150, 160, 140, 255), true);
            return;
        }

        // 子 tab 分段条（二级导航：小一号、米色容器、橙色选中段）
        drawSegmentedTabs(
            this.gm, this.contentNode!, 'SubSegBar', subY,
            groups, this.subTab, 'sub',
            (key) => {
                this.subTab = key;
                this.renderContent(); // 内部会 resetCollectScroll，从第一页重来
            }
        );

        if (data.items.length === 0) {
            this.gm.createLabel(this.contentNode!, '暂未收集到该分类的玩偶', 0, subY - 82, 15, new Color(150, 160, 140, 255), true);
            return;
        }

        this.buildCollectScrollView(subY - 24);
        this.appendCollectSlots(data.items);
    }

    /**
     * 滚动容器：ScrollView + Mask 裁切 + content 锚点 (0.5, 1) 从顶往下排（与商城页网格同款）。
     * content 高度随追加动态长高，scrolling 回调里判断是否够近底部再拉下一页。
     */
    private buildCollectScrollView(topY: number) {
        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        const bottomY = -pageH / 2 + 8;
        const viewH = Math.max(topY - bottomY, 100);
        const viewY = (topY + bottomY) / 2;
        const viewW = pageW - 24;
        this.collectViewH = viewH;

        const scrollNode = this.gm.createNode('CollectScroll', this.contentNode!, 0, viewY, viewW, viewH);
        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;
        const viewNode = this.gm.createNode('View', scrollNode, 0, 0, viewW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;
        const gridNode = this.gm.createNode('CollectGrid', viewNode, 0, 0, viewW, viewH);
        gridNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        gridNode.setPosition(0, viewH / 2, 0);
        scrollView.content = gridNode;

        this.collectGridNode = gridNode;
        this.collectScrollView = scrollView;

        // scrolling 每帧都可能触发，靠 collectLoading + 剩余条数判断收口
        scrollNode.on('scrolling', this.onCollectScrolling, this);
    }

    /** 追加一批格子到 content 尾部，并把 content 高度撑到覆盖全部已加载条目 */
    private appendCollectSlots(items: MyStorageItem[]) {
        if (!this.collectGridNode || !this.collectGridNode.isValid) return;
        // 本批第一条在累积列表里的下标：决定它排在第几行，避免与已有格子重叠
        const startIndex = this.collectItems.length - items.length;

        items.forEach((item, i) => {
            const index = startIndex + i;
            const x = index % 2 === 0 ? -82 : 82;
            const y = -Math.floor(index / 2) * SLOT_PITCH - 40;
            this.drawSlot(this.collectGridNode!, x, y, {
                iconUrl: item.colorUrl,
                name: item.name,
                showStar: item.isCurrent,
                rightText: `x${item.count}`,
                rightColor: BROWN,
                onTap: () => {
                    this.gm.renderCollectDetail(item.name, item.colorUrl, () => {
                        // 设为当前展示：同步 CollectStore（猫咪图标等页面还读它），再整页重来刷新星标
                        CollectStore.setCurrent(item.collectId);
                        this.renderContent();
                    });
                },
            });
        });

        const rows = Math.ceil(this.collectItems.length / 2);
        const naturalH = rows * SLOT_PITCH + 16;
        this.collectGridNode.getComponent(UITransform)!.setContentSize(
            this.gm.screenWidth - 24, Math.max(naturalH, this.collectViewH));

        // 已加载内容还撑不满可视区（每页 10 条=5 行，屏幕通常放得下更多）：
        // 此时压根没法滚动，scrolling 事件永远不会来，得主动补下一页直到填满或没数据
        if (naturalH < this.collectViewH && this.collectItems.length < this.collectTotal) {
            this.loadCollectPage(false);
        }
    }

    /** 滑到距底部 LOAD_MORE_THRESHOLD 以内就预加载下一页 */
    private onCollectScrolling() {
        if (!this.collectScrollView || !this.collectGridNode || !this.collectGridNode.isValid) return;
        if (this.collectLoading) return;
        if (this.collectItems.length >= this.collectTotal) return;

        const contentH = this.collectGridNode.getComponent(UITransform)!.height;
        // content 锚点 (0.5,1)：position.y 就是它的上边缘，内容向下延伸到 position.y - contentH。
        // 可视区下边缘在 -viewH/2，所以「还能往下滑多少」= 内容下边缘到可视下边缘的距离：
        //   remaining = (-viewH/2) - (position.y - contentH) = contentH - position.y - viewH/2
        // 顶部时 remaining = contentH - viewH，滑到底时为 0。
        const remaining = contentH - this.collectGridNode.position.y - this.collectViewH / 2;
        if (remaining <= LOAD_MORE_THRESHOLD) {
            this.loadCollectPage(false);
        }
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
