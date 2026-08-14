import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

const platform = typeof wx !== 'undefined' ? wx : (typeof tt !== 'undefined' ? tt : null);

/**
 * 背景音乐管理。
 *
 * 关于「看完广告后没声音」：微信/抖音播激励视频是系统级打断音频，不走 InnerAudioContext.pause()，
 * 所以打断后 innerAudio.paused 仍是 false。早先 playBGM() 用 `!paused` 提前返回，
 * 就把「被外部打断」误判成「正在播放」，play() 永不执行，音乐再也不响。
 *
 * 现在不再读 paused，改为自己维护两个状态：
 *   soundOn    用户是否开着声音（设置面板控制，落 localStorage）
 *   shouldPlay 游戏是否希望 BGM 在播（playBGM/stopBGM 控制）
 * 恢复播放统一走 resumeAfterInterruption()，它只按这两个状态决定，不看平台的 paused。
 */
@ccclass('SoundManager')
export class SoundManager extends Component {
    private static instance: SoundManager | null = null;
    private innerAudio: any = null;
    private bgmVolume = 1;

    /** 系统音效（点击按钮）：独立上下文，懒创建、反复复用，不循环 */
    private systemClickAudio: any = null;
    /** 游戏音效（点击水果）：同上 */
    private gameClickAudio: any = null;
    /** 果篮装满撤走音效：同上 */
    private boxClearAudio: any = null;

    /** 用户是否开着声音（音乐/BGM 开关，落 localStorage soundEnabled） */
    private soundOn = true;
    /** 用户是否开着音效（点击音效独立开关，落 localStorage sfxEnabled） */
    private sfxOn = true;
    /** 游戏是否希望 BGM 正在播（与平台实际状态无关，仅表达意图） */
    private shouldPlay = false;
    /** 中断恢复监听函数引用（onDestroy 时要注销，防止僵尸回调） */
    private resumeHandler: (() => void) | null = null;

    static getInstance(): SoundManager | null {
        return SoundManager.instance;
    }

    onLoad() {
        if (SoundManager.instance) {
            this.node.destroy();
            return;
        }
        SoundManager.instance = this;

        this.soundOn = localStorage.getItem('soundEnabled') !== 'false';
        this.sfxOn = localStorage.getItem('sfxEnabled') !== 'false';

        try {
            if (platform && platform.createInnerAudioContext) {
                this.innerAudio = platform.createInnerAudioContext();
                this.innerAudio.loop = true;
                this.innerAudio.volume = this.soundOn ? this.bgmVolume : 0;
                this.innerAudio.autoplay = false;
                this.innerAudio.src = 'bgm.mp3';
                this.innerAudio.onError((err: any) => {
                    console.warn('BGM innerAudio error:', err);
                });
                this.playBGM();
            }
        } catch (e) {
            console.warn('BGM wx init failed:', e);
        }

        this.listenInterruptions();
    }

    /**
     * 注册各类中断的恢复入口：
     *   onShow                  切后台/看广告/跳转其他小程序后回到游戏
     *   onAudioInterruptionEnd  来电、闹钟、其他 App 抢占音频结束
     * 两个事件都是叠加注册，不会覆盖 GameManager 里已有的 onShow 监听。
     */
    private listenInterruptions() {
        if (!platform) return;
        this.resumeHandler = () => this.resumeAfterInterruption();
        try {
            if (typeof platform.onShow === 'function') platform.onShow(this.resumeHandler);
            if (typeof platform.onAudioInterruptionEnd === 'function') {
                platform.onAudioInterruptionEnd(this.resumeHandler);
            }
        } catch (e) {
            console.warn('BGM listen interruptions failed:', e);
        }
    }

    /**
     * 场景销毁时清理：置空单例引用 + 注销 onShow 监听 + 销毁音频上下文。
     * 否则旧实例随场景销毁后静态引用仍非空，新场景的 SoundManager 会在 onLoad
     * 里被单例守卫自毁，从此 getInstance 只剩僵尸实例，音乐开关彻底失灵
     * （旧音频上下文还在响，开关却控制不了它）。与 AdManager.onDestroy 同模式。
     */
    onDestroy() {
        if (SoundManager.instance === this) {
            SoundManager.instance = null;
        }
        if (platform && this.resumeHandler) {
            try {
                if (typeof platform.offShow === 'function') platform.offShow(this.resumeHandler);
                if (typeof platform.offAudioInterruptionEnd === 'function') {
                    platform.offAudioInterruptionEnd(this.resumeHandler);
                }
            } catch (e) {
                console.warn('BGM off interruptions failed:', e);
            }
        }
        if (this.innerAudio) {
            try {
                this.innerAudio.stop();
                this.innerAudio.destroy();
            } catch (e) {
                console.warn('BGM destroy failed:', e);
            }
            this.innerAudio = null;
        }
        // 音效上下文同样随场景销毁，避免僵尸音频（与 BGM 同清理时机）
        [this.systemClickAudio, this.gameClickAudio, this.boxClearAudio].forEach((audio) => {
            if (!audio) return;
            try {
                audio.stop();
                audio.destroy();
            } catch (e) {
                console.warn('SFX destroy failed:', e);
            }
        });
        this.systemClickAudio = null;
        this.gameClickAudio = null;
        this.boxClearAudio = null;
    }

    /**
     * 中断结束后恢复播放。不改变播放意图，只是把实际状态拉回意图。
     * 广告关闭、切后台返回、音频被抢占结束都走这里。
     */
    resumeAfterInterruption() {
        if (!this.innerAudio) return;
        if (!this.shouldPlay || !this.soundOn) return;
        try {
            // 不看 paused：被系统打断时它仍是 false。play() 对正在播放的音频是幂等的。
            this.innerAudio.play();
        } catch (e) {
            console.warn('BGM resume failed:', e);
        }
    }

    playBGM() {
        this.shouldPlay = true;
        if (!this.innerAudio || !this.soundOn) return;
        try {
            this.innerAudio.play();
        } catch (e) {
            console.warn('BGM play failed:', e);
        }
    }

    stopBGM() {
        this.shouldPlay = false;
        if (!this.innerAudio) return;
        try {
            this.innerAudio.stop();
        } catch (e) {
            console.warn('BGM stop failed:', e);
        }
    }

    /**
     * 短音效懒创建：独立 InnerAudioContext、不循环。音效文件放包根目录（build-templates 拷入），
     * 与 bgm.mp3 同套路。创建失败（如平台不支持）静默返回 null，调用方自然无声。
     */
    private ensureSfxAudio(src: string): any {
        try {
            if (!platform || !platform.createInnerAudioContext) return null;
            const audio = platform.createInnerAudioContext();
            audio.loop = false;
            audio.volume = 1;
            audio.src = src;
            audio.onError((err: any) => {
                console.warn('SFX innerAudio error:', src, err);
            });
            return audio;
        } catch (e) {
            console.warn('SFX init failed:', src, e);
            return null;
        }
    }

    /** 播放短音效：音效开关关闭时不播；正在播时从头重播（stop+play），连点不叠声 */
    private playSfx(getCtx: () => any, setCtx: (a: any) => void, src: string) {
        if (!this.sfxOn) return;
        let audio = getCtx();
        if (!audio) {
            audio = this.ensureSfxAudio(src);
            if (!audio) return;
            setCtx(audio);
        }
        try {
            audio.stop();
            audio.play();
        } catch (e) {
            console.warn('SFX play failed:', src, e);
        }
    }

    /** 系统音效：点击按钮等 UI 操作 */
    playSystemClick() {
        this.playSfx(() => this.systemClickAudio, (a) => { this.systemClickAudio = a; }, 'system_click.mp3');
    }

    /** 游戏音效：点击水果摘果 */
    playGameClick() {
        this.playSfx(() => this.gameClickAudio, (a) => { this.gameClickAudio = a; }, 'game_click.mp3');
    }

    /** 游戏音效：果篮装满飞出撤走 */
    playBoxClear() {
        this.playSfx(() => this.boxClearAudio, (a) => { this.boxClearAudio = a; }, 'box_clear.mp3');
    }

    setMute(isMuted: boolean) {
        this.soundOn = !isMuted;
        if (!this.innerAudio) return;
        try {
            this.innerAudio.volume = isMuted ? 0 : this.bgmVolume;
            // 从静音恢复时，若本该在播则补一次 play（静音期间可能已被打断停掉）
            if (!isMuted && this.shouldPlay) {
                this.innerAudio.play();
            }
        } catch (e) {
            console.warn('Set mute failed:', e);
        }
    }

    toggleMute(): boolean {
        this.setMute(this.soundOn);
        return this.soundOn;
    }

    /** 音效独立开关：只影响点击音效，不动 BGM（设置面板「音效」行调用） */
    setSfxMute(isMuted: boolean) {
        this.sfxOn = !isMuted;
    }
}
