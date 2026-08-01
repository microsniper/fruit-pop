import { _decorator, Component, Node, Vec3, Layers, UITransform, Color, Graphics, Sprite, SpriteFrame, Label, Mask, resources, director, UIOpacity, tween } from 'cc';
import { LoadingPage } from './LoadingPage';

const { ccclass } = _decorator;

/**
 * 开场欢迎页（独立 Welcome 场景，主包启动场景）：
 * 果园背景 + 标题 + 水果环绕跳动动画 + 「一起闯荡果园大世界」呼吸按钮。
 * 只依赖主包资源（home_bg、水果图），本身不加载分包；
 * 点按钮跳 Loading 场景（每次页面跳转都有加载动画），由 Loading 负责分包/登录加载。
 */
@ccclass('WelcomePage')
export class WelcomePage extends Component {
    /** 逻辑分辨率（与 GameManager.setupLayout 一致） */
    private readonly W = 375;
    private readonly H = 812;

    /** 参与环绕动画的水果（主包 fruits/ 下 9 张；注意 Сorn 是西里尔字母 С） */
    private readonly fruitNames = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot', 'Pomegranate'];
    private readonly orbitRadius = 112;
    private readonly orbitSpeed = 45; // 环绕角速度（度/秒）
    private orbitAngle = 0;
    private orbitCenter = { x: 0, y: 0 };
    private fruitNodes: Node[] = [];

    start() {
        this.buildBackground();
        this.buildFruitOrbit();
        this.buildEnterButton();
    }

    update(dt: number) {
        if (this.fruitNodes.length === 0) return;
        this.orbitAngle += dt * this.orbitSpeed;
        const n = this.fruitNodes.length;
        this.fruitNodes.forEach((node, i) => {
            if (!node || !node.isValid) return;
            const rad = (this.orbitAngle + (i / n) * 360) * Math.PI / 180;
            const x = this.orbitCenter.x + this.orbitRadius * Math.cos(rad);
            // 环绕 + 自身上下跳动（相位错开，此起彼伏）；水果保持正立不随角度翻转
            const y = this.orbitCenter.y + this.orbitRadius * Math.sin(rad) + Math.sin(this.orbitAngle * 0.07 + i * 1.3) * 12;
            node.setPosition(new Vec3(x, y, 0));
        });
    }

    // ---------------- UI 搭建 ----------------

    /** 背景：兜底纯色 + home_bg 等比填满（cover-fit）+ Mask 裁切（与首页/加载页同款） */
    private buildBackground() {
        const pageW = this.W;
        const pageH = this.H;
        const bgColor = this.createGraphicsNode('BgColor', this.node, pageW, pageH, 0, 0);
        this.drawRoundedRect(bgColor.getComponent(Graphics)!, pageW, pageH, new Color(232, 237, 220, 255), 0);

        const bgClip = this.createNode('BgClip', this.node, 0, 0, pageW, pageH);
        bgClip.addComponent(Mask);
        const bgNode = this.createNode('Bg', bgClip, 0, 0, pageW, pageH);
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
    }

    /** 水果环绕动画：9 张水果图，位置由 update 按环绕角计算 */
    private buildFruitOrbit() {
        this.orbitCenter = { x: 0, y: this.H * 0.14 };
        this.fruitNames.forEach((name) => {
            const node = this.createNode(`Fruit_${name}`, this.node, 0, 0, 46, 46);
            const sp = node.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            resources.load(`fruits/${name}/spriteFrame`, SpriteFrame, (err, sf) => {
                if (!err && sf && sp && sp.isValid) {
                    sp.spriteFrame = sf;
                    const rect = sf.rect;
                    if (rect && rect.height > 0) {
                        node.getComponent(UITransform)!.setContentSize(46 * (rect.width / rect.height), 46);
                    }
                }
            });
            this.fruitNodes.push(node);
        });
    }

    /** 进入按钮：延迟淡入 + 呼吸缩放；点击跳 Loading（进主页） */
    private buildEnterButton() {
        const btnW = this.W * 0.8;
        const btnH = 68;
        const btn = this.createNode('EnterBtn', this.node, 0, -this.H * 0.26, btnW, btnH);
        const bg = this.createGraphicsNode('BtnBg', btn, btnW, btnH, 0, 0);
        // 橙黄底 + 深棕描边胶囊（与进度条填充同色，统一游戏主色）
        this.drawRoundedRect(bg.getComponent(Graphics)!, btnW, btnH, new Color(250, 172, 40, 255), btnH / 2, 4, new Color(122, 84, 48, 255));
        this.createLabel(btn, '一起闯荡果园大世界', 0, 0, 26, new Color(255, 255, 255, 255), true);

        // 延迟淡入（水果先转起来，按钮最后出现）
        const op = btn.addComponent(UIOpacity);
        op.opacity = 0;
        tween(op).delay(0.8).to(0.5, { opacity: 255 }).start();
        // 呼吸效果：缩放 1.0 ↔ 1.07 循环
        tween(btn)
            .delay(1.3)
            .to(1.0, { scale: new Vec3(1.07, 1.07, 1) }, { easing: 'sineInOut' })
            .to(1.0, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        btn.on(Node.EventType.TOUCH_END, () => {
            LoadingPage.target = 'home';
            director.loadScene('Loading');
        }, this);
    }

    // ---------------- 小工具（与 LoadingPage 同款风格） ----------------

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
