import { _decorator, Component, Node, Vec3, Layers, UITransform, Color, Graphics, Sprite, SpriteFrame, Label, Mask, resources, director, UIOpacity, tween } from 'cc';
import { BundleManager } from './BundleManager';
import { loginAndGetProgress, fetchGameConfig, getDefaultGameConfig, GameConfig } from './api';

const { ccclass } = _decorator;

/** 加载页跳转目标：进主页 / 直接进无限模式 */
export type LoadingTarget = 'home' | 'endless';

/** Loading 场景预热的请求，Main 场景 GameManager 启动时复用，避免重复 wx.login/拉配置 */
interface WarmupRequests {
    login: Promise<number>;
    config: Promise<GameConfig>;
}

/**
 * 通用加载页（独立 Loading 场景）：
 * 果园背景 + 摘呀摘 logo + 苹果进度条 + 健康游戏忠告 + 适龄提示。
 * 两个入口：① 游戏启动（进主页）② 首页点无限模式（直接进对局）。
 * 展示期间并发完成真实加载：分包、水果图、登录/配置预热、Main 场景预载，
 * 进度条按各任务加权汇总，全部完成且满最短展示时长后切到 Main 场景。
 */
@ccclass('LoadingPage')
export class LoadingPage extends Component {
    /** 逻辑分辨率（与 GameManager.setupLayout 一致） */
    private readonly W = 375;
    private readonly H = 812;
    /** 最短展示时长：资源全缓存时也不一闪而过 */
    private readonly MIN_SHOW_MS = 1200;

    private static _target: LoadingTarget = 'home';
    private static _warmup: WarmupRequests | null = null;
    private static _launched = false;

    /** 首页切场景前设置目标，Loading 完成后由 GameManager 消费并自动复位 */
    static set target(t: LoadingTarget) { LoadingPage._target = t; }
    static consumeTarget(): LoadingTarget {
        const t = LoadingPage._target;
        LoadingPage._target = 'home';
        return t;
    }
    /** GameManager 启动时取走预热请求 */
    static consumeWarmup(): WarmupRequests | null {
        const w = LoadingPage._warmup;
        LoadingPage._warmup = null;
        return w;
    }
    /** Main 场景是否经由 Loading 页进入（决定 GameManager 是否再显示旧转圈与 2 秒等待） */
    static consumeLaunched(): boolean {
        const v = LoadingPage._launched;
        LoadingPage._launched = false;
        return v;
    }

    /** 各加载任务权重（合计 100），进度条 = 真实进度加权和 */
    private readonly weights = { bundle: 30, fruits: 25, login: 20, config: 10, scene: 15 };
    private readonly done = { bundle: 0, fruits: 0, login: 0, config: 0, scene: 0 };
    private shownProgress = 0;
    private startTs = 0;
    private finished = false;
    private logoShown = false;

    private barWidth = 0;
    private fillNode: Node | null = null;
    private appleNode: Node | null = null;

    start() {
        this.startTs = Date.now();
        this.buildUI();
        this.runTasks();
    }

    update(dt: number) {
        if (this.finished) return;
        const target = this.computeProgress();
        // 平滑逼近真实进度，避免跳跃式前进
        this.shownProgress += (target - this.shownProgress) * Math.min(1, dt * 5);
        if (target >= 1 && target - this.shownProgress < 0.01) {
            this.shownProgress = 1;
        }
        this.renderProgress(this.shownProgress);
        if (this.shownProgress >= 1 && Date.now() - this.startTs >= this.MIN_SHOW_MS) {
            this.finished = true;
            LoadingPage._launched = true;
            director.loadScene('Main');
        }
    }

    private computeProgress(): number {
        const w = this.weights;
        const d = this.done;
        return (w.bundle * d.bundle + w.fruits * d.fruits + w.login * d.login + w.config * d.config + w.scene * d.scene) / 100;
    }

    // ---------------- 加载任务 ----------------

    private runTasks() {
        // ① 分包（bundle_late）：logo 与游戏内 UI 图都在里面，拿到 logo 后淡入标题
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/title_home/spriteFrame', SpriteFrame)
            .then((sf) => {
                this.done.bundle = 1;
                this.showLogo(sf);
            })
            .catch(() => { this.done.bundle = 1; });

        // ② 主包水果图预载（与 GameManager.loadFruitSprites 同一批，进 Main 后秒完成）
        const fruits = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot'];
        let fruitLoaded = 0;
        fruits.forEach((name) => {
            resources.load(`fruits/${name}/spriteFrame`, SpriteFrame, () => {
                fruitLoaded++;
                this.done.fruits = fruitLoaded / fruits.length;
            });
        });

        // ③④ 登录 → 配置（串行：无 token 时 fetchGameConfig 内部会再登录一次，链式避免重复 wx.login）
        const loginP: Promise<number> = loginAndGetProgress()
            .then((lv) => { this.done.login = 1; return lv; })
            .catch(() => { this.done.login = 1; return 1; });
        const configP: Promise<GameConfig> = loginP
            .then(() => fetchGameConfig())
            .then((c) => { this.done.config = 1; return c; })
            .catch(() => { this.done.config = 1; return getDefaultGameConfig(); });
        LoadingPage._warmup = { login: loginP, config: configP };

        // ⑤ Main 场景预载：进度 100% 后切换场景不掉帧
        director.preloadScene('Main', () => {
            this.done.scene = 1;
        });
    }

    // ---------------- UI 搭建 ----------------

    private buildUI() {
        const pageW = this.W;
        const pageH = this.H;

        // 兜底纯色背景（背景图加载完成前避免露底），与首页同色
        const bgColor = this.createGraphicsNode('BgColor', this.node, pageW, pageH, 0, 0);
        this.drawRoundedRect(bgColor.getComponent(Graphics)!, pageW, pageH, new Color(232, 237, 220, 255), 0);

        // 背景图：等比缩放填满（cover-fit），裁切层防止溢出（与首页同款处理）
        const bgClip = this.createNode('BgClip', this.node, 0, 0, pageW, pageH);
        bgClip.addComponent(Mask);
        const bgNode = this.createNode('Bg', bgClip, 0, 0, pageW, pageH);
        const bgSprite = bgNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('ui/home_welcome_bg/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && bgSprite && bgSprite.isValid) {
                bgSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scale = Math.max(pageW / rect.width, pageH / rect.height);
                    bgNode.getComponent(UITransform)!.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        });

        // 「加载中...」
        this.createLabel(this.node, '加载中...', 0, -56, 22, new Color(80, 60, 35, 255), true);

        // 进度条：白底胶囊 + 深棕描边，橙黄填充，红苹果骑在填充前端
        this.barWidth = pageW * 0.78;
        const barH = 22;
        const barNode = this.createNode('ProgressBar', this.node, 0, -96, this.barWidth, barH);
        const barBg = this.createGraphicsNode('BarBg', barNode, this.barWidth, barH, 0, 0);
        this.drawRoundedRect(barBg.getComponent(Graphics)!, this.barWidth, barH, new Color(255, 255, 255, 255), barH / 2, 3, new Color(122, 84, 48, 255));
        this.fillNode = this.createGraphicsNode('BarFill', barNode, 0, 0, 0, 0);
        this.appleNode = this.createNode('BarApple', barNode, -this.barWidth / 2, 16, 36, 36);
        const appleSprite = this.appleNode.addComponent(Sprite);
        appleSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('fruits/Red Apple/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && appleSprite && appleSprite.isValid && this.appleNode) {
                appleSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.height > 0) {
                    this.appleNode.getComponent(UITransform)!.setContentSize(36 * (rect.width / rect.height), 36);
                }
            }
        });

        // 健康游戏忠告
        const tipColor = new Color(96, 76, 52, 255);
        this.createLabel(this.node, '《健康游戏忠告》', 0, -150, 15, tipColor, true);
        const tips = [
            '抵制不良游戏，拒绝盗版游戏。',
            '注意自我保护，谨防受骗上当。',
            '适度游戏益脑，沉迷游戏伤身。',
            '合理安排时间，享受健康生活。'
        ];
        tips.forEach((text, i) => {
            this.createLabel(this.node, text, 0, -178 - i * 24, 13, tipColor, false);
        });

        // 适龄提示（右下角）
        this.buildAgeBadge(this.node, pageW / 2 - 36, -pageH / 2 + 42);
    }

    /** 适龄提示标识：白底圆角块 + 蓝色 12+ 区块 + CADPA + 适龄提示 */
    private buildAgeBadge(parent: Node, x: number, y: number) {
        const badge = this.createNode('AgeBadge', parent, x, y, 52, 62);
        const bg = this.createGraphicsNode('BadgeBg', badge, 52, 62, 0, 0);
        this.drawRoundedRect(bg.getComponent(Graphics)!, 52, 62, new Color(255, 255, 255, 255), 8, 2, new Color(210, 210, 210, 255));
        const blue = this.createGraphicsNode('BadgeBlue', badge, 44, 32, 0, 11);
        this.drawRoundedRect(blue.getComponent(Graphics)!, 44, 32, new Color(38, 122, 193, 255), 5, 0);
        this.createLabel(badge, '12+', 0, 16, 16, new Color(255, 255, 255, 255), true);
        this.createLabel(badge, 'CADPA', 0, 4, 6.5, new Color(255, 255, 255, 230), true);
        this.createLabel(badge, '适龄提示', 0, -19, 10, new Color(90, 90, 90, 255), true);
    }

    /** 标题 logo：分包就绪后淡入（与首页同款 title_home 图与呼吸动画） */
    private showLogo(sf: SpriteFrame | null) {
        if (this.logoShown || !sf || !this.node || !this.node.isValid) return;
        this.logoShown = true;
        const titleW = this.W * 0.62;
        const titleNode = this.createNode('Title', this.node, 0, this.H * 0.34, titleW, titleW * 0.41);
        const sp = titleNode.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.spriteFrame = sf;
        const rect = sf.rect;
        if (rect && rect.width > 0) {
            titleNode.getComponent(UITransform)!.setContentSize(titleW, titleW * (rect.height / rect.width));
        }
        const op = titleNode.addComponent(UIOpacity);
        op.opacity = 0;
        tween(op).to(0.4, { opacity: 255 }).start();
        tween(titleNode)
            .delay(0.4)
            .to(1.2, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            .to(1.2, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    /** 刷新进度条填充与苹果位置 */
    private renderProgress(p: number) {
        if (!this.fillNode || !this.fillNode.isValid) return;
        const innerW = this.barWidth - 8;
        const fillW = p <= 0 ? 0 : Math.max(14, innerW * Math.min(1, p));
        const g = this.fillNode.getComponent(Graphics)!;
        g.clear();
        if (fillW > 0) {
            const h = 14;
            // 底层橙黄 + 上半高光，模拟渐变立体感
            g.fillColor = new Color(250, 172, 40, 255);
            g.roundRect(-fillW / 2, -h / 2, fillW, h, h / 2);
            g.fill();
            g.fillColor = new Color(255, 206, 90, 255);
            g.roundRect(-fillW / 2 + 2, 0, Math.max(0, fillW - 4), h / 2 - 1, h / 4);
            g.fill();
        }
        this.fillNode.setPosition(new Vec3(-innerW / 2 + fillW / 2, 0, 0));
        if (this.appleNode && this.appleNode.isValid) {
            this.appleNode.setPosition(new Vec3(-innerW / 2 + fillW, 16, 0));
        }
    }

    // ---------------- 小工具（与 GameManager 同款风格） ----------------

    private createNode(name: string, parent: Node, x: number, y: number, width: number, height: number) {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
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
}
