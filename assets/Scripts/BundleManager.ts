import { assetManager, AssetManager, Asset } from 'cc';

/**
 * 分包资源管理器
 * 统一管理 bundle_late 分包的加载，避免直接依赖 resources
 */
export class BundleManager {
    private static instance: BundleManager;
    private bundle: AssetManager.Bundle | null = null;
    private loadingPromise: Promise<AssetManager.Bundle> | null = null;

    static getInstance(): BundleManager {
        if (!BundleManager.instance) {
            BundleManager.instance = new BundleManager();
        }
        return BundleManager.instance;
    }

    /** 加载 bundle_late 分包（可重复调用，内部缓存） */
    private loadBundle(): Promise<AssetManager.Bundle> {
        if (this.bundle) {
            return Promise.resolve(this.bundle);
        }
        if (this.loadingPromise) {
            return this.loadingPromise;
        }

        this.loadingPromise = new Promise<AssetManager.Bundle>((resolve, reject) => {
            const doLoad = () => {
                assetManager.loadBundle('bundle_late', (err, bundle) => {
                    if (err) {
                        this.loadingPromise = null;
                        reject(err);
                        return;
                    }
                    this.bundle = bundle;
                    this.loadingPromise = null;
                    resolve(bundle);
                });
            };

            // 微信小游戏：先手动加载分包并注册 SystemJS 模块
            const wx = (globalThis as any).wx;
            const wxRequire = (globalThis as any).__wxRequire;
            if (wx && wx.loadSubpackage && wxRequire) {
                wx.loadSubpackage({
                    name: 'bundle_late',
                    success: () => {
                        try {
                            wxRequire('subpackages/bundle_late/index.js');
                        } catch (e) {
                            console.warn('[BundleManager] 注册 SystemJS 模块失败:', e);
                        }
                        doLoad();
                    },
                    fail: (err: any) => {
                        console.warn('[BundleManager] wx.loadSubpackage 失败:', err);
                        doLoad();
                    }
                });
            } else {
                doLoad();
            }
        });

        return this.loadingPromise;
    }

    /**
     * 从分包加载 SpriteFrame
     * @param path 分包内的路径，如 'ui/panel_success'
     * @param type 资源类型
     */
    loadAsset<T extends Asset>(path: string, type: new (...args: any[]) => T): Promise<T> {
        return this.loadBundle().then((bundle) => {
            return new Promise<T>((resolve, reject) => {
                bundle.load(path, type, (err, asset) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(asset as T);
                });
            });
        });
    }

    /** 预加载分包（游戏启动时调用，提前加载等用户打开弹窗时不卡顿） */
    preload(): void {
        this.loadBundle().catch((err) => {
            console.warn('[BundleManager] 分包预加载失败:', err);
        });
    }
}
