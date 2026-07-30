import { Node, Vec3, UITransform, Color, tween, Graphics, Mask, Sprite, SpriteFrame, Label, resources } from 'cc';
import { getGameConfig, isNewUserThisLogin } from './api';
import { SoundManager } from './SoundManager';
import { BundleManager } from './BundleManager';
import type { GameManager } from './GameManager';

declare const wx: any;

/**
 * 首页：模式选择页（无限模式/每日挑战）及只在首页出现的功能——
 * 每日登录宝箱、首页设置弹窗、免费太阳、新人礼弹窗。
 * 纯逻辑类（非组件），共享工具与状态通过 GameManager 引用访问。
 */
export class HomePage {
    /** 首页节点：模式选择页（无限模式/每日挑战） */
    private pageNode: Node | null = null;
    /** 首页免费太阳按钮（领满置灰用） */
    private freeSunBtnNode: Node | null = null;
    /** 免费太阳每日限领次数 */
    private readonly FREE_SUN_DAILY_LIMIT = 3;
    /** 本次登录是否已标记过新人礼待领取（防止领取后同会话重复标记） */
    private newUserGiftMarked = false;
    /** 签到引导手指（未领每日登录好礼时压在签到按钮上） */
    private signInGuideNode: Node | null = null;

    constructor(private gm: GameManager) {}

    /** 首页：模式选择页（无限模式 / 每日挑战），与排行榜页同样的整页切换方式 */
    render() {
        this.close();
        this.gm.rankPage.close();
        if (this.gm.rootNode) {
            this.gm.rootNode.removeAllChildren();
        }
        this.gm.teardownGameView();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.pageNode = this.gm.createNode('HomePage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // 兜底纯色背景（背景图加载完成前避免露底）
        const bgColor = this.gm.createGraphicsNode('HomeBgColor', this.pageNode, pageW, pageH, 0, 0);
        this.gm.drawRoundedRect(bgColor.getComponent(Graphics)!, pageW, pageH, new Color(232, 237, 220, 255), 0);

        // 背景图：等比缩放填满（cover-fit），裁切层防止溢出
        const bgClip = this.gm.createNode('HomeBgClip', this.pageNode, 0, 0, pageW, pageH);
        bgClip.addComponent(Mask);
        const bgNode = this.gm.createNode('HomeBg', bgClip, 0, 0, pageW, pageH);
        const bgSprite = bgNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('ui/home_bg/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && bgSprite && bgSprite.isValid) {
                bgSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scale = Math.max(pageW / rect.width, pageH / rect.height);
                    bgNode.getComponent(UITransform)!.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        });

        // 顶部标题「摘呀摘」（title_home.png，分包；启动时分包已随水果预载，此时必定可用）
        const titleW = pageW * 0.62;
        const titleNode = this.gm.createNode('HomeTitle', this.pageNode, 0, pageH * 0.34, titleW, titleW * 0.41);
        const titleSprite = titleNode.addComponent(Sprite);
        titleSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/title_home/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && titleSprite.isValid) {
                titleSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    titleNode.getComponent(UITransform)!.setContentSize(titleW, titleW * (rect.height / rect.width));
                }
            }
        }).catch(() => {});
        // 标题轻微呼吸动画
        tween(titleNode)
            .to(1.2, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            .to(1.2, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        // 两个模式入口按钮（每日挑战在上，无限模式在下）
        this.createHomeButton('btn_daily', 0, -pageH * 0.08, 125, () => this.showTip('每日挑战即将上线，敬请期待！'));
        this.createHomeButton('btn_endless', 0, -pageH * 0.22, 125, () => this.enterEndlessMode());

        // 左右两侧功能图标：每日签到（左）、排行榜（右）
        const sideBtnW = 58;
        const sideBtnY = pageH * 0.10;
        this.createHomeButton('btn_signin', -pageW / 2 + 42, sideBtnY, sideBtnW, () => this.onSignInClick());
        const rankBtnNode = this.createHomeButton('btn_rank', pageW / 2 - 42, sideBtnY, sideBtnW, () => {
            this.gm.rankPage.open(true);
        });
        // 未授权用户：微信原生授权按钮叠在排行榜按钮上（游戏内排行榜入口已移除，授权只在首页完成），
        // 点击即由微信自动串起「官方隐私弹窗 → 昵称头像授权弹窗」
        if (rankBtnNode) {
            this.gm.rankPage.setupAuthOverlay(rankBtnNode);
        }

        // 左上角设置按钮：放在树冠下方，避免遮挡背景上的树
        this.createHomeButton('btn_home_settings', -pageW / 2 + 42, pageH * 0.22, sideBtnW, () => this.renderHomeSettingsModal());

        // 免费太阳（排行榜上方，与设置按钮同高）：看广告领小太阳，每天限 3 次
        this.freeSunBtnNode = this.createHomeButton('btn_free_sun', pageW / 2 - 42, pageH * 0.22, sideBtnW, () => this.onFreeSunClick());
        if (this.freeSunBtnNode && this.getFreeSunClaimsToday() >= this.FREE_SUN_DAILY_LIMIT) {
            const sp = this.freeSunBtnNode.getComponent(Sprite);
            if (sp) sp.grayscale = true;
        }

        // 小太阳余额（设置与免费太阳之间，居中）：复用游戏内「sun.png 图标+数字」样式，
        // 引用挂到 gm.sunCountLabel/sunIconNode 上，新人礼的太阳飞行动画自动飞向这里
        const balIconH = 40;
        const balIconW = balIconH * 2.5; // 新图 250x100（2.5:1），右侧数字底框加宽
        const balY = pageH * 0.22;
        const balSunNode = this.gm.createNode('HomeSunIcon', this.pageNode, 0, balY, balIconW, balIconH);
        this.gm.sunIconNode = balSunNode;
        const balSunSprite = balSunNode.addComponent(Sprite);
        balSunSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/sun/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && balSunSprite.isValid) {
                balSunSprite.spriteFrame = sf;
            }
        }).catch(() => {});
        // 数字靠左显示在底框内部（内部左缘实测在图宽 42% 处），左锚点+不缩放，数字变大时向右撑
        const balLabelNode = this.gm.createNode('HomeSunCount', this.pageNode, (0.42 - 0.5) * balIconW + 6, balY, balIconW * 0.5, balIconH);
        const balLabel = balLabelNode.addComponent(Label);
        balLabel.fontSize = 18;
        balLabel.lineHeight = balIconH;
        balLabel.color = new Color(46, 110, 30, 255);
        balLabel.string = `${this.gm.totalSuns}`;
        const balTransform = balLabelNode.getComponent(UITransform);
        if (balTransform) balTransform.setAnchorPoint(0, 0.5);
        balLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        balLabel.verticalAlign = Label.VerticalAlign.CENTER;
        balLabel.overflow = Label.Overflow.NONE;
        this.gm.sunCountLabel = balLabel;

        // 弹窗层：设置弹窗等挂载在此，盖在首页之上（首页销毁了游戏界面的弹窗层，需重建）
        this.gm.modalLayerNode = this.gm.createNode('ModalLayer', this.gm.rootNode!, 0, 0, pageW, pageH);
        this.gm.modalLayerNode.setSiblingIndex(999);
        // 原生授权按钮浮在 Canvas 之上，任何弹窗（签到/设置/新人礼）打开期间需隐藏，防止透明按钮误拦截点击
        this.gm.modalLayerNode.on(Node.EventType.CHILD_ADDED, () => {
            this.gm.rankPage.setAuthOverlayVisible(false);
        }, this);
        this.gm.modalLayerNode.on(Node.EventType.CHILD_REMOVED, () => {
            if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid && this.gm.modalLayerNode.children.length === 0) {
                this.gm.rankPage.setAuthOverlayVisible(true);
            }
        }, this);

        // 未领每日登录好礼：手指引导指向签到按钮
        this.showSignInGuideIfNeeded(-pageW / 2 + 42, sideBtnY);

        // 新人礼弹窗改在首页弹出（已领取的不会再弹）
        this.gm.scheduleOnce(() => this.tryShowRewards(), 0.6);
    }

    /** 首页按钮：整图 Sprite + 按压缩放反馈，高度按图片比例自适应 */
    private createHomeButton(imgName: string, x: number, y: number, width: number, onTap: () => void): Node | null {
        if (!this.pageNode) return null;
        const btnNode = this.gm.createNode(`HomeBtn_${imgName}`, this.pageNode, x, y, width, width * 0.55);
        const sprite = btnNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load(`ui/${imgName}/spriteFrame`, SpriteFrame, (err, sf) => {
            if (!err && sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    btnNode.getComponent(UITransform)!.setContentSize(width, width * (rect.height / rect.width));
                }
            }
        });
        btnNode.on(Node.EventType.TOUCH_START, () => {
            tween(btnNode).to(0.06, { scale: new Vec3(0.94, 0.94, 1) }).start();
        }, this);
        btnNode.on(Node.EventType.TOUCH_CANCEL, () => {
            tween(btnNode).to(0.08, { scale: new Vec3(1, 1, 1) }).start();
        }, this);
        btnNode.on(Node.EventType.TOUCH_END, () => {
            tween(btnNode).to(0.08, { scale: new Vec3(1, 1, 1) }).start();
            onTap();
        }, this);
        return btnNode;
    }

    /**
     * 签到引导手指：今天还没领每日登录好礼时，手指压在签到按钮上朝按钮方向反复轻戳。
     * 点签到按钮即销毁；挂在 pageNode 下随首页销毁，下次回首页仍未领会再出现。
     */
    private showSignInGuideIfNeeded(btnX: number, btnY: number) {
        if (!this.pageNode) return;
        const today = new Date().getDate();
        if (this.getSignedDaysThisMonth().indexOf(today) >= 0) return;

        // 图 144x256，指尖朝左上（位于图上约 30%/8% 处），手放按钮右下让指尖落在按钮中心
        const handH = 64;
        const handW = Math.round(handH * 144 / 256);
        const hx = btnX + handW * 0.2;
        const hy = btnY - handH * 0.42;
        const handNode = this.gm.createNode('SignInGuideHand', this.pageNode, hx, hy, handW, handH);
        this.signInGuideNode = handNode;
        const handSprite = handNode.addComponent(Sprite);
        handSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hand_guide/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && handSprite.isValid) {
                handSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 朝按钮方向（左上）反复轻戳；手指节点不挂触摸事件，不挡按钮点击
        tween(handNode)
            .to(0.45, { position: new Vec3(hx - 5, hy + 7, 0) }, { easing: 'sineInOut' })
            .to(0.45, { position: new Vec3(hx, hy, 0) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
        }
        this.pageNode = null;
        this.signInGuideNode = null;
        // 首页太阳余额引用随页面销毁置空（进游戏时 ensureTempSlotViews 检测到空引用会重建游戏内版本）
        this.gm.sunCountLabel = null;
        this.gm.sunIconNode = null;
        // 授权叠层只服务首页排行榜按钮，离开首页即销毁（重新 render 时会再创建）
        this.gm.rankPage.destroyAuthOverlay();
    }

    /** 进入无限模式：重建主界面并渲染已有进度，首次进入时补触发新手引导 */
    private enterEndlessMode() {
        this.close();
        this.gm.goBackToGame();
        this.gm.showWelcomeFlowIfNeeded();
    }

    /** 新人礼是否待领取（本地存储标记，领取成功才清除，跨会话有效） */
    private isNewUserGiftPending(): boolean {
        try {
            if (typeof wx !== 'undefined') {
                return wx.getStorageSync('newUserGiftPending') === 'true';
            }
            return localStorage.getItem('newUserGiftPending') === 'true';
        } catch (e) {
            return false;
        }
    }

    private setNewUserGiftPending(pending: boolean) {
        try {
            if (typeof wx !== 'undefined') {
                wx.setStorageSync('newUserGiftPending', pending ? 'true' : '');
            } else {
                localStorage.setItem('newUserGiftPending', pending ? 'true' : '');
            }
        } catch (e) {}
    }

    /** 首页奖励弹窗轮询：登录数据可能晚于首页渲染返回，反复检查直到弹出或超次（离开首页即停止） */
    private tryShowRewards(attempt = 0) {
        if (!this.pageNode || !this.pageNode.isValid) return;
        if (attempt > 15) return;
        const retry = () => this.gm.scheduleOnce(() => this.tryShowRewards(attempt + 1), 2);
        // 有其他弹窗开着（签到/设置等）先等
        if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid && this.gm.modalLayerNode.children.length > 0) {
            retry();
            return;
        }
        // 新用户本次登录：标记新人礼待领取（仅标记一次，领取后不再重标）
        if (isNewUserThisLogin() && !this.newUserGiftMarked) {
            this.newUserGiftMarked = true;
            this.setNewUserGiftPending(true);
        }
        if (this.isNewUserGiftPending()) {
            this.showNewUserGiftModal();
            return;
        }
        retry();
    }

    /** 新人见面礼弹窗：仅创建用户的那次登录弹出，金额来自 game_config 的 new_user_reward */
    private showNewUserGiftModal() {
        const amount = getGameConfig()?.newUserReward ?? 1000;
        this.renderNewUserGiftModal(amount);
    }

    private renderNewUserGiftModal(amount: number) {
        if (!this.gm.modalLayerNode) return;
        this.gm.modalLayerNode.removeAllChildren();

        // 遮罩（点击不关闭，仅拦截穿透；新人礼无 X，必须点宝箱领取）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 宝箱整图面板：panel_new_user_gift.png（标题、打开的宝箱、金色光芒都画在图里，1:1 方图）
        const panelW = Math.min(340, this.gm.screenWidth * 0.92);
        const panelNode = this.gm.createNode('NewUserGiftPanel', this.gm.modalLayerNode, 0, 0, panelW, panelW);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_new_user_gift/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
                }
            }
        }).catch(() => {});

        const ph = panelTransform.height;

        // 提示文案：面板下方
        this.gm.createLabel(this.gm.modalLayerNode, `点击宝箱领取 +${amount} 小太阳`, 0, -ph / 2 - 36, 20, new Color(255, 235, 160, 255), true);

        // 整个面板都是领取热区（无 X 按钮，不能错过）
        let claiming = false;
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            if (claiming) return;
            claiming = true;

            const startSuns = this.gm.totalSuns;
            this.gm.totalSuns += amount;
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('totalSuns', this.gm.totalSuns.toString());
            } else {
                localStorage.setItem('totalSuns', this.gm.totalSuns.toString());
            }
            // 领取成功，清除待领取标记（之后不再弹新人礼）
            this.setNewUserGiftPending(false);

            // 宝箱弹一下 + "+N 小太阳" 上飘 + 金色太阳飞向顶部计数
            if (breathTween) breathTween.stop();
            tween(panelNode)
                .to(0.12, { scale: new Vec3(1.15, 1.15, 1) })
                .to(0.12, { scale: new Vec3(1, 1, 1) })
                .start();
            const gainLabel = this.gm.createLabel(this.gm.modalLayerNode!, `+${amount} 小太阳`, 0, ph * 0.18, 30, new Color(255, 220, 80, 255), true);
            tween(gainLabel.node)
                .by(0.8, { position: new Vec3(0, 70, 0) })
                .start();

            // 起飞点取宝箱主体中心（面板中心略偏下）
            const chestWorldPos = panelTransform.convertToWorldSpaceAR(new Vec3(0, -ph * 0.1, 0));
            this.gm.playDailyRewardSunFly(chestWorldPos, startSuns, amount, () => {
                if (this.gm.modalLayerNode) this.gm.modalLayerNode.removeAllChildren();
            });
        }, this);

        // 入场：从小到大弹出；播完后再启动独立的循环呼吸 tween
        let breathTween: ReturnType<typeof tween> | null = null;
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode)
            .to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .call(() => {
                if (!panelNode.isValid) return;
                breathTween = tween(panelNode)
                    .to(0.55, { scale: new Vec3(1.09, 1.09, 1) }, { easing: 'sineInOut' })
                    .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever();
                breathTween.start();
            })
            .start();
    }

    /** 免费太阳：看广告领小太阳（额度与每日签到一致），每天限 FREE_SUN_DAILY_LIMIT 次 */
    private onFreeSunClick() {
        const used = this.getFreeSunClaimsToday();
        if (used >= this.FREE_SUN_DAILY_LIMIT) {
            this.gm.renderCommonTip('免费太阳', '今天的免费太阳已经领完啦\n明天再来哦～');
            return;
        }
        this.gm.showAdThen(() => {
            const amount = getGameConfig()?.dailyLoginReward ?? 200;
            this.gm.totalSuns += amount;
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('totalSuns', this.gm.totalSuns.toString());
            } else {
                localStorage.setItem('totalSuns', this.gm.totalSuns.toString());
            }
            const newUsed = used + 1;
            this.setFreeSunClaimsToday(newUsed);
            // 首页太阳余额同步刷新
            if (this.gm.sunCountLabel && this.gm.sunCountLabel.isValid) {
                this.gm.sunCountLabel.string = `${this.gm.totalSuns}`;
            }
            const left = this.FREE_SUN_DAILY_LIMIT - newUsed;
            this.showTip(left > 0 ? `+${amount} 小太阳 今日还可领 ${left} 次` : `+${amount} 小太阳 今日次数已用完`);
            if (left <= 0 && this.freeSunBtnNode && this.freeSunBtnNode.isValid) {
                const sp = this.freeSunBtnNode.getComponent(Sprite);
                if (sp) sp.grayscale = true;
            }
        }, 'free_sun');
    }

    /** 今日免费太阳已领次数（本地存储，格式 "日期:count"，跨天自动归零） */
    private getFreeSunClaimsToday(): number {
        const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
            ? (wx.getStorageSync('freeSunClaims') || '')
            : (localStorage.getItem('freeSunClaims') || '');
        const [date, cnt] = String(raw).split(':');
        return date === this.gm.getTodayStr() ? (parseInt(cnt, 10) || 0) : 0;
    }

    private setFreeSunClaimsToday(count: number) {
        const val = `${this.gm.getTodayStr()}:${count}`;
        if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync('freeSunClaims', val);
        } else {
            localStorage.setItem('freeSunClaims', val);
        }
    }

    /** 首页设置弹窗：只有音量/震动开关 + 游戏反馈按钮（暂不可点击），面板图 panel_home_settings.png */
    private renderHomeSettingsModal() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.removeAllChildren();

        // 遮罩：点击关闭
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 面板：panel_home_settings.png（640x841，分包）
        const panelW = 300;
        const panelH = panelW * 841 / 640;
        const panelNode = this.gm.createNode('HomeSettingsPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_home_settings/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 图内相对定位
        const px = (fx: number) => (fx - 0.5) * panelW;
        const py = (fy: number) => (0.5 - fy) * panelH;

        // 右上角 X 关闭热区
        const closeBtn = this.gm.createNode('CloseBtn', panelNode, px(0.901), py(0.061), 48, 48);
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 音量开关：与图上喇叭图标同一水平线，开关放右侧（createToggle 内部会 +60 偏移）
        const toggleX = 28;
        this.gm.createToggle(panelNode, toggleX, py(0.361), this.gm.soundEnabled, (isOn) => {
            this.gm.soundEnabled = isOn;
            localStorage.setItem('soundEnabled', String(isOn));
            SoundManager.getInstance()?.setMute(!isOn);
            if (isOn) {
                SoundManager.getInstance()?.playBGM();
            } else {
                SoundManager.getInstance()?.stopBGM();
            }
        });

        // 震动开关：与图上震动图标同一水平线
        this.gm.createToggle(panelNode, toggleX, py(0.577), this.gm.vibrationEnabled, (isOn) => {
            this.gm.vibrationEnabled = isOn;
            localStorage.setItem('vibrationEnabled', String(isOn));
            if (isOn) this.gm.triggerVibration('light');
        });

        // 游戏反馈按钮（图里的橙色立体按钮）：暂不可点击，不挂事件，仅占位
    }

    /** 点击签到按钮：今天未领弹每日登录宝箱，已领弹提示 */
    private onSignInClick() {
        // 点了签到按钮即撤掉引导手指
        if (this.signInGuideNode && this.signInGuideNode.isValid) {
            this.signInGuideNode.destroy();
        }
        this.signInGuideNode = null;
        const today = new Date().getDate();
        if (this.getSignedDaysThisMonth().indexOf(today) >= 0) {
            this.gm.renderCommonTip('每日登录好礼', '今天的好礼已经领过啦\n明天再来哦～');
            return;
        }
        this.renderDailyGiftModal();
    }

    /** 每日登录宝箱弹窗（panel_daily_gift.png）：点宝箱 +小太阳（每天一次），太阳粒子飞向顶部余额 */
    private renderDailyGiftModal() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.removeAllChildren();

        const amount = getGameConfig()?.dailyLoginReward ?? 200;

        // 遮罩：点击关闭（今天不领，之后再点签到按钮还能领）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 宝箱整图面板：panel_daily_gift.png（标题、宝箱、金色光芒都画在图里，1:1 方图）
        const panelW = Math.min(340, this.gm.screenWidth * 0.92);
        const panelNode = this.gm.createNode('DailyGiftPanel', this.gm.modalLayerNode, 0, 0, panelW, panelW);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_daily_gift/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
                }
            }
        }).catch(() => {});

        const ph = panelTransform.height;

        // 提示文案：面板下方
        this.gm.createLabel(this.gm.modalLayerNode, `点击宝箱领取 +${amount} 小太阳`, 0, -ph / 2 - 36, 20, new Color(255, 235, 160, 255), true);

        // 整个面板都是领取热区
        let claiming = false;
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            if (claiming) return;
            claiming = true;

            const startSuns = this.gm.totalSuns;
            this.gm.totalSuns += amount;
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('totalSuns', this.gm.totalSuns.toString());
            } else {
                localStorage.setItem('totalSuns', this.gm.totalSuns.toString());
            }
            // 记录今天已领（沿用签到天数存储，跨月自动清零）
            this.setSignedToday();

            // 宝箱弹一下 + "+N 小太阳" 上飘 + 金色太阳飞向顶部余额（计数随粒子到达滚动）
            if (breathTween) breathTween.stop();
            tween(panelNode)
                .to(0.12, { scale: new Vec3(1.15, 1.15, 1) })
                .to(0.12, { scale: new Vec3(1, 1, 1) })
                .start();
            const gainLabel = this.gm.createLabel(this.gm.modalLayerNode!, `+${amount} 小太阳`, 0, ph * 0.18, 30, new Color(255, 220, 80, 255), true);
            tween(gainLabel.node)
                .by(0.8, { position: new Vec3(0, 70, 0) })
                .start();

            // 起飞点取宝箱主体中心（面板中心略偏下）
            const chestWorldPos = panelTransform.convertToWorldSpaceAR(new Vec3(0, -ph * 0.1, 0));
            this.gm.playDailyRewardSunFly(chestWorldPos, startSuns, amount, () => {
                if (this.gm.modalLayerNode) this.gm.modalLayerNode.removeAllChildren();
            });
        }, this);

        // 入场：从小到大弹出；播完后再启动独立的循环呼吸 tween
        let breathTween: ReturnType<typeof tween> | null = null;
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode)
            .to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .call(() => {
                if (!panelNode.isValid) return;
                breathTween = tween(panelNode)
                    .to(0.55, { scale: new Vec3(1.09, 1.09, 1) }, { easing: 'sineInOut' })
                    .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever();
                breathTween.start();
            })
            .start();
    }

    /** 本月已签到的日期列表（本地存储，格式 "YYYY-M:d1,d2"，跨月自动清零） */
    private getSignedDaysThisMonth(): number[] {
        const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
            ? (wx.getStorageSync('signInDays') || '')
            : (localStorage.getItem('signInDays') || '');
        const sep = String(raw).lastIndexOf(':');
        if (sep < 0) return [];
        const monthKey = String(raw).substring(0, sep);
        const d = new Date();
        if (monthKey !== `${d.getFullYear()}-${d.getMonth() + 1}`) return [];
        return String(raw).substring(sep + 1).split(',').map(Number).filter(n => n > 0);
    }

    private setSignedToday() {
        const d = new Date();
        const days = this.getSignedDaysThisMonth();
        if (days.indexOf(d.getDate()) < 0) days.push(d.getDate());
        const val = `${d.getFullYear()}-${d.getMonth() + 1}:${days.join(',')}`;
        if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync('signInDays', val);
        } else {
            localStorage.setItem('signInDays', val);
        }
    }

    /** 首页轻提示：短暂浮现后自动消失 */
    private showTip(text: string) {
        if (!this.pageNode || !this.pageNode.isValid) return;
        const existing = this.pageNode.getChildByName('HomeTip');
        if (existing) existing.destroy();
        const tipNode = this.gm.createNode('HomeTip', this.pageNode, 0, -this.gm.screenHeight * 0.33, 280, 40);
        const tipBg = this.gm.createGraphicsNode('TipBg', tipNode, 280, 40, 0, 0);
        this.gm.drawRoundedRect(tipBg.getComponent(Graphics)!, 280, 40, new Color(60, 80, 50, 210), 20);
        this.gm.createLabel(tipNode, text, 0, 0, 14, new Color(255, 255, 255, 255), true);
        tween(tipNode)
            .delay(1.6)
            .to(0.25, { scale: new Vec3(0.8, 0.8, 1) })
            .call(() => {
                if (tipNode.isValid) tipNode.destroy();
            })
            .start();
    }
}
