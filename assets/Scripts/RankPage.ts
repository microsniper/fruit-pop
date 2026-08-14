import { Node, UITransform, Color, Graphics, Mask, Sprite, SpriteFrame, ScrollView } from 'cc';
import { fetchRankConfig, RankItem, hasUserProfile, updateProfile, getDailyRankConfig, DailyRankResponse } from './api';
import { BundleManager } from './BundleManager';
import { drawTitlePlate } from './PageTabs';
import { SoundManager } from './SoundManager';
import type { GameManager } from './GameManager';

declare const wx: any;

/**
 * 排行榜页：支持「无限榜」（个人关卡数）和「挑战榜」（当日各省通关人数）两个 tab。
 * 纯列表展示 + 底部我的排名，纯逻辑类（非组件）。
 */
export class RankPage {
    private pageNode: Node | null = null;
    private fromHome = false;
    private defaultAvatarsLoaded = false;
    private defaultAvatarFrames: SpriteFrame[] = [];
    // ===== Tab 切换 =====
    private currentTab: 'endless' | 'daily' = 'endless';
    private endlessCache: { list: RankItem[], myRank: RankItem | null } | null = null;
    private dailyCache: DailyRankResponse | null = null;
    private contentNode: Node | null = null;
    private tabEndlessNode: Node | null = null;
    private tabDailyNode: Node | null = null;

    constructor(private gm: GameManager) {}

    /** 排行榜入口：处理授权状态分流后进榜 */
    open(fromHome: boolean) {
        this.fromHome = fromHome;
        if (typeof wx === 'undefined') {
            this.loadAndShowRank();
            return;
        }
        if (hasUserProfile()) {
            this.loadAndShowRank();
            return;
        }
        wx.getSetting({
            success: (settingRes: any) => {
                const authSetting = settingRes.authSetting || {};
                if (authSetting['scope.userInfo'] === true) {
                    wx.getUserInfo({
                        success: (userRes: any) => {
                            this.saveAndEnterRank(userRes.userInfo);
                        },
                        fail: () => this.showAuthRequiredToast()
                    });
                } else {
                    this.showAuthRequiredToast();
                }
            },
            fail: () => this.showAuthRequiredToast()
        });
    }

    private showAuthRequiredToast() {
        if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
            wx.showToast({ title: '授权后才能查看排行榜', icon: 'none' });
        }
    }

    setupAuthOverlay(targetNode: Node) {
        this.gm.setupAuthOverlay('rank', targetNode, () => this.loadAndShowRank());
    }

    destroyAuthOverlay() {
        this.gm.destroyAuthOverlay('rank');
    }

    setAuthOverlayVisible(visible: boolean) {
        this.gm.setAuthOverlayVisible('rank', visible);
    }

    private async saveAndEnterRank(userInfo: any) {
        const nickname = ((userInfo.nickName || '') as string).trim() || '微信玩家';
        const avatarUrl = ((userInfo.avatarUrl || '') as string).trim();
        const result = await updateProfile(nickname, avatarUrl);
        if (!result.success) {
            console.warn('保存微信头像昵称失败:', result.message);
            if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
                wx.showToast({ title: result.message || '保存失败，请重试', icon: 'none' });
            }
        }
        this.loadAndShowRank();
    }

    private async loadDefaultAvatars(): Promise<void> {
        if (this.defaultAvatarsLoaded) return;
        return new Promise((resolve) => {
            const avatarNames = ['Avatars1', 'Avatars2', 'Avatars3', 'Avatars4', 'Avatars5', 'Avatars6'];
            let loaded = 0;
            avatarNames.forEach((name) => {
                BundleManager.getInstance().loadAsset<SpriteFrame>(`avatar/${name}/spriteFrame`, SpriteFrame).then((spriteFrame) => {
                    loaded++;
                    if (spriteFrame) this.defaultAvatarFrames.push(spriteFrame);
                    if (loaded === avatarNames.length) { this.defaultAvatarsLoaded = true; resolve(); }
                }).catch(() => {
                    loaded++;
                    if (loaded === avatarNames.length) { this.defaultAvatarsLoaded = true; resolve(); }
                });
            });
        });
    }

    private getDefaultAvatarFrame(avatarUrl: string): SpriteFrame | null {
        if (!avatarUrl || this.defaultAvatarFrames.length === 0) return null;
        const match = avatarUrl.match(/^default:(\d+)$|^(\d+)$/);
        if (!match) return null;
        const index = parseInt(match[1] || match[2], 10) - 1;
        if (index < 0 || index >= this.defaultAvatarFrames.length) return null;
        return this.defaultAvatarFrames[index];
    }

    private getRandomDefaultAvatar(): SpriteFrame | null {
        if (this.defaultAvatarFrames.length === 0) return null;
        return this.defaultAvatarFrames[Math.floor(Math.random() * this.defaultAvatarFrames.length)];
    }

    private createAvatarSpriteNode(parent: Node, x: number, y: number, size: number, avatarUrl?: string): Node {
        const node = this.gm.createNode('Avatar', parent, x, y, size, size);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        const maskNode = this.gm.createNode('AvatarMask', parent, x, y, size, size);
        const mask = maskNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_ELLIPSE;
        node.parent = maskNode;
        node.setPosition(0, 0, 0);
        const url = (avatarUrl || '').trim();
        if (url.startsWith('http')) {
            this.setDefaultAvatarFrame(sprite);
            // 走 GameManager 统一的远程图 LRU 缓存（按 URL 复用纹理，超限自动释放），
            // 避免排行榜每次渲染都重新下载/新建 Texture2D 导致显存只增不减
            this.gm.loadRemoteImage(url, sprite, () => this.setDefaultAvatarFrame(sprite, url));
        } else {
            this.setDefaultAvatarFrame(sprite, url);
        }
        return maskNode;
    }

    private setDefaultAvatarFrame(sprite: Sprite, avatarUrl?: string) {
        const frame = this.getDefaultAvatarFrame(avatarUrl || '') || this.getRandomDefaultAvatar();
        if (frame) sprite.spriteFrame = frame;
    }

    private async loadAndShowRank() {
        this.gm.showLoadingOverlay();
        try {
            const data = await fetchRankConfig();
            this.endlessCache = { list: data.list, myRank: data.myRank };
            await this.loadDefaultAvatars();
            this.gm.hideLoadingOverlay();
            this.currentTab = 'endless';
            this.renderPage();
        } catch {
            this.gm.hideLoadingOverlay();
        }
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
            this.pageNode = null;
        }
        if (this.gm.modalLayerNode) this.gm.modalLayerNode.active = false;
        if (this.gm.topAreaNode) this.gm.topAreaNode.active = true;
        if (this.gm.boardAreaNode) this.gm.boardAreaNode.active = true;
        if (this.gm.bottomAreaNode) this.gm.bottomAreaNode.active = true;
    }

    private getRankDisplayName(item: RankItem): string {
        const nick = (item.nickname || '').trim();
        // 未授权昵称：只显示「玩家」，不带数字后缀
        return nick ? nick.substring(0, 8) : '玩家';
    }

    /** 排名行配色：自己=橙、前三名=金/银/铜、其余浅灰 */
    private rowColors(rank: number, isMe: boolean): { bg: Color; text: Color } {
        if (isMe) return { bg: new Color(255, 150, 0, 255), text: new Color(255, 255, 255, 255) };
        if (rank === 1) return { bg: new Color(255, 200, 60, 255), text: new Color(110, 75, 45, 255) };
        if (rank === 2) return { bg: new Color(215, 222, 228, 255), text: new Color(90, 100, 110, 255) };
        if (rank === 3) return { bg: new Color(226, 168, 110, 255), text: new Color(110, 75, 45, 255) };
        return { bg: new Color(242, 244, 240, 255), text: new Color(80, 100, 70, 255) };
    }

    // ===== 页面骨架 + Tab =====

    private renderPage() {
        this.close();
        this.destroyAuthOverlay();
        if (this.gm.rootNode) this.gm.rootNode.destroyAllChildren();
        this.gm.teardownGameView();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.pageNode = this.gm.createNode('RankPage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // 背景
        const bg = this.gm.createGraphicsNode('RankBg', this.pageNode, pageW, pageH, 0, 0);
        bg.getComponent(Graphics)!.fillColor = new Color(245, 248, 240, 255);
        bg.getComponent(Graphics)!.rect(-pageW / 2, -pageH / 2, pageW, pageH);
        bg.getComponent(Graphics)!.fill();

        // 顶部导航（下移避刘海屏安全区）
        const headerY = pageH / 2 - 80;
        const backBtn = this.gm.createNode('BackBtn', this.pageNode, -pageW / 2 + 30, headerY, 40, 40);
        this.gm.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true);
        backBtn.on(Node.EventType.TOUCH_END, () => {
            if (this.fromHome) { this.fromHome = false; this.gm.homePage.render(); }
            else { this.gm.goBackToGame(); }
        }, this);

        // 顶部「排行榜」金属铭牌（商城同款样式）；tab 下移到铭牌下方（与商城主 tab 位置一致）
        drawTitlePlate(this.gm, this.pageNode, headerY, '排行榜');

        // Tab
        this.renderTabs(headerY - 56);
        this.renderTabContent();
    }

    private renderTabs(headerY: number) {
        const tabW = 80, tabH = 32, gap = 12;
        const leftX = -(tabW * 2 + gap) / 2 + tabW / 2;

        this.tabEndlessNode = this.gm.createNode('TabEndless', this.pageNode!, leftX, headerY, tabW, tabH);
        this.tabEndlessNode.on(Node.EventType.TOUCH_END, () => {
            if (this.currentTab === 'endless') return;
            SoundManager.getInstance()?.playSystemClick();
            this.switchTab('endless');
        }, this);

        this.tabDailyNode = this.gm.createNode('TabDaily', this.pageNode!, leftX + tabW + gap, headerY, tabW, tabH);
        this.tabDailyNode.on(Node.EventType.TOUCH_END, () => {
            if (this.currentTab === 'daily') return;
            SoundManager.getInstance()?.playSystemClick();
            this.switchTab('daily');
        }, this);

        this.updateTabStyle();
    }

    private updateTabStyle() {
        const selBg = new Color(100, 160, 80, 255);
        const selText = new Color(255, 255, 255, 255);
        const dimText = new Color(150, 160, 140, 255);

        if (this.tabEndlessNode?.isValid) {
            this.tabEndlessNode.destroyAllChildren();
            if (this.currentTab === 'endless') {
                const g = this.gm.createGraphicsNode('TabBg', this.tabEndlessNode, 80, 32, 0, 0);
                this.gm.drawRoundedRect(g.getComponent(Graphics)!, 80, 32, selBg, 16);
            }
            this.gm.createLabel(this.tabEndlessNode, '全国', 0, 0, 16, this.currentTab === 'endless' ? selText : dimText, true);
        }
        if (this.tabDailyNode?.isValid) {
            this.tabDailyNode.destroyAllChildren();
            if (this.currentTab === 'daily') {
                const g = this.gm.createGraphicsNode('TabBg', this.tabDailyNode, 80, 32, 0, 0);
                this.gm.drawRoundedRect(g.getComponent(Graphics)!, 80, 32, selBg, 16);
            }
            this.gm.createLabel(this.tabDailyNode, '全省', 0, 0, 16, this.currentTab === 'daily' ? selText : dimText, true);
        }
    }

    private switchTab(tab: 'endless' | 'daily') {
        if (this.currentTab === tab) return;
        this.currentTab = tab;
        this.updateTabStyle();
        if (tab === 'daily' && !this.dailyCache) {
            this.loadDailyRank();
        } else {
            this.renderTabContent();
        }
    }

    /**
     * 挑战榜列表 + 「我的排名」卡片统一用展示接口（叠加虚拟基数），避免出现
     * 「排名第1、却只有1人通关」这种真实/虚拟两套口径混着看很矛盾的问题——
     * 展示接口自己就会按同一份虚拟叠加后的列表算出 myRank（排名和人数口径与上面列表完全一致）。
     */
    private async loadDailyRank() {
        this.gm.showLoadingOverlay();
        try {
            this.dailyCache = await getDailyRankConfig();
            this.gm.hideLoadingOverlay();
            this.renderTabContent();
        } catch {
            this.gm.hideLoadingOverlay();
        }
    }

    private renderTabContent() {
        if (this.contentNode?.isValid) {
            this.contentNode.destroy();
            this.contentNode = null;
        }
        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.contentNode = this.gm.createNode('TabContent', this.pageNode!, 0, 0, pageW, pageH);

        if (this.currentTab === 'endless' && this.endlessCache) {
            this.renderEndlessContent(this.contentNode);
        } else if (this.currentTab === 'daily' && this.dailyCache) {
            this.renderDailyContent(this.contentNode);
        }
    }

    // ===== 无限榜：纯列表 =====

    private renderEndlessContent(parent: Node) {
        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        const padX = 20;
        const listW = pageW - padX * 2;
        const headerY = pageH / 2 - 80;
        const data = this.endlessCache!;
        const list = data.list || [];
        const myRank = data.myRank;

        // 列表区域（卡片行直接铺在页面背景上，无大底板）；tab 下移后列表顶部同步再让 56px
        const topY = headerY - 96;
        const myCardH = myRank ? 90 : 20;
        const listBgH = pageH / 2 + topY;
        const viewH = listBgH - 20 - myCardH;
        const viewY = topY - listBgH / 2 - 10 + myCardH / 2;

        // ScrollView
        const itemH = 64;
        const scrollNode = this.gm.createNode('ScrollView', parent, 0, viewY, pageW, viewH);
        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;

        const viewNode = this.gm.createNode('View', scrollNode, 0, 0, pageW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        const contentH = Math.max(list.length * itemH, viewH);
        const contentNode = this.gm.createNode('Content', viewNode, 0, 0, pageW, contentH);
        contentNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        contentNode.setPosition(0, viewH / 2, 0);
        scrollView.content = contentNode;

        // 分帧建行：每行含 Mask.GRAPHICS_ELLIPSE（头像圆形裁切）+ 3 个 Label + 1 个 Graphics，
        // 20 行一次性同步建完会在一帧内堆约 140 个节点，中低端机上单帧耗时可达到卡顿级别、
        // 期间主线程被占满导致点击无响应；每帧只建一批，把这份耗时摊到多帧，中间让主线程喘气
        const ROW_CHUNK = 4;
        let rowIndex = 0;
        const buildRowStep = () => {
            if (!contentNode.isValid) {
                this.gm.unschedule(buildRowStep);
                return;
            }
            const end = Math.min(rowIndex + ROW_CHUNK, list.length);
            for (; rowIndex < end; rowIndex++) {
                const item = list[rowIndex];
                const y = -rowIndex * itemH - itemH / 2;
                const leftX = -listW / 2 + 16;
                const isMe = !!item.isMe;
                const colors = this.rowColors(item.rank, isMe);

                // 行卡片
                const rowBg = this.gm.createGraphicsNode('RowBg', contentNode, listW, 56, 0, y);
                this.gm.drawRoundedRect(rowBg.getComponent(Graphics)!, listW, 56, colors.bg, 12);

                // 排名
                const rl = this.gm.createLabel(contentNode, `${item.rank}`, leftX + 8, y, 18, colors.text, true);
                rl.horizontalAlign = 0;
                rl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

                // 头像
                this.createAvatarSpriteNode(contentNode, leftX + 56, y, 36, item.avatarUrl);

                // 昵称
                const nick = this.getRankDisplayName(item);
                const nl = this.gm.createLabel(contentNode, nick, leftX + 82, y, 15, colors.text, isMe);
                nl.horizontalAlign = 0;
                nl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

                // 关卡数
                const rightX = listW / 2 - 16;
                const vl = this.gm.createLabel(contentNode, `${item.levelNum}关`, rightX, y, 17, colors.text, true);
                vl.horizontalAlign = 2;
                vl.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
            }
            if (rowIndex >= list.length) {
                this.gm.unschedule(buildRowStep);
            }
        };
        if (list.length > 0) {
            this.gm.schedule(buildRowStep, 0);
        }

        // 底部我的排名
        if (myRank) {
            this.renderMyCard(parent, listW, pageH, `${myRank.rank || '?'}`, this.getRankDisplayName(myRank), `${myRank.levelNum || 0}关`, myRank.avatarUrl);
        }
    }

    // ===== 挑战榜：各省通关人数 =====

    private renderDailyContent(parent: Node) {
        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        const padX = 20;
        const listW = pageW - padX * 2;
        const headerY = pageH / 2 - 80;
        const data = this.dailyCache!;
        const list = data.list || [];
        const myRank = data.myRank;

        // 列表区域（卡片行直接铺在页面背景上，无大底板）；我的省份卡片带水果人群，比无限榜的高；tab 下移后列表顶部同步再让 56px
        const topY = headerY - 96;
        const myCardH = myRank ? 90 : 40;
        const listBgH = pageH / 2 + topY;
        const viewH = listBgH - 20 - myCardH;
        const viewY = topY - listBgH / 2 - 10 + myCardH / 2;

        // ScrollView
        const itemH = 64;
        const scrollNode = this.gm.createNode('ScrollView', parent, 0, viewY, pageW, viewH);
        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;

        const viewNode = this.gm.createNode('View', scrollNode, 0, 0, pageW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        const contentH = Math.max(list.length * itemH, viewH);
        const contentNode = this.gm.createNode('Content', viewNode, 0, 0, pageW, contentH);
        contentNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        contentNode.setPosition(0, viewH / 2, 0);
        scrollView.content = contentNode;

        // 分帧建行：与无限榜同款手法，省份数增多时同样不会一次同步卡住主线程
        const ROW_CHUNK = 4;
        let rowIndex = 0;
        const buildRowStep = () => {
            if (!contentNode.isValid) {
                this.gm.unschedule(buildRowStep);
                return;
            }
            const end = Math.min(rowIndex + ROW_CHUNK, list.length);
            for (; rowIndex < end; rowIndex++) {
                const item = list[rowIndex];
                const y = -rowIndex * itemH - itemH / 2;
                const leftX = -listW / 2 + 16;
                const isMe = !!item.isMe;
                const colors = this.rowColors(item.rank, isMe);

                // 行卡片
                const rowBg = this.gm.createGraphicsNode('RowBg', contentNode, listW, 56, 0, y);
                this.gm.drawRoundedRect(rowBg.getComponent(Graphics)!, listW, 56, colors.bg, 12);

                // 排名
                const rl = this.gm.createLabel(contentNode, `${item.rank}`, leftX + 8, y, 18, colors.text, true);
                rl.horizontalAlign = 0;
                rl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

                // 省份名
                const nl = this.gm.createLabel(contentNode, item.regionName || '未知', leftX + 50, y, 17, colors.text, isMe);
                nl.horizontalAlign = 0;
                nl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

                // 通关人数
                const rightX = listW / 2 - 16;
                const vl = this.gm.createLabel(contentNode, `${item.clearCount}人通关`, rightX, y, 15, colors.text, true);
                vl.horizontalAlign = 2;
                vl.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
            }
            if (rowIndex >= list.length) {
                this.gm.unschedule(buildRowStep);
            }
        };
        if (list.length > 0) {
            this.gm.schedule(buildRowStep, 0);
        }

        // 底部我的省份
        if (myRank) {
            this.renderMyCard(parent, listW, pageH, `${myRank.rank || '?'}`, myRank.regionName || '我的省份', `${myRank.clearCount}人通关`, undefined);
        } else {
            const tipY = -pageH / 2 + 40;
            this.gm.createLabel(parent, '完成今日挑战后上榜', 0, tipY, 14, new Color(150, 160, 140, 255), true);
        }
    }

    // ===== 底部"我的排名"卡片（两个 tab 共用） =====

    private renderMyCard(parent: Node, listW: number, pageH: number, rank: string, name: string, value: string, avatarUrl?: string) {
        const cardH = 64;
        const cardY = -pageH / 2 + cardH / 2 + 16;

        const bg = this.gm.createGraphicsNode('MyCardBg', parent, listW, cardH, 0, cardY);
        this.gm.drawRoundedRect(bg.getComponent(Graphics)!, listW, cardH, new Color(255, 190, 60, 255), 16);

        const leftX = -listW / 2 + 16;

        // 排名
        const rl = this.gm.createLabel(parent, rank, leftX + 8, cardY, 20, new Color(255, 255, 255, 255), true);
        rl.horizontalAlign = 0;
        rl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

        // 头像（无限榜有头像，挑战榜没有）
        let nameX = leftX + 50;
        if (avatarUrl) {
            this.createAvatarSpriteNode(parent, leftX + 56, cardY, 36, avatarUrl);
            nameX = leftX + 82;
        }

        // 名称
        const nl = this.gm.createLabel(parent, name, nameX, cardY, 17, new Color(255, 255, 255, 255), true);
        nl.horizontalAlign = 0;
        nl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

        // 数值
        const rightX = listW / 2 - 16;
        const vl = this.gm.createLabel(parent, value, rightX, cardY, 18, new Color(255, 255, 255, 255), true);
        vl.horizontalAlign = 2;
        vl.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
    }
}
