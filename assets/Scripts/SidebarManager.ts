import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

declare const tt: any;

@ccclass('SidebarManager')
export class SidebarManager extends Component {

    private isSidebarSupported = false;
    private isFromSidebar = false;

    onLoad() {
        if (typeof tt === 'undefined') return;

        this.checkSupport();
        this.listenShow();
    }

    private checkSupport() {
        if (!tt.checkScene) {
            console.log('[Sidebar] tt.checkScene not available');
            return;
        }
        tt.checkScene({
            scene: 'sidebar',
            success: (res: any) => {
                if (res && res.data && res.data.isExist) {
                    this.isSidebarSupported = true;
                    console.log('[Sidebar] support: true');
                }
            },
            fail: (err: any) => {
                console.warn('[Sidebar] checkScene fail:', JSON.stringify(err));
            }
        });
    }

    private listenShow() {
        if (!tt.onShow) return;
        tt.onShow((res: any) => {
            if (res && res.launch_from === 'homepage' && res.location === 'sidebar_card') {
                this.isFromSidebar = true;
                console.log('[Sidebar] returned from sidebar');
                this.onEnterFromSidebar();
            }
        });
    }

    public gotoMySidebar() {
        if (!this.isSidebarSupported) {
            console.log('[Sidebar] not supported, skip');
            return;
        }
        tt.navigateToScene({
            scene: 'sidebar',
            success: () => {
                console.log('[Sidebar] navigateToScene success');
            },
            fail: (err: any) => {
                console.warn('[Sidebar] navigateToScene fail:', JSON.stringify(err));
            }
        });
    }

    private onEnterFromSidebar() {
        // TODO: 从侧边栏回来，发放奖励
    }
}
