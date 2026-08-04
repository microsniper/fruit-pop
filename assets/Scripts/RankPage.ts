import { Node, UITransform, Color, Graphics, Mask, Sprite, SpriteFrame, ImageAsset, ScrollView, assetManager, Texture2D } from 'cc';
import { fetchRank, RankItem, hasUserProfile, updateProfile } from './api';
import { BundleManager } from './BundleManager';
import type { GameManager } from './GameManager';

declare const wx: any;

/**
 * 排行榜页：整页渲染、微信授权流程、默认/微信头像加载。
 * 纯逻辑类（非组件），共享工具与状态通过 GameManager 引用访问。
 */
export class RankPage {
    /** 排行榜页根节点 */
    private pageNode: Node | null = null;
    /** 排行榜页是否从首页打开（决定返回键回首页还是回游戏） */
    private fromHome = false;
    private defaultAvatarsLoaded = false;
    private defaultAvatarFrames: SpriteFrame[] = [];

    constructor(private gm: GameManager) {}

    /** 排行榜入口：处理授权状态分流后进榜。fromHome 决定返回键去向 */
    open(fromHome: boolean) {
        this.fromHome = fromHome;
        // 非微信环境或无 wx api：直接进排行榜
        if (typeof wx === 'undefined') {
            this.loadAndShowRank();
            return;
        }
        // 已有档案：直接进排行榜
        if (hasUserProfile()) {
            this.loadAndShowRank();
            return;
        }
        // 未授权时点击本应被原生授权按钮拦截，走到这里说明原生按钮创建失败。
        // 兜底：曾授权过则直接取用户信息，否则提示需要授权（不放行进榜）
        wx.getSetting({
            success: (settingRes: any) => {
                const authSetting = settingRes.authSetting || {};
                if (authSetting['scope.userInfo'] === true) {
                    wx.getUserInfo({
                        success: (userRes: any) => {
                            this.saveAndEnterRank(userRes.userInfo);
                        },
                        fail: () => {
                            this.showAuthRequiredToast();
                        }
                    });
                } else {
                    this.showAuthRequiredToast();
                }
            },
            fail: () => {
                this.showAuthRequiredToast();
            }
        });
    }

    private showAuthRequiredToast() {
        if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
            wx.showToast({ title: '授权后才能查看排行榜', icon: 'none' });
        }
    }

    /**
     * 在排行榜按钮位置叠加透明的微信原生授权按钮。
     * 点击后微信自动串起「官方隐私弹窗 → 昵称头像授权弹窗」，
     * 任一步取消都不进入排行榜。坐标换算/创建/保存均委托 GameManager 通用方法。
     */
    setupAuthOverlay(targetNode: Node) {
        this.gm.setupAuthOverlay('rank', targetNode, () => this.loadAndShowRank());
    }

    destroyAuthOverlay() {
        this.gm.destroyAuthOverlay('rank');
    }

    /** 显示/隐藏排行榜上的原生授权按钮（弹窗打开期间需隐藏，防止透明按钮误拦截点击） */
    setAuthOverlayVisible(visible: boolean) {
        this.gm.setAuthOverlayVisible('rank', visible);
    }

    private async saveAndEnterRank(userInfo: any) {
        const nickname = ((userInfo.nickName || '') as string).trim() || '微信玩家';
        const avatarUrl = ((userInfo.avatarUrl || '') as string).trim();
        const result = await updateProfile(nickname, avatarUrl);
        if (!result.success) {
            // 保存失败：把后端原因直接提示出来，便于真机排查；不阻塞进榜
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
                    if (spriteFrame) {
                        this.defaultAvatarFrames.push(spriteFrame);
                    }
                    if (loaded === avatarNames.length) {
                        this.defaultAvatarsLoaded = true;
                        resolve();
                    }
                }).catch(() => {
                    loaded++;
                    if (loaded === avatarNames.length) {
                        this.defaultAvatarsLoaded = true;
                        resolve();
                    }
                });
            });
        });
    }

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
        const node = this.gm.createNode('Avatar', parent, x, y, size, size);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM; // 强制使用自定义尺寸，避免原图过大

        // 可选：添加一个 Mask 组件让图片变成圆形
        const maskNode = this.gm.createNode('AvatarMask', parent, x, y, size, size);
        const mask = maskNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_ELLIPSE; // 圆形遮罩

        // 把 sprite 放到 mask 下面
        node.parent = maskNode;
        node.setPosition(0, 0, 0);

        const url = (avatarUrl || '').trim();

        // 远程微信头像
        if (url.startsWith('http')) {
            this.setDefaultAvatarFrame(sprite); // 先给默认图，加载成功后替换
            assetManager.loadRemote<ImageAsset>(url, { ext: '.png' }, (err, imageAsset) => {
                if (!err && imageAsset && sprite.isValid) {
                    const texture = new Texture2D();
                    texture.image = imageAsset;
                    const spriteFrame = new SpriteFrame();
                    spriteFrame.texture = texture;
                    sprite.spriteFrame = spriteFrame;
                }
            });
        } else {
            // 默认头像
            this.setDefaultAvatarFrame(sprite, url);
        }
        return maskNode;
    }

    private setDefaultAvatarFrame(sprite: Sprite, avatarUrl?: string) {
        const frame = this.getDefaultAvatarFrame(avatarUrl || '') || this.getRandomDefaultAvatar();
        if (frame) {
            sprite.spriteFrame = frame;
        }
    }

    private async loadAndShowRank() {
        this.gm.showLoadingOverlay();
        try {
            const data = await fetchRank();
            await this.loadDefaultAvatars();
            this.gm.hideLoadingOverlay();
            this.render(data.list, data.myRank);
        } catch {
            this.gm.hideLoadingOverlay();
        }
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
            this.pageNode = null;
        }
        if (this.gm.modalLayerNode) {
            this.gm.modalLayerNode.active = false;
        }
        if (this.gm.topAreaNode) this.gm.topAreaNode.active = true;
        if (this.gm.boardAreaNode) this.gm.boardAreaNode.active = true;
        if (this.gm.bottomAreaNode) this.gm.bottomAreaNode.active = true;
    }

    /** 榜单展示昵称：未授权用户按 userId 生成稳定的随机玩家名 */
    private getRankDisplayName(item: RankItem): string {
        const nick = (item.nickname || '').trim();
        if (nick) return nick.substring(0, 8);
        const seed = Number(item.userId) || 0;
        return `玩家${(seed * 73 + 1357) % 9000 + 1000}`;
    }

    private render(list: RankItem[], myRank: RankItem | null) {
        this.close();
        // 排行榜页会销毁主界面，原生授权按钮一并销毁（返回时随 ensureTempSlotViews 重建）
        this.destroyAuthOverlay();
        if (this.gm.rootNode) {
            this.gm.rootNode.removeAllChildren();
        }
        this.gm.teardownGameView();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        const padX = 20;
        const listW = pageW - padX * 2;

        this.pageNode = this.gm.createNode('RankPage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // --- 整体背景 (采用浅色清新的原木/休闲主题色) ---
        const bg = this.gm.createGraphicsNode('RankBg', this.pageNode, pageW, pageH, 0, 0);
        bg.getComponent(Graphics)!.fillColor = new Color(245, 248, 240, 255); // 极浅的米绿色背景
        bg.getComponent(Graphics)!.rect(-pageW / 2, -pageH / 2, pageW, pageH);
        bg.getComponent(Graphics)!.fill();

        // --- 顶部导航区域 ---
        const headerY = pageH / 2 - 40;

        // 返回按钮 (< 图标)
        const backBtnW = 40;
        const backBtnH = 40;
        const backBtn = this.gm.createNode('BackBtn', this.pageNode, -pageW / 2 + 30, headerY, backBtnW, backBtnH);
        this.gm.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true); // 绿色箭头
        backBtn.on(Node.EventType.TOUCH_END, () => {
            // 从首页进来的返回首页，从游戏进来的返回游戏
            if (this.fromHome) {
                this.fromHome = false;
                this.gm.homePage.render();
            } else {
                this.gm.goBackToGame();
            }
        }, this);

        // 标题 (排行榜)
        this.gm.createLabel(this.pageNode, '排行榜', 0, headerY, 22, new Color(60, 80, 50, 255), true); // 深绿色标题

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
        const podiumBg = this.gm.createGraphicsNode('PodiumBg', this.pageNode, listW, podiumBgH, 0, podiumBgY);
        this.gm.drawRoundedRect(podiumBg.getComponent(Graphics)!, listW, podiumBgH, new Color(230, 240, 220, 255), 24);

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
            this.createAvatarSpriteNode(this.pageNode!, itemX, itemY, avatarSize, item.avatarUrl);
            // 外圈装饰环
            const avatarBorder = this.gm.createGraphicsNode(`PodiumBorder_${config.rank}`, this.pageNode!, avatarSize + 8, avatarSize + 8, itemX, itemY);
            this.gm.drawCircle(avatarBorder.getComponent(Graphics)!, avatarSize / 2 + 4, new Color(0, 0, 0, 0), 3, config.color);

            // 排名徽章 (贴在头像下方)
            const badgeSize = 20 * config.scale;
            const badgeY = itemY - avatarSize / 2;
            const badge = this.gm.createGraphicsNode(`PodiumBadge_${config.rank}`, this.pageNode!, badgeSize, badgeSize, itemX, badgeY);
            this.gm.drawCircle(badge.getComponent(Graphics)!, badgeSize / 2, config.color);
            this.gm.createLabel(this.pageNode!, `${config.rank}`, itemX, badgeY, 12 * config.scale, new Color(255, 255, 255, 255), true);

            // 昵称
            const nick = this.getRankDisplayName(item);
            this.gm.createLabel(this.pageNode!, nick, itemX, badgeY - 20, 14, new Color(80, 100, 70, 255), config.rank === 1);

            // 关卡数 (高亮颜色)
            this.gm.createLabel(this.pageNode!, `${item.levelNum}关`, itemX, badgeY - 40, 16, config.color, true);

            // 皇冠 (仅第一名有)
            if (config.rank === 1) {
                this.gm.createLabel(this.pageNode!, '👑', itemX, itemY + avatarSize / 2 + 15, 24, new Color(255, 190, 60, 255), true);
            }
        });

        // --- 列表区域 (List Area) ---
        // 列表大底板
        let listStartY = podiumBgY - podiumBgH / 2 - 20;
        const myRankH = myRank ? 90 : 20; // 为底部的"我的排名"预留高度
        const listBgH = pageH / 2 + listStartY; // 延伸到底部，刚好到屏幕边缘
        const listBgCenterY = listStartY - listBgH / 2;

        const listBg = this.gm.createGraphicsNode('ListBg', this.pageNode, pageW, listBgH, 0, listBgCenterY);
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

        const scrollViewNode = this.gm.createNode('ScrollView', this.pageNode, 0, viewY, viewW, viewH);
        const scrollView = scrollViewNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;

        const viewNode = this.gm.createNode('View', scrollViewNode, 0, 0, viewW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        const contentH = Math.max(visibleCount * itemH, viewH);
        const contentNode = this.gm.createNode('Content', viewNode, 0, 0, viewW, contentH);
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
            const rankLabel = this.gm.createLabel(contentNode, `${item.rank}`, itemLeftX + 10, itemY, 20, rankColor, true);
            rankLabel.horizontalAlign = 0; // LEFT
            rankLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 头像 (紧跟在排名右侧)
            const avatarSize = 40;
            const avatarX = itemLeftX + 60; // 排名占约 40px 宽度
            this.createAvatarSpriteNode(contentNode, avatarX, itemY, avatarSize, item.avatarUrl);

            // 昵称 (紧跟在头像右侧)
            const nick = (item.nickname || '玩家').substring(0, 8);
            const nameColor = isMe ? new Color(200, 140, 30, 255) : new Color(80, 100, 70, 255);

            const nickLabel = this.gm.createLabel(contentNode, nick, avatarX + 30, itemY, 16, nameColor, isMe);
            nickLabel.horizontalAlign = 0; // LEFT
            nickLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 关卡数 (靠最右)
            const rightX = listW / 2 - 20;
            const lvLabel = this.gm.createLabel(contentNode, `${item.levelNum} 关`, rightX, itemY, 18, nameColor, true);
            lvLabel.horizontalAlign = 2; // RIGHT
            lvLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);

            // 分割线
            if (i < visibleCount - 1) {
                const lineY = itemY - itemH / 2;
                const lineNode = this.gm.createGraphicsNode('ItemLine', contentNode, listW, 1, 0, lineY);
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
            const myBg = this.gm.createGraphicsNode('MyRankBg', this.pageNode, listW, myCardH, 0, myCardY);
            this.gm.drawRoundedRect(myBg.getComponent(Graphics)!, listW, myCardH, new Color(255, 190, 60, 255), 20); // 醒目的暖黄色

            const itemLeftX = -listW / 2 + 20;

            // 排名数字 (最左侧)
            const rankLabel = this.gm.createLabel(this.pageNode, `${myRank.rank || '?'}`, itemLeftX + 10, myCardY, 20, new Color(255, 255, 255, 255), true);
            rankLabel.horizontalAlign = 0; // LEFT
            rankLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 头像 (紧跟排名)
            const avatarSize = 40;
            const avatarX = itemLeftX + 60;
            this.createAvatarSpriteNode(this.pageNode, avatarX, myCardY, avatarSize, myRank.avatarUrl);

            // 昵称
            const nick = this.getRankDisplayName(myRank);
            const nickLabel = this.gm.createLabel(this.pageNode, nick, avatarX + 30, myCardY, 18, new Color(255, 255, 255, 255), true);
            nickLabel.horizontalAlign = 0; // LEFT
            nickLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

            // 关卡数
            const rightX = listW / 2 - 20;
            const lvLabel = this.gm.createLabel(this.pageNode, `${myRank.levelNum || 0} 关`, rightX, myCardY, 20, new Color(255, 255, 255, 255), true);
            lvLabel.horizontalAlign = 2; // RIGHT
            lvLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
        }
    }
}
