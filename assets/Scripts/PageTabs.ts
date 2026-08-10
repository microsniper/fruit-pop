import { Node, Color, Graphics, LabelOutline } from 'cc';
import type { GameManager } from './GameManager';

const BROWN = new Color(110, 75, 45, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const BLUE = new Color(30, 136, 229, 255);
const ORANGE = new Color(255, 150, 0, 255);

/**
 * 金属铭牌标题（参考「排行榜」铭牌样式）：灰钢圆牌 + 顶部高光 + 深灰粗描边 + 两颗螺丝 + 白字深描边。
 * 仓库/商城页顶栏共用。
 */
export function drawTitlePlate(gm: GameManager, parent: Node, y: number, title: string) {
    const old = parent.getChildByName('TitlePlate');
    if (old) old.destroy();

    const w = 150, h = 44;
    const plate = gm.createNode('TitlePlate', parent, 0, y, w, h);
    const g = plate.addComponent(Graphics);
    g.fillColor = new Color(170, 175, 185, 255);
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.fill();
    // 顶部高光条（金属反光）
    g.fillColor = new Color(210, 215, 225, 110);
    g.roundRect(-w / 2 + 8, 3, w - 16, h / 2 - 8, 8);
    g.fill();
    g.strokeColor = new Color(90, 95, 105, 255);
    g.lineWidth = 3;
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.stroke();
    // 左右螺丝钉
    [-1, 1].forEach((s) => {
        const screw = gm.createNode('Screw', plate, s * (w / 2 - 20), 0, 10, 10);
        const sg = screw.addComponent(Graphics);
        sg.fillColor = new Color(120, 125, 135, 255);
        sg.circle(0, 0, 5);
        sg.fill();
        sg.strokeColor = new Color(80, 85, 95, 255);
        sg.lineWidth = 1.5;
        sg.circle(0, 0, 5);
        sg.stroke();
        sg.moveTo(-2.5, -2.5);
        sg.lineTo(2.5, 2.5);
        sg.stroke();
    });
    const label = gm.createLabel(plate, title, 0, 0, 22, new Color(255, 255, 255, 255), true);
    const outline = label.node.addComponent(LabelOutline);
    if (outline) {
        outline.color = new Color(70, 75, 90, 255);
        outline.width = 2;
    }
}

/**
 * 分段控制 tab 条（能看出上下级）：
 *  main 一级：深色胶囊容器 240x42 + 亮蓝选中段（内缩凸起）+ 白字；未选中浅灰字
 *  sub  二级：小一号 32 高、米色容器棕描边 + 橙色选中段；未选中棕字
 * 整条按 barName 重画（切换时先销毁旧条）。
 */
export function drawSegmentedTabs(
    gm: GameManager, parent: Node, barName: string, y: number,
    tabs: { key: string; name: string }[], activeKey: string,
    tier: 'main' | 'sub', onSwitch: (key: string) => void
) {
    const old = parent.getChildByName(barName);
    if (old) old.destroy();
    if (tabs.length === 0) return;

    const main = tier === 'main';
    const h = main ? 42 : 32;
    const w = main ? 240 : Math.min(240, tabs.length * 80);
    const segW = w / tabs.length;

    const bar = gm.createNode(barName, parent, 0, y, w, h);
    const g = bar.addComponent(Graphics);
    g.fillColor = main ? new Color(70, 65, 85, 255) : new Color(225, 215, 190, 255);
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.fill();
    g.strokeColor = main ? new Color(45, 42, 60, 255) : BEIGE_LINE;
    g.lineWidth = 2;
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.stroke();

    tabs.forEach((tab, i) => {
        const x = -w / 2 + segW * i + segW / 2;
        const active = tab.key === activeKey;
        const seg = gm.createNode(`Seg_${tab.key}`, bar, x, 0, segW, h);
        if (active) {
            const pw = segW - 6, ph = h - 6;
            const pg = seg.addComponent(Graphics);
            pg.fillColor = main ? BLUE : ORANGE;
            pg.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2);
            pg.fill();
        }
        gm.createLabel(
            seg, tab.name, 0, 0, main ? 18 : 15,
            active ? new Color(255, 255, 255, 255) : (main ? new Color(200, 195, 215, 255) : BROWN),
            true
        );
        seg.on(Node.EventType.TOUCH_END, () => {
            if (!active) onSwitch(tab.key);
        }, this);
    });
}
