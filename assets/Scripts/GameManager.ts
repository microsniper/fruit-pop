import { _decorator, Component, Node, instantiate, Prefab, Vec3, UITransform, Label, Color, Sprite, SpriteFrame, tween, Graphics } from 'cc';
import { loginAndGetProgress, saveProgress } from './api';
const { ccclass, property } = _decorator;

export enum ScrewColor {
    RED = 'red',
    GREEN = 'green',
    BLUE = 'blue',
    YELLOW = 'yellow',
    PURPLE = 'purple',
    CYAN = 'cyan',
    PINK = 'pink',
    ORANGE = 'orange'
}
const COLORS: string[] = [ScrewColor.RED, ScrewColor.GREEN, ScrewColor.BLUE, ScrewColor.YELLOW, ScrewColor.PURPLE, ScrewColor.CYAN, ScrewColor.PINK, ScrewColor.ORANGE];

interface PlateTemplate {
    type: 'circle' | 'rect';
    w: number;
    h: number;
    holes: {x: number, y: number}[];
}

const PLATE_TEMPLATES: PlateTemplate[] = [
    { type: 'rect', w: 160, h: 160, holes: [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.2, y: 0.8}, {x: 0.8, y: 0.8}] },
    { type: 'rect', w: 140, h: 140, holes: [{x: 0.2, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.5, y: 0.8}] },
    { type: 'rect', w: 110, h: 110, holes: [{x: 0.25, y: 0.25}, {x: 0.75, y: 0.75}] },
    { type: 'rect', w: 180, h: 100, holes: [{x: 0.2, y: 0.5}, {x: 0.8, y: 0.5}] },
    { type: 'rect', w: 100, h: 180, holes: [{x: 0.5, y: 0.2}, {x: 0.5, y: 0.8}] },
    { type: 'circle', w: 140, h: 140, holes: [{x: 0.5, y: 0.5}] }
];

interface PlateData {
    id: string;
    type: 'circle' | 'rect';
    w: number;
    h: number;
    x: number;
    y: number;
    layer: number;
    screws: ScrewData[];
    holes: {x: number, y: number}[];
    removed: boolean;
    node?: Node;
    rotation?: number;
    gravityOrigin?: { x: number; y: number };
}

interface ScrewData {
    id: string;
    color: string;
    x: number;
    y: number;
    removed: boolean;
    node?: Node;
}

@ccclass('GameManager')
export class GameManager extends Component {

    @property(Prefab)
    screwPrefab: Prefab | null = null; 

    @property(Node)
    gameBoardNode: Node | null = null; 

    @property(Node)
    boxContainerNode: Node | null = null; 

    @property(Label)
    levelLabel: Label | null = null; 

    private currentLevel: number = 1;
    private maxTempHoles: number = 7; 
    private tempHoles: Node[] = []; 
    private plates: PlateData[] = [];
    private gameOver: boolean = false;

    async start() {
        // Fetch progress before starting
        this.currentLevel = await loginAndGetProgress();
        this.initGame();
    }

    initGame() {
        this.tempHoles = [];
        this.gameOver = false;
        if (this.levelLabel) {
            this.levelLabel.string = `挑战进度: ${this.currentLevel}`;
        }
        this.generateLevel();
    }

    updatePlateGravity(plate: PlateData) {
        const remaining = plate.screws.filter(s => !s.removed);
        if (remaining.length !== 1) {
            plate.rotation = 0;
            plate.gravityOrigin = undefined;
            if (plate.node) {
                tween(plate.node).stop();
                tween(plate.node)
                    .to(0.3, { angle: 0 })
                    .start();
            }
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
            if (plate.node) {
                tween(plate.node).stop();
                tween(plate.node)
                    .to(0.3, { angle: 0 })
                    .start();
            }
            return;
        }
        
        let targetRotation = Math.atan2(dx, dy) * (180 / Math.PI);
        // Cocos Creator uses counter-clockwise rotation for positive angles, but the math gives clockwise.
        // Let's negate it for Cocos.
        targetRotation = -targetRotation;
        
        plate.rotation = targetRotation;
        plate.gravityOrigin = { x: anchorX, y: anchorY };

        if (plate.node) {
            // Calculate anchor point in 0-1 range
            const anchorPointX = anchorX / plate.w;
            const anchorPointY = anchorY / plate.h;
            
            const uiTransform = plate.node.getComponent(UITransform);
            if (uiTransform) {
                // Changing anchor point affects position, we need to adjust position to keep it visually in place
                // A simpler way for visual rotation is just to animate angle around the new anchor.
                // For simplicity, we just set the anchor point. 
                // Since this might shift the node, we can calculate the offset.
                const oldAnchor = uiTransform.anchorPoint;
                const diffX = (anchorPointX - oldAnchor.x) * plate.w;
                const diffY = (anchorPointY - oldAnchor.y) * plate.h;
                
                // Rotate the diff vector by current angle to get world diff (if already rotated, but usually it's not)
                // For now, let's just set it. We'll adjust if it jumps.
                uiTransform.setAnchorPoint(anchorPointX, anchorPointY);
                plate.node.setPosition(plate.node.position.x + diffX, plate.node.position.y + diffY, 0);
                
                tween(plate.node).stop();
                tween(plate.node)
                    .to(0.5, { angle: targetRotation }, { easing: 'quadOut' })
                    .start();
            }
        }
    }

    generateLevel() {
        if (!this.screwPrefab || !this.gameBoardNode) return;

        this.gameBoardNode.removeAllChildren();
        this.plates = [];

        const levelNum = this.currentLevel;
        const numColors = Math.min(COLORS.length, 4 + Math.floor((levelNum - 1) / 2));
        const activeColors = COLORS.slice(0, numColors);

        const numTriplets = Math.min(15, 2 + levelNum);
        let screwsToPlace: string[] = [];
        
        for (let i = 0; i < numTriplets; i++) {
            const c = activeColors[Math.floor(Math.random() * activeColors.length)];
            screwsToPlace.push(c, c, c);
        }
        
        screwsToPlace.sort(() => Math.random() - 0.5);
        const totalScrews = screwsToPlace.length;

        let availableTemplates = PLATE_TEMPLATES;
        if (levelNum === 1) {
            availableTemplates = PLATE_TEMPLATES.filter(t => t.holes.length >= 3);
        }

        const spreadFactor = Math.max(0.5, 1.2 - levelNum * 0.1); 
        // Convert range to match Cocos coordinate system (0,0 is center)
        const rangeX = 200 * spreadFactor;
        const rangeY = 250 * spreadFactor;
        const centerYOffset = 100; // Shift up slightly
        
        const generatedCenters: {x: number, y: number}[] = [];
        let totalHolesAvailable = 0;
        let plateIndex = 0;

        while (totalHolesAvailable < totalScrews) {
            const template = availableTemplates[Math.floor(Math.random() * availableTemplates.length)];
            
            let x = 0, y = 0;
            let bestDist = -1;
            for (let tryCount = 0; tryCount < 10; tryCount++) {
                const tx = (Math.random() * 2 - 1) * rangeX;
                const ty = centerYOffset + (Math.random() * 2 - 1) * rangeY;
                
                if (generatedCenters.length === 0) {
                    x = tx; y = ty; break;
                }
                
                let minDist = 9999;
                for (let c of generatedCenters) {
                    const d = Math.sqrt(Math.pow(tx - c.x, 2) + Math.pow(ty - c.y, 2));
                    if (d < minDist) minDist = d;
                }
                
                if (minDist > bestDist) {
                    bestDist = minDist;
                    x = tx; y = ty;
                }
            }
            generatedCenters.push({x, y});
            
            const maxLayer = levelNum === 1 ? 1 : Math.min(10, 2 + Math.floor(levelNum * 1.5));
            const layer = Math.floor(Math.random() * maxLayer);
            
            const rotation = template.type === 'circle' ? 0 : (Math.random() > 0.5 ? 0 : 90);
            
            const actualHoles = template.holes.map(h => {
                if (rotation === 90) {
                   return { x: h.y * template.h, y: (1 - h.x) * template.w };
                }
                return { x: h.x * template.w, y: h.y * template.h };
            });
            
            const renderW = rotation === 90 ? template.h : template.w;
            const renderH = rotation === 90 ? template.w : template.h;
            
            this.plates.push({
                id: `p${plateIndex++}`,
                type: template.type,
                w: renderW, 
                h: renderH,
                x: x, y: y,
                layer: layer,
                screws: [],
                holes: actualHoles,
                removed: false,
                rotation: 0
            });
            
            totalHolesAvailable += actualHoles.length;
        }

        let allAvailableHoles: {plate: PlateData, holeIndex: number}[] = [];
        this.plates.forEach(p => {
            p.holes.forEach((_, hIndex) => {
                allAvailableHoles.push({plate: p, holeIndex: hIndex});
            });
        });
        
        allAvailableHoles.sort(() => Math.random() - 0.5);

        screwsToPlace.forEach((color, index) => {
            if (allAvailableHoles.length === 0) return;
            
            const target = allAvailableHoles.pop()!;
            const plate = target.plate;
            const hole = plate.holes[target.holeIndex];
            
            plate.screws.push({
                id: `s_${index}`,
                color: color,
                x: hole.x,
                y: hole.y,
                removed: false
            });
        });

        // Remove plates with no screws
        this.plates = this.plates.filter(p => p.screws.length > 0);

        // Sort plates by layer for proper rendering order
        this.plates.sort((a, b) => a.layer - b.layer);

        // Draw plates and screws
        this.plates.forEach(plate => {
            this.drawPlate(plate);

            plate.screws.forEach(screwData => {
                let screwNode = instantiate(this.screwPrefab!);
                
                // Update position calculation:
                // plate.x/y is the center. hole x/y is relative to top-left.
                // In Cocos, node position is center if anchor is 0.5,0.5.
                // But we set plate anchor point to 0.5, 0.5 in drawPlate usually.
                // Let's make sure.
                screwNode.setPosition(new Vec3(plate.x - plate.w/2 + screwData.x, plate.y + plate.h/2 - screwData.y, 0));
                
                screwNode.on(Node.EventType.TOUCH_END, () => {
                    this.onScrewClicked(plate, screwData);
                }, this);

                (screwNode as any).screwData = screwData;
                (screwNode as any).plateData = plate;
                screwData.node = screwNode;

                this.gameBoardNode!.addChild(screwNode);
                
                // Color the screw
                const sprite = screwNode.getComponent(Sprite);
                if (sprite) {
                    sprite.color = this.getColorFromString(screwData.color);
                }
            });

            this.updatePlateGravity(plate);
        });
    }

    getColorFromString(colorStr: string): Color {
        switch(colorStr) {
            case ScrewColor.RED: return new Color(255, 0, 0);
            case ScrewColor.GREEN: return new Color(0, 255, 0);
            case ScrewColor.BLUE: return new Color(0, 0, 255);
            case ScrewColor.YELLOW: return new Color(255, 255, 0);
            case ScrewColor.PURPLE: return new Color(128, 0, 128);
            case ScrewColor.CYAN: return new Color(0, 255, 255);
            case ScrewColor.PINK: return new Color(255, 192, 203);
            case ScrewColor.ORANGE: return new Color(255, 165, 0);
            default: return new Color(255, 255, 255);
        }
    }

    drawPlate(plate: PlateData) {
        // 使用 Graphics 绘制简单的板子
        let plateNode = new Node(`Plate_${plate.id}`);
        let g = plateNode.addComponent(Graphics);
        g.fillColor = new Color(200, 200, 200, 150); // 半透明灰色
        g.roundRect(-plate.w/2, -plate.h/2, plate.w, plate.h, 10);
        g.fill();
        plateNode.setPosition(new Vec3(plate.x, plate.y, 0));
        // 将板子节点放在螺丝底层
        plateNode.setSiblingIndex(0);
        plate.node = plateNode;
        this.gameBoardNode!.addChild(plateNode);
    }

    isPointInsidePlate(plate: PlateData, x: number, y: number) {
        // x and y are world coordinates (relative to gameBoard center)
        const rotation = plate.rotation || 0;
        
        let localX = x;
        let localY = y;
        
        if (rotation !== 0) {
            // Need to rotate the point around the plate's gravityOrigin or center
            const originX = plate.x - plate.w/2 + (plate.gravityOrigin?.x ?? plate.w/2);
            const originY = plate.y + plate.h/2 - (plate.gravityOrigin?.y ?? plate.h/2);
            
            // Cocos angle is counter-clockwise positive, but our rotation might be different.
            // Let's use the rotation value directly.
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

    isScrewBlocked(plate: PlateData, screw: ScrewData) {
        const screwAbsX = plate.x - plate.w/2 + screw.x;
        const screwAbsY = plate.y + plate.h/2 - screw.y;
        
        // Sampling points around the screw to check if it's mostly covered
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

        for (let other of this.plates) {
            if (other.id === plate.id || other.removed) continue;
            if (other.layer > plate.layer) {
                let insideCount = 0;
                for (const point of samplePoints) {
                    if (this.isPointInsidePlate(other, screwAbsX + point.x, screwAbsY + point.y)) {
                        insideCount++;
                    }
                }
                if (insideCount >= 7) {
                    return true;
                }
            }
        }
        return false;
    }

    onScrewClicked(plate: PlateData, screwData: ScrewData) {
        if (this.gameOver) return;

        if (this.isScrewBlocked(plate, screwData)) {
            console.log("螺丝被遮挡了！");
            // 简单的震动反馈
            let node = screwData.node;
            if (node) {
                tween(node).stop();
                let origX = node.position.x;
                tween(node)
                    .to(0.05, { position: new Vec3(origX + 5, node.position.y, 0) })
                    .to(0.05, { position: new Vec3(origX - 5, node.position.y, 0) })
                    .to(0.05, { position: new Vec3(origX, node.position.y, 0) })
                    .start();
            }
            return;
        }

        if (this.tempHoles.length >= this.maxTempHoles) {
            console.log("暂存区已满！游戏失败");
            this.gameOver = true;
            return;
        }

        screwData.removed = true;
        let screwNode = screwData.node!;

        // 移入暂存槽
        screwNode.removeFromParent();
        this.boxContainerNode?.addChild(screwNode);
        this.tempHoles.push(screwNode);

        const targetX = -300 + (this.tempHoles.length - 1) * 100;
        const targetY = 0; 
        
        tween(screwNode).stop();
        tween(screwNode)
            .to(0.3, { position: new Vec3(targetX, targetY, 0) }, { easing: 'backOut' })
            .call(() => {
                this.checkMatch();
            })
            .start();

        this.checkPlateFall(plate);
    }

    checkPlateFall(plate: PlateData) {
        const remainingScrews = plate.screws.filter(s => !s.removed);
        if (remainingScrews.length === 0 && plate.node) {
            plate.removed = true;
            tween(plate.node)
                .to(0.8, { position: new Vec3(plate.node.position.x, plate.node.position.y - 800, 0) }, { easing: 'quadIn' })
                .call(() => {
                    plate.node?.destroy();
                })
                .start();
        } else if (remainingScrews.length > 0) {
            this.updatePlateGravity(plate);
        }
    }

    updateTempHolesPosition() {
        const startX = -300; 
        const spacing = 100;
        
        for (let i = 0; i < this.tempHoles.length; i++) {
            let node = this.tempHoles[i];
            const targetX = startX + i * spacing;
            
            tween(node).stop();
            tween(node)
                .to(0.2, { position: new Vec3(targetX, 0, 0) }, { easing: 'quadOut' })
                .start();
        }
    }

    checkMatch() {
        if (this.tempHoles.length < 3) return;

        let colorCount: { [key: string]: Node[] } = {};
        for (let node of this.tempHoles) {
            let color = (node as any).screwData.color;
            if (!colorCount[color]) {
                colorCount[color] = [];
            }
            colorCount[color].push(node);
        }

        for (let color in colorCount) {
            if (colorCount[color].length >= 3) {
                let nodesToRemove = colorCount[color].slice(0, 3);
                nodesToRemove.forEach(node => {
                    let index = this.tempHoles.indexOf(node);
                    if (index > -1) {
                        this.tempHoles.splice(index, 1);
                    }
                    tween(node)
                        .to(0.2, { scale: new Vec3(0, 0, 0) })
                        .call(() => node.destroy())
                        .start();
                });

                setTimeout(() => {
                    this.updateTempHolesPosition();
                    this.checkWin();
                }, 250);
                break; 
            }
        }
    }

    checkWin() {
        if (this.gameOver) return;
        
        const allPlatesRemoved = this.plates.every((p) => p.removed);
        const tempHolesEmpty = this.tempHoles.length === 0;
        
        if (allPlatesRemoved && tempHolesEmpty) {
            this.gameOver = true;
            console.log("挑战成功！");
            this.currentLevel++;
            saveProgress(this.currentLevel);
            setTimeout(() => {
                this.initGame();
            }, 1000);
        }
    }
}
